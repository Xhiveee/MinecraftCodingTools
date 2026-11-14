import { auditImplementationInput, verifyRequirementsInput } from "./verification-schemas.js";

export const verificationTools = [
  {
    name: "audit_implementation",
    title: "Audit edited implementation",
    description: "Review selected edited Java/Kotlin lines for TODO/FIXME comments, stub-like throws and empty annotated event handlers. Returns paged locations and evidence. Signals require human or agent review.",
    input: auditImplementationInput,
    openWorld: false,
    load: async () => {
      const { auditImplementation } = await import("./implementation-audit.js");
      return (_services: unknown, args: Parameters<typeof auditImplementation>[0]) => auditImplementation(args);
    },
  },
  {
    name: "verify_requirements",
    title: "Verify acceptance evidence",
    description: "Check declared requirements against local component files, literal text, JAR entries and specific JUnit XML results. Reports missing, failed, stale and runtime-unverified evidence. Executes no code.",
    input: verifyRequirementsInput,
    openWorld: false,
    load: async () => {
      const { verifyRequirements } = await import("./verification.js");
      return (_services: unknown, args: Parameters<typeof verifyRequirements>[0]) => verifyRequirements(args);
    },
  },
];
