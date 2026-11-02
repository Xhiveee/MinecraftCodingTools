import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = `${manifest.displayName}-v${manifest.version}`;
const zip = await readFile(path.join(root, 'releases', `${name}.zip`));
const checksum = await readFile(path.join(root, 'releases', `${name}.zip.sha256`), 'utf8');
assert.equal(checksum.split(' ')[0], createHash('sha256').update(zip).digest('hex'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'MinecraftCodingTools-release-'));
let client;
try {
  new AdmZip(zip).extractAllTo(temp);
  const extracted = path.join(temp, name);
  const install = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev'], { cwd: extracted, encoding: 'utf8', windowsHide: true })
    : spawnSync('npm', ['ci', '--omit=dev'], { cwd: extracted, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  client = new Client({ name: 'archive-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(extracted, 'dist', 'index.js')], stderr: 'pipe' }));
  assert.deepEqual(client.getServerVersion(), { name: 'MinecraftCodingTools', version: manifest.version });
  assert.ok((await client.listTools()).tools.length > 0);
  for (const file of ['profiles/mod/fabric.yaml', 'profiles/plugin/paper.yaml', 'skills/minecraft-coding-tools/SKILL.md']) assert.ok((await readFile(path.join(extracted, file))).length);
  console.log('PASS: ZIP checksum, isolated production install, stdio MCP handshake, tools, profiles and skill.');
} finally {
  await client?.close();
  await rm(temp, { recursive: true, force: true });
}
