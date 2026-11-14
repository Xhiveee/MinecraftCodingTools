import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { diagnose, type Diagnosis } from "../diagnostics/parse.js";
import { runProcess, type RunResult } from "../exec/run.js";
import { discoverJdks, pickJdk, type JdkInfo } from "../jdk/discover.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import { lookupProfile, type Services } from "../services.js";
import { clip, ok } from "./result.js";
import { gradleBuildInput } from "./schemas.js";
import { blockedBuild, buildEvidence, failedBuildUnit, readBuildLog } from "../../common/build-evidence.js";
import { gradleMaxJvm, wrapperGradleVersion } from "../../common/gradle-jvm.js";
import { gradleState, stateDir } from "../../common/project-state.js";

export { gradleMaxJvm, wrapperGradleVersion } from "../../common/gradle-jvm.js";

const KEEP = [
  /\.(java|kts?):(\d+:|\[\d+,\d+\])|^\s*[ew]: /,
  /^\s*(symbol|location|required|found|reason|символ|расположение|требуется|найдено|причина)\s*:/,
  /^\* What went wrong:|^FAILURE:|^BUILD (FAILED|SUCCESSFUL)/,
  /Could not (resolve|find|GET)|status code \d{3}/,
  /JVM runtime version|Unsupported class file|class file version|languageVersion=|Gradle requires JVM/,
  /Mixin|mixin|Injection|@Shadow/,
  /Exception|Error:|Caused by:/,
  /Crash report saved|Suspected Mod|Mod ID: '|which is missing|Incompatible mods/,
];

export interface GradleRunOptions {
  projectDir: string;
  tasks: string[];
  args?: string[];
  javaHome?: string;
  timeoutSec: number;
  daemon: boolean;
  env?: Record<string, string>;
  logName: string;
  signal?: AbortSignal;
}

export interface GradleRun {
  project: ProjectInfo;
  jdk: JdkInfo;
  requiredJvm: number;
  command: string;
  result: RunResult;
  diagnosis: Diagnosis;
  warnings: string[];
  tasks: string[];
  failedUnits: string[];
}

const versionGte = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

async function requiredJvm(services: Services, info: ProjectInfo, warnings: string[]): Promise<{ jvm: number; max?: number; why: string }> {
  const wrapper = await wrapperGradleVersion(info.rootDir ?? info.dir);
  const max = wrapper ? gradleMaxJvm(wrapper) : undefined;
  const cap = (jvm: number, why: string) => (max && jvm > max ? { jvm: max, max, why: `${why} Capped at JDK ${max}: the newest Gradle ${wrapper} runs on.` } : { jvm, max, why });
  try {
    const { profile } = await lookupProfile(services, info.loader, info.mcVersion);
    // minJvm belongs to the plugin version the profile pins; only enforce it when the project's Gradle is that new.
    const minJvm = profile.gradle.minJvm && (!wrapper || versionGte(wrapper, profile.gradle.version)) ? profile.gradle.minJvm : 0;
    const jvm = Math.max(profile.java, minJvm);
    return cap(jvm, `${info.loader} ${info.mcVersion} targets Java ${profile.java}${minJvm > profile.java ? ` and its Gradle plugin needs JDK ${minJvm} to run` : ""}.`);
  } catch (e) {
    if (info.gradleJvm) return cap(info.gradleJvm, `From project metadata (profile lookup failed: ${(e as Error).message}).`);
    warnings.push(`Could not resolve the profile (${(e as Error).message}); assuming JDK 21.`);
    return cap(21, "Fallback.");
  }
}

