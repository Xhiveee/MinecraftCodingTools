import AdmZip from "adm-zip";
import { RegexMatcher } from "./regex.js";

export type SearchKind = "class" | "method" | "field" | "any";
export interface SearchClass {
  n: string;
  a: number;
  m: [string, string, number][];
  f: [string, string, number][];
}
export interface RegexSearchHit {
  kind: Exclude<SearchKind, "any">;
  owner: string;
  name: string;
  desc?: string;
  access: number;
}
export interface SourceHit { file: string; line: number; text: string }
export interface TextSearchIndex {
  grepSources(matcher: RegexMatcher, limit: number): Promise<SourceHit[] | undefined>;
  textCandidates(pattern: string): string[] | undefined;
  cachedSource(outer: string): Promise<string | undefined>;
}

/** Shared regex name search for the plugin and mod indexes. */
export async function searchIndexRegex(classes: Iterable<SearchClass>, query: string, kind: SearchKind, limit: number): Promise<RegexSearchHit[]> {
  const matcher = new RegexMatcher(query, "i");
  try {
    const rows: RegexSearchHit[] = [];
    for (const c of classes) {
      if (kind === "any" || kind === "class") rows.push({ kind: "class", owner: c.n, name: c.n, access: c.a });
      if (kind === "any" || kind === "method") for (const [name, desc, access] of c.m) if (!(access & 0x1000 && name.startsWith("lambda$"))) rows.push({ kind: "method", owner: c.n, name, desc, access });
      if (kind === "any" || kind === "field") for (const [name, desc, access] of c.f) rows.push({ kind: "field", owner: c.n, name, desc, access });
    }
    const matches = await matcher.testAll(rows.map((row) => row.name));
    const hits = rows.flatMap((row, i) => matches[i] ? [{ ...row, score: row.kind === "class" ? 1.5 : 1 }] : []);
    hits.sort((x, y) => y.score - x.score || x.owner.length - y.owner.length || x.owner.localeCompare(y.owner));
    return hits.slice(0, limit).map(({ score: _score, ...hit }) => hit);
  } finally {
    await matcher.close();
  }
}

/** Grep Java/Kotlin entries in a source archive using the bounded regex worker. */
export async function grepSourceZip(zip: AdmZip, matcher: RegexMatcher, limit: number): Promise<SourceHit[]> {
  const out: SourceHit[] = [];
  for (const entry of zip.getEntries()) {
    if (!/\.(?:java|kt)$/.test(entry.entryName)) continue;
    const lines = entry.getData().toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 512) {
      const batch = lines.slice(i, i + 512);
      const matches = await matcher.testMany(batch);
      for (let j = 0; j < batch.length; j++) if (matches[j]) {
        out.push({ file: entry.entryName, line: i + j + 1, text: batch[j]!.trim().slice(0, 240) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** Find likely classes using required regex literals before decompilation. */
export function sourceCandidates(zip: AdmZip, knownClasses: ReadonlySet<string>, pattern: string): string[] | undefined {
  const lit = regexLiterals(pattern);
  if (!lit) return undefined;
  const out = new Set<string>();
  for (const entry of zip.getEntries()) {
    const n = entry.entryName;
    if (!n.endsWith(".class") || n.startsWith("META-INF/")) continue;
    const cls = n.slice(0, -6);
    if (!knownClasses.has(cls)) continue;
    const text = entry.getData().toString("latin1").toLowerCase();
    if (lit.mode === "all" ? lit.tokens.every((t) => text.includes(t)) : lit.tokens.some((t) => text.includes(t))) out.add(cls.split("$")[0]!);
  }
  return [...out].sort();
}

/** Identifier-like literal words (>= 3 chars) required by a regex, for safe candidate prefiltering. */
export function regexLiterals(src: string): { mode: "all" | "any"; tokens: string[] } | undefined {
  const cleaned = src
    .replace(/\\[dDwWsSbBnrtfv]/g, " ")
    .replace(/\[(?:\\.|[^\]])*\]/g, " ")
    .replace(/\{\d+(?:,\d*)?\}/g, " ")
    .replace(/\(\?[:=!<]+/g, " ");
  const tokenize = (s: string) => (s.replace(/\\(.)/g, " $1 ").match(/[A-Za-z_$][\w$]*/g) ?? []).filter((t) => t.length >= 3).map((t) => t.toLowerCase());
  if (/(^|[^\\])\|/.test(cleaned)) {
    const branches = cleaned.split(/(?<!\\)\|/).map(tokenize);
    if (branches.some((b) => !b.length)) return undefined;
    return { mode: "any", tokens: [...new Set(branches.map((b) => b.sort((x, y) => y.length - x.length)[0]!))] };
  }
  const required = cleaned.replace(/[A-Za-z_$][\w$]*[?*]|\([^()]*\)[?*]/g, " ");
  const tokens = [...new Set(tokenize(required))];
  return tokens.length ? { mode: "all", tokens } : undefined;
}

/** Shared bounded scan/decompile loop for plugin and mod text searches. */
export async function searchSourceText(index: TextSearchIndex, matcher: RegexMatcher, offset: number, limit: number, decompileMany: (outers: string[]) => Promise<Map<string, string>>) {
  const hits = await index.grepSources(matcher, offset + limit + 1);
  if (hits) return { hits, origin: "sources jar" };
  const candidates = index.textCandidates(matcher.pattern);
  if (!candidates) return { hits: [], origin: "no sources jar, and the regex has no literal word (3+ letters) to preselect classes for decompilation — add one, e.g. a method or field name" };
  const out: SourceHit[] = [];
  let decompiled = 0;
  let scanned = 0;
  const grep = async (outer: string, text: string) => {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && out.length < offset + limit + 1; i += 512) {
      const batch = lines.slice(i, i + 512);
      const matches = await matcher.testMany(batch);
      for (let j = 0; j < batch.length && out.length < offset + limit + 1; j++) if (matches[j]) out.push({ file: `${outer}.java`, line: i + j + 1, text: batch[j]!.trim().slice(0, 240) });
    }
  };
  const fresh = new Map<string, string>();
  for (let k = 0; k < candidates.length && out.length < offset + limit + 1; k++) {
    const outer = candidates[k]!;
    let text = fresh.get(outer) ?? (await index.cachedSource(outer));
    if (text === undefined) {
      if (decompiled >= 40) break;
      const batch: string[] = [];
      for (let j = k; j < candidates.length && batch.length < Math.min(20, 40 - decompiled); j++) if ((await index.cachedSource(candidates[j]!)) === undefined) batch.push(candidates[j]!);
      const result = await decompileMany(batch);
      decompiled += batch.length;
      for (const [name, source] of result) fresh.set(name, source);
      text = result.get(outer) ?? "";
    }
    await grep(outer, text);
    scanned = k + 1;
  }
  const rest = candidates.length - scanned;
  return {
    hits: out,
    origin: `decompiled (Vineflower, cached): ${scanned}/${candidates.length} candidate classes scanned${decompiled ? `, ${decompiled} decompiled now` : ""}${rest > 0 && out.length <= offset + limit ? ` — ${rest} not scanned yet: call again to continue` : ""}`,
  };
}
