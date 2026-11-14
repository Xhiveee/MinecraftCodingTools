import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../common/project-state.js";

/** Root of the installed FFN package (contains profiles/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function defaultConfigHome(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export interface FfnConfig {
  /** Built-in profiles shipped with FFN. */
  builtinProfilesDir: string;
  /** User profiles: override / extend built-ins without touching code. */
  userProfilesDir: string;
  cacheDir: string;
  /** Default TTL for mutable version indexes (manifests, maven-metadata). */
  cacheTtlMs: number;
  /** Never touch the network; serve from cache only. */
  offline: boolean;
  userAgent: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): FfnConfig {
  const ttlMin = Number(env.FFN_CACHE_TTL_MINUTES ?? "360");
  return {
    builtinProfilesDir: path.join(PACKAGE_ROOT, "profiles", "mod"),
    userProfilesDir: env.FFN_PROFILES_DIR ?? path.join(defaultConfigHome(), "ffn", "profiles"),
    cacheDir: (!projectRoot && env.FFN_CACHE_DIR) || path.join(stateDir(projectRoot ?? env.MCT_WORKSPACE_DIR ?? process.cwd()), "mod"),
    cacheTtlMs: (Number.isFinite(ttlMin) && ttlMin >= 0 ? ttlMin : 360) * 60_000,
    offline: env.FFN_OFFLINE === "1" || env.FFN_OFFLINE === "true",
    // Some hosts (e.g. maven.minecraftforge.net) reject generic/blank user agents.
    userAgent: env.FFN_USER_AGENT ?? "FFN-MCP/0.8 (Minecraft modding MCP server; +https://github.com/)",
  };
}
