import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { RegexMatcher } from "../../common/regex.js";
import { readProjectInfo } from "../project/info.js";
import { fail, okText, page } from "./result.js";
import { getProjectSourceInput, inspectProjectInput, projectSourceSearchInput } from "./schemas.js";
import { z } from "zod";

type Inspect = z.infer<z.ZodObject<typeof inspectProjectInput>>;
type Search = z.infer<z.ZodObject<typeof projectSourceSearchInput>>;
type Source = z.infer<z.ZodObject<typeof getProjectSourceInput>>;

const rootsOf = (project: Awaited<ReturnType<typeof readProjectInfo>>) => [
  ...project.javaSourceRoots.map((dir) => ({ language: "java" as const, dir })),
  ...(project.kotlinSourceRoots ?? []).map((dir) => ({ language: "kotlin" as const, dir })),
];

export async function inspectModProject(_services: unknown, args: Inspect) {
  const project = await readProjectInfo(args.projectDir).catch((e: Error) => e);
  if (project instanceof Error) return fail(project.message);
  const roots = rootsOf(project);
  const languages = project.languages ?? ["java"];
  const lines = [
    `${project.loader} mod, Minecraft ${project.mcVersion}, ${project.mappings} mappings${project.modId ? `, mod id ${project.modId}` : ""}.`,
    `Languages: ${languages.join(" + ")}${project.kotlinPluginVersion ? ` (Kotlin Gradle plugin ${project.kotlinPluginVersion})` : languages.includes("kotlin") ? " (Kotlin plugin version not detected)" : ""}.`,
    `Source roots: ${roots.length ? roots.map((r) => `${r.language}: ${path.relative(project.rootDir ?? project.dir, r.dir).replace(/\\/g, "/")}`).join(", ") : "none found"}.`,
    `Build project: ${project.gradlePath ?? ":"} (${project.rootDir ?? project.dir}).`,
    languages.includes("kotlin") ? "Code-generation preference: use Kotlin for new source files in this project; preserve Java only when editing existing Java sources." : "Code-generation preference: use Java unless Kotlin is explicitly requested.",
  ];
  return okText(lines.join("\n"));
}

async function sourceFiles(root: string, out: string[], maxFiles: number): Promise<boolean> {
  if (out.length >= maxFiles || !existsSync(root)) return out.length < maxFiles;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (out.length >= maxFiles) return false;
    if (entry.name.startsWith(".") || ["build", "run", "node_modules", "generated"].includes(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!(await sourceFiles(file, out, maxFiles))) return false;
    } else if (/\.(?:java|kt)$/.test(entry.name)) out.push(file);
  }
  return true;
}

export async function projectSourceSearch(_services: unknown, args: Search) {
  const project = await readProjectInfo(args.projectDir).catch((e: Error) => e);
  if (project instanceof Error) return fail(project.message);
  const roots = rootsOf(project).filter((r) => !args.language || args.language === "all" || r.language === args.language);
  if (!roots.length) return okText(`No ${args.language === "kotlin" ? "Kotlin" : args.language === "java" ? "Java" : "Java/Kotlin"} source roots found in ${project.dir}.`);
  const files: string[] = [];
  let complete = true;
  for (const root of roots) if (!(await sourceFiles(root.dir, files, 5000))) { complete = false; break; }
  const isRegex = args.query.length > 2 && args.query.startsWith("/") && args.query.endsWith("/");
  const pattern = isRegex ? args.query.slice(1, -1) : args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegexMatcher(pattern, "i");
  const limit = args.limit ?? 30;
  const offset = args.offset ?? 0;
  const hits: { file: string; line: number; text: string }[] = [];
  let bytesRead = 0;
  try {
    searchFiles: for (const file of files) {
      const fileStat = await stat(file);
      if (fileStat.size > 32 * 1024 * 1024 - bytesRead) { complete = false; break; }
      const data = await readFile(file);
      bytesRead += data.byteLength;
      const lines = data.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && hits.length < offset + limit + 1; i += 512) {
        const batch = lines.slice(i, i + 512);
        const matches = await matcher.testMany(batch);
        for (let j = 0; j < batch.length && hits.length < offset + limit + 1; j++) if (matches[j]) {
          hits.push({ file: path.relative(project.rootDir ?? project.dir, file).replace(/\\/g, "/"), line: i + j + 1, text: batch[j]!.trim().slice(0, 240) });
        }
      }
      if (hits.length >= offset + limit + 1) break searchFiles;
    }
  } finally {
    await matcher.close();
  }
  const pg = page(hits, offset, limit);
  const lines = pg.items.map((h) => `${h.file}:${h.line}  ${h.text}`);
  const suffix = !complete ? " Search bounded after 5,000 files or 32 MiB of source." : "";
  return okText([`${pg.items.length} match(es) for ${isRegex ? `/${pattern}/i` : JSON.stringify(args.query)} (${project.loader}, ${roots.map((r) => r.language).filter((v, i, a) => a.indexOf(v) === i).join("+")})${pg.more ? ` — more: offset=${offset + limit}` : ""}.${suffix}`, ...lines].join("\n"));
}

export async function getProjectSource(_services: unknown, args: Source) {
  const project = await readProjectInfo(args.projectDir).catch((e: Error) => e);
  if (project instanceof Error) return fail(project.message);
  if (!/\.(?:java|kt)$/.test(args.file)) return fail("Only .java and .kt source files are supported.");
  const requested = path.resolve(project.rootDir ?? project.dir, args.file);
  const roots = rootsOf(project).map((r) => path.resolve(r.dir));
  let actual: string;
  try {
    actual = await realpath(requested);
  } catch {
    return fail(`Source file not found: ${args.file}`);
  }
  const inside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!roots.some((root) => inside(root, actual))) return fail("The file is outside detected Java/Kotlin source roots.");
  const fileStat = await stat(actual);
  if (fileStat.size > 8 * 1024 * 1024) return fail("Source file exceeds the 8 MiB read limit; use project_source_search or inspect a smaller file.");
  const content = await readFile(actual, "utf8");
  const lines = content.split("\n");
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 200;
  const end = Math.min(lines.length, offset + limit);
  const rel = path.relative(project.rootDir ?? project.dir, actual).replace(/\\/g, "/");
  return okText([`${rel}: lines ${offset + 1}-${end} of ${lines.length}${end < lines.length ? ` — more: offset=${end}` : ""}`, ...lines.slice(offset, end).map((line, i) => `${offset + i + 1}: ${line}`)].join("\n"));
}
