import { readFile } from "node:fs/promises";
import path from "node:path";

export async function wrapperGradleVersion(root: string): Promise<string | undefined> {
  try {
    const text = await readFile(path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8");
    return /gradle-(\d+(?:\.\d+)+(?:-rc-\d+)?)-(?:bin|all)\.zip/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

export function gradleMaxJvm(version: string): number | undefined {
  const [major, minor = "0"] = (/^(\d+)(?:\.(\d+))?/.exec(version) ?? []).slice(1);
  if (!major || Number(major) > 9) return;
  const n = Number(major) * 100 + Number(minor);
  // https://docs.gradle.org/current/userguide/compatibility.html#java_runtime
  const introduced: [number, number][] = [[908, 27], [904, 26], [901, 25], [814, 24], [810, 23], [808, 22], [805, 21], [803, 20], [706, 19], [705, 18], [703, 17], [700, 16], [607, 15], [603, 14], [600, 13], [504, 12], [500, 11], [407, 10], [403, 9], [0, 8]];
  return introduced.find(([first]) => n >= first)?.[1];
}
