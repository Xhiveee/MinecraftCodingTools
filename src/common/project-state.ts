import path from "node:path";
import { mkdir } from "node:fs/promises";

export function stateDir(root: string) {
  return path.resolve(root, ".mct");
}

function mavenHome(root: string) {
  return path.join(stateDir(root), "maven");
}

export function mavenRepository(root: string) {
  return path.join(mavenHome(root), "repository");
}

async function tempEnv(root: string, env: NodeJS.ProcessEnv) {
  const tmp = path.join(stateDir(root), "tmp");
  await mkdir(tmp, { recursive: true });
  return { ...env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

export async function gradleState(root: string, env: NodeJS.ProcessEnv) {
  const home = path.join(stateDir(root), "gradle");
  return {
    env: { ...await tempEnv(root, env), GRADLE_USER_HOME: home },
    args: [
      "--gradle-user-home", home,
      "--project-cache-dir", path.join(stateDir(root), "gradle-project"),
      `-Dmaven.repo.local=${mavenRepository(root)}`,
      `-Pkotlin.project.persistent.dir=${path.join(stateDir(root), "kotlin")}`,
      "-Pkotlin.project.persistent.dir.gradle.disableWrite=true",
    ],
  };
}

export async function mavenState(root: string, env: NodeJS.ProcessEnv) {
  return {
    env: { ...await tempEnv(root, env), MAVEN_USER_HOME: mavenHome(root) },
    args: [`-Dmaven.repo.local=${mavenRepository(root)}`],
  };
}
