import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOLS as modTools } from './mod/tools/registry.js';
import { TOOLS as pluginTools } from './plugin/tools/registry.js';
import { guard } from './common/result.js';
import { SERVER_INFO } from './metadata.js';

export function createServer(overrides: { mod?: () => Promise<import('./mod/services.js').Services>; plugin?: () => Promise<import('./plugin/services.js').Services> } = {}): McpServer {
const server = new McpServer(SERVER_INFO, {
  instructions: [
    'Wrap every tool call in request with target=mod (Fabric/Forge/NeoForge) or target=plugin (Bukkit/Spigot/Paper). Use the exposed tool schemas and names build/search_source.',
    'Establish the project module, Minecraft version, loader/platform and namespace first. For mods use inspect_mod_project; inspect plugin build files and metadata. Pass projectDir where supported and use get_profile for build facts.',
    'Prefer public API events before Mixin or NMS. Search symbols, read get_class outlines, then request specific methods; use exact descriptors for overloads and translate_mapping for namespace changes.',
    'For dependencies: list_project_artifacts -> inspect_code_archive -> search_code_archive -> get_code_archive_class. Reuse returned jarPath/sourcesJarPath. Read outlines before source; prefer original sources. Follow pagination offsets.',
    'Classpath discovery covers compile dependencies; archive usages/callees cover one JAR. Analyze other and nested JARs separately. Kotlin parsing is static and decompiled Kotlin is Java; verify signatures by compiling.',
    'Preserve existing file languages and use detected language preference for new mod code. Validate changed mixins/NMS references, build and run relevant tests; diagnose real failures with analyze_crash.',
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
let modServices: Promise<import('./mod/services.js').Services> | undefined;
let pluginServices: Promise<import('./plugin/services.js').Services> | undefined;
for (const [name, variants] of groups) {
  const schemas = variants.map(({target,tool}) => z.object({target:z.literal(target), ...tool.input as z.ZodRawShape}));
  const request = schemas.length === 1 ? schemas[0] : z.union(schemas as [typeof schemas[number],typeof schemas[number]]);
  server.registerTool(name, {
    description: variants.map(({target,tool}) => `${target}: ${tool.description}`).join('\n'),
    inputSchema: {request},
    annotations: {
      readOnlyHint: variants.every(({tool}) => tool.readOnly ?? true),
      openWorldHint: variants.some(({tool}) => 'openWorld' in tool ? tool.openWorld ?? true : true)
    }
  }, async ({request}) => guard(async () => {
    const {target,...args} = request;
    if (target === 'mod') {
      const tool = modTools.find(t => (names[t.name] ?? t.name) === name)!;
      const services = await (modServices ??= (overrides.mod?.() ?? import('./mod/services.js').then(m => m.createServices())));
      return (await tool.load())(services,args as never);
    }
    const tool = pluginTools.find(t => (names[t.name] ?? t.name) === name)!;
    const services = await (pluginServices ??= (overrides.plugin?.() ?? import('./plugin/services.js').then(m => m.createServices())));
    return (await tool.load())(services,args as never);
  }));
}
return server;
}
