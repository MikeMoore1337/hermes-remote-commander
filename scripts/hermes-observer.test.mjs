import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observation, observerEnabled, publishObservation } from '../packages/relay/dist/hermes-observer.js';

const now = 1_800_000_000_000;
const device = (id, name, paused = 0) => ({ device_id: id, user_id: 'owner', name, paused, token_hash: 'hash', last_seen: now - 1000 });
const workspace = (deviceId, name) => ({ deviceId, name, root: `/workspace/projects/${name}`, branch: 'main', scope: 'sandbox', origin: `https://github.com/example/${name}`, aliases: [] });
function fixture() {
  const rows = [device('device-one', 'Laptop'), device('device-two', 'Sandbox', 1)];
  const sockets = new Map(rows.map(row => [row.device_id, { ownerId: 'owner', lastSeen: now - 1000, socket: { hermesAuthTokenHash: 'hash' } }]));
  return { rows, sockets, store: { listDevices: () => rows, getDevice: id => rows.find(row => row.device_id === id) }, hub: { get: id => sockets.get(id) } };
}

test('snapshot binds each project to its own current owner grant and socket', () => {
  const f = fixture();
  const projects = [workspace('device-one', 'alpha'), workspace('device-two', 'beta'), workspace('foreign-device', 'hidden')];
  const value = observation(f.hub, f.store, 'owner', projects, now);
  assert.equal(value.status, 'partial');
  assert.equal(value.native_host_access, 'not_verified');
  assert.deepEqual(value.devices.map(d => d.status), ['online', 'paused']);
  assert.deepEqual(value.workspaces.map(w => [w.name, w.device_name, w.state]), [
    ['alpha', 'Laptop', 'reachable_not_git_verified'], ['beta', 'Sandbox', 'not_ready'],
  ]);
  assert.doesNotMatch(JSON.stringify(value), /device-one|device-two|foreign-device|token_hash|hash/);
  f.sockets.get('device-one').lastSeen = now - 301_000;
  assert.equal(observation(f.hub, f.store, 'owner', projects, now).workspaces[0].state, 'not_ready');
  f.sockets.get('device-one').lastSeen = now - 1_000;
  f.sockets.get('device-one').socket.hermesAuthTokenHash = 'revoked';
  assert.equal(observation(f.hub, f.store, 'owner', projects, now).workspaces[0].state, 'not_ready');
  f.rows[1].name = 'Laptop';
  assert.throws(() => observation(f.hub, f.store, 'owner', projects, now), /observer_invalid_device/);
});

test('publisher requires a private opt-in and refuses unsafe targets', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brc-observer-'));
  const marker = path.join(directory, '.hermes-brc-observer-enable');
  const target = path.join(directory, 'hermes-brc-observation.json');
  const f = fixture();
  const value = observation(f.hub, f.store, 'owner', [workspace('device-one', 'alpha')], now);
  try {
    assert.equal(observerEnabled(directory), false);
    assert.equal(publishObservation(directory, value), false);
    assert.equal(fs.existsSync(target), false);
    fs.writeFileSync(marker, 'enabled\n', { mode: 0o600 });
    assert.equal(publishObservation(directory, value), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), value);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    fs.chmodSync(marker, 0o644);
    assert.equal(publishObservation(directory, value), false);
    fs.chmodSync(marker, 0o600);
    fs.chmodSync(directory, 0o755);
    assert.equal(observerEnabled(directory), false);
    fs.chmodSync(directory, 0o700);
    fs.unlinkSync(target);
    fs.symlinkSync(marker, target);
    assert.throws(() => publishObservation(directory, value), /observer_target_untrusted/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'enabled\n');
    fs.unlinkSync(target);
    fs.renameSync(marker, target);
    fs.symlinkSync(target, marker);
    assert.equal(observerEnabled(directory), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
