import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';
import type { z } from 'zod';
import { ok } from './result.js';
import { readProjectInfo as modInfo } from '../mod/project/info.js';
import { readProjectInfo as pluginInfo, parseProperties } from '../plugin/project/info.js';
import { validationInput } from './validation-schemas.js';

type Args = z.infer<z.ZodObject<typeof validationInput>>;
type Finding = { severity: 'error' | 'warning'; file: string; message: string };
type Json = Record<string, any>;
export type ValidationKind = 'resources' | 'data' | 'worldgen' | 'plugin' | 'mod' | 'modules';

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink() || ['node_modules', '.git', '.mct', '.ffn', 'run', '.gradle'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];
const id = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/;
const unresolved = (v: string) => /\$\{|@\w+@/.test(v);
const legacy = (v?: string) => !!v && /^1\./.test(v) && Number(v.split('.')[1]) < 21;

export async function validate(kind: ValidationKind, a: Args) {
  const dir = path.resolve(a.projectDir);
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], file: string, message: string) => findings.push({ severity, file: path.relative(dir, file) || '.', message });
  let info: Awaited<ReturnType<typeof modInfo>> | undefined;
  if (!['plugin', 'modules'].includes(kind)) {
    try { info = await modInfo(dir); } catch { /* Packs do not need a build project. */ }
  }
  const version = a.mcVersion ?? info?.mcVersion;
  let roots = a.roots?.map(r => path.resolve(dir, r)) ?? info?.resourceRoots ?? [];
  if (!roots.length) roots = [existsSync(path.join(dir, 'src/main/resources')) ? path.join(dir, 'src/main/resources') : dir];
  roots = [...new Set(roots)];
  const all = new Set<string>();
  for (const root of ['plugin', 'modules'].includes(kind) ? [] : roots) {
    if (!existsSync(root)) { add('error', root, 'Resource root does not exist.'); continue; }
    for (const file of await files(root)) all.add(file);
  }
  const json = new Map<string, Json>();
  async function parse(file: string, yaml = false) {
    try {
      const text = await readFile(file, 'utf8');
      const value: unknown = yaml ? YAML.parse(text) : JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!object(value) && !(Array.isArray(value) && /\/data\/[^/]+\/(predicates?|item_modifiers?)\//.test(file.replaceAll('\\', '/')))) throw new Error('Expected an object.');
      return value as Json;
    } catch (e) { add('error', file, `Invalid ${yaml ? 'YAML' : 'JSON'}: ${(e as Error).message}`); }
  }
  const relevant = (f: string) => {
    const s = f.replaceAll('\\', '/');
    return kind === 'resources' ? s.includes('/assets/') || f.endsWith('pack.mcmeta')
      : kind === 'data' ? s.includes('/data/') || f.endsWith('pack.mcmeta')
      : kind === 'worldgen' ? /\/data\/[^/]+\/(worldgen|dimension|dimension_type|tags\/worldgen|neoforge\/biome_modifier)\//.test(s) : false;
  };
  for (const f of all) if ((f.endsWith('.json') || f.endsWith('.mcmeta')) && relevant(f)) {
    const value = await parse(f); if (value) json.set(f, value);
  }
  const available = (relative: string) => roots.some(r => existsSync(path.join(r, relative)));
  function ref(file: string, value: unknown, registry: string, ext = '.json', base = 'data', optional = false) {
    if (typeof value !== 'string' || value.startsWith('#') && base === 'assets') return;
    if (!id.test(value.replace(/^#/, '')) || value.includes('..') || value.startsWith('/')) { add('error', file, `Invalid resource identifier: ${value}`); return; }
    const tag = value.startsWith('#');
    const clean = value.replace(/^#/, '');
    const [ns, name] = clean.includes(':') ? clean.split(':') : ['minecraft', clean];
    const target = `${base}/${ns}/${tag ? 'tags/' : ''}${registry}/${name}${ext}`;
    if (available(target) || optional) return;
    const supplied = roots.some(r => existsSync(path.join(r, base, ns!)));
    add(ns === 'minecraft' || !supplied ? 'warning' : 'error', file, `${ns === 'minecraft' || !supplied ? 'Unverified external' : 'Missing local'} reference ${value}: ${target}`);
  }
  function walk(v: unknown, fn: (o: Json) => void) {
    if (Array.isArray(v)) v.forEach(x => walk(x, fn));
    else if (object(v)) { fn(v); Object.values(v).forEach(x => walk(x, fn)); }
  }
  if (kind === 'data' && version && !legacy(version)) for (const f of all) {
    if (/\/data\/[^/]+\/(functions|loot_tables|tags\/(blocks|items|functions))\//.test(f.replaceAll('\\', '/'))) add('error', f, `Legacy data directory for ${version}.`);
  }
  for (const [f, v] of json) {
    const p = f.replaceAll('\\', '/');
    if (f.endsWith('pack.mcmeta')) {
      if (!object(v.pack)) add('error', f, 'Missing pack object.');
      else {
        const pack = v.pack;
        if (pack.description === undefined) add('error', f, 'Missing pack.description.');
        if (pack.pack_format === undefined && pack.min_format === undefined) add('error', f, 'Missing pack format.');
        if (pack.pack_format !== undefined && (!Number.isInteger(pack.pack_format) || pack.pack_format < 0)) add('error', f, 'pack_format must be a nonnegative integer.');
        if ((pack.min_format === undefined) !== (pack.max_format === undefined)) add('error', f, 'min_format and max_format must be supplied together.');
        const parts = (x: unknown): number[] | undefined => Number.isInteger(x) && Number(x) >= 0 ? [Number(x)] : Array.isArray(x) && x.length >= 1 && x.length <= 2 && x.every(n => Number.isInteger(n) && n >= 0) ? x : undefined;
        const min = parts(pack.min_format), max = parts(pack.max_format);
        if (pack.min_format !== undefined && (!min || !max)) add('error', f, 'Format bounds must be integers or one/two-integer arrays.');
        if (min && max && (min[0]! > max[0]! || min[0] === max[0] && (min[1] ?? 0) > (max[1] ?? Infinity))) add('error', f, 'min_format exceeds max_format.');
      }
    }
    if (kind === 'resources') {
      if (p.includes('/models/')) {
        if (typeof v.parent === 'string' && !v.parent.startsWith('builtin/')) ref(f, v.parent, 'models', '.json', 'assets');
        if (v.textures !== undefined && !object(v.textures)) add('error', f, 'textures must be an object.');
        for (const t of Object.values(object(v.textures) ? v.textures : {})) {
          const value = object(t) ? t.sprite : t;
          if (typeof value !== 'string') add('error', f, 'Texture reference must be a string or sprite object.');
          else ref(f, value, 'textures', '.png', 'assets');
        }
        for (const o of array(v.overrides)) ref(f, o?.model, 'models', '.json', 'assets');
      }
      if (p.includes('/blockstates/')) walk(v, o => ref(f, o.model, 'models', '.json', 'assets'));
      if (p.includes('/items/')) walk(v, o => { if (o.type === 'minecraft:model') ref(f, o.model, 'models', '.json', 'assets'); });
      if (p.endsWith('/sounds.json')) for (const event of Object.values(v)) {
        if (!object(event) || !Array.isArray(event.sounds)) { add('error', f, 'Sound events require a sounds array.'); continue; }
        for (const s of event.sounds) {
          if (object(s) && s.type === 'event') {
            const name = String(s.name ?? '');
            const ns = /\/assets\/([^/]+)\//.exec(p)?.[1];
            const [namespace, key] = name.includes(':') ? name.split(':') : ['minecraft', name];
            if (namespace === ns && !v[key!]) add('error', f, `Missing sound event ${name}.`);
            else if (namespace !== ns) add('warning', f, `External sound event not verified: ${name}`);
          } else ref(f, object(s) ? s.name : s, 'sounds', '.ogg', 'assets');
        }
      }
      if (p.includes('/font/')) for (const provider of array(v.providers).filter(object)) {
        const type = String(provider.type).replace(/^minecraft:/, '');
        if (type === 'bitmap') ref(f, typeof provider.file === 'string' ? provider.file.replace(/\.png$/, '') : provider.file, 'textures', '.png', 'assets');
        else if (type === 'ttf') ref(f, provider.file, 'font', '', 'assets');
        else if (type === 'reference') ref(f, provider.id, 'font', '.json', 'assets');
      }
      if (f.endsWith('.png.mcmeta') && !existsSync(f.slice(0, -7))) add('error', f, 'Animation metadata has no matching PNG.');
    }
    if (kind === 'data') {
      if (p.includes('/tags/')) {
        if (!Array.isArray(v.values)) add('error', f, 'Tag requires a values array.');
        else {
          const registry = /\/tags\/(functions?)\//.exec(p)?.[1];
          for (const entry of v.values) {
            const value = typeof entry === 'string' ? entry : object(entry) ? entry.id : undefined;
            if (typeof value !== 'string' || !id.test(value.replace(/^#/, ''))) add('error', f, 'Invalid tag entry.');
            else if (object(entry) && entry.required !== undefined && typeof entry.required !== 'boolean') add('error', f, 'Tag entry required must be boolean.');
            else if (registry === 'function' || registry === 'functions') ref(f, value, registry, value.startsWith('#') ? '.json' : '.mcfunction', 'data', object(entry) && entry.required === false);
          }
        }
      }
      if (/\/tags\/functions?\/(load|tick)\.json$/.test(p) && !/\/data\/minecraft\//.test(p)) add('warning', f, 'Only minecraft load/tick tags run automatically.');
      if (/\/data\/[^/]+\/recipes?\//.test(p) && typeof v.type !== 'string') add('error', f, 'Recipe requires a type identifier.');
    }
    if (kind === 'worldgen') {
      if (p.includes('/placed_feature/') && v.feature === undefined) add('error', f, 'Placed feature requires a feature reference or inline feature.');
      if (p.includes('/structure_set/') && !Array.isArray(v.structures)) add('error', f, 'Structure set requires a structures array.');
      if (p.includes('/dimension/') && (v.type === undefined || !object(v.generator))) add('error', f, 'Dimension requires type and generator.');
      if (p.includes('/template_pool/') && !Array.isArray(v.elements)) add('error', f, 'Template pool requires an elements array.');
      if (p.includes('/placed_feature/')) ref(f, v.feature, version && /^26\./.test(version) && Number(version.split('.')[1]) >= 3 ? 'worldgen/feature' : 'worldgen/configured_feature');
      if (p.includes('/structure_set/')) for (const s of array(v.structures)) ref(f, s?.structure, 'worldgen/structure');
      if (p.includes('/structure/')) ref(f, v.start_pool, 'worldgen/template_pool');
      if (p.includes('/dimension/')) { ref(f, v.type, 'dimension_type'); ref(f, v.generator?.settings, 'worldgen/noise_settings'); }
      if (p.includes('/template_pool/')) {
        if (v.fallback !== 'minecraft:empty') ref(f, v.fallback, 'worldgen/template_pool');
        walk(v.elements, o => { ref(f, o.location, legacy(version) ? 'structures' : 'structure', '.nbt'); ref(f, o.processors, 'worldgen/processor_list'); });
      }
      const featureRefs = (v: unknown): void => { if (Array.isArray(v)) v.forEach(featureRefs); else if (typeof v === 'string') ref(f, v, 'worldgen/placed_feature'); };
      if (p.includes('/biome/') || p.includes('/biome_modifier/')) featureRefs(v.features);
      if (p.includes('/biome_modifier/')) {
        const biomes = Array.isArray(v.biomes) ? v.biomes : [v.biomes];
        for (const biome of biomes) ref(f, biome, 'worldgen/biome');
      }
    }
  }
  if (kind === 'data') {
    const visiting = new Set<string>(), done = new Set<string>();
    const visit = (f: string) => {
      if (visiting.has(f)) { add('error', f, 'Cyclic function tag reference.'); return; }
      if (done.has(f)) return;
      visiting.add(f);
      for (const entry of array(json.get(f)?.values)) {
        const value = typeof entry === 'string' ? entry : entry?.id;
        if (typeof value !== 'string' || !value.startsWith('#') || !id.test(value.slice(1)) || value.includes('..')) continue;
        const [ns, name] = value.slice(1).includes(':') ? value.slice(1).split(':') : ['minecraft', value.slice(1)];
        for (const root of roots) { const target = path.join(root, 'data', ns!, 'tags', legacy(version) ? 'functions' : 'function', `${name}.json`); if (json.has(target)) visit(target); }
      }
      visiting.delete(f); done.add(f);
    };
    for (const f of json.keys()) if (/\/tags\/functions?\//.test(f.replaceAll('\\', '/'))) visit(f);
  }
  if (kind === 'plugin') await plugin(dir, add, parse);
  if (kind === 'mod') await mod(dir, roots, info, add, parse);
  if (kind === 'modules') await modules(dir, add);
  if (['resources', 'data', 'worldgen'].includes(kind) && ![...json.keys()].some(f => relevant(f) && !f.endsWith('pack.mcmeta'))) add('warning', dir, `No ${kind} JSON files found in the selected roots.`);
  if (['data', 'worldgen'].includes(kind) && !version) add('warning', dir, 'Minecraft version unknown; version-specific directory checks are incomplete. Pass mcVersion.');
  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const offset = a.offset ?? 0, limit = a.limit ?? 100;
  return { ...ok(`${kind}: ${errors} error(s), ${warnings} warning(s). Static checks only; no build or game executed.`, {
    roots, mcVersion: version, errors, warnings, findings: findings.slice(offset, offset + limit), total: findings.length,
    ...(offset + limit < findings.length ? { nextOffset: offset + limit } : {}),
  }), isError: errors > 0 || !!a.strict && warnings > 0 };
}

type Add = (severity: Finding['severity'], file: string, message: string) => void;
type Parse = (file: string, yaml?: boolean) => Promise<Json | undefined>;

async function plugin(dir: string, add: Add, parse: Parse) {
  const descriptors = ['plugin.yml', 'paper-plugin.yml'].map(n => [path.join(dir, 'src/main/resources', n), path.join(dir, n)].find(existsSync)).filter((p): p is string => !!p);
  if (!descriptors.length) { add('error', dir, 'No plugin.yml or paper-plugin.yml found.'); return; }
  const source = (await files(path.join(dir, 'src')).catch(() => [])).filter(f => /\.(java|kt)$/.test(f));
  const parsed: { file: string; value: Json }[] = [];
  for (const f of descriptors) {
    const v = await parse(f, true); if (!v) continue;
    parsed.push({ file: f, value: v });
    for (const key of ['name', 'version', 'main']) if (typeof v[key] !== 'string' || !v[key].trim()) add('error', f, `Missing or invalid ${key}.`);
    if (!v['api-version']) add('warning', f, 'api-version is not declared.');
    if (typeof v.version === 'string' && unresolved(v.version)) add('warning', f, 'Version placeholder requires processResources; inspect the built descriptor.');
    if (typeof v.main === 'string') {
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(v.main)) { add('error', f, 'Invalid main class name.'); continue; }
      const simple = v.main.split('.').pop()!;
      let found = false;
      for (const s of source) {
        const text = await readFile(s, 'utf8');
        const pkg = /\bpackage\s+([\w.]+)/.exec(text)?.[1];
        if ((pkg ? pkg + '.' : '') + simple === v.main && new RegExp(`\\bclass\\s+${simple.replaceAll('$', '\\$')}\\b`).test(text)) {
          found = true;
          if (!/\bextends\s+|\bclass\s+\w+[^\n{]*:/.test(text)) add('warning', s, 'Main class has no visible superclass; verify it extends JavaPlugin.');
        }
      }
      if (!found) add('warning', f, `Main class ${v.main} not found in src; generated sources or dependencies were not inspected.`);
    }
    if (f.endsWith('paper-plugin.yml') && v.commands) add('warning', f, 'Paper plugins register commands through lifecycle APIs, not the commands field.');
    if (v['api-version'] !== undefined && !/^\d+\.\d+(?:\.\d+)?$/.test(String(v['api-version']))) add('error', f, 'Invalid api-version format.');
    if (v['folia-supported'] !== undefined && typeof v['folia-supported'] !== 'boolean') add('error', f, 'folia-supported must be boolean.');
    for (const key of ['depend', 'softdepend', 'loadbefore']) if (v[key] !== undefined && (!Array.isArray(v[key]) || !v[key].every((x: unknown) => typeof x === 'string'))) add('error', f, `${key} must be a string array.`);
    if (v.dependencies !== undefined && !object(v.dependencies)) add('error', f, 'Paper dependencies must be a mapping.');
  }
  if (parsed.length === 2) for (const key of ['name', 'version', 'api-version']) {
    if (String(parsed[0]!.value[key]) !== String(parsed[1]!.value[key])) add('warning', parsed[1]!.file, `${key} differs between plugin descriptors; verify the intended dual-platform metadata.`);
  }
  for (const f of source) {
    const text = await readFile(f, 'utf8');
    if (/\b(?:Bukkit|getServer\(\))\.reload\s*\(/.test(text)) add('warning', f, 'Server reload call detected; restart the development server instead.');
  }
}

async function mod(dir: string, roots: string[], info: Awaited<ReturnType<typeof modInfo>> | undefined, add: Add, parse: Parse) {
  if (!info) add('warning', dir, 'Project loader/version could not be inferred.');
  let count = 0;
  for (const root of roots) for (const name of ['fabric.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const f = path.join(root, name); if (!existsSync(f)) continue; count++;
    const expected = info?.platform === 'common' ? undefined : info?.loader;
    if (expected && !({ fabric: 'fabric.mod.json', forge: 'META-INF/mods.toml', neoforge: 'META-INF/neoforge.mods.toml' }[expected] === name)) add('warning', f, `Descriptor differs from detected loader ${expected}.`);
    if (name.endsWith('.json')) {
      const v = await parse(f); if (!v) continue;
      if (v.schemaVersion !== 1) add('warning', f, 'Only Fabric schemaVersion 1 is checked.');
      for (const key of ['id', 'version']) if (typeof v[key] !== 'string' || !v[key]) add('error', f, `Missing or invalid ${key}.`);
      if (typeof v.id === 'string' && !/^[a-z][a-z0-9_-]{1,63}$/.test(v.id)) add('error', f, 'Invalid Fabric mod id.');
      if (v.mixins !== undefined && !Array.isArray(v.mixins)) add('error', f, 'mixins must be an array.');
      for (const entry of array(v.mixins)) {
        const config = typeof entry === 'string' ? entry : entry?.config;
        if (typeof config !== 'string') add('error', f, 'Invalid mixin config entry.');
        else if (!roots.some(r => existsSync(path.join(r, config)))) add('error', f, `Missing mixin config ${config}.`);
      }
      if (v.environment !== undefined && !['*', 'client', 'server'].includes(v.environment)) add('error', f, 'Invalid Fabric environment.');
      if (v.entrypoints !== undefined && !object(v.entrypoints)) add('error', f, 'Fabric entrypoints must be a mapping.');
      for (const entries of Object.values(object(v.entrypoints) ? v.entrypoints : {})) {
        if (!Array.isArray(entries)) { add('error', f, 'Each Fabric entrypoint group must be an array.'); continue; }
        for (const entry of entries) if (typeof entry !== 'string' && !(object(entry) && typeof entry.value === 'string')) add('error', f, 'Invalid Fabric entrypoint.');
      }
      if (typeof v.accessWidener === 'string' && !roots.some(r => existsSync(path.join(r, v.accessWidener)))) add('error', f, `Missing access widener ${v.accessWidener}.`);
    } else {
      let v: Json;
      try { v = parseToml(await readFile(f, 'utf8')); }
      catch (e) { add('error', f, `Invalid TOML: ${(e as Error).message}`); continue; }
      for (const key of ['modLoader', 'loaderVersion', 'license']) if (typeof v[key] !== 'string' || !v[key]) add('error', f, `Missing or invalid TOML field ${key}.`);
      if (!Array.isArray(v.mods) || !v.mods.length) add('error', f, 'Missing [[mods]] table.');
      for (const entry of array(v.mods)) {
        if (!object(entry)) { add('error', f, 'Invalid mods table.'); continue; }
        for (const key of ['modId', 'version']) if (typeof entry[key] !== 'string' || !entry[key]) add('error', f, `Missing or invalid mods.${key}.`);
        if (typeof entry.modId === 'string' && !/^[a-z][a-z0-9_]{1,63}$/.test(entry.modId)) add('error', f, 'Invalid Forge/NeoForge modId.');
      }
    }
  }
  if (!count && info?.platform !== 'common') add('error', dir, 'No mod descriptor found in resource roots; include template/generated roots if applicable.');
}

async function modules(dir: string, add: Add) {
  let info: Awaited<ReturnType<typeof modInfo>>;
  try { info = await modInfo(dir); } catch {
    try {
      const root = await pluginInfo(dir);
      if (!root.modules.length) add('warning', dir, 'No plugin modules detected.');
      const names = new Map<string, string>();
      const versions = new Set<string>();
      for (const module of root.modules) {
        try {
          const m = await pluginInfo(module);
          if (m.mcVersion) versions.add(m.mcVersion);
          const name = m.pluginYml?.name;
          if (name && names.has(name)) add('error', module, `Duplicate plugin name ${name}; also declared in ${names.get(name)}.`);
          if (name) names.set(name, module);
        } catch (e) { add('warning', module, `Module could not be inspected: ${(e as Error).message}`); }
      }
      if (versions.size > 1) add('warning', dir, `Plugin modules target different Minecraft versions: ${[...versions].join(', ')}.`);
    } catch (e) { add('warning', dir, `Module discovery unavailable: ${(e as Error).message}`); }
    return;
  }
  const list = info.subprojects ?? [];
  if (!list.length) { add('warning', dir, 'No mod subprojects detected.'); return; }
  const versions = new Map<string, string[]>();
  const modVersions = new Set<string>();
  for (const module of list) {
    try {
      const m = await modInfo(module.dir);
      if (m.platform === 'common') continue;
      const props = parseProperties(await readFile(path.join(module.dir, 'gradle.properties'), 'utf8').catch(() => ''));
      if (props.mod_version) modVersions.add(props.mod_version);
      const entries = versions.get(m.mcVersion) ?? []; entries.push(module.path); versions.set(m.mcVersion, entries);
      if (info.modId && m.modId && info.modId !== m.modId) add('warning', module.dir, `modId ${m.modId} differs from root ${info.modId}.`);
    } catch (e) { add('warning', module.dir, `Module could not be inspected: ${(e as Error).message}`); }
  }
  const settings = await readFile(path.join(dir, 'settings.gradle.kts'), 'utf8').catch(() => readFile(path.join(dir, 'settings.gradle'), 'utf8').catch(() => ''));
  const stonecutter = settings.includes('dev.kikugie.stonecutter');
  if (versions.size > 1 && !stonecutter) add('warning', dir, `Modules target different Minecraft versions: ${JSON.stringify(Object.fromEntries(versions))}. May be intentional; compatibility is not established.`);
  if (modVersions.size > 1) add('warning', dir, `Module mod_version values differ: ${[...modVersions].join(', ')}.`);
  for (const module of list.filter(m => m.platform === 'common')) {
    if (!existsSync(module.dir)) { add('warning', module.dir, 'Common module directory does not exist.'); continue; }
    const source = (await files(module.dir)).filter(f => /\.(java|kt)$/.test(f) && !f.includes(`${path.sep}build${path.sep}`));
    for (const f of source) if (/^\s*import\s+(?:net\.fabricmc|net\.neoforged|net\.minecraftforge)\./m.test(await readFile(f, 'utf8'))) add('warning', f, 'Loader-specific import in common module; verify platform separation.');
  }
}
