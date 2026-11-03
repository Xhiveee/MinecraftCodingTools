import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { loadConfig as modConfig } from '../dist/mod/config.js';
import { loadConfig as pluginConfig } from '../dist/plugin/config.js';
import { parse } from 'java-parser';
import { readProjectInfo } from '../dist/mod/project/info.js';
import { IndexService } from '../dist/mod/index/service.js';
import { resolveMixinEnvironment } from '../dist/mod/mixin/environment.js';

test('project metadata prefers .mct and keeps legacy .ffn read-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mct-metadata-'));
  try {
    const legacy = { loader: 'forge', mcVersion: '1.20.1', mappings: 'mojmap' };
    await mkdir(path.join(root, '.ffn'));
    await writeFile(path.join(root, '.ffn/project.json'), JSON.stringify(legacy));
    const oldInfo = await readProjectInfo(root);
    assert.equal(oldInfo.source, 'ffn');
    assert.equal(oldInfo.loader, 'forge');
    await mkdir(path.join(root, '.mct'));
    await writeFile(path.join(root, '.mct/project.json'), JSON.stringify({ ...legacy, loader: 'neoforge', mcVersion: '1.21.1' }));
    const info = await readProjectInfo(root);
    assert.equal(info.source, 'mct');
    assert.equal(info.loader, 'neoforge');
    assert.equal(info.mcVersion, '1.21.1');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.ffn/project.json'), 'utf8')), legacy);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('classpath and Mixin resolvers use .mct even when Gradle cannot start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mct-project-state-'));
  try {
    await writeFile(path.join(root, 'build.gradle'), "plugins { id 'net.minecraftforge.gradle' }");
    await writeFile(path.join(root, 'gradle.properties'), 'minecraft_version=1.20.1\nforge_version=47.2.0');
    const info = await readProjectInfo(root);
    const services = {};
    await assert.rejects(new IndexService(services).projectClasspath(info), /No Gradle wrapper/);
    await access(path.join(root, '.mct/mct-classpath.gradle'));
    const environment = await resolveMixinEnvironment(services, info);
    assert.ok(environment.notes.some((note) => note.includes('No Gradle wrapper')));
    await assert.rejects(access(path.join(root, '.ffn')));
    await assert.rejects(access(path.join(root, '.bsp')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Java parser remains operational with patched transitive dependencies', () => {
  assert.equal(parse('class Example { int answer() { return 42; } }').name, 'compilationUnit');
});

test('MCP initialization reports release identity, tools and installed profiles', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = createServer();
  const client = new Client({ name: 'release-check', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    assert.deepEqual(client.getServerVersion(), { name: 'MinecraftCodingTools', version: manifest.version });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ['build', 'search_source', 'list_project_artifacts', 'get_code_archive_class']) assert.ok(names.includes(name));
    assert.match(client.getInstructions(), /compile dependencies/);
    for (const config of [modConfig({}), pluginConfig({})]) assert.ok((await readFile(`${config.builtinProfilesDir}/${config.builtinProfilesDir.endsWith('mod') ? 'fabric' : 'paper'}.yaml`, 'utf8')).length);
    const skill = await readFile(new URL('../skills/minecraft-coding-tools/SKILL.md', import.meta.url), 'utf8');
    assert.match(skill, /^name: minecraft-coding-tools$/m);
  } finally { await client.close(); await server.close(); }
});
