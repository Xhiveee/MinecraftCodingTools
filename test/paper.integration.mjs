import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { paperSmokeTest } from '../dist/plugin/tools/paper-smoke.js';

const run = promisify(execFile);
const { MCT_PAPER_SERVER_JAR, MCT_PAPER_API_JAR, MCT_PAPER_JDK, MCT_PAPER_ACCEPT_EULA } = process.env;

test('real Paper reports clean lifecycle and plugin onEnable failure', { timeout: 450_000 }, async () => {
  assert.ok(MCT_PAPER_SERVER_JAR && MCT_PAPER_API_JAR && MCT_PAPER_JDK && MCT_PAPER_ACCEPT_EULA === 'true',
    'Set MCT_PAPER_SERVER_JAR, MCT_PAPER_API_JAR, MCT_PAPER_JDK, and MCT_PAPER_ACCEPT_EULA=true for this authorized run.');
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'mct-paper-integration-'));
  const javaHome = path.resolve(MCT_PAPER_JDK);
  const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  try {
    for (const broken of [false, true]) {
      const source = path.join(projectDir, 'LifecyclePlugin.java');
      await writeFile(source, `package demo;
import org.bukkit.plugin.java.JavaPlugin;
public final class LifecyclePlugin extends JavaPlugin {
    @Override public void onEnable() {
        ${broken ? 'throw new IllegalStateException("Expected lifecycle fixture failure");' : 'getLogger().info("Lifecycle fixture enabled");'}
    }
    @Override public void onDisable() {
        getLogger().info("Lifecycle fixture disabled");
    }
}
`);
      await run(javac, ['-cp', path.resolve(MCT_PAPER_API_JAR), '-d', projectDir, source], { timeout: 20_000 });
      const zip = new AdmZip();
      zip.addFile('plugin.yml', Buffer.from("name: MctLifecycle\nversion: '1.0'\nmain: demo.LifecyclePlugin\n"));
      zip.addFile('demo/LifecyclePlugin.class', await readFile(path.join(projectDir, 'demo', 'LifecyclePlugin.class')));
      const pluginJar = path.join(projectDir, 'fixture.jar');
      await writeFile(pluginJar, zip.toBuffer());
      const result = await paperSmokeTest({
        projectDir, javaHome, pluginJar, serverJar: path.resolve(MCT_PAPER_SERVER_JAR), acceptEula: true, allowExecution: true,
      });
      const evidence = result.structuredContent;
      assert.equal(evidence.status, broken ? 'plugin_failure' : 'passed', JSON.stringify(evidence));
      assert.equal(evidence.exitCode, 0);
      assert.equal(evidence.forced, false);
      assert.match(await readFile(evidence.logFile, 'utf8'), broken ? /Expected lifecycle fixture failure/ : /Lifecycle fixture disabled/);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