export async function runGradle(services: Services, o: GradleRunOptions): Promise<GradleRun | { error: string; cause: "project" | "wrapper" | "jdk" }> {
  const project = await readProjectInfo(o.projectDir).catch((error: Error) => error);
  if (project instanceof Error) return { error: project.message, cause: "project" };
  const warnings: string[] = [];
  const root = project.rootDir ?? project.dir;
  const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!existsSync(wrapper)) return { error: `No Gradle wrapper (${path.basename(wrapper)}) in ${root}.`, cause: "wrapper" };
  // a subproject directory: run from the root and qualify bare task names (":fabric:build")
  const sub = project.gradlePath && project.gradlePath !== ":" ? project.gradlePath : undefined;
  const tasks = o.tasks.map((t) => (sub && !t.startsWith(":") && !t.startsWith("-") && t !== "ffnPrintClasspath" ? `${sub}:${t}` : t));
  const req = await requiredJvm(services, project, warnings);
  const all = await discoverJdks();
  let jdk: JdkInfo | undefined;
  if (o.javaHome) {
    jdk = all.find((j) => path.resolve(j.home) === path.resolve(o.javaHome!)) ?? { home: o.javaHome, major: 0, version: "?", isJdk: true, source: "javaHome" };
    if (jdk.major && jdk.major < req.jvm) warnings.push(`javaHome is JDK ${jdk.major} but ${req.jvm}+ is required: ${req.why}`);
    if (jdk.major && req.max && jdk.major > req.max) warnings.push(`javaHome is JDK ${jdk.major}; Gradle ${await wrapperGradleVersion(root)} supports up to JDK ${req.max}.`);
  } else {
    const choice = pickJdk(all, req.jvm, req.why, req.max);
    if (!choice.jdk) return { error: choice.missing!, cause: "jdk" };
    jdk = choice.jdk;
  }
  const state = stateDir(root);
  const toolchainPaths = all.filter((j) => j.isJdk).map((j) => j.home).join(",");
  const args = [
    ...tasks,
    "--console=plain",
    ...(o.daemon ? [] : ["--no-daemon"]),
    ...(toolchainPaths ? [`-Porg.gradle.java.installations.paths=${toolchainPaths}`] : []),
    ...(o.args ?? []),
  ];
  const storage = await gradleState(root, {
    ...process.env,
    JAVA_HOME: jdk.home,
    PATH: `${path.join(jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    ...o.env,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(state, "logs", `${o.logName}-${stamp}-${randomUUID()}.log`);
  const failedUnits = new Set<string>();
  const commandArgs = [...storage.args, ...args];
  const result = await runProcess({
    command: wrapper,
    args: commandArgs,
    cwd: root,
    env: storage.env,
    timeoutMs: o.timeoutSec * 1000,
    signal: o.signal,
    logFile,
    tailLines: 80,
    keepPatterns: KEEP,
    maxKept: 300,
    onLine: line => {
      const unit = failedBuildUnit(line);
      if (unit && failedUnits.size < 10) failedUnits.add(unit);
    },
  });
  const diagnosis = diagnose(await readBuildLog(result));
  return { project, jdk, requiredJvm: req.jvm, command: `${path.basename(wrapper)} ${commandArgs.join(" ")}`, result, diagnosis, warnings, tasks, failedUnits: [...failedUnits] };
}

function status(r: RunResult): string {
  if (r.aborted) return "cancelled";
  if (r.timedOut) return "timed out (process tree killed)";
  return r.exitCode === 0 ? "succeeded" : `failed (exit ${r.exitCode ?? r.signal})`;
}

function report(run: GradleRun) {
  const r = run.result;
  const failed = r.exitCode !== 0 || r.timedOut;
  const errs = run.diagnosis.findings.filter((f) => f.severity === "error");
  const findings = [...errs, ...run.diagnosis.findings.filter((f) => f.severity !== "error")];
  return {
    jdk: `${run.jdk.major} (required ${run.requiredJvm}+)`,
    status: status(r),
    durationSec: Math.round(r.durationMs / 100) / 10,
    logFile: r.logFile,
    findings: findings.slice(0, 20).map((f) => ({ ...f, message: clip(f.message, 300), evidence: f.evidence && f.evidence !== f.message ? clip(f.evidence, 200) : undefined })),
    ...(findings.length > 20 ? { moreFindings: `${findings.length - 20} more in the log (analyze_crash path=<logFile> offset=20)` } : {}),
    culprit: run.diagnosis.culprit,
    warnings: run.warnings,
    // the log tail only when it can help: failures without recognised findings get more lines
    ...(failed ? { tail: r.tail.slice(errs.length ? -10 : -30).map((l) => clip(l, 200)) } : {}),
  };
}



type BuildArgs = z.infer<z.ZodObject<typeof gradleBuildInput>>;

export async function gradleBuild(services: Services, a: BuildArgs, signal?: AbortSignal) {
  const run = await runGradle(services, {
    projectDir: a.projectDir,
    tasks: a.tasks?.length ? a.tasks : ["build"],
    args: a.args,
    javaHome: a.javaHome,
    timeoutSec: a.timeoutSec ?? 1200,
    daemon: a.daemon ?? true,
    logName: "build",
    signal,
  });
  if ("error" in run) return blockedBuild(run.error, path.resolve(a.projectDir), run.cause);
  const data = report(run);
  const structuredContent = {
    ...buildEvidence(run.result, run.diagnosis.findings, run.project, run.tasks, run.failedUnits),
    buildSystem: "gradle", jdk: run.jdk.major, diagnostics: data.findings, warnings: data.warnings,
  };
  return { ...ok(`Gradle ${run.tasks.join(" ")} ${data.status} in ${data.durationSec}s with JDK ${run.jdk.major}. ${run.diagnosis.summary}`, data), structuredContent, isError: structuredContent.status !== "passed" };
}
