import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { clip, ok } from "./result.js";
import { projectFile } from "./verification.js";
import type { auditImplementationInput } from "./verification-schemas.js";

type Args = z.infer<z.ZodObject<typeof auditImplementationInput>>;
type Finding = { file: string; line: number; code: string; severity: "info" | "warning"; evidence: string; message: string };

const commentOrLiteral = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g;
const stub = /\{\s*(throw\s+(?:new\s+)?(?:java\.lang\.)?(?:UnsupportedOperationException|NotImplementedError)\s*\(\s*@?\s*\))\s*;?\s*}/g;
const kotlinTodo = /(?:^|[^\w.])(?:kotlin\.)?TODO\s*\(\s*@?\s*\)/g;
const emptyHandler = /@(?:org\.bukkit\.event\.|net\.(?:minecraftforge|neoforged)\.bus\.api\.)?(?:EventHandler|SubscribeEvent)\b(?:\s*\([^(){}]{0,250}\))?\s*(?:(?:public|private|protected|static|final|internal|override|open)\s+)*(?:void|fun)\s+[\w$]+\s*\([^(){}]{0,350}\)\s*(?::\s*Unit\s*)?\{\s*}/g;

function inspect(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  const lineStarts = [0, ...Array.from(text.matchAll(/\n/g), m => m.index + 1)];
  const record = (at: number, code: string, severity: Finding["severity"], message: string) => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid]! <= at) low = mid;
      else high = mid;
    }
    findings.push({ file, line: low + 1, code, severity, message, evidence: clip(lines[low]!.trim(), 240) });
  };
  const code = text.replace(commentOrLiteral, (match, offset: number) => {
    const comment = match.startsWith("//") || match.startsWith("/*");
    if (comment) for (const marker of match.matchAll(/\b(?:TODO|FIXME)\b/g)) {
      record(offset + marker.index, "comment_marker", "info", "Review whether this comment concerns an accepted requirement.");
    }
    return (comment ? "" : "@") + match.slice(comment ? 0 : 1).replace(/[^\r\n]/g, " ");
  });
  for (const match of code.matchAll(stub)) {
    record(match.index + match[0].indexOf(match[1]!), "unsupported_throw", "warning", "Block contains only an unsupported-operation throw. Confirm that this path should reject the operation.");
  }
  if (file.endsWith(".kt")) for (const match of code.matchAll(kotlinTodo)) {
    record(match.index + (match[0].startsWith("TODO") || match[0].startsWith("kotlin.") ? 0 : 1), "kotlin_todo", "warning", "TODO() usually throws at runtime. Check which callers reach it.");
  }
  for (const match of code.matchAll(emptyHandler)) {
    record(match.index + match[0].lastIndexOf("{"), "empty_event_handler", "warning", "Annotated event handler has an empty body. Check its intended role.");
  }
  return findings;
}

export async function auditImplementation(args: Args) {
  const root = await realpath(args.projectDir);
  const findings = new Map<string, Finding>();
  const unavailable: { file: string; reason: string }[] = [];
  const scanned = new Map<string, Finding[]>();
  for (const range of args.files) {
    const { file, fromLine = 1, toLine = Infinity } = range;
    try {
      if (!/\.(java|kt)$/.test(file)) throw new Error("Expected a Java or Kotlin source file.");
      const source = await projectFile(root, file);
      if (!scanned.has(source.file)) {
        if (source.info.size > 512 * 1024) throw new Error("Source file exceeds the 512 KiB limit.");
        const relative = path.relative(root, source.file).split(path.sep).join("/");
        scanned.set(source.file, inspect(relative, await readFile(source.file, "utf8")));
      }
      for (const finding of scanned.get(source.file)!) if (finding.line >= fromLine && finding.line <= toLine) {
        findings.set(`${finding.file}:${finding.line}:${finding.code}`, finding);
      }
    } catch (error) {
      unavailable.push({ file, reason: (error as Error).message });
    }
  }
  const ordered = [...findings.values()].sort((a, b) =>
    Number(b.severity === "warning") - Number(a.severity === "warning") || a.file.localeCompare(b.file) || a.line - b.line);
  const offset = args.offset ?? 0, limit = args.limit ?? 30;
  const data = {
    scannedFiles: scanned.size, unavailable, findings: ordered.slice(offset, offset + limit), total: ordered.length,
    nextOffset: offset + limit < ordered.length ? offset + limit : undefined,
    limitation: "Heuristic review of selected lines. Check intent and callers. No conclusions about registration, coverage, or runtime behavior.",
  };
  return { ...ok(`Found ${ordered.length} signal(s) in edited Java/Kotlin source. ${unavailable.length} selection(s) unavailable.`), structuredContent: data };
}
