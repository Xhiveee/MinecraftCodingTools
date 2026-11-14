import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { auditImplementation } from '../dist/common/implementation-audit.js';
import { failedBuildUnit, buildEvidence } from '../dist/common/build-evidence.js';
import { gradleMaxJvm } from '../dist/common/gradle-jvm.js';
import { groupCompilerMessages, parseCompilerOutput } from '../dist/common/compiler.js';
import { runProcess, spawnPlan } from '../dist/common/run-process.js';
import { verifyRequirements } from '../dist/common/verification.js';
import { pickJdk } from '../dist/plugin/jdk/discover.js';
import { paperLifecycle, paperSmokeTest } from '../dist/plugin/tools/paper-smoke.js';
import { diagnose as diagnosePlugin } from '../dist/plugin/diagnostics/parse.js';
import { createServer } from '../dist/server.js';
import { gradleState, mavenState } from '../dist/common/project-state.js';
import { loadConfig as modConfig } from '../dist/mod/config.js';
import { loadConfig as pluginConfig } from '../dist/plugin/config.js';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mct-reliability-'));
  try {
    await run(root, async (file, data) => {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      return target;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('acceptance uses exact JUnit cases, archive entries and component freshness', () => fixture(async (root, put) => {
  const source = await put('src/Demo.java', 'class Demo {}');
  await utimes(source, 10, 10);
  const jar = new AdmZip();
  jar.addFile('demo/Demo.class', Buffer.from('fixture entry'));
  await put('build/demo.jar', jar.toBuffer());
  await put('results.xml', `<testsuites><testsuite><testcase classname="demo.DemoTest" name="passes"/>
    <testcase classname="demo.DemoTest" name="skip"><skipped/></testcase>
    <testcase classname="demo.DemoTest" name="fails"><failure>broken</failure></testcase>
    <testcase classname="demo.DemoTest" name="fails"/>
  </testsuite></testsuites>`);
  const junit = testName => ({ kind: 'junit', file: 'results.xml', className: 'demo.DemoTest', testName });
  const entry = { kind: 'jar_entry', file: 'build/demo.jar', entry: 'demo/Demo.class' };
  const verify = async requirements => (await verifyRequirements({ projectDir: root, requirements: requirements.map((r, i) => ({
    id: String(i), behavior: 'Example behavior', components: ['src/Demo.java'], ...r,
  })) })).structuredContent.requirements.map(r => r.status);
  assert.deepEqual(await verify([
    { checks: [entry, junit('passes')] }, { checks: [junit('passes')], runtimeRequired: true },
    { checks: [junit('fails')] }, { checks: [junit('skip')] }, { checks: [junit('missing')] },
    { checks: [{ ...entry, entry: 'other.class' }] }, { checks: [entry] }, { checks: [], components: ['missing.java'] },
    { checks: [{ kind: 'source_contains', file: '../outside', text: 'class' }] },
  ]), ['verified_by_report', 'runtime_unverified', 'verification_failed', 'blocked', 'blocked', 'implementation_incomplete',
    'behavior_unverified', 'implementation_incomplete', 'blocked']);
  const newer = Date.now() / 1000 + 60;
  await utimes(source, newer, newer);
  assert.deepEqual(await verify([{ checks: [junit('passes')] }, { checks: [entry] }]), ['blocked', 'blocked']);
}));

test('audit scopes findings to selected lines and ignores marker-like string literals', () => fixture(async (root, put) => {
  await put('Demo.java', `class Demo {
  // TODO legacy
  String sample = "FIXME and throw new UnsupportedOperationException()";
  @EventHandler public void onJoin(Event e) { /* no behavior */ }
  void rejected() { throw new UnsupportedOperationException("stub"); }
  boolean valid() { return true; }
}`);
  await put('Demo.kt', 'fun save() = TODO("persist")\n// FIXME finish\n');
  const args = { projectDir: root, files: [{ file: 'Demo.java', fromLine: 3 }, { file: 'Demo.kt' }, { file: 'missing.kt' }] };
  const first = (await auditImplementation({ ...args, limit: 2 })).structuredContent;
  assert.deepEqual(first.findings.map(f => [f.code, f.line]), [['empty_event_handler', 4], ['unsupported_throw', 5]]);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.unavailable.length, 1);
  const second = (await auditImplementation({ ...args, offset: 2 })).structuredContent;
  assert.deepEqual(second.findings.map(f => f.code), ['kotlin_todo', 'comment_marker']);
}));

test('runner captures unterminated UTF-8 lines across chunks and sends graceful stop', () => fixture(async root => {
  const logFile = path.join(root, 'console.log');
  const observed = [];
  const run = await runProcess({
    command: process.execPath, cwd: root, logFile, timeoutMs: 5000,
    args: ['-e', `process.stdin.once("data", data => {
      if (data.toString().trim() !== "stop") process.exit(1);
      const b = Buffer.from("выключен");
      process.stdout.write(b.subarray(0, 1));
      setTimeout(() => process.stdout.end(b.subarray(1)), 15);
    }); console.log("ready");`],
    shutdown: { input: 'stop\n', timeoutMs: 1000 },
    onLine: line => { observed.push(line); if (line === 'ready') return 'stop'; },
  });
  assert.equal(run.exitCode, 0);
  assert.ok(run.stoppedEarly);
  assert.equal(run.forced, false);
  assert.deepEqual(run.tail, ['ready', 'выключен']);
  assert.deepEqual(observed, run.tail);
  assert.equal(await readFile(logFile, 'utf8'), 'ready\nвыключен');
}));

test('runner enforces timeout, cancellation, output ceiling and spawn failure', () => fixture(async root => {
  const options = { command: process.execPath, cwd: root, timeoutMs: 5000, args: ['-e', 'setInterval(() => {}, 10)'] };
  const overdue = await runProcess({ ...options, timeoutMs: 100, logFile: path.join(root, 'timeout.log') });
  assert.ok(overdue.timedOut && overdue.forced);
  const controller = new AbortController();
  const cancelling = runProcess({ ...options, signal: controller.signal, logFile: path.join(root, 'abort.log'), args: ['-e', 'console.log("ready"); setInterval(() => {}, 10)'],
    onLine: () => { controller.abort(); },
  });
  assert.equal((await cancelling).aborted, true);
  const logFile = path.join(root, 'capped.log');
  const oversized = await runProcess({ ...options, logFile, maxLogBytes: 256, args: ['-e', 'console.log("x".repeat(4096)); setInterval(() => {}, 10)'] });
  assert.ok(oversized.logLimitExceeded);
  assert.equal((await readFile(logFile)).length, 256);
  await assert.rejects(runProcess({ ...options, command: path.join(root, 'missing'), logFile: path.join(root, 'spawn.log') }), /ENOENT/);
}));

test('build categorizes failing module tasks and Java compatibility', () => {
  assert.equal(failedBuildUnit('> Task :fabric:compileJava FAILED'), ':fabric:compileJava');
  assert.equal(failedBuildUnit("Execution failed for task ':paper:test'."), ':paper:test');
  assert.match(failedBuildUnit('[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.0:test (default-test) on project demo: test failures'), /^demo /);
  const evidence = buildEvidence({ exitCode: 1 }, [{ severity: 'error', kind: 'compile_error' }, { severity: 'warning', kind: 'jvm_mismatch' }],
    { dir: '/project/fabric', rootDir: '/project' }, [':fabric:build'], [':fabric:compileJava']);
  assert.deepEqual(evidence.failureKinds, ['compilation']);
  assert.equal(evidence.buildRoot, '/project');
  assert.equal(gradleMaxJvm('9.1-rc-1'), 25);
  assert.equal(gradleMaxJvm('9.4.0'), 26);
  assert.equal(gradleMaxJvm('8.7'), 21);
  assert.match(pickJdk([{ isJdk: true, major: 25 }], 17, '', 21).missing, /17–21/);
  assert.equal(spawnPlan('C:\\space dir\\gradlew.bat', [':fabric:build'], 'win32').verbatim, true);
  assert.throws(() => spawnPlan('gradlew.bat', ['%CUSTOM%'], 'win32'), /wrapper arguments/);
});

test('Maven diagnostics preserve the full artifact coordinate and explain offline cache mismatch', () => {
  const report = diagnosePlugin('Caused by: The following artifacts could not be resolved: net.kyori:adventure-bom:pom:4.17.0 (present, but unavailable): Cannot access papermc in offline mode');
  assert.equal(report.findings[0].message, 'Could not resolve net.kyori:adventure-bom:pom:4.17.0.');
  assert.match(report.findings[0].suggestion, /repository ID/);
});

test('Gradle repeated javac output retains the diagnostic with symbol details', () => {
  const { messages } = parseCompilerOutput([
    'C:/demo/src/Main.java:6: error: cannot find symbol',
    '> Task :compileJava FAILED',
    'C:/demo/src/Main.java:6: error: cannot find symbol',
    '  symbol: variable MissingType',
    '  location: class Main',
  ]);
  const grouped = groupCompilerMessages(messages);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].symbol.name, 'MissingType');
});

