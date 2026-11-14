import AdmZip from "adm-zip";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { diagnose } from "../diagnostics/parse.js";
import { runProcess } from "../exec/run.js";
import { discoverJdks, pickJdk, type JdkInfo } from "../jdk/discover.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import { lookupProfile, type Services } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { downloadFile } from "../util/download.js";
import { findingLine } from "./crash.js";
import { clip, okText } from "./result.js";
import { buildInput } from "./schemas.js";
import { blockedBuild, buildEvidence, failedBuildUnit, readBuildLog } from "../../common/build-evidence.js";
import { gradleMaxJvm, wrapperGradleVersion } from "../../common/gradle-jvm.js";
import { gradleState, mavenState } from "../../common/project-state.js";

export { gradleMaxJvm, wrapperGradleVersion } from "../../common/gradle-jvm.js";

type A = z.infer<z.ZodObject<typeof buildInput>>;

const KEEP = [
  /\.(java|kts?):(\d+:|\[\d+,\d+\])|^\s*[ew]: /,
  /^\s*(symbol|location|required|found|reason|символ|расположение|требуется|найдено|причина)\s*:/,
  /^\* What went wrong:|^FAILURE:|^BUILD (FAILED|SUCCESSFUL|SUCCESS|FAILURE)/,
  /\[ERROR\]|Could not (resolve|find|GET|transfer)|status code \d{3}|could not be resolved/,
  /JVM runtime version|Unsupported class file|class file version|languageVersion=|Gradle requires JVM|release version|target release/,
  /Exception|Error:|Caused by:/,
];

export async function requiredJvm(services: Services, info: ProjectInfo, gradle?: string): Promise<{ jvm: number; max?: number; why: string }> {
  let jvm = 17;
  let why = "default";
  if (info.mcVersion) {
    try {
      const { profile } = await lookupProfile(services, info.platform, info.mcVersion);
      jvm = profile.java;
      why = `${info.platform} ${info.mcVersion} targets Java ${jvm}`;
    } catch (e) {
      why = `profile lookup failed (${(e as Error).message.split("\n")[0]})`;
    }
  }
  // paperweight-userdev 2.x runs on Java 21+
  if (info.nms === "paperweight" && jvm < 21) {
    jvm = 21;
    why += "; paperweight-userdev needs JDK 21 to run (compiles for the target via toolchain)";
  }
  // Maven compiles in-process: --release N needs javac 9+, so old targets build on a JDK 17 with release=N
  if (info.build === "maven" && jvm < 17) {
    const pom = await readFile(path.join(info.dir, "pom.xml"), "utf8").catch(() => "");
    if (/<(maven\.compiler\.)?release>/.test(pom)) {
      jvm = 17;
      why += " (built with JDK 17 and --release)";
    }
  }
  const max = gradle ? gradleMaxJvm(gradle) : undefined;
  if (max && jvm > max) return { jvm: max, max, why: `${why}; capped at ${max} (newest Gradle ${gradle} runs on)` };
  return { jvm, max, why };
}

/** Where Maven may be, in order: project wrapper, then mvn on PATH (Windows: mvnw.cmd / mvn.cmd, ';'-separated PATH). */
export function mavenCandidates(root: string, pathEnv: string, platform: NodeJS.Platform = process.platform): string[] {
  const P = platform === "win32" ? path.win32 : path.posix;
  const win = platform === "win32";
  return [P.join(root, win ? "mvnw.cmd" : "mvnw"), ...pathEnv.split(P.delimiter).filter(Boolean).map((d) => P.join(d.replace(/^"(.*)"$/, "$1"), win ? "mvn.cmd" : "mvn"))];
}

export function gradleWrapper(root: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.win32.join(root, "gradlew.bat") : path.posix.join(root, "gradlew");
}

/** mvnw, mvn on PATH, or Apache Maven downloaded from Maven Central into the cache. */
async function mavenCommand(services: Services, root: string): Promise<{ cmd: string; note?: string }> {
  const win = process.platform === "win32";
  const found = mavenCandidates(root, process.env.PATH ?? "").find((c) => existsSync(c));
  if (found) return { cmd: found };
  const v = await services.versions.latestMaven(ENDPOINTS.mavenDistMetadata, { prefix: "3." });
  if (!v) throw new Error("No Maven found (mvnw/mvn) and its version list could not be read.");
  const home = path.join(services.config.cacheDir, "tools", `apache-maven-${v}`);
  const bin = path.join(home, "bin", win ? "mvn.cmd" : "mvn");
  if (!existsSync(bin)) {
    const zip = await downloadFile(ENDPOINTS.mavenDist(v), path.join(services.config.cacheDir, "downloads", `apache-maven-${v}-bin.zip`), { userAgent: services.config.userAgent, offline: services.config.offline });
    const tmp = `${home}.tmp`;
    await rm(tmp, { recursive: true, force: true });
    new AdmZip(zip).extractAllTo(tmp, true);
    await rename(path.join(tmp, `apache-maven-${v}`), home);
    await rm(tmp, { recursive: true, force: true });
    if (!win) chmodSync(bin, 0o755);
  }
  return { cmd: bin, note: `Maven ${v} (no mvnw/mvn found; official binary from Maven Central, cached)` };
}

