import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { loadConfig as modConfig } from '../dist/mod/config.js';
import { loadConfig as pluginConfig } from '../dist/plugin/config.js';
import { parse } from 'java-parser';

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
