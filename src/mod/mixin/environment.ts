import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectInfo } from "../project/info.js";
import type { Services } from "../services.js";
import { runGradle } from "../tools/gradle.js";

export type EvidenceState = "confirmed" | "missing" | "unknown";
export interface Evidence { state: EvidenceState; sources: string[] }
export interface MixinEnvironment {
  registrations: Record<string, Evidence>;
  compileExtras: Evidence;
  runtimeExtras: Evidence;
  notes: string[];
}

export interface GradleMixinData {
  projectPath: string;
  manifest: Record<string, string> | null;
  resources: string[];
  compile: string[] | null;
  runtime: string[] | null;
}

// Query evaluated tasks and source sets rather than interpreting Kotlin/Groovy build logic.
export const MIXIN_ENVIRONMENT_INIT = `
gradle.allprojects { p ->
    p.tasks.register("ffnPrintMixinEnvironment") {
        def resourcesTask = p.tasks.findByName("processResources")
        if (resourcesTask != null) dependsOn(resourcesTask)
        doLast {
            def sets = p.extensions.findByName("sourceSets")
            def main = sets?.findByName("main")
            def jar = p.tasks.findByName("jar")
            def files = { names ->
                def cfgs = names.collect { p.configurations.findByName(it) }.findAll { it != null && it.canBeResolved }
                cfgs.isEmpty() ? null : cfgs.collectMany { it.files }.collect { it.absolutePath }.unique()
            }
            def attrs = jar?.hasProperty("manifest") ? jar.manifest.effectiveManifest.attributes.collectEntries { k, v -> [(k.toString()): v.toString()] } : null
            println "FFN-MIXIN:" + groovy.json.JsonOutput.toJson([
                projectPath: p.path, manifest: attrs,
                resources: main?.output?.resourcesDir == null ? [] : [main.output.resourcesDir.absolutePath],
                compile: files(["compileClasspath", "clientCompileClasspath"]),
                runtime: files(["runtimeClasspath", "clientRuntimeClasspath"])
            ])
        }
    }
}
`;

const marker = "com/llamalad7/mixinextras/injector/wrapoperation/WrapOperation.class";

export function classpathExtras(files: string[] | null): Evidence {
  if (files === null) return { state: "unknown", sources: [] };
  const sources: string[] = [];
  let incomplete = false;
  const inspect = (zip: AdmZip, origin: string, depth: number) => {
    if (zip.getEntry(marker)) sources.push(`${origin}!/${marker}`);
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.startsWith("META-INF/jars/") || !entry.entryName.endsWith(".jar")) continue;
      if (depth >= 3) { incomplete = true; continue; }
      inspect(new AdmZip(entry.getData()), `${origin}!/${entry.entryName}`, depth + 1);
    }
  };
  for (const file of files) {
    try {
      if (!existsSync(file)) { incomplete = true; continue; }
      if (file.endsWith(".jar")) inspect(new AdmZip(file), file, 0);
      else if (existsSync(path.join(file, marker))) sources.push(path.join(file, marker));
    } catch { incomplete = true; }
  }
  return { state: sources.length ? "confirmed" : incomplete ? "unknown" : "missing", sources };
}

type RegistrationKind = "manifest" | "mods.toml" | "fabric.mod.json";

export async function inspectMixinEnvironment(project: ProjectInfo, data: GradleMixinData, registrationKind?: RegistrationKind): Promise<MixinEnvironment> {
  if (data.projectPath !== (project.gradlePath ?? ":")) throw new Error(`Expected module ${project.gradlePath ?? ":"}, received ${data.projectPath}.`);
  const registered = new Map<string, string[]>();
  const add = (name: string, source: string) => registered.set(name, [...(registered.get(name) ?? []), source]);
  const kind = registrationKind ?? (project.loader === "fabric" ? "fabric.mod.json" : project.loader === "neoforge" ? "mods.toml" : "manifest");
  const manifest = Object.entries(data.manifest ?? {}).find(([key]) => key.toLowerCase() === "mixinconfigs")?.[1];
  if (kind === "manifest" && manifest) for (const name of manifest.split(",").map((s) => s.trim()).filter(Boolean)) add(name, `${data.projectPath}:jar.manifest.MixinConfigs`);
  let metadataKnown = kind === "manifest" && data.manifest !== null && project.platform !== "common";
  const notes: string[] = [];
  for (const dir of data.resources) {
    if (kind === "fabric.mod.json") {
      const file = path.join(dir, "fabric.mod.json");
      if (!existsSync(file)) continue;
      const json = JSON.parse(await readFile(file, "utf8")) as { mixins?: (string | { config: string })[] };
      metadataKnown = true;
      for (const item of json.mixins ?? []) add(typeof item === "string" ? item : item.config, file);
    } else if (kind === "mods.toml") {
      for (const name of ["neoforge.mods.toml", "mods.toml"]) {
        const file = path.join(dir, "META-INF", name);
        if (!existsSync(file)) continue;
        metadataKnown = true;
        const text = (await readFile(file, "utf8")).replace(/^\s*#.*$/gm, "");
        for (const section of text.split(/(?=^\s*\[)/m).filter((s) => /^\s*\[\[mixins\]\]/.test(s))) {
          const config = /^\s*config\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
          if (config) add(config, file);
        }
      }
    }
  }
  if (!metadataKnown) notes.push(`Processed loader metadata unavailable for ${data.projectPath}; registration cannot be confirmed.`);
  const registrations = Object.fromEntries(project.mixinConfigs.map((file) => {
    const name = path.basename(file);
    const sources = registered.get(name) ?? [];
    return [name, { state: sources.length ? "confirmed" : metadataKnown ? "missing" : "unknown", sources } satisfies Evidence];
  }));
  return { registrations, compileExtras: classpathExtras(data.compile), runtimeExtras: project.platform === "common" ? { state: "unknown", sources: [] } : classpathExtras(data.runtime), notes };
}

export async function resolveMixinEnvironment(services: Services, project: ProjectInfo, registrationKind?: RegistrationKind): Promise<MixinEnvironment> {
  const root = project.rootDir ?? project.dir;
  const cache = path.join(root, ".ffn");
  await mkdir(cache, { recursive: true });
  const temp = await mkdtemp(path.join(cache, "mixin-environment-"));
  try {
    const init = path.join(temp, "init.gradle");
    await writeFile(init, MIXIN_ENVIRONMENT_INIT);
    const task = `${project.gradlePath === ":" || !project.gradlePath ? "" : project.gradlePath}:ffnPrintMixinEnvironment`;
    const run = await runGradle(services, { projectDir: project.dir, tasks: [task], args: ["--init-script", init, "--no-configuration-cache", "-q"], timeoutSec: 180, daemon: true, logName: "mixin-environment" });
    if ("error" in run) throw new Error(run.error);
    if (run.result.exitCode !== 0) throw new Error(`${run.diagnosis.summary} (log: ${run.result.logFile})`);
    const text = await readFile(run.result.logFile, "utf8");
    const line = /^FFN-MIXIN:(.+)$/m.exec(text)?.[1];
    if (!line) throw new Error("Gradle returned no mixin environment.");
    return await inspectMixinEnvironment(project, JSON.parse(line) as GradleMixinData, registrationKind);
  } catch (e) {
    return {
      registrations: {}, compileExtras: { state: "unknown", sources: [] }, runtimeExtras: { state: "unknown", sources: [] },
      notes: [`Could not inspect evaluated Gradle mixin environment: ${(e as Error).message}`],
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
