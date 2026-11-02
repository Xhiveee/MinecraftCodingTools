import { z } from "zod";
import { RegexMatcher } from "./regex.js";
import { searchSourceText } from "./source-search.js";
import { fail, ok, okText, page } from "./result.js";
import type { inspectCodeArchiveInput, searchCodeArchiveInput, getCodeArchiveClassInput } from "./code-archive-schemas.js";
import type { CodeArchiveSummary } from "./code-archive.js";

type Inspect = z.infer<z.ZodObject<typeof inspectCodeArchiveInput>>;
type Search = z.infer<z.ZodObject<typeof searchCodeArchiveInput>>;
type ReadClass = z.infer<z.ZodObject<typeof getCodeArchiveClassInput>>;
type Kind = "any" | "class" | "method" | "field";

export interface CodeArchiveIndex {
  meta: { jar: string; sourcesJar?: string; classCount: number; namespace: string };
  classes: Map<string, { n: string; a: number; f: [string, string, number][]; m: [string, string, number][] }>;
  resolve(name: string): string[];
  get(name: string): { n: string; a: number; s?: string; i: string[]; f: [string, string, number][]; m: [string, string, number][] } | undefined;
  search(query: string, kind: Kind, limit: number): { kind: "class" | "method" | "field"; owner: string; name: string; desc?: string; access: number }[];
  searchRegex(query: string, kind: Kind, limit: number): Promise<{ kind: "class" | "method" | "field"; owner: string; name: string; desc?: string; access: number }[]>;
  source(name: string, decompile: (outer: string) => Promise<string | undefined>): Promise<{ text: string; origin: string } | undefined>;
  grepSources(matcher: RegexMatcher, limit: number): Promise<{ file: string; line: number; text: string }[] | undefined>;
  textCandidates(pattern: string | RegExp): string[] | undefined;
  cachedSource(outer: string): Promise<string | undefined>;
  storeSource(outer: string, text: string): Promise<void>;
}

export interface CodeArchiveAdapter<I extends CodeArchiveIndex> {
  open(file: string, sourcesJar?: string): Promise<{ index: I; summary: CodeArchiveSummary }>;
  decompileMany(index: I, outers: string[]): Promise<Map<string, string>>;
  usages(index: I, owner: string, member?: { kind: "method" | "field"; name: string; desc?: string }): Promise<{ cls: string; method?: string; how: string; via?: string }[]>;
  callees(index: I, owner: string, name: string, desc: string): { how: string; owner: string; name: string; desc: string; inLambda?: boolean }[] | undefined;
}

const dotted = (name: string) => name.replace(/\//g, ".");
const PRIMITIVES: Record<string, string> = { V: "void", Z: "boolean", B: "byte", C: "char", S: "short", I: "int", J: "long", F: "float", D: "double" };
function typeAt(desc: string, at: number): { type: string; next: number } {
  let arrays = 0;
  while (desc[at] === "[") { arrays++; at++; }
  const c = desc[at];
  let type: string;
  let next = at + 1;
  if (c === "L") {
    const end = desc.indexOf(";", at);
    if (end < 0) return { type: desc, next: desc.length };
    type = dotted(desc.slice(at + 1, end));
    next = end + 1;
  } else type = c ? PRIMITIVES[c] ?? c : "?";
  return { type: `${type}${"[]".repeat(arrays)}`, next };
}
function javaSignature(desc: string): string {
  if (!desc.startsWith("(")) return typeAt(desc, 0).type;
  const params: string[] = [];
  let i = 1;
  while (i < desc.length && desc[i] !== ")") { const p = typeAt(desc, i); params.push(p.type); i = p.next; }
  return `(${params.join(", ")})${typeAt(desc, i + 1).type}`;
}
function accessLabel(access: number): string {
  return [access & 0x1 ? "public" : access & 0x2 ? "private" : access & 0x4 ? "protected" : "", access & 0x8 ? "static" : "", access & 0x10 ? "final" : "", access & 0x400 ? "abstract" : ""].filter(Boolean).join(" ");
}

export async function inspectCodeArchive<I extends CodeArchiveIndex>(a: Inspect, adapter: CodeArchiveAdapter<I>) {
  const { summary, index } = await adapter.open(a.jarPath, a.sourcesJarPath);
  const packages = new Map<string, number>();
  for (const name of index.classes.keys()) {
    const pkg = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "(root)";
    packages.set(pkg, (packages.get(pkg) ?? 0) + 1);
  }
  const popular = [...packages].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 25).map(([name, count]) => ({ package: dotted(name), classes: count }));
  return ok(`Indexed ${summary.file}: ${summary.classCount} classes across ${summary.packageCount} packages.${summary.sourcesJar ? ` Sources: ${summary.sourcesJar}.` : " No sources jar found; Vineflower can decompile classes on demand."}`, { ...summary, packages: popular });
}

