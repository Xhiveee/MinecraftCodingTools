import path from "node:path";

/** Minimal environment for helper JARs so they do not inherit MCP credentials or user-specific config paths. */
export function restrictedJavaEnv(javaExecutable: string, workDir: string, hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const javaHome = path.dirname(path.dirname(javaExecutable));
  const env: NodeJS.ProcessEnv = {
    PATH: [path.join(javaHome, "bin"), ...(hostEnv.SystemRoot ? [path.join(hostEnv.SystemRoot, "System32")] : [])].join(path.delimiter),
    JAVA_HOME: javaHome,
    HOME: workDir,
    USERPROFILE: workDir,
    TEMP: workDir,
    TMP: workDir,
    TMPDIR: workDir,
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "LANG", "LC_ALL"]) if (hostEnv[key]) env[key] = hostEnv[key];
  return env;
}
