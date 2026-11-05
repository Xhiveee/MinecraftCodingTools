import { z } from 'zod';

export const validationInput = {
  projectDir: z.string().describe('Project module or unpacked pack directory. No build scripts are executed.'),
  mcVersion: z.string().optional().describe('Exact target version; inferred for mod projects when possible.'),
  roots: z.array(z.string()).optional().describe('Resource roots relative to projectDir or absolute; include generated resources and unpacked dependencies.'),
  strict: z.boolean().optional().describe('Treat warnings as failure.'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};
