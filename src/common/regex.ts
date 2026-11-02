import { Worker } from "node:worker_threads";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let regex;
try {
  regex = new RegExp(workerData.pattern, workerData.flags);
  parentPort.postMessage({ ready: true });
} catch (error) {
  parentPort.postMessage({ ready: false, error: String(error && error.message || error) });
}
parentPort.on("message", ({ id, values }) => {
  try {
    parentPort.postMessage({ id, matches: values.map((value) => regex.test(value)) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message || error) });
  }
});`;

/** Runs caller-supplied patterns off the MCP event loop and terminates pathological matches. */
export class RegexMatcher {
  private static activeMatchers = 0;
  private static readonly maxActiveMatchers = 8;
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly deadlineAt: number;
  private nextId = 0;
  private pending = new Map<number, { resolve: (matches: boolean[]) => void; reject: (error: Error) => void }>();
  private disposed = false;
  private slotReleased = false;

  constructor(readonly pattern: string, flags = "", private readonly timeoutMs = 500, totalTimeoutMs = 60_000) {
    if (pattern.length > 2048) throw new Error("Regex is too long (maximum 2048 characters).");
    if (RegexMatcher.activeMatchers >= RegexMatcher.maxActiveMatchers) throw new Error("Too many regex searches are running; retry when another search finishes.");
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags } });
    RegexMatcher.activeMatchers++;
    this.deadlineAt = Date.now() + totalTimeoutMs;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (error) reject(error);
        else resolve();
      };
      const startupTimer = setTimeout(() => {
        finish(new Error("Regex worker did not start in time."));
        void this.worker.terminate();
      }, 10_000);
      this.worker.once("message", (message: { ready?: boolean; error?: string }) => {
        if (message.ready) finish();
        else if (message.error) finish(new Error(`Invalid regular expression: ${message.error}`));
      });
      this.worker.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      this.worker.once("exit", (code) => {
        if (!settled) finish(new Error(`Regex worker exited before initialization (code ${code}).`));
      });
    });
    // A caller may close a matcher before the worker finishes booting; keep that expected shutdown observed.
    void this.ready.catch(() => {});
    this.worker.on("message", (message: { id?: number; matches?: boolean[]; error?: string }) => {
      if (message.id === undefined) return;
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error));
      else task.resolve(message.matches ?? []);
    });
    this.worker.on("error", (error) => this.rejectPending(error instanceof Error ? error : new Error(String(error))));
  }

  async testMany(values: string[]): Promise<boolean[]> {
    await this.ready;
    if (this.disposed) throw new Error("Regex matcher is closed.");
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      await this.close();
      throw new Error("Regex search exceeded its total time limit.");
    }
    const id = this.nextId++;
    return new Promise<boolean[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(remaining <= this.timeoutMs ? "Regex search exceeded its total time limit." : "Regex search exceeded its per-batch time limit."));
        void this.close();
      }, Math.min(this.timeoutMs, remaining));
      this.pending.set(id, {
        resolve: (matches) => { clearTimeout(timer); resolve(matches); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.worker.postMessage({ id, values });
    });
  }

  async testAll(values: string[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let i = 0; i < values.length; i += 512) out.push(...await this.testMany(values.slice(i, i + 512)));
    return out;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new Error("Regex matcher was terminated."));
    try {
      await this.worker.terminate();
    } finally {
      if (!this.slotReleased) {
        this.slotReleased = true;
        RegexMatcher.activeMatchers--;
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
}