test('Paper lifecycle matches selected plugin identity and detects shutdown failure evidence', () => {
  const lifecycle = paperLifecycle({ name: 'Demo', version: '1.0' }, 'mct-0-Demo.jar');
  for (const line of [
    '[12:00:00] [Server thread/INFO]: [Other] Enabling Other v1.0',
    '[12:00:01 INFO]: [Demo] Enabling Demo v1.0*',
    '[12:00:02 INFO]: Done (2.133s)! For help, type "help"',
    '[12:00:03 INFO]: Stopping server',
    '[12:00:03 INFO]: [Demo] Disabling Demo v1.0',
    '[12:00:04 ERROR]: Error occurred while disabling Demo v1.01 (Is it up to date?)',
  ]) lifecycle.observe(line);
  assert.deepEqual(Object.keys(lifecycle.evidence), ['enabling', 'serverReady', 'stopping', 'disabling']);
  lifecycle.observe('[12:00:04 ERROR]: Error occurred (in the plugin loader) while disabling Demo v1.0 (Is it up to date?)');
  assert.match(lifecycle.evidence.pluginError, /disabling Demo/);
  const early = paperLifecycle({ name: 'Demo', version: '1.0' }, 'mct-0-Demo.jar');
  early.observe('[12:00:01 INFO]: [Demo] Disabling Demo v1.0');
  early.observe('[12:00:02 INFO]: Stopping server');
  assert.ok(early.evidence.disabledEarly);
  assert.equal(early.evidence.disabling, undefined);
});

