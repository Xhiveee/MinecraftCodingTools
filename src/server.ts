import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { TOOLS as modTools } from './mod/tools/registry.js';
import { TOOLS as pluginTools } from './plugin/tools/registry.js';
import { guard } from './common/result.js';
import { SERVER_INFO } from './metadata.js';

async function toolProjectRoot(target: 'mod' | 'plugin', projectDir?: string) {
  if (!projectDir && (target === 'mod' ? process.env.FFN_CACHE_DIR : process.env.BSP_CACHE_DIR)) return;
  const start = projectDir ?? process.env.MCT_WORKSPACE_DIR ?? process.cwd();
  const root = await realpath(start).catch(() => path.resolve(start));
  if (target === 'plugin') {
    const { readProjectInfo } = await import('./plugin/project/info.js');
    const info = await readProjectInfo(root).catch(() => undefined);
    if (info) return info.rootDir;
  }
  return (await import('./mod/project/info.js')).findGradleRoot(root);
}

export function createServer(overrides: { mod?: () => Promise<import('./mod/services.js').Services>; plugin?: () => Promise<import('./plugin/services.js').Services> } = {}): McpServer {
const server = new McpServer(SERVER_INFO, {
  instructions: [
    'Wrap every tool call in request with target=mod (Fabric/Forge/NeoForge) or target=plugin (Bukkit/Spigot/Paper). Use the exposed tool schemas and names build/search_source.',
    'Establish the project module, Minecraft version, loader/platform and namespace first. For mods use inspect_mod_project; inspect plugin build files and metadata. Pass projectDir where supported and use get_profile for build facts.',
    'Pass projectDir to source and archive tools to keep downloaded tools, indices and decompiled source under the build root .mct directory.',
    'Prefer public API events before Mixin or NMS. Search symbols, read get_class outlines, then request specific methods; use exact descriptors for overloads and translate_mapping for namespace changes.',
    'For dependencies: list_project_artifacts -> inspect_code_archive -> search_code_archive -> get_code_archive_class. Reuse returned jarPath/sourcesJarPath. Read outlines before source; prefer original sources. Follow pagination offsets.',
    'Classpath discovery covers compile dependencies; archive usages/callees cover one JAR. Analyze other and nested JARs separately. Kotlin parsing is static and decompiled Kotlin is Java; verify signatures by compiling.',
    'Preserve existing file languages and use detected language preference for new mod code. Validate changed mixins/NMS references, build and run relevant tests; diagnose real failures with analyze_crash.',
    'Use audit_implementation on edited source and verify_requirements on acceptance evidence. Run paper_smoke_test only with authorized local JARs and explicit EULA acceptance. A lifecycle pass covers enable/disable; verify feature behavior separately.',
    'Use validate_mod/validate_plugin for selected-module descriptors, validate_resources/data/worldgen for edited resources, and validate_modules for module consistency. Supply mcVersion and generated/dependency resource roots when needed. These are static checks, not game-codec or runtime verification. Image generation requires a host image tool.',
    'Build/classpath tasks execute project code as the current user. Use within authorized project work; runPaperclip/buildtools require authorization for that execution. Report only checks actually performed, distinguishing static checks, compilation and runtime verification.'
  ].join('\n')
});
const names: Record<string,string> = {gradle_build:'build', search_mc_source:'search_source', search_server_source:'search_source'};
type Target = 'mod' | 'plugin';
type Tool = (typeof modTools)[number] | (typeof pluginTools)[number];
const groups = new Map<string, {target:Target; tool:Tool}[]>();
for (const [target, list] of [['mod',modTools],['plugin',pluginTools]] as const) {
  for (const tool of list) {
    const name = names[tool.name] ?? tool.name;
    const entries = groups.get(name) ?? [];
    entries.push({target,tool});
    groups.set(name,entries);
  }
}
const modServices = new Map<string | undefined, Promise<import('./mod/services.js').Services>>();
const pluginServices = new Map<string | undefined, Promise<import('./plugin/services.js').Services>>();
for (const [name, variants] of groups) {
  const schemas = variants.map(({target,tool}) => z.object({target:z.literal(target), ...tool.input as z.ZodRawShape}));
  const request = schemas.length === 1 ? schemas[0] : z.union(schemas as [typeof schemas[number],typeof schemas[number]]);
  const first = variants[0]!.tool;
  server.registerTool(name, {
    title: name === 'build' ? 'Build project' : name === 'search_source' ? 'Search Minecraft source' : first.title,
    description: variants.length > 1 && variants.every(({tool}) => tool.description === first.description)
      ? first.description
      : variants.map(({target,tool}) => `${target}: ${tool.description}`).join('\n'),
    inputSchema: {request},
    annotations: {
      readOnlyHint: variants.every(({tool}) => tool.readOnly ?? true),
      openWorldHint: variants.some(({tool}) => 'openWorld' in tool ? tool.openWorld ?? true : true)
    }
  }, async ({request}, {signal}) => guard(async () => {
    const {target,...args} = request;
    const { projectDir } = args as { projectDir?: string };
    if (target === 'mod') {
      const tool = modTools.find(t => (names[t.name] ?? t.name) === name)!;
      const root = overrides.mod ? undefined : await toolProjectRoot(target, projectDir);
      if (!modServices.has(root)) modServices.set(root, (overrides.mod?.() ?? import('./mod/services.js').then(m => m.createServices({ projectRoot: root })))
        .catch(error => { modServices.delete(root); throw error; }));
      const services = await modServices.get(root)!;
      return (await tool.load())(services, args as never, signal);
    }
    const tool = pluginTools.find(t => (names[t.name] ?? t.name) === name)!;
    const root = overrides.plugin ? undefined : await toolProjectRoot(target, projectDir);
    if (!pluginServices.has(root)) pluginServices.set(root, (overrides.plugin?.() ?? import('./plugin/services.js').then(m => m.createServices({ projectRoot: root })))
      .catch(error => { pluginServices.delete(root); throw error; }));
    const services = await pluginServices.get(root)!;
    return (await tool.load())(services, args as never, signal);
  }));
}
return server;
}