export async function build(services: Services, a: A, signal?: AbortSignal) {
  const info = await readProjectInfo(a.projectDir).catch((e: Error) => e);
  if (info instanceof Error) return blockedBuild(info.message, path.resolve(a.projectDir), "project");
  const root = info.build === "gradle" ? info.rootDir : info.dir;
  const notes: string[] = [];
  let cmd: string;
  let args: string[];
  let tasks: string[];
  let gradleVersion: string | undefined;
  if (info.build === "gradle") {
    cmd = gradleWrapper(root);
    if (!existsSync(cmd)) return blockedBuild(`No Gradle wrapper in ${root}. Add one (gradle wrapper --gradle-version <get_profile's Gradle>) and retry.`, info.dir, "wrapper");
    gradleVersion = await wrapperGradleVersion(root);
    const sub = info.dir !== root ? `:${path.relative(root, info.dir).split(path.sep).join(":")}` : "";
    tasks = (a.tasks?.length ? a.tasks : ["build"]).map((t) => (sub && !t.startsWith(":") && !t.startsWith("-") ? `${sub}:${t}` : t));
    args = [...tasks, "--console=plain"];
  } else {
    try {
      const m = await mavenCommand(services, root);
      cmd = m.cmd;
      if (m.note) notes.push(m.note);
    } catch (e) {
      return blockedBuild((e as Error).message, info.dir, "maven");
    }
    tasks = a.tasks?.length ? a.tasks : ["package"];
    args = [...tasks, "-B", "-ntp"];
  }
  const req = await requiredJvm(services, info, gradleVersion);
  const all = await discoverJdks();
  let jdk: JdkInfo;
  if (a.javaHome) jdk = all.find((j) => path.resolve(j.home) === path.resolve(a.javaHome!)) ?? { home: a.javaHome, major: 0, version: "?", isJdk: true, source: "javaHome" };
  else {
    const choice = pickJdk(all, req.jvm, req.why, req.max);
    if (!choice.jdk) return blockedBuild(choice.missing!, info.dir, "jdk");
    jdk = choice.jdk;
  }
  if (jdk.major && (jdk.major < req.jvm || req.max && jdk.major > req.max)) {
    notes.push(`javaHome is JDK ${jdk.major}; expected ${req.max ? `${req.jvm}–${req.max}` : `${req.jvm}+`} (${req.why}).`);
  }
  if (info.build === "gradle") {
    const paths = all.filter((j) => j.isJdk).map((j) => j.home).join(",");
    if (paths) args.push(`-Porg.gradle.java.installations.paths=${paths}`);
  }
  args.push(...(a.args ?? []));
  const logFile = path.join(root, ".mct", "logs", `build-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.log`);
  await mkdir(path.dirname(logFile), { recursive: true });
  const failedUnits = new Set<string>();
  const storage = await (info.build === "gradle" ? gradleState : mavenState)(info.rootDir, {
    ...process.env, JAVA_HOME: jdk.home, PATH: `${path.join(jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const r = await runProcess({
    command: cmd,
    args: [...storage.args, ...args],
    cwd: root,
    env: storage.env,
    timeoutMs: (a.timeoutSec ?? 1200) * 1000,
    signal,
    logFile,
    tailLines: 60,
    keepPatterns: KEEP,
    maxKept: 300,
    onLine: line => {
      const unit = failedBuildUnit(line);
      if (unit && failedUnits.size < 10) failedUnits.add(unit);
    },
  });
  const d = diagnose(await readBuildLog(r));
  const evidence = buildEvidence(r, d.findings, { ...info, rootDir: root }, tasks, [...failedUnits]);
  const failed = evidence.status !== "passed";
  const status = r.aborted ? "cancelled" : r.timedOut ? "timed out (killed)" : failed ? `failed (exit ${r.exitCode ?? r.signal})` : "succeeded";
  const errs = d.findings.filter((f) => f.severity === "error");
  const shown = [...errs, ...d.findings.filter((f) => f.severity !== "error" && f.kind !== "compile_warning")].slice(0, 15);
  const artifacts = failed ? [] : await builtJars(info);
  const out = [
    `${info.build === "gradle" ? `Gradle${gradleVersion ? ` ${gradleVersion}` : ""}` : "Maven"} ${args.filter((x) => !x.startsWith("-")).join(" ")} ${status} in ${Math.round(r.durationMs / 100) / 10}s, JDK ${jdk.major || "?"} (${req.why}).`,
    ...(d.findings.length ? [d.summary] : []),
    ...shown.map(findingLine),
    ...(d.findings.length > shown.length ? [`… ${d.findings.length - shown.length} more: analyze_crash path=${logFile}`] : []),
    ...(failed && !errs.length ? ["tail:", ...r.tail.slice(-25).map((l) => clip(l, 200))] : []),
    ...(artifacts.length ? [`jars: ${artifacts.join(", ")}`] : []),
    ...notes.map((n) => `note: ${n}`),
    `log: ${logFile}`,
  ];
  return {
    ...okText(out.join("\n")),
    structuredContent: {
      ...evidence, buildSystem: info.build, jdk: jdk.major, artifacts, warnings: notes,
      diagnostics: shown.map(f => ({ ...f, message: clip(f.message, 300), evidence: f.evidence && clip(f.evidence, 200) })),
    },
    isError: failed,
  };
}

async function builtJars(info: ProjectInfo): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dirs = [path.join(info.dir, info.build === "maven" ? "target" : path.join("build", "libs"))];
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of await readdir(d)) if (f.endsWith(".jar")) out.push(path.relative(info.dir, path.join(d, f)));
  }
  return out;
}
