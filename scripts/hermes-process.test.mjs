import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'brc-process-test-'));
process.env.BRC_HOME = home;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { callTool, listTools } = await import('../packages/agent/dist/dispatcher.js');
const { usageTracker } = await import('../packages/agent/dist/core/utils/usageTracker.js');
usageTracker.trackSuccess = usageTracker.trackFailure = async () => {};
after(() => rmSync(home, { recursive: true, force: true }));

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
