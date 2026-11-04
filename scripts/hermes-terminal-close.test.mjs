import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

test('output arriving after process exit is included once streams close', async () => {
  const child = new EventEmitter();
  child.pid = 2_147_483_000;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => child;
  syncBuiltinESMExports();
  try {
    const { TerminalManager } = await import('../packages/agent/dist/core/terminal-manager.js');
    const manager = new TerminalManager();
    const pending = manager.executeCommand('synthetic', 1000, '/bin/sh');
    child.exitCode = 0;
    child.emit('exit', 0);
    assert.equal(manager.readOutputPaginated(child.pid, 0, 100).isComplete, false);
    assert.equal(manager.forceTerminate(child.pid), false);
    child.stdout.emit('data', Buffer.from('LAST_STDOUT\n'));
    child.stderr.emit('data', Buffer.from('LAST_STDERR\n'));
    child.emit('close', 0);
    const result = await pending;
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /LAST_STDOUT/);
    assert.match(result.output, /LAST_STDERR/);
    const retained = manager.readOutputPaginated(child.pid, 0, 100);
    assert.equal(retained.isComplete, true);
    assert.match(retained.lines.join('\n'), /LAST_STDOUT/);
    assert.match(retained.lines.join('\n'), /LAST_STDERR/);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test('late stream closure cannot remove a replacement session with the same PID', async () => {
  const children = [new EventEmitter(), new EventEmitter()];
  for (const child of children) {
    child.pid = 2_147_482_999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
  }
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => children.shift();
  syncBuiltinESMExports();
  try {
    const { TerminalManager } = await import('../packages/agent/dist/core/terminal-manager.js');
    const manager = new TerminalManager();
    const first = children[0];
    const second = children[1];
    const firstCall = manager.executeCommand('first', 1000, '/bin/sh');
    first.exitCode = 0;
    first.emit('exit', 0);
    const secondCall = manager.executeCommand('second', 1000, '/bin/sh');
    first.emit('close', 0);
    await firstCall;
    assert.equal(manager.getSession(second.pid).process, second);
    second.exitCode = 0;
    second.emit('exit', 0);
    second.emit('close', 0);
    await secondCall;
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test('termination escalation is not sent after process exit while pipes drain', async () => {
  const child = new EventEmitter();
  child.pid = 2_147_482_998;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => child;
  syncBuiltinESMExports();
  try {
    const { TerminalManager } = await import('../packages/agent/dist/core/terminal-manager.js');
    const manager = new TerminalManager();
    const pending = manager.executeCommand('synthetic', 3000, '/bin/sh');
    assert.equal(manager.forceTerminate(child.pid), true);
    child.exitCode = 0;
    child.emit('exit', 0);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(signals, ['SIGINT']);
    child.emit('close', 0);
    await pending;
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});
