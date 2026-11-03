#!/usr/bin/env node
// #372: real ephemeral BRC relay + two fake WSS agents; exercise per-device
// routing, pause, offline and tool allowlist without any OS file/shell access.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const pwd = process.cwd();
const requireRelay = createRequire(path.join(pwd, 'packages/relay/package.json'));
const WS = requireRelay('ws');
const { buildRelay } = await import(pathToFileURL(path.join(pwd, 'packages/relay/dist/app.js')).href);
const { invokeTool, listUserDevices } = await import(pathToFileURL(path.join(pwd, 'packages/relay/dist/mcp/invoke.js')).href);
const { liveTools } = await import(pathToFileURL(path.join(pwd, 'packages/relay/dist/mcp/server.js')).href);
const { observation } = await import(pathToFileURL(path.join(pwd, 'packages/relay/dist/hermes-observer.js')).href);

const tmp = mkdtempSync(path.join(tmpdir(), 'hermes-two-agents-'));
const secret = () => randomBytes(24).toString('hex');
const relay = buildRelay({
  port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1',
  trustProxy: false, dbFile: path.join(tmp, 'state.sqlite'),
  sessionSecret: secret(), adminUser: 'owner-fixture',
  adminPassword: secret(), relayVersion: 'pinned-ci-only',
}, () => {});
const sockets = [];
const assert = (ok, name) => {
  if (!ok) throw Error('ROUTING_ASSERTION_FAILED:' + name);
  console.log(name + '=PASS');
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate) => {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return true;
    await pause(100);
  }
  return false;
};

