import { copyFile, mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { readPluginArchive } from "../../common/plugin-archive.js";
import { clip, ok } from "../../common/result.js";
import { restrictedJavaEnv } from "../../common/restricted-env.js";
import { runProcess } from "../exec/run.js";
import type { paperSmokeTestInput } from "./schemas.js";

type Args = z.infer<z.ZodObject<typeof paperSmokeTestInput>>;
type Status = "passed" | "plugin_failure" | "infrastructure_failure" | "blocked" | "cancelled" | "inconclusive";
const prefix = /^\[(?:\d{2}:\d{2}:\d{2}(?:\.\d+)? )?(?:[^\]\r\n]+\/)?(?:INFO|WARN|ERROR|FATAL)\]:\s*/;
const timePrefix = /^\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]\s*/;

export function paperLifecycle(plugin: { name: string; version: string }, deployedJar: string) {
  const label = `${plugin.name} v${plugin.version}`;
  const evidence: Record<string, string> = {};
  return {
    evidence,
    observe(line: string) {
      const message = line.replace(/\x1b\[[0-9;]*m/g, "").replace(timePrefix, "");
      if (!prefix.test(message)) return;
      const body = message.replace(prefix, "");
      const pluginMessage = body.replace(`[${plugin.name}] `, "");
      const record = (key: string) => { evidence[key] ??= clip(line, 400); };
      if (pluginMessage === `Enabling ${label}` || pluginMessage === `Enabling ${label}*`) record("enabling");
      if (pluginMessage === `Disabling ${label}`) record(evidence.stopping ? "disabling" : "disabledEarly");
      if (/^Done \([\d.,]+s\)! For help, type "help"/.test(body)) record("serverReady");
      if (body === "Stopping server") record("stopping");
      const failure = pluginMessage.replace("Error occurred (in the plugin loader) while ", "Error occurred while ");
      if (["enabling", "disabling", "loading"].some(action => failure === `Error occurred while ${action} ${label}` ||
          failure.startsWith(`Error occurred while ${action} ${label} `)) ||
          /(?:Could not load|Failed to load|Error loading)/i.test(body) && (body.includes(deployedJar) || body.includes(label)) ||
          /UnknownDependencyException/.test(body) && (body.includes(deployedJar) || body.includes(`'${plugin.name}'`))) record("pluginError");
    },
  };
}

export async function paperSmokeTest(args: Args, signal?: AbortSignal) {
  let logFile: string | undefined, runDir: string | undefined;
  const limitations = "Checks Paper startup and the selected plugin's enable/disable lifecycle using server logs. Gameplay and command behavior need separate tests. JARs run as the MCP user and can use the network.";
  function report(status: Status, message: string, data: object = {}) {
    return { ...ok(message), structuredContent: { status, runDir, logFile, ...data, limitations }, isError: status !== "passed" };
  }
  if (args.allowExecution !== true || args.acceptEula !== true) return report("blocked", "Running Paper requires explicit execution authorization and EULA acceptance.");
  const resolveFile = async (root: string, file: string, extension?: string) => {
    const resolved = await realpath(path.resolve(root, file));
    if (!(await stat(resolved)).isFile() || extension && !resolved.toLowerCase().endsWith(extension)) throw new Error(`Expected a local ${extension ?? "regular"} file: ${file}`);
    return resolved;
  };
  let java: string, serverJar: string, jars: string[], plugin: ReturnType<typeof readPluginArchive>;
  try {
    const root = await realpath(args.projectDir);
    if (!(await stat(root)).isDirectory()) throw new Error("projectDir must be a directory.");
    java = await resolveFile(root, path.join(args.javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"));
    serverJar = await resolveFile(root, args.serverJar, ".jar");
    jars = await Promise.all([args.pluginJar, ...(args.dependencyJars ?? [])].map(file => resolveFile(root, file, ".jar")));
    const plugins = jars.map(readPluginArchive);
    if (jars.includes(serverJar) || new Set(plugins.map(p => p.name.toLowerCase())).size !== plugins.length) throw new Error("Supply distinct plugin identities and a separate server JAR.");
    plugin = plugins[0]!;
    if (signal?.aborted) return report("cancelled", "Paper smoke test cancelled before startup.");
    const state = path.join(root, ".mct", "smoke");
    await mkdir(state, { recursive: true });
    runDir = await mkdtemp(path.join(state, "paper-"));
    const pluginsDir = path.join(runDir, "plugins");
    await mkdir(pluginsDir);
    await Promise.all([
      writeFile(path.join(runDir, "eula.txt"), "eula=true\n"),
      writeFile(path.join(runDir, "server.properties"), [
        "server-ip=127.0.0.1", "server-port=0", "enable-rcon=false", "enable-query=false",
        "enable-status=false", "enable-jmx-monitoring=false", "enable-command-block=false",
        "white-list=true", "enforce-whitelist=true", "view-distance=3", "simulation-distance=3", "",
      ].join("\n")),
      ...jars.map((jar, index) => copyFile(jar, path.join(pluginsDir, `mct-${index}-${plugins[index]!.name}.jar`))),
    ]);
  } catch (error) {
    return report(runDir ? "infrastructure_failure" : "blocked", (error as Error).message);
  }
  logFile = path.join(runDir, "console.log");
  const lifecycle = paperLifecycle(plugin, `mct-0-${plugin.name}.jar`);
  try {
    let stopping = false;
    const run = await runProcess({
      command: java,
      args: ["-Xms256M", "-Xmx2G", "-Duser.home=.", "-Djava.io.tmpdir=.", "-jar", serverJar, "--nogui"],
      cwd: runDir,
      env: restrictedJavaEnv(java, runDir),
      logFile,
      signal,
      timeoutMs: (args.startupTimeoutSec ?? 180) * 1000,
      maxLogBytes: 16 * 1024 * 1024,
      shutdown: { input: "stop\n", timeoutMs: 20_000 },
      onLine: line => {
        lifecycle.observe(line);
        if (lifecycle.evidence.serverReady && !stopping) { stopping = true; return "stop"; }
      },
    });
    const evidence = lifecycle.evidence;
    const data = {
      plugin: { name: plugin.name, version: plugin.version, descriptor: plugin.descriptor }, evidence, exitCode: run.exitCode, forced: run.forced,
      durationMs: run.durationMs, tail: run.tail.slice(-12).map(line => clip(line, 300)),
    };
    if (run.aborted) return report("cancelled", "Paper smoke test cancelled.", data);
    if (evidence.pluginError || evidence.disabledEarly && evidence.serverReady) return report("plugin_failure", `${plugin.name} failed during loading or lifecycle.`, data);
    if (run.timedOut || run.logLimitExceeded || run.forced || run.exitCode !== 0) {
      return report("infrastructure_failure", run.timedOut ? "Paper did not start before the deadline."
        : run.logLimitExceeded ? "Paper exceeded the console log limit."
        : run.forced ? "Paper required forced termination." : "Paper exited unsuccessfully.", data);
    }
    if (!evidence.serverReady) return report("infrastructure_failure", "Paper exited before startup completed.", data);
    if (!run.stoppedEarly || !evidence.enabling || !evidence.disabling || !evidence.stopping) return report("inconclusive", "Paper started, but the full plugin lifecycle could not be observed.", data);
    return report("passed", `Paper started and ${plugin.name} enabled and disabled during a clean shutdown.`, data);
  } catch (error) {
    return report(signal?.aborted ? "cancelled" : "infrastructure_failure", (error as Error).message);
  }
}
