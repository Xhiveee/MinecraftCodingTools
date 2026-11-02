import { z } from "zod";

export const inspectCodeArchiveInput = {
  jarPath: z.string().describe("Path to a local mod, plugin, or library .jar."),
  sourcesJarPath: z.string().optional().describe("Optional matching -sources.jar; otherwise it is discovered next to the binary jar."),
};

export const searchCodeArchiveInput = {
  jarPath: z.string().describe("Path to a local mod, plugin, or library .jar."),
  sourcesJarPath: z.string().optional().describe("Optional matching -sources.jar."),
  query: z.string().min(1).max(2048).describe("Class/member name, or /regex/ for a case-insensitive regex. kind=text searches source/decompiled code."),
  kind: z.enum(["any", "class", "method", "field", "text", "usages", "callees"]).optional().describe("Default any; text searches source/decompiled code, usages finds callers, callees lists calls/field access from bytecode."),
  limit: z.number().int().min(1).max(100).optional().describe("Matches (default 30)."),
  offset: z.number().int().min(0).max(1e6).optional().describe("Paging offset."),
};

export const getCodeArchiveClassInput = {
  jarPath: z.string().describe("Path to a local mod, plugin, or library .jar."),
  sourcesJarPath: z.string().optional().describe("Optional matching -sources.jar."),
  className: z.string().describe("Fully qualified, internal, or unique simple class name."),
  mode: z.enum(["outline", "source"]).optional().describe("Default source; source uses attached sources or Vineflower decompilation."),
  offset: z.number().int().min(0).max(1e6).optional().describe("Source line offset."),
  limit: z.number().int().min(1).max(500).optional().describe("Source lines (default 200)."),
};

export const listProjectArtifactsInput = {
  projectDir: z.string().describe("Path to a mod or plugin project containing Gradle or Maven build files."),
  limit: z.number().int().min(1).max(300).optional().describe("Maximum JAR paths to return (default 100)."),
  offset: z.number().int().min(0).max(1e6).optional().describe("Paging offset."),
};
