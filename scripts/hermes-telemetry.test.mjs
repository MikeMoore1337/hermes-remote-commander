import { test } from 'node:test';
import assert from 'node:assert/strict';

test('disabled telemetry does not initialize identity or read configuration', async () => {
  const { configManager } = await import('../packages/agent/dist/core/config-manager.js');
  const { capture } = await import('../packages/agent/dist/core/utils/capture.js');
  const oldOptIn = process.env.BRC_UPSTREAM_TELEMETRY;
  const oldDisable = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  const oldId = configManager.getOrCreateClientId;
  const oldGet = configManager.getValue;
  let calls = 0;
  configManager.getOrCreateClientId = async () => { calls++; return 'synthetic'; };
  configManager.getValue = async () => { calls++; return false; };
  try {
    delete process.env.BRC_UPSTREAM_TELEMETRY;
    delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    await capture('synthetic-default');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    process.env.BRC_UPSTREAM_TELEMETRY = '1';
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    await capture('synthetic-test');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally {
    configManager.getOrCreateClientId = oldId;
    configManager.getValue = oldGet;
    if (oldOptIn === undefined) delete process.env.BRC_UPSTREAM_TELEMETRY;
    else process.env.BRC_UPSTREAM_TELEMETRY = oldOptIn;
    if (oldDisable === undefined) delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    else process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = oldDisable;
  }
});