test('Paper smoke test blocks missing JARs instead of spawning a server', () => fixture(async root => {
  const args = { projectDir: root, javaHome: 'missing', serverJar: 'paper.jar', pluginJar: 'demo.jar', allowExecution: true, acceptEula: true };
  const result = await paperSmokeTest(args);
  assert.equal(result.structuredContent.status, 'blocked');
  assert.equal(result.structuredContent.runDir, undefined);
}));

test('MCP advertises target schemas and retries failed service initialization', () => fixture(async (root, put) => {
  await put('Example.kt', 'fun example() = TODO()');
  let attempts = 0;
  const server = createServer({ plugin: async () => { if (++attempts === 1) throw new Error('temporary setup error'); return {}; } });
  const client = new Client({ name: 'reliability-tests', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.find(tool => tool.name === 'paper_smoke_test').annotations.readOnlyHint, false);
    const audit = target => client.callTool({ name: 'audit_implementation', arguments: { request: { target, projectDir: root, files: [{ file: 'Example.kt' }] } } });
    assert.equal((await audit('plugin')).isError, true);
    assert.equal((await audit('plugin')).structuredContent.findings[0].code, 'kotlin_todo');
    assert.equal((await audit('mod')).structuredContent.total, 1);
    const invalid = await client.callTool({ name: 'paper_smoke_test', arguments: { request: { target: 'mod', projectDir: root } } });
    assert.equal(invalid.isError, true);
    const consent = await client.callTool({ name: 'paper_smoke_test', arguments: { request: {
      target: 'plugin', projectDir: root, javaHome: 'missing', serverJar: 'paper.jar', pluginJar: 'demo.jar', acceptEula: true,
    } } });
    assert.equal(consent.isError, true);
    assert.equal(consent.structuredContent, undefined);
  } finally {
    await client.close();
    await server.close();
  }
}));

