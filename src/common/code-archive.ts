import AdmZip from "adm-zip";
import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { readdir, stat, rm } from "node:fs/promises";

const digests = new Map<string, { stamp: string; value: Promise<string> }>();

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;
const MAX_CLASSES = 60_000;
const DESCRIPTORS = ["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "plugin.yml", "paper-plugin.yml", "META-INF/MANIFEST.MF", "META-INF/jarjar/metadata.json"];

export interface CodeArchiveSummary {
  file: string;
  sizeBytes: number;
  classCount: number;
  packageCount: number;
  nestedJarCount: number;
  sourcesJar?: string;
  descriptors: { file: string; text: string }[];
}

export function validatedCodeArchive(file: string): AdmZip {
  const fileStat = statSync(file);
  if (!fileStat.isFile()) throw new Error(`Archive path is not a regular file: ${file}`);
  const size = fileStat.size;
  if (size > MAX_FILE_BYTES) throw new Error(`Archive is too large (${size} bytes; limit ${MAX_FILE_BYTES}).`);
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error(`Archive has too many entries (${entries.length}; limit ${MAX_ENTRIES}).`);
  let total = 0;
  let classes = 0;
  for (const entry of entries) {
    const bytes = entry.header.size;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ENTRY_BYTES) throw new Error(`Archive entry is too large: ${entry.entryName} (${bytes} bytes).`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error(`Archive expands beyond the ${MAX_TOTAL_BYTES}-byte limit.`);
    if (entry.entryName.endsWith(".class") && !entry.entryName.startsWith("META-INF/")) classes++;
  }
  if (classes > MAX_CLASSES) throw new Error(`Archive has too many class entries (${classes}; limit ${MAX_CLASSES}).`);
  return zip;
}

export function resolveSourcesArchive(binary: string, explicit?: string): string | undefined {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (path.resolve(binary) === resolved) throw new Error("The sources archive must differ from the binary archive.");
    validatedCodeArchive(resolved);
    return resolved;
  }
  const candidate = binary.replace(/\.jar$/i, "-sources.jar");
  try {
    validatedCodeArchive(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

export async function codeArchiveCacheKey(binary: string, sources?: string): Promise<string> {
  const digest = async (file: string) => {
    const resolved = path.resolve(file);
    const s = statSync(resolved);
    const stamp = `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`;
    const cached = digests.get(resolved);
    if (cached?.stamp === stamp) return cached.value;
    const value = (async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
    })();
    digests.set(resolved, { stamp, value });
    if (digests.size > 128) digests.delete(digests.keys().next().value!);
    try { return await value; } catch (e) { digests.delete(resolved); throw e; }
  };
  return createHash("sha256").update(JSON.stringify({ binaryPath: path.resolve(binary), binary: await digest(binary), sourcesPath: sources ? path.resolve(sources) : undefined, sources: sources ? await digest(sources) : undefined })).digest("hex").slice(0, 32);
}

/** Bound archive indexes on disk; never remove an index held by this server. */
export async function trimArchiveCache(root: string, protectedDirs: string[], maximum = 32): Promise<void> {
  const protectedSet = new Set(protectedDirs.map((p) => path.resolve(p)));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(entries.filter((e) => e.isDirectory() && /^[a-f0-9]{32}$/.test(e.name)).map(async (e) => {
    const dir = path.resolve(root, e.name);
    const info = await stat(dir).catch(() => undefined);
    return { dir, modified: info?.mtimeMs ?? 0 };
  }));
  candidates.sort((a, b) => b.modified - a.modified);
  let remaining = candidates.length;
  for (const item of candidates.reverse()) {
    if (remaining <= maximum) break;
    if (protectedSet.has(item.dir) || Date.now() - item.modified < 86_400_000) continue;
    await rm(item.dir, { recursive: true, force: true });
    remaining--;
  }
}

export function summarizeCodeArchive(file: string, zip: AdmZip, classCount: number, sourcesJar?: string): CodeArchiveSummary {
  const classes = zip.getEntries().filter((e) => e.entryName.endsWith(".class") && !e.entryName.startsWith("META-INF/")).map((e) => e.entryName.slice(0, -6));
  const packages = new Set(classes.map((name) => name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ""));
  const descriptors: CodeArchiveSummary["descriptors"] = [];
  const extras = zip.getEntries().map((e) => e.entryName).filter((name) => /(?:^|\/)\S*mixins?\.json$/.test(name) || /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.(?:properties|xml)$/.test(name));
  for (const name of [...new Set([...DESCRIPTORS, ...extras])].slice(0, 32)) {
    const entry = zip.getEntry(name);
    if (!entry || entry.header.size > 64 * 1024) continue;
    descriptors.push({ file: name, text: entry.getData().toString("utf8").slice(0, 4000) });
  }
  return {
    file: path.basename(file), sizeBytes: statSync(file).size, classCount, packageCount: packages.size,
    nestedJarCount: zip.getEntries().filter((e) => e.entryName.toLowerCase().endsWith(".jar")).length,
    ...(sourcesJar ? { sourcesJar: path.basename(sourcesJar) } : {}), descriptors,
  };
}
