import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  logFile: string;
  tailLines?: number;
  keepPatterns?: RegExp[];
  maxKept?: number;
  maxLogBytes?: number;
  signal?: AbortSignal;
  shutdown?: { input: string; timeoutMs: number };
  onLine?: (line: string) => "stop" | void;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stoppedEarly: boolean;
  aborted: boolean;
  logLimitExceeded: boolean;
  forced: boolean;
  durationMs: number;
  logFile: string;
  tail: string[];
  kept: string[];
  totalLines: number;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> | void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    return new Promise(resolve => {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const fallback = () => { child.kill("SIGKILL"); resolve(); };
      killer.once("error", fallback);
      killer.once("close", code => code === 0 ? resolve() : fallback());
    });
  }
  try { process.kill(-pid, signal); }
  catch { child.kill(signal); }
}

export function winCmdLine(command: string, args: string[]): string {
  const quote = (arg: string) => {
    // cmd expands percent references inside double quotes, and literal quotes can break argument boundaries.
    if (/[%!"\r\n\0]/.test(arg)) throw new Error("Windows build wrapper arguments cannot contain %, !, quotes, or line breaks.");
    return arg === "" || /[\s&|<>^(),;=]/.test(arg) ? `"${arg}"` : arg;
  };
  return [command, ...args].map(quote).join(" ");
}

export function spawnPlan(command: string, args: string[], platform: NodeJS.Platform = process.platform, comSpec = process.env.ComSpec) {
  return platform === "win32" && /\.(bat|cmd)$/i.test(command)
    ? { file: comSpec ?? "cmd.exe", args: ["/d", "/s", "/v:off", "/c", `"${winCmdLine(command, args)}"`], verbatim: true }
    : { file: command, args, verbatim: false };
}

export async function runProcess(o: RunOptions): Promise<RunResult> {
  o.signal?.throwIfAborted();
  const plan = spawnPlan(o.command, o.args);
  await mkdir(path.dirname(o.logFile), { recursive: true });
  const handle = await open(o.logFile, "w");
  const log = handle.createWriteStream();
  let logError: Error | undefined;
  const logDone = finished(log).catch(error => { logError = error; });
  const start = Date.now();
  const tail: string[] = [], kept: string[] = [];
  let totalLines = 0, bytesWritten = 0;
  let timedOut = false, stoppedEarly = false, aborted = false, logLimitExceeded = false, forced = false;
  let timer: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined, drainDeadline: NodeJS.Timeout | undefined;
  let terminating = false;
  let killing: Promise<void> | void = undefined;
  let observerError: unknown;
  try {
    const child = spawn(plan.file, plan.args, {
      cwd: o.cwd, env: o.env ?? process.env, detached: process.platform !== "win32",
      stdio: [o.shutdown ? "pipe" : "ignore", "pipe", "pipe"],
      windowsVerbatimArguments: plan.verbatim, windowsHide: true,
    });
    const streams = [child.stdout!, child.stderr!];
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      clearTimeout(escalation);
      forced = true;
      killing = killTree(child, "SIGKILL");
      // A descendant can keep inherited pipes open after the root process has exited.
      drainDeadline = setTimeout(() => streams.forEach(stream => stream.destroy()), 3000);
    };
    const shutdown = () => {
      if (terminating || escalation) return;
      if (!o.shutdown || !child.stdin || child.stdin.destroyed) { terminate(); return; }
      escalation = setTimeout(terminate, o.shutdown.timeoutMs);
      child.stdin.end(o.shutdown.input);
    };
    const cancel = () => { aborted = true; if (!stoppedEarly) shutdown(); };
    o.signal?.addEventListener("abort", cancel, { once: true });
    if (o.signal?.aborted) cancel();
    child.stdin?.on("error", terminate);
    log.once("error", terminate);
    const maxLine = 8192;
    const onLine = (line: string) => {
      totalLines++;
      tail.push(line);
      if (tail.length > (o.tailLines ?? 120)) tail.shift();
      if (kept.length < (o.maxKept ?? 400) && o.keepPatterns?.some(r => r.test(line))) kept.push(line);
      let action: "stop" | void;
      try {
        action = observerError === undefined ? o.onLine?.(line) : undefined;
      } catch (error) {
        observerError = error ?? new Error("Process output observer failed.");
        terminate();
        return;
      }
      if (!stoppedEarly && !aborted && !timedOut && !terminating && action === "stop") {
        stoppedEarly = true;
        clearTimeout(timer);
        shutdown();
      }
    };
    for (const stream of streams) {
      const decoder = new StringDecoder();
      let partial = "", clipped = false;
      const consume = (text: string, end = false) => {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (partial.length + line.length > maxLine) clipped = true;
          partial += line.slice(0, maxLine - partial.length);
          if (i < lines.length - 1 || end && (partial || clipped)) {
            onLine(partial.replace(/\r$/, "") + (clipped ? "…" : ""));
            partial = "";
            clipped = false;
          }
        }
      };
      stream.on("data", (chunk: Buffer) => {
        const remaining = (o.maxLogBytes ?? Infinity) - bytesWritten;
        if (remaining > 0 && !log.destroyed) {
          const bytes = chunk.subarray(0, remaining);
          bytesWritten += bytes.length;
          if (!log.write(bytes)) streams.forEach(s => s.pause());
        }
        if (chunk.length > remaining) { logLimitExceeded = true; terminate(); }
        consume(decoder.write(chunk));
      });
      stream.once("end", () => consume(decoder.end(), true));
    }
    log.on("drain", () => streams.forEach(stream => stream.resume()));
    log.on("error", () => streams.forEach(stream => stream.resume()));
    if (!aborted) timer = setTimeout(() => {
      timedOut = true;
      if (!aborted) shutdown();
    }, o.timeoutMs);
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    }).finally(() => o.signal?.removeEventListener("abort", cancel));
    clearTimeout(timer);
    clearTimeout(escalation);
    clearTimeout(drainDeadline);
    await killing;
    log.end();
    await logDone;
    if (logError) throw logError;
    if (observerError !== undefined) throw observerError;
    return {
      ...result, timedOut, stoppedEarly, aborted, logLimitExceeded, forced,
      durationMs: Date.now() - start, logFile: o.logFile, tail, kept, totalLines,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    clearTimeout(drainDeadline);
    if (!log.writableEnded) log.end();
    await logDone;
  }
}
