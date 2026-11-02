import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Services } from "../services.js";
import { readProjectInfo } from "../project/info.js";
import { fail, ok } from "./result.js";
import { listProjectArtifactsInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof listProjectArtifactsInput>>;

export async function listProjectArtifacts(services: Services, a: A) {
  const project = await readProjectInfo(a.projectDir).catch((e: Error) => e);
  if (project instanceof Error) return fail(project.message);
  const files = await services.indexes.projectClasspath(project);
  const jars = [...new Set(files.filter((f) => /\.jar$/i.test(f)))].sort((x, y) => x.localeCompare(y));
  const offset = a.offset ?? 0;
  const limit = a.limit ?? 100;
  const items = jars.slice(offset, offset + limit).map((jarPath) => {
    const stem = jarPath.replace(/\.jar$/i, "");
    const candidates = [`${stem}-sources.jar`, `${stem.replace(/-merged$/i, "")}-sources.jar`];
    const sourcesJarPath = candidates.find(existsSync);
    return { jarPath, ...(sourcesJarPath ? { sourcesJarPath } : {}) };
  });
  const directoryCount = new Set(files.filter((f) => !/\.jar$/i.test(f))).size;
  return ok(`Resolved ${jars.length} JAR(s) from ${project.loader} ${project.mcVersion}'s compile classpath${directoryCount ? ` and ${directoryCount} class directory/directories` : ""}. Use a returned jarPath with inspect_code_archive, search_code_archive, or get_code_archive_class.${jars.length > offset + limit ? ` More remain; call again with offset=${offset + limit}.` : ""}`, {
    projectDir: path.resolve(a.projectDir),
    entries: items,
    total: jars.length,
    offset,
    limit,
    ...(directoryCount ? { classDirectories: directoryCount } : {}),
  });
}
