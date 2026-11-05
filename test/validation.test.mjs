import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validate } from '../dist/common/validation.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mct-validation-'));
  const put = async (file, value) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  try { await fn(root, put); } finally { await rm(root, { recursive: true, force: true }); }
}
function data(result) { return JSON.parse(result.content[0].text.split('\n').slice(1).join('\n')); }

test('resources resolve generated roots and distinguish missing local and external assets', async () => fixture(async (root, put) => {
  await put('main/assets/demo/models/item/wand.json', { textures: { layer0: 'demo:item/wand' }, parent: 'minecraft:item/generated' });
  await put('generated/assets/demo/textures/item/wand.png', 'fixture');
  let result = data(await validate('resources', { projectDir: root, roots: ['main', 'generated'] }));
  assert.equal(result.errors, 0);
  await put('main/assets/demo/blockstates/wand.json', { variants: { '': { model: 'demo:block/missing' } } });
  result = data(await validate('resources', { projectDir: root, roots: ['main', 'generated'] }));
  assert.equal(result.errors, 1);
  assert.match(result.findings.find(f => f.severity === 'error').message, /Missing local/);
  await put('main/assets/demo/models/item/other.json', { parent: 'dependency:item/base' });
  const strict = await validate('resources', { projectDir: root, roots: ['main', 'generated'], strict: true, limit: 1 });
  assert.equal(strict.isError, true);
  assert.equal(data(strict).nextOffset, 1);
}));

test('data supports legacy paths, nested function tags, optional references and cycles', async () => fixture(async (root, put) => {
  await put('data/demo/functions/start.mcfunction', 'say hi');
  assert.equal(data(await validate('data', { projectDir: root, mcVersion: '1.20.1' })).errors, 0);
  assert.equal(data(await validate('data', { projectDir: root, mcVersion: '1.21.1' })).errors, 1);
  await put('data/demo/tags/function/nested/a.json', { values: ['#demo:nested/b', { id: 'demo:absent', required: false }] });
  await put('data/demo/tags/function/nested/b.json', { values: ['#demo:nested/a'] });
  const result = data(await validate('data', { projectDir: root, mcVersion: '1.21.1' }));
  assert.ok(result.findings.some(f => f.message.includes('Cyclic')));
  assert.ok(!result.findings.some(f => f.message.includes('Missing local reference demo:absent')));
}));

test('worldgen validates local dimension and structure references', async () => fixture(async (root, put) => {
  await put('data/demo/dimension/sky.json', { type: 'demo:sky', generator: { settings: 'demo:sky' } });
  await put('data/demo/worldgen/placed_feature/ore.json', { feature: 'demo:ore' });
  await put('data/demo/worldgen/feature/ore.json', { type: 'minecraft:ore' });
  let result = data(await validate('worldgen', { projectDir: root, mcVersion: '26.3' }));
  assert.equal(result.errors, 2);
  await put('data/demo/dimension_type/sky.json', {});
  await put('data/demo/worldgen/noise_settings/sky.json', {});
  result = data(await validate('worldgen', { projectDir: root, mcVersion: '26.3' }));
  assert.equal(result.errors, 0);
}));

test('plugin supports indirect Kotlin entry class without rejecting older api versions', async () => fixture(async (root, put) => {
  await put('src/main/resources/plugin.yml', 'name: Demo\nversion: "${version}"\nmain: demo.Demo\napi-version: "1.20"\n');
  await put('src/main/kotlin/demo/Bootstrap.kt', 'package demo\nclass Demo : BasePlugin()');
  let result = data(await validate('plugin', { projectDir: root }));
  assert.equal(result.errors, 0);
  assert.ok(!result.findings.some(f => f.message.includes('not found')));
  await put('src/main/resources/paper-plugin.yml', 'name: Demo\nversion: "1"\nmain: demo.Demo\ncommands: {}\nfolia-supported: yes\n');
  result = data(await validate('plugin', { projectDir: root }));
  assert.ok(result.findings.some(f => f.message.includes('folia-supported')));
  await put('src/main/resources/plugin.yml', 'name: [');
  assert.ok(data(await validate('plugin', { projectDir: root })).findings.some(f => f.message.includes('Invalid YAML')));
}));

