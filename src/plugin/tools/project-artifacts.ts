import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runProcess } from "../exec/run.js";
import { readProjectInfo } from "../project/info.js";
import type { Services } from "../services.js";
import { fail, ok } from "./result.js";
import { gradleWrapper, mavenCandidates, requiredJvm, wrapperGradleVersion } from "./build.js";
import { discoverJdks, pickJdk } from "../jdk/discover.js";
import { listProjectArtifactsInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof listProjectArtifactsInput>>;
const CLASSPATH_INIT = `allprojects { p ->
  p.tasks.register("bspPrintCompileClasspath") {
    doLast {
      def sets = p.extensions.findByName("sourceSets")
      if (sets != null) sets.findAll { it.name == "main" }.each { s ->
        s.compileClasspath.files.each { f -> println("BSP-CP:\${p.projectDir.canonicalPath}|\${f.absolutePath}") }
      }
    }
  }
}
`;

function sourceJarFor(jar: string): string | undefined {
  const stem = jar.replace(/\.jar$/i, "");
  return [`${stem}-sources.jar`, `${stem.replace(/-merged$/i, "")}-sources.jar`].find(existsSync);
}

export async function listProjectArtifacts(services: Services, a: A) {
  const info = await readProjectInfo(a.projectDir).catch((e: Error) => e);
  if (info instanceof Error) return fail(info.message);
  const root = info.rootDir;
  const base = path.join(root, ".mct", "classpath");
  await mkdir(base, { recursive: true });
  const work = await mkdtemp(path.join(base, "run-"));
  const logFile = path.join(work, "resolve.log");
  await mkdir(work, { recursive: true });
  let jars: string[] = [];
  let directories = 0;
  const gradleVersion = info.build === "gradle" ? await wrapperGradleVersion(root) : undefined;
  const req = await requiredJvm(services, info, gradleVersion);
  const jdks = await discoverJdks();
  const choice = pickJdk(jdks, req.jvm, req.why, req.max);
  if (!choice.jdk) return fail(choice.missing!);
  const javaEnv = {
    ...process.env,
    JAVA_HOME: choice.jdk.home,
    PATH: `${path.join(choice.jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  if (info.build === "gradle") {
    const wrapper = gradleWrapper(root);
    if (!existsSync(wrapper)) return fail(`No Gradle wrapper in ${root}; add gradlew before resolving the compile classpath.`);
    const init = path.join(work, "classpath.init.gradle");
    await writeFile(init, CLASSPATH_INIT, "utf8");
    const result = await runProcess({ command: wrapper, args: ["bspPrintCompileClasspath", "--init-script", init, "--no-configuration-cache", "--console=plain", ...(services.config.offline ? ["--offline"] : [])], cwd: root, env: javaEnv, timeoutMs: 20 * 60_000, logFile, tailLines: 80 });
    if (result.exitCode !== 0 || result.timedOut) return fail(`Gradle classpath resolution ${result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`}. Log: ${logFile}\n${result.tail.slice(-12).join("\n")}`);
    const log = await readFile(logFile, "utf8");
    const { realpathSync } = await import("node:fs");
    const wanted = realpathSync(info.dir);
    const entries = [...new Set([...log.matchAll(/^BSP-CP:([^|]*)\|(.+)$/gm)]
      .filter((m) => realpathSync(m[1]!) === wanted).map((m) => m[2]!.trim()))];
    directories = entries.filter((f) => !/\.jar$/i.test(f)).length;
    jars = [...new Set(entries.filter((f) => /\.jar$/i.test(f)))];
  } else {
    const win = process.platform === "win32";
    const command = mavenCandidates(root, process.env.PATH ?? "").find(existsSync);
    if (!command) return fail(`No Maven wrapper (mvnw) or mvn executable found in PATH for ${root}.`);
    const output = path.join(work, `maven-classpath-${process.pid}-${Date.now()}.txt`);
    await rm(output, { force: true });
    try {
    const result = await runProcess({ command, args: ["-B", "-ntp", ...(services.config.offline ? ["-o"] : []), "-f", path.join(info.dir, "pom.xml"), "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath", "-DincludeScope=compile", `-Dmdep.outputFile=${output}`], cwd: root, env: javaEnv, timeoutMs: 20 * 60_000, logFile, tailLines: 80 });
    if (result.exitCode !== 0 || result.timedOut) return fail(`Maven classpath resolution ${result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`}. The dependency plugin may need to be downloaded. Log: ${logFile}\n${result.tail.slice(-12).join("\n")}`);
    const classpath = await readFile(output, "utf8").catch(() => "");
    if (!existsSync(output)) return fail(`Maven completed but produced no classpath file. Log: ${logFile}`);
    jars = [...new Set(classpath.trim().split(win ? ";" : path.delimiter).filter((f) => /\.jar$/i.test(f)))];
    } finally { await rm(output, { force: true }); }
  }
  jars.sort((x, y) => x.localeCompare(y));
  const offset = a.offset ?? 0;
  const limit = a.limit ?? 100;
  const entries = jars.slice(offset, offset + limit).map((jarPath) => ({ jarPath, ...(sourceJarFor(jarPath) ? { sourcesJarPath: sourceJarFor(jarPath) } : {}) }));
  return ok(`Resolved ${jars.length} JAR(s) from ${info.platform} ${info.mcVersion}'s compile classpath${directories ? ` and ${directories} class director${directories === 1 ? "y" : "ies"}` : ""}. Use a returned jarPath with inspect_code_archive, search_code_archive, or get_code_archive_class.${jars.length > offset + limit ? ` More remain; call again with offset=${offset + limit}.` : ""}`, {
    projectDir: info.dir,
    entries,
    total: jars.length,
    offset,
    limit,
    ...(directories ? { classDirectories: directories } : {}),
  });
}
