import { z } from "zod";

const file = z.string().min(1).max(1024);
const requirement = z.object({
  id: z.string().min(1).max(80),
  behavior: z.string().min(1).max(600),
  components: z.array(file).min(1).max(15).describe("Project-relative implementation files."),
  checks: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source_contains"), file, text: z.string().min(1).max(500) }),
    z.object({ kind: z.literal("jar_entry"), file, entry: z.string().min(1).max(512) }),
    z.object({ kind: z.literal("junit"), file, className: z.string().min(1).max(512), testName: z.string().min(1).max(512) }),
  ])).max(10).describe("Project-relative files. JUnit checks read an existing Gradle/Maven XML report."),
  runtimeRequired: z.boolean().optional().describe("Flag behavior that requires a separate in-game check."),
  limitation: z.string().max(500).optional(),
});

export const verifyRequirementsInput = {
  projectDir: z.string().min(1),
  requirements: z.array(requirement).min(1).max(20).refine(
    entries => new Set(entries.map(entry => entry.id)).size === entries.length,
    "Requirement IDs must be unique.",
  ),
};

export const auditImplementationInput = {
  projectDir: z.string().min(1),
  files: z.array(z.object({
    file,
    fromLine: z.number().int().positive().optional(),
    toLine: z.number().int().positive().optional(),
  }).refine(
    range => range.toLine === undefined || range.toLine >= (range.fromLine ?? 1),
    "toLine must be at or after fromLine.",
  )).min(1).max(50).describe("Edited Java/Kotlin source files or inclusive changed line ranges, relative to projectDir."),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