test('mod descriptors use real TOML parsing and check Fabric mixin registration', async () => fixture(async (root, put) => {
  await put('src/main/resources/META-INF/mods.toml', 'modLoader="javafml"\nloaderVersion="[47,)"\nlicense="MIT"\n[[mods]]\nmodId="demo"\nversion="1"\n');
  assert.equal(data(await validate('mod', { projectDir: root })).errors, 0);
  await put('src/main/resources/META-INF/mods.toml', '[[mods]\n');
  assert.ok(data(await validate('mod', { projectDir: root })).findings.some(f => f.message.includes('Invalid TOML')));
  await put('src/main/resources/fabric.mod.json', { schemaVersion: 1, id: 'demo', version: '1', mixins: ['demo.mixins.json'] });
  assert.ok(data(await validate('mod', { projectDir: root })).findings.some(f => f.message.includes('Missing mixin')));
}));

test('module checks detect loader imports in common', async () => fixture(async (root, put) => {
  await put('settings.gradle.kts', 'include("common", "fabric", "neoforge")');
  await put('gradle.properties', 'minecraft_version=1.21.1\n');
  await put('common/build.gradle.kts', 'plugins { java }');
  await put('common/src/main/java/demo/X.java', 'import net.fabricmc.api.ModInitializer;');
  await put('fabric/build.gradle.kts', 'plugins { id("fabric-loom") }');
  await put('neoforge/build.gradle.kts', 'plugins { id("net.neoforged.moddev") }');
  const result = data(await validate('modules', { projectDir: root }));
  assert.ok(result.findings.some(f => f.message.includes('Loader-specific import')));
}));

test('malformed resource shapes produce findings rather than exceptions', async () => fixture(async (root, put) => {
  await put('assets/demo/models/item/x.json', { textures: 3, overrides: {} });
  await put('assets/demo/font/x.json', { providers: 3 });
  const result = data(await validate('resources', { projectDir: root }));
  assert.ok(result.errors > 0);
}));

test('metadata bounds, animation sidecars and array predicates are checked correctly', async () => fixture(async (root, put) => {
  await put('pack.mcmeta', { pack: { description: 'Demo', min_format: [97, 2], max_format: [97, 1] } });
  await put('assets/demo/textures/block/x.png.mcmeta', { animation: {} });
  let result = data(await validate('resources', { projectDir: root }));
  assert.ok(result.findings.some(f => f.message.includes('exceeds')));
  assert.ok(result.findings.some(f => f.message.includes('matching PNG')));
  await put('data/demo/predicate/ready.json', [{ condition: 'minecraft:random_chance', chance: 0.5 }]);
  result = data(await validate('data', { projectDir: root, mcVersion: '1.21.1' }));
  assert.ok(!result.findings.some(f => f.message.includes('Expected an object')));
}));

test('Stonecutter Minecraft version variants do not report version drift', async () => fixture(async (root, put) => {
  await put('settings.gradle.kts', 'plugins { id("dev.kikugie.stonecutter") version "0.7.7" }\nstonecutter { create(rootProject) }');
  await put('build.gradle.kts', 'plugins { id("dev.architectury.loom") }');
  await put('stonecutter.gradle.kts', 'stonecutter active "1.20.1-forge"');
  await put('gradle.properties', 'modId=demo\n');
  await put('versions/1.20.1-forge/gradle.properties', 'loom.platform=forge\n');
  await put('versions/1.21.1-neoforge/gradle.properties', 'loom.platform=neoforge\n');
  const result = data(await validate('modules', { projectDir: root }));
  assert.ok(!(result.findings ?? []).some(f => f.message.includes('different Minecraft versions')));
  assert.equal(result.errors, 0);
}));

test('Maven plugin modules detect duplicate plugin identities', async () => fixture(async (root, put) => {
  await put('pom.xml', '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging><modules><module>a</module><module>b</module></modules></project>');
  for (const name of ['a', 'b']) {
    await put(`${name}/pom.xml`, `<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>${name}</artifactId><version>1</version></project>`);
    await put(`${name}/src/main/resources/plugin.yml`, 'name: Duplicate\nmain: demo.Main\nversion: "1"\napi-version: "1.21"\n');
  }
  const result = data(await validate('modules', { projectDir: root }));
  assert.ok(result.findings.some(f => f.message.includes('Duplicate plugin name')));
}));

test('MCP exposes and executes validators through target routing', async () => fixture(async (root, put) => {
  await put('assets/demo/models/item/x.json', {});
  const server = createServer({ mod: async () => ({}) });
  const client = new Client({ name: 'validation-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const list = await client.listTools();
    for (const name of ['validate_resources', 'validate_plugin', 'validate_mod', 'validate_data', 'validate_worldgen', 'validate_modules']) assert.ok(list.tools.some(t => t.name === name));
    const result = await client.callTool({ name: 'validate_resources', arguments: { request: { target: 'mod', projectDir: root } } });
    assert.equal(result.isError, false);
  } finally { await client.close(); await server.close(); }
}));
