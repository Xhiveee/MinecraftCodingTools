import YAML from "yaml";
import { validatedCodeArchive } from "./code-archive.js";

export function readPluginArchive(file: string) {
  const zip = validatedCodeArchive(file);
  // Paper gives its native descriptor precedence when both descriptors are present.
  const entry = zip.getEntry("paper-plugin.yml") ?? zip.getEntry("plugin.yml");
  if (!entry || entry.header.size > 64 * 1024) throw new Error("Expected a built JAR with a root plugin.yml or paper-plugin.yml up to 64 KiB.");
  const metadata = YAML.parse(entry.getData().toString("utf8")) as Record<string, unknown> | null;
  const name = metadata?.name;
  const version = metadata?.version;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid plugin name in ${entry.entryName}.`);
  if (typeof version !== "string" || !version.trim() || /[\r\n]|\$\{|@\w+@/.test(version)) throw new Error(`Expected a processed version in ${entry.entryName}.`);
  for (const key of ["main", "bootstrapper", "loader"]) {
    if (key !== "main" && (entry.entryName !== "paper-plugin.yml" || metadata?.[key] === undefined)) continue;
    const cls = metadata?.[key];
    if (typeof cls !== "string" || !/^[\w$]+(?:\.[\w$]+)*$/.test(cls)) throw new Error(`Invalid ${key} in ${entry.entryName}.`);
    if (!zip.getEntry(cls.replaceAll(".", "/") + ".class")) throw new Error(`${entry.entryName} declares ${key} ${cls}, whose class file is absent from the JAR.`);
  }
  return { name, version, descriptor: entry.entryName, metadata: metadata! };
}