test('build state overrides the inherited Gradle home and scopes tool caches to the build root', () => fixture(async root => {
  const gradle = await gradleState(root, { GRADLE_USER_HOME: 'outside', PATH: 'jdk' });
  const maven = await mavenState(root, { MAVEN_USER_HOME: 'outside' });
  const local = path.join(root, '.mct');
  assert.equal(gradle.env.GRADLE_USER_HOME, path.join(local, 'gradle'));
  assert.equal(gradle.env.PATH, 'jdk');
  assert.equal(gradle.env.TMPDIR, path.join(local, 'tmp'));
  assert.equal(gradle.args[gradle.args.indexOf('--project-cache-dir') + 1], path.join(local, 'gradle-project'));
  assert.equal(maven.env.MAVEN_USER_HOME, path.join(local, 'maven'));
  assert.deepEqual(maven.args, [`-Dmaven.repo.local=${path.join(local, 'maven', 'repository')}`]);
  assert.equal(modConfig({ FFN_CACHE_DIR: 'override' }, root).cacheDir, path.join(local, 'mod'));
  assert.equal(pluginConfig({ MCT_WORKSPACE_DIR: root }).cacheDir, path.join(local, 'plugin'));
  assert.equal(pluginConfig({ BSP_CACHE_DIR: 'override' }).cacheDir, 'override');
}));

test('MCP shares an archive index between modules and isolates different build roots', () => fixture(async (root, put) => {
  const jar = new AdmZip();
  // A Java 8 class with an empty constructor, kept in the fixture so the test needs no JDK.
  jar.addFile('Demo.class', Buffer.from(
    'cafebabe00000034000a01000444656d6f0700010100106a6176612f6c616e672f4f626a6563740700030100063c696e69743e0100032829560c000500060a00040007010004436f6465002100020004000000000001000100050006000100090000001100010001000000052ab70008b1000000000000',
    'hex',
  ));
  const binary = await put('external/demo.jar', jar.toBuffer());
  jar.addFile('Demo.java', Buffer.from('public class Demo {}\n'));
  const sources = await put('external/demo-sources.jar', jar.toBuffer());
  for (const project of ['first', 'second']) {
    await put(`${project}/settings.gradle`, "include 'nested'");
    await put(`${project}/nested/build.gradle`, 'plugins { id "java" }');
  }
  const server = createServer();
  const client = new Client({ name: 'project-storage-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    for (const target of ['mod', 'plugin']) {
      const getIndex = async (projectDir, jarPath = binary) => {
        const response = await client.callTool({ name: 'inspect_code_archive', arguments: { request: { target, projectDir, jarPath, sourcesJarPath: sources } } });
        assert.equal(response.isError, undefined, response.content[0].text);
        return JSON.parse(response.content[0].text.split('\n').at(-1)).indexDir;
      };
      const first = path.join(root, 'first');
      const nested = path.join(first, 'nested');
      const index = await getIndex(first);
      assert.ok(index.startsWith(path.join(first, '.mct', target, 'index') + path.sep));
      assert.equal(await getIndex(nested, path.relative(nested, binary)), index);
      const second = path.join(root, 'second');
      assert.ok((await getIndex(path.join(second, 'nested'))).startsWith(path.join(second, '.mct', target, 'index') + path.sep));
      const source = await client.callTool({ name: 'get_code_archive_class', arguments: {
        request: { target, projectDir: nested, jarPath: path.relative(nested, binary), className: 'Demo' },
      } });
      assert.match(source.content[0].text, /public class Demo/);
    }
  } finally {
    await client.close();
    await server.close();
  }
}));