export async function searchCodeArchive<I extends CodeArchiveIndex>(a: Search, adapter: CodeArchiveAdapter<I>) {
  const { index, summary } = await adapter.open(a.jarPath, a.sourcesJarPath);
  const limit = a.limit ?? 30;
  const offset = a.offset ?? 0;
  if (a.kind === "usages" || a.kind === "callees") {
    const hash = a.query.indexOf("#");
    const ownerQuery = (hash < 0 ? a.query : a.query.slice(0, hash)).trim();
    const selector = hash < 0 ? "" : a.query.slice(hash + 1).trim();
    const resolved = index.resolve(ownerQuery);
    if (resolved.length !== 1) return fail(resolved.length ? `Class is ambiguous: ${resolved.map(dotted).join(", ")}. Use the fully qualified name.` : `Class ${ownerQuery} not found in ${summary.file}.`);
    const owner = resolved[0]!;
    if (a.kind === "usages") {
      let member: { kind: "method" | "field"; name: string; desc?: string } | undefined;
      if (selector) {
        const f = /^([^(:]+):(.+)$/.exec(selector);
        const m = /^([^(:]+)(\(.*)?$/.exec(selector);
        const name = f?.[1] ?? m?.[1] ?? selector;
        const desc = f?.[2] ?? m?.[2];
        const cls = index.get(owner)!;
        const fieldOnly = cls.f.some(([n]) => n === name) && !cls.m.some(([n]) => n === name);
        member = { kind: f || fieldOnly ? "field" : "method", name, ...(desc ? { desc } : {}) };
        if (!cls[member.kind === "field" ? "f" : "m"].some(([n, d]) => n === name && (!desc || d === desc))) return fail(`${dotted(owner)} has no ${member.kind} ${selector}.`);
      }
      const hits = await adapter.usages(index, owner, member);
      const lines = hits.slice(offset, offset + limit).map((x) => `${dotted(x.cls)}${x.method ? `#${x.method}` : ""}  ${x.how}${x.via ? ` via ${dotted(x.via)}` : ""}`);
      return okText([`${hits.length} usage(s) of ${dotted(owner)}${selector ? `#${selector}` : ""} in ${summary.file}${hits.length > offset + limit ? ` — offset=${offset + limit}` : ""}.`, ...lines].join("\n"));
    }
    const m = /^([^(:]+)(\(.*)?$/.exec(selector);
    if (!m) return fail("callees query must be Class#method or Class#method(descriptor).");
    const candidates = index.get(owner)!.m.filter(([name, desc]) => name === m[1] && (!m[2] || desc === m[2]));
    if (!candidates.length) return fail(`${dotted(owner)} has no method ${selector}.`);
    const lines: string[] = [];
    for (const [name, desc] of candidates.slice(0, 5)) {
      if (candidates.length > 1) lines.push(`${name}${desc}:`);
      lines.push(...(adapter.callees(index, owner, name, desc) ?? []).map((x) => `  ${x.how.padEnd(4)} ${dotted(x.owner)}#${x.name}${x.desc}${x.inLambda ? " (lambda)" : ""}`));
    }
    const pg = page(lines, offset, limit);
    return okText([`Callees of ${dotted(owner)}#${selector} in ${summary.file}${pg.more ? ` — ${pg.more}` : ""}.`, ...pg.items].join("\n"));
  }
  if (a.kind === "text") {
    const query = a.query.length > 2 && a.query.startsWith("/") && a.query.endsWith("/") ? a.query.slice(1, -1) : a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegexMatcher(query, "i");
    try {
      const result = await searchSourceText(index, matcher, offset, limit, (outers) => adapter.decompileMany(index, outers));
      const pg = page(result.hits, offset, limit);
      const lines = pg.items.map((h) => `${h.file}:${h.line}  ${h.text}`);
      return okText([`${pg.items.length} source match(es) in ${summary.file} (${result.origin})${pg.more ? ` — offset=${offset + limit}` : ""}.`, ...lines].join("\n"));
    } finally {
      await matcher.close();
    }
  }
  const regex = a.query.length > 2 && a.query.startsWith("/") && a.query.endsWith("/");
  const kind = (a.kind ?? "any") as Kind;
  const hits = regex ? await index.searchRegex(a.query.slice(1, -1), kind, offset + limit + 1) : index.search(a.query, kind, offset + limit + 1);
  const pg = page(hits, offset, limit);
  const lines = pg.items.map((h) => h.kind === "class" ? `class  ${dotted(h.name)}` : `${h.kind.padEnd(6)} ${dotted(h.owner)}#${h.name}${h.desc ?? ""}`);
  return okText([`${pg.items.length} match(es) in ${summary.file} for ${JSON.stringify(a.query)}${pg.more ? ` — offset=${offset + limit}` : ""}.`, ...lines].join("\n"));
}

export async function getCodeArchiveClass<I extends CodeArchiveIndex>(a: ReadClass, adapter: CodeArchiveAdapter<I>) {
  const { index, summary } = await adapter.open(a.jarPath, a.sourcesJarPath);
  const found = index.resolve(a.className);
  if (found.length !== 1) return fail(found.length ? `Class name is ambiguous: ${found.map(dotted).join(", ")}. Use a fully qualified name.` : `Class ${a.className} not found in ${summary.file}.`);
  const name = found[0]!;
  const cls = index.get(name)!;
  const header = `${cls.a & 0x200 ? "interface" : cls.a & 0x4000 ? "enum" : "class"} ${dotted(name)}${cls.s && cls.s !== "java/lang/Object" ? ` extends ${dotted(cls.s)}` : ""}${cls.i.length ? ` implements ${cls.i.map(dotted).join(", ")}` : ""} — ${cls.f.length} field(s), ${cls.m.length} method(s) in ${summary.file}`;
  if (a.mode === "outline") {
    const members = [
      ...cls.f.filter(([, , access]) => !(access & 0x1000)).map(([n, d, access]) => `${accessLabel(access)} ${javaSignature(d)} ${n}  [${d}]`.trim()),
      ...cls.m.filter(([, , access]) => !(access & 0x1000)).map(([n, d, access]) => `${accessLabel(access)} ${n}${javaSignature(d)}  [${d}]`.trim()),
    ];
    const pg = page(members, a.offset ?? 0, a.limit ?? 200);
    return okText([header, ...pg.items, ...(pg.more ? [`… ${pg.more}`] : [])].join("\n"));
  }
  const source = await index.source(name, async (outer) => (await adapter.decompileMany(index, [outer])).get(outer));
  if (!source) return fail(`No source or decompilation result for ${dotted(name)} in ${summary.file}.`);
  const lines = source.text.split("\n");
  const offset = a.offset ?? 0;
  const limit = a.limit ?? 200;
  const end = Math.min(lines.length, offset + limit);
  return okText([`${header}; ${source.origin}; lines ${offset + 1}-${end} of ${lines.length}${end < lines.length ? ` — offset=${end}` : ""}.`, ...lines.slice(offset, end).map((line, i) => `${offset + i + 1}: ${line}`)].join("\n"));
}
