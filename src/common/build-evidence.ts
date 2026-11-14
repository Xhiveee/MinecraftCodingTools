import { readFile, stat } from "node:fs/promises";
import type { RunResult } from "./run-process.js";
import { fail } from "./result.js";

interface Finding { severity: string; kind: string }

export function blockedBuild(message: string, projectDir: string, kind: "project" | "wrapper" | "jdk" | "maven") {
  return { ...fail(message), structuredContent: { status: "blocked", projectDir, failureKinds: [kind], message } };
}

export async function readBuildLog(run: RunResult) {
  if ((await stat(run.logFile)).size < 8_000_000) return readFile(run.logFile, "utf8");
  return [...run.kept, ...run.tail].join("\n");
}

export function failedBuildUnit(line: string): string | undefined {
  const gradle = /^(?:> Task (:\S+) FAILED|\s*Execution failed for task '(.*?)')/.exec(line);
  if (gradle) return gradle[1] ?? gradle[2];
  const maven = /^\[ERROR\] Failed to execute goal (\S+)(?: \([^)]*\))? on project ([\w.-]+):/.exec(line);
  if (maven) return `${maven[2]} (${maven[1]})`;
}

export function buildEvidence(run: RunResult, findings: Finding[], project: { dir: string; rootDir?: string }, tasks: string[], failedUnits: string[]) {
  const status = run.aborted ? "cancelled" : run.timedOut ? "timed_out" : run.exitCode === 0 ? "passed" : "failed";
  const kinds = new Set(findings.filter(f => f.severity === "error").map(f => f.kind));
  const failureKinds = status === "passed" ? [] : [
    ...(kinds.has("jvm_mismatch") || kinds.has("toolchain_missing") ? ["jdk"] : []),
    ...(kinds.has("dependency_resolution") ? ["dependency"] : []),
    ...(kinds.has("mixin_error") ? ["mixin"] : []),
    ...(kinds.has("nms_mismatch") ? ["nms"] : []),
    ...(kinds.has("compile_error") ? ["compilation"] : []),
    ...(failedUnits.some(unit => /(?:^|:)test\w*$|surefire|failsafe/i.test(unit)) ? ["tests"] : []),
  ];
  return {
    status, exitCode: run.exitCode, signal: run.signal, elapsedMs: run.durationMs,
    projectDir: project.dir, buildRoot: project.rootDir ?? project.dir, tasks, failedUnits,
    failureKinds: status === "failed" && !failureKinds.length ? ["unclassified"] : failureKinds,
    logFile: run.logFile,
  };
}
