import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mavenRepository, stateDir } from "../common/project-state.js";

/** Root of the installed BSP package (contains profiles/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function defaultConfigHome(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export interface BspConfig {
  /** Built-in profiles shipped with BSP. */
  builtinProfilesDir: string;
  /** User profiles: override / extend built-ins without touching code. */
  userProfilesDir: string;
  cacheDir: string;
  /** TTL for mutable version indexes (manifests, maven-metadata). */
  cacheTtlMs: number;
  /** Never touch the network; serve from cache only. */
  offline: boolean;
  userAgent: string;
  /** Existing local Maven repository searched for prebuilt Spigot JARs. */
  mavenLocal: string;
  projectMavenLocal: string;
  /** Extra directories with BuildTools output jars (spigot-<mc>.jar). */
  buildToolsDirs: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): BspConfig {
  const ttlMin = Number(env.BSP_CACHE_TTL_MINUTES ?? "360");
  const root = projectRoot ?? env.MCT_WORKSPACE_DIR ?? process.cwd();
  return {
    builtinProfilesDir: path.join(PACKAGE_ROOT, "profiles", "plugin"),
    userProfilesDir: env.BSP_PROFILES_DIR ?? path.join(defaultConfigHome(), "bsp", "profiles"),
    cacheDir: (!projectRoot && env.BSP_CACHE_DIR) || path.join(stateDir(root), "plugin"),
    cacheTtlMs: (Number.isFinite(ttlMin) && ttlMin >= 0 ? ttlMin : 360) * 60_000,
    offline: env.BSP_OFFLINE === "1" || env.BSP_OFFLINE === "true",
    userAgent: env.BSP_USER_AGENT ?? "BSP-MCP/0.2 (Bukkit/Spigot/Paper plugin dev MCP server; +https://github.com/Xhiveee/bsp)",
    mavenLocal: env.BSP_MAVEN_LOCAL ?? path.join(os.homedir(), ".m2", "repository"),
    projectMavenLocal: mavenRepository(root),
    buildToolsDirs: (env.BSP_BUILDTOOLS_DIRS ?? "").split(path.delimiter).filter(Boolean),
  };
}
