import path from "node:path";
import type AdmZip from "adm-zip";

const MAX_SERVER_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ENTRY_BYTES = 384 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_NESTED_JARS = 512;
const MAX_NESTED_JAR_BYTES = 512 * 1024 * 1024;

export function validateServerArchiveSize(compressedBytes: number): void {
  if (compressedBytes > MAX_SERVER_ARCHIVE_BYTES) throw new Error(`Server archive is too large (${compressedBytes} bytes; maximum ${MAX_SERVER_ARCHIVE_BYTES}).`);
}

/** Reject oversized ZIP metadata before decompressing entries through AdmZip. */
export function validateServerArchive(zip: AdmZip, compressedBytes: number): void {
  validateServerArchiveSize(compressedBytes);
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`Server archive has too many entries (${entries.length}; maximum ${MAX_ARCHIVE_ENTRIES}).`);
  let total = 0;
  for (const entry of entries) {
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) throw new Error(`Server archive entry is too large: ${entry.entryName} (${size} bytes).`);
    total += size;
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error(`Server archive expands beyond the ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte limit.`);
  }
}

/** Validate selected nested server/API archives before extraction. */
export function validateNestedArchives(entries: readonly AdmZip.IZipEntry[]): void {
  if (entries.length > MAX_NESTED_JARS) throw new Error(`Server archive contains too many nested JARs (${entries.length}; maximum ${MAX_NESTED_JARS}).`);
  let total = 0;
  for (const entry of entries) {
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) throw new Error(`Nested JAR is too large: ${entry.entryName} (${size} bytes).`);
    total += size;
    if (total > MAX_NESTED_JAR_BYTES) throw new Error(`Nested JARs expand beyond the ${MAX_NESTED_JAR_BYTES}-byte extraction limit.`);
  }
}

/** Resolve an archive entry beneath the extraction root, rejecting cross-platform traversal forms. */
export function archiveOutputPath(root: string, entryName: string): string {
  const relative = entryName.replace(/^META-INF\//, "");
  const segments = relative.split("/");
  const badSegment = (part: string) => !part || part === "." || part === ".." || /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
  if (!entryName.startsWith("META-INF/") || !relative || /[\\:\0]/.test(relative) || path.posix.isAbsolute(relative) || segments.some(badSegment)) {
    throw new Error(`Unsafe archive entry path: ${entryName}`);
  }
  const base = path.resolve(root);
  const destination = path.resolve(base, relative);
  const fromBase = path.relative(base, destination);
  if (!fromBase || fromBase === ".." || fromBase.startsWith(`..${path.sep}`) || path.isAbsolute(fromBase)) {
    throw new Error(`Unsafe archive entry path: ${entryName}`);
  }
  return destination;
}