try {
  await new Promise((resolve, reject) => {
    relay.http.once('error', reject);
    relay.http.listen(0, '127.0.0.1', resolve);
  });
  const addr = relay.http.address();
  if (!addr || typeof addr === 'string') throw Error('NO_EPHEMERAL_PORT');
  const owner = relay.store.getUserByName('owner-fixture');
  if (!owner) throw Error('MISSING_SYNTHETIC_USER');

  const devices = ['sandbox-one', 'sandbox-two'];
  for (const [index, id] of devices.entries()) {
    const credential = relay.store.issueDeviceToken(id, owner.id, index === 0 ? 'Fixture One' : 'Fixture Two', 'linux-test');
    const socket = new WS('ws://127.0.0.1:' + addr.port + '/ws', {
      headers: { Authorization: 'Bearer ' + credential }
    });
    sockets.push(socket);
    socket.on('message', (bytes) => {
      const msg = JSON.parse(String(bytes));
      if (msg.type === 'call') {
        socket.send(JSON.stringify({
          type: 'result', id: msg.id,
          result: { content: [{ type: 'text', text: id + ':synthetic-result' }] }
        }));
      }
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({
      type: 'hello', protocol: 1,
      device: { deviceId: id, name: id, platform: 'linux', arch: 'x64',
        hostname: id, agentVersion: 'fixture', coreVersion: 'fixture' },
      tools: [{ name: 'read_file', description: 'fixture read only',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    }));
  }
  assert(await until(() => relay.hub.list(owner.id).length === 2), 'TWO_AGENT_REAL_WSS_ONLINE');
  const workspaces = devices.map((deviceId, index) => ({ name: index ? 'beta' : 'alpha', aliases: [], deviceId,
    root: index ? '/workspace/projects/beta' : '/workspace/projects/alpha',
    origin: index ? 'https://github.com/example/beta' : 'https://github.com/example/alpha', branch: 'main', scope: 'sandbox' }));
  const otherOwner = relay.store.upsertUser('other-fixture', secret());
  relay.store.issueDeviceToken('foreign-device', otherOwner.id, 'Other Owner', 'linux-test');
  workspaces.push({ name: 'foreign', aliases: [], deviceId: 'foreign-device', root: '/workspace/projects/foreign',
    origin: 'https://github.com/example/foreign', branch: 'main', scope: 'sandbox' });
  let snapshot = observation(relay.hub, relay.store, owner.id, workspaces);
  assert(snapshot.devices.length === 2 && snapshot.workspaces.length === 2 &&
    snapshot.devices.every(d => d.status === 'online') && snapshot.workspaces.every(w => w.state === 'reachable_not_git_verified'),
    'TWO_AGENT_OBSERVER_CURRENT_SOCKETS');
  assert(relay.hub.resolveDefault(owner.id) === null, 'TWO_AGENT_AMBIGUOUS_ROUTING_REJECTED');
  const toolNames = new Set(liveTools(relay.hub, relay.store, owner.id).tools.map((t) => t.name));
  assert(toolNames.has('read_file') && !toolNames.has('get_config'), 'TWO_AGENT_GATEWAY_TOOL_FILTER');

  const ctx = { userId: owner.id, clientId: 'synthetic-client' };
  const noDevice = await invokeTool(relay.hub, relay.store, ctx, 'read_file', { path: 'fixture' });
  assert(!noDevice.ok && noDevice.status === 409, 'TWO_AGENT_EXPLICIT_DEVICE_REQUIRED');
  for (const id of devices) {
    const reply = await invokeTool(relay.hub, relay.store, ctx, 'read_file', {
      deviceId: id, path: 'fixture',
    });
    assert(reply.ok && reply.result.content[0].text === id + ':synthetic-result',
      'TWO_AGENT_ISOLATED_ROUTING_' + id.toUpperCase().replace('-', '_'));
  }
  const forbidden = await invokeTool(relay.hub, relay.store, ctx, 'get_config', {
    deviceId: 'sandbox-one',
  });
  assert(!forbidden.ok && forbidden.status === 403, 'TWO_AGENT_UNSAFE_TOOL_DENIED');
  relay.store.setDevicePaused('sandbox-two', true);
  snapshot = observation(relay.hub, relay.store, owner.id, workspaces);
  assert(snapshot.devices.find(d => d.name === 'Fixture Two')?.status === 'paused' && snapshot.workspaces.find(w => w.name === 'beta')?.state === 'not_ready',
    'TWO_AGENT_OBSERVER_PAUSE_ENFORCED');
  const paused = await invokeTool(relay.hub, relay.store, ctx, 'read_file', {
    deviceId: 'sandbox-two', path: 'fixture',
  });
  assert(!paused.ok && paused.status === 423, 'TWO_AGENT_OWNER_PAUSE_ENFORCED');
  relay.store.setDevicePaused('sandbox-two', false);
  sockets[1].close(1000);
  assert(await until(() => relay.hub.list(owner.id).length === 1), 'TWO_AGENT_DISCONNECT_DETECTED');
  const offline = await invokeTool(relay.hub, relay.store, ctx, 'read_file', {
    deviceId: 'sandbox-two', path: 'fixture',
  });
  assert(!offline.ok && offline.status === 404, 'TWO_AGENT_OFFLINE_CALL_DENIED');

  const seen = listUserDevices(relay.hub, relay.store, owner.id);
  assert(seen.length === 2 && seen.filter((d) => d.online).length === 1,
    'TWO_AGENT_REGISTRY_OFFLINE_VISIBLE');
  snapshot = observation(relay.hub, relay.store, owner.id, workspaces);
  assert(snapshot.devices.find(d => d.name === 'Fixture Two')?.status === 'offline' && snapshot.workspaces.find(w => w.name === 'beta')?.state === 'not_ready',
    'TWO_AGENT_OBSERVER_OFFLINE_ENFORCED');
  assert(!JSON.stringify(snapshot).includes('sandbox-one') && !JSON.stringify(snapshot).includes('sandbox-two'),
    'TWO_AGENT_OBSERVER_REDACTS_IDS');
  relay.store.issueDeviceToken('sandbox-one', owner.id, 'Fixture One', 'linux-test');
  snapshot = observation(relay.hub, relay.store, owner.id, workspaces);
  assert(snapshot.devices.find(d => d.name === 'Fixture One')?.status === 'offline' &&
    snapshot.workspaces.find(w => w.name === 'alpha')?.state === 'not_ready', 'TWO_AGENT_OBSERVER_REVOKED_SOCKET');
  console.log('HERMES_BRC_TWO_WSS_AGENT_ROUTING_E2E=PASS');
} finally {
  for (const socket of sockets) {
    try { socket.terminate(); } catch {}
  }
  await relay.close();
  rmSync(tmp, { recursive: true, force: true });
}
