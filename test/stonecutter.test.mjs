import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readProjectInfo } from '../dist/mod/project/info.js';

test('Stonecutter discovers dynamic version modules, shared sources and active project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mct-stonecutter-'));
  try {
    await writeFile(path.join(root, 'settings.gradle.kts'), `plugins { id("dev.kikugie.stonecutter") version "0.7.7-beta.2" }
stonecutter { centralScript = "build.gradle.kts"
shared { rootProject.projectDir.resolve("versions").listFiles().filter { !it.isFile }.forEach { version(it.name) } }
create(rootProject) }`);
    await writeFile(path.join(root, 'build.gradle.kts'), 'plugins { id("dev.architectury.loom"); kotlin("jvm") }');
    await writeFile(path.join(root, 'gradle.properties'), 'modId=example\nkotlinVersion=2.2.0\n');
    await writeFile(path.join(root, 'stonecutter.gradle.kts'), 'stonecutter active "1.20.1-forge"');
    await mkdir(path.join(root, 'src/main/kotlin'), { recursive: true });
    await mkdir(path.join(root, 'src/main/resources'), { recursive: true });
    for (const [name, loader, version] of [['1.20.1-forge', 'forge', '1.20.1'], ['1.21.1-neoforge', 'neoforge', '1.21.1'], ['1.21-fabric', 'fabric', '1.21']]) {
      const module = path.join(root, 'versions', name);
      await mkdir(module, { recursive: true });
      await writeFile(path.join(module, 'gradle.properties'), `loom.platform=${loader}\n`);
      const info = await readProjectInfo(module);
      assert.equal(info.rootDir, root);
      assert.equal(info.gradlePath, `:${name}`);
      assert.equal(info.classpathProject, `:${name}`);
      assert.equal(info.loader, loader);
      assert.equal(info.mcVersion, version);
      assert.equal(info.modId, 'example');
      assert.equal(info.kotlinPluginVersion, '2.2.0');
      assert.ok(info.kotlinSourceRoots.includes(path.join(root, 'src/main/kotlin')));
    }
    const selected = await readProjectInfo(root);
    assert.equal(selected.loader, 'forge');
    assert.equal(selected.mcVersion, '1.20.1');
    assert.equal(selected.classpathProject, ':1.20.1-forge');
    await writeFile(path.join(root, 'versions/1.20.1-forge/gradle.properties'), 'loom.platform=forge\nminecraft_version=1.20.2');
    assert.equal((await readProjectInfo(path.join(root, 'versions/1.20.1-forge'))).mcVersion, '1.20.2');
    await writeFile(path.join(root, 'settings.gradle.kts'), 'rootProject.name = "ordinary"');
    await writeFile(path.join(root, 'versions/1.20.1-forge/gradle.properties'), 'loom.platform=forge');
    await assert.rejects(readProjectInfo(path.join(root, 'versions/1.20.1-forge')), /Could not determine/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary ForgeGradle projects still use their declared version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mct-forge-'));
  try {
    await writeFile(path.join(root, 'build.gradle'), "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }");
    await writeFile(path.join(root, 'gradle.properties'), 'minecraft_version=1.20.1\nforge_version=47.2.0');
    const info = await readProjectInfo(root);
    assert.equal(info.loader, 'forge');
    assert.equal(info.mcVersion, '1.20.1');
    assert.equal(info.rootDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
