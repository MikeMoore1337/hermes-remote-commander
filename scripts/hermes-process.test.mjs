import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'brc-process-test-'));
process.env.BRC_HOME = home;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { callTool, listTools } = await import('../packages/agent/dist/dispatcher.js');
const { usageTracker } = await import('../packages/agent/dist/core/utils/usageTracker.js');
usageTracker.trackSuccess = usageTracker.trackFailure = async () => {};
after(() => rmSync(home, { recursive: true, force: true }));

test('procfs fallback is bounded and excludes command arguments and environment', async () => {
  const { listLinuxProcfs } = await import('../packages/agent/dist/core/tools/process.js');
  const root = path.join(home, 'synthetic-proc');
  mkdirSync(root);
  for (const [pid, command] of [['11', 'worker\n'], ['12', 'line\x01break\n'], ['13', 'other\n']]) {
    const dir = path.join(root, pid);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'comm'), command);
    writeFileSync(path.join(dir, 'cmdline'), 'PRIVATE_SYNTHETIC_ARGUMENT');
    writeFileSync(path.join(dir, 'environ'), 'PRIVATE_SYNTHETIC_ENVIRONMENT');
  }
  mkdirSync(path.join(root, 'not-a-pid'));
  const all = await listLinuxProcfs(root);
  assert.equal(all.processes.length, 3);
  assert.equal(all.truncated, false);
  assert.ok(all.processes.some(p => p.command === 'line break'));
  assert.ok(all.processes.every(p => p.cpu === 'n/a' && p.memory === 'n/a'));
  assert.doesNotMatch(JSON.stringify(all), /PRIVATE_SYNTHETIC/);
  const limited = await listLinuxProcfs(root, 2);
  assert.equal(limited.processes.length, 2);
  assert.equal(limited.truncated, true);
  await assert.rejects(listLinuxProcfs(root, 0), /invalid_procfs_limit/);
  await assert.rejects(listLinuxProcfs(path.join(root, 'missing')), /ENOENT/);
});

test('procfs fallback refuses a symlinked process name', { skip: process.platform !== 'linux' }, async () => {
  const { listLinuxProcfs } = await import('../packages/agent/dist/core/tools/process.js');
  const root = path.join(home, 'symlink-proc');
  mkdirSync(path.join(root, '11'), { recursive: true });
  writeFileSync(path.join(root, 'private'), 'PRIVATE_SYNTHETIC_SECRET');
  symlinkSync('../private', path.join(root, '11', 'comm'));
  await assert.rejects(listLinuxProcfs(root), error => error.code === 'ELOOP');
});

test('Linux agent lists process names when ps is absent', { skip: process.platform !== 'linux' }, () => {
  const url = new URL('../packages/agent/dist/core/tools/process.js', import.meta.url).href;
  const script = `import {listProcesses} from ${JSON.stringify(url)}; const r=await listProcesses(); process.stdout.write(JSON.stringify(r)); if(r.isError) process.exitCode=1;`;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.match(raw, /PID: [0-9]+/);
  assert.match(raw, /Linux procfs fallback: names only; CPU and memory unavailable/);
});

test('Linux tool dispatcher returns fallback process names', { skip: process.platform !== 'linux' }, async () => {
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const result = await callTool('list_processes', {});
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /Linux procfs fallback: names only/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('Linux agent does not hide an existing ps failure behind procfs', { skip: process.platform !== 'linux' }, () => {
  const bin = path.join(home, 'broken-ps');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const url = new URL('../packages/agent/dist/core/tools/process.js', import.meta.url).href;
  const script = `import {listProcesses} from ${JSON.stringify(url)}; process.stdout.write(JSON.stringify(await listProcesses()));`;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(JSON.parse(raw).isError, true);
  assert.doesNotMatch(raw, /Linux procfs fallback/);
});

test('kill_process refuses group, malformed and protected PIDs without signalling', async () => {
  const original = process.kill;
  const calls = [];
  process.kill = (...args) => { calls.push(args); return true; };
  try {
    for (const pid of [-1, -2, 0, 1, 1.5, 2_147_483_648, NaN, Infinity, '2', process.pid]) {
      const result = await callTool('kill_process', { pid });
      assert.equal(result.isError, true, `PID ${pid} must be refused`);
    }
    assert.deepEqual(calls, []);
    const schema = listTools().find(tool => tool.name === 'kill_process').inputSchema;
    assert.equal(schema.properties.pid.minimum, 2);
    assert.equal(schema.properties.pid.maximum, 2_147_483_647);
    process.kill = () => false;
    assert.equal((await callTool('kill_process', { pid: process.pid === 2 ? 3 : 2 })).isError, true);
  } finally {
    process.kill = original;
  }
});

test('kill_process signals a real child without stopping a second child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const childExit = once(child, 'exit');
  const otherExit = once(other, 'exit');
  let timeout;
  try {
    await Promise.all([once(child, 'spawn'), once(other, 'spawn')]);
    const result = await callTool('kill_process', { pid: child.pid });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /signal sent/i);
    await Promise.race([childExit, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('child did not exit')), 5000);
    })]);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (other.exitCode === null && other.signalCode === null) other.kill();
    await Promise.allSettled([childExit, otherExit]);
  }
});

test('completed nonzero shell exit is an MCP error with readable output', async () => {
  const { configManager } = await import('../packages/agent/dist/core/config-manager.js');
  const originalGetConfig = configManager.getConfig;
  const originalGetValue = configManager.getValue;
  const originalGetOrCreateClientId = configManager.getOrCreateClientId;
  configManager.getConfig = async () => ({ blockedCommands: [], fileReadLineLimit: 1000 });
  configManager.getValue = async () => false;
  configManager.getOrCreateClientId = async () => 'synthetic';
  try {
    const windows = process.platform === 'win32';
    const command = windows ? 'echo EXPECTED_FAILURE_OUTPUT & exit /b 7' : "printf 'EXPECTED_FAILURE_OUTPUT\\n'; exit 7";
    const shell = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const result = await callTool('start_process', { command, shell, timeout_ms: 10000 });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result);
    assert.match(text, /EXPECTED_FAILURE_OUTPUT/);
    const pid = Number(text.match(/Process (\d+) exited with code 7/)?.[1]);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const output = await callTool('read_process_output', { pid, timeout_ms: 1000 });
    assert.equal(output.isError, true);
    assert.match(JSON.stringify(output), /EXPECTED_FAILURE_OUTPUT/);
    assert.match(JSON.stringify(output), /exit code 7/);
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    configManager.getConfig = originalGetConfig;
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalGetOrCreateClientId;
  }
});
