import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { z } from "zod";
import { validatedCodeArchive } from "./code-archive.js";
import { ok } from "./result.js";
import type { verifyRequirementsInput } from "./verification-schemas.js";

type Args = z.infer<z.ZodObject<typeof verifyRequirementsInput>>;
type Check = Args["requirements"][number]["checks"][number];
type CheckResult = { status: "passed" | "failed" | "blocked"; evidence: string };

export async function projectFile(root: string, relative: string) {
  function inside(file: string) {
    const rel = path.relative(root, file);
    return rel && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
  }
  const requested = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !inside(requested)) throw new Error(`Expected a file inside projectDir: ${relative}`);
  const file = await realpath(requested);
  if (!inside(file)) throw new Error(`File resolves outside projectDir: ${relative}`);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Not a regular file: ${relative}`);
  return { file, info };
}

const reportParser = new XMLParser({
  ignoreAttributes: false,
  isArray: name => name === "testsuite" || name === "testcase",
});
interface TestCase { "@_classname"?: string; "@_name"?: string; failure?: unknown; error?: unknown; skipped?: unknown }
interface Suite { testsuite?: Suite[]; testcase?: TestCase[] }

function* testCases(suite: Suite | undefined): Iterable<TestCase> {
  if (!suite) return;
  yield* suite.testcase ?? [];
  for (const child of suite.testsuite ?? []) yield* testCases(child);
}

async function evaluate(check: Check, artifact: Awaited<ReturnType<typeof projectFile>>, newestComponent: number, archives: Map<string, Set<string>>, reports: Map<string, TestCase[]>): Promise<CheckResult> {
  const { file, info } = artifact;
  if (check.kind !== "source_contains" && info.mtimeMs < newestComponent) {
    return { status: "blocked", evidence: "Evidence file is older than a listed implementation component. Regenerate it." };
  }
  if (check.kind === "jar_entry") {
    if (!archives.has(file)) {
      if (archives.size >= 4) return { status: "blocked", evidence: "At most four distinct JARs can be read per request." };
      archives.set(file, new Set(validatedCodeArchive(file).getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName)));
    }
    const present = archives.get(file)!.has(check.entry);
    return { status: present ? "passed" : "failed", evidence: `${present ? "Found" : "Missing"} archive entry ${check.entry}.` };
  }
  if (info.size > 2 * 1024 * 1024) throw new Error("Evidence exceeds the 2 MiB text limit.");
  if (check.kind === "source_contains") {
    const text = await readFile(file, "utf8");
    const at = text.indexOf(check.text);
    return at < 0 ? { status: "failed", evidence: "Literal text was absent." }
      : { status: "passed", evidence: `Literal text found at line ${text.slice(0, at).split("\n").length}.` };
  }
  if (!reports.has(file)) {
    if (reports.size >= 10) return { status: "blocked", evidence: "At most ten distinct JUnit reports can be read per request." };
    const text = await readFile(file, "utf8");
    if (/<!DOCTYPE/i.test(text) || XMLValidator.validate(text) !== true) throw new Error("Invalid JUnit XML report.");
    const report = reportParser.parse(text) as { testsuite?: Suite[]; testsuites?: Suite };
    if (report.testsuites === undefined && report.testsuite === undefined) throw new Error("Expected a JUnit XML testsuite or testsuites root.");
    reports.set(file, [...testCases(report.testsuites), ...(report.testsuite ?? []).flatMap(suite => [...testCases(suite)])]);
  }
  const matches = reports.get(file)!.filter(test => test["@_classname"] === check.className && test["@_name"] === check.testName);
  const failed = matches.filter(test => test.failure !== undefined || test.error !== undefined).length;
  const executed = matches.filter(test => test.skipped === undefined).length;
  const label = `${check.className}#${check.testName}`;
  if (failed) return { status: "failed", evidence: `${label}: ${failed}/${matches.length} matching test executions reported failure or error.` };
  if (!executed) return { status: "blocked", evidence: `${label}: ${matches.length ? "matching tests were skipped." : "no matching test case in the report."}` };
  return { status: "passed", evidence: `${label}: ${executed}/${matches.length} matching test cases executed and passed.` };
}

export async function verifyRequirements(args: Args) {
  const root = await realpath(args.projectDir);
  const archives = new Map<string, Set<string>>();
  const reports = new Map<string, TestCase[]>();
  const resolved = new Map<string, ReturnType<typeof projectFile>>();
  const resolve = (file: string) => {
    if (!resolved.has(file)) resolved.set(file, projectFile(root, file));
    return resolved.get(file)!;
  };
  const requirements = [];
  for (const requirement of args.requirements) {
    let newestComponent = 0;
    const components = [];
    for (const file of requirement.components) {
      try {
        const { info } = await resolve(file);
        newestComponent = Math.max(newestComponent, info.mtimeMs);
        components.push({ file, status: "present" });
      } catch (error) {
        components.push({ file, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "blocked", evidence: (error as Error).message });
      }
    }
    const checks = [];
    for (const check of requirement.checks) {
      let result: CheckResult;
      try {
        result = await evaluate(check, await resolve(check.file), newestComponent, archives, reports);
      } catch (error) {
        result = { status: "blocked", evidence: (error as Error).message };
      }
      checks.push({ kind: check.kind, file: check.file, ...result });
    }
    const status = checks.some(c => c.kind === "junit" && c.status === "failed") ? "verification_failed"
      : components.some(c => c.status === "missing") || checks.some(c => c.kind !== "junit" && c.status === "failed") ? "implementation_incomplete"
      : components.some(c => c.status === "blocked") || checks.some(c => c.status === "blocked") ? "blocked"
      : checks.some(c => c.kind === "junit") ? (requirement.runtimeRequired ? "runtime_unverified" : "verified_by_report")
      : "behavior_unverified";
    requirements.push({ id: requirement.id, behavior: requirement.behavior, status, components, checks, runtimeRequired: requirement.runtimeRequired, limitation: requirement.limitation });
  }
  const data = {
    requirements,
    limitations: "File and JAR checks establish presence. JUnit results are recorded evidence, with timestamps compared to supplied components only. The tool does not run tests, assess coverage, or independently establish gameplay behavior.",
  };
  return { ...ok(requirements.map(requirement => `${requirement.id}: ${requirement.status}`).join("\n")), structuredContent: data };
}
