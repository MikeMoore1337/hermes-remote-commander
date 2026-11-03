#!/usr/bin/env node
// Real end-to-end BRC relay handshake against disposable loopback SQLite.
// Run from pinned upstream source root AFTER pnpm build + Hermes relay patch.
// Never opens production ports, uses owner secrets or connects real devices.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const root = process.cwd();
const requireRelay = createRequire(path.join(root, 'packages/relay/package.json'));
const WebSocket = requireRelay('ws');
const { buildRelay } = await import(pathToFileURL(path.join(root, 'packages/relay/dist/app.js')).href);
const { invokeTool, listUserDevices } = await import(pathToFileURL(path.join(root, 'packages/relay/dist/mcp/invoke.js')).href);
const { liveTools } = await import(pathToFileURL(path.join(root, 'packages/relay/dist/mcp/server.js')).href);
const temp = mkdtempSync(path.join(tmpdir(), 'hermes-brc-wss-auth-'));
const secret = () => randomBytes(32).toString('hex');
const relay = buildRelay({
  port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1',
  trustProxy: false,
  dbFile: path.join(temp, 'relay.sqlite'),
  sessionSecret: secret(), adminUser: 'unit-only', adminPassword: secret(),
  relayVersion: 'test-pinned',
}, () => {});
let goodSocket = null;
let staleSocket = null;
let rotatedSocket = null;

async function connectOnce(uri, opts = {}) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(uri, opts);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WEBSOCKET_HANDSHAKE_TIMEOUT'));
    }, 4000);
    let done = false;
    const complete = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    ws.once('open', () => complete({ accepted: true, socket: ws }));
    ws.once('unexpected-response', (_req, response) => {
      const status = response.statusCode;
      response.resume();
      complete({ accepted: false, status });
    });
    ws.on('error', (err) => {
      // Some Node runtimes report a connection reset after the 401 response.
      complete({ accepted: false, errorCode: err.code || 'NETWORK_REJECTED' });
    });
    ws.once('close', () => complete({ accepted: false, errorCode: 'SOCKET_CLOSED' }));
  });
}

try {
  await new Promise((resolve, reject) => {
    relay.http.once('error', reject);
    relay.http.listen(0, '127.0.0.1', resolve);
  });
  const addr = relay.http.address();
  if (!addr || typeof addr === 'string') throw Error('PORT_NOT_ASSIGNED');
  const base = 'ws://127.0.0.1:' + addr.port + '/ws';
  const user = relay.store.getUserByName('unit-only');
  if (!user) throw Error('USER_NOT_CREATED');
  const validToken = relay.store.issueDeviceToken('sandbox-agent', user.id, 'sandbox-agent', 'linux');

  const queryOnly = await connectOnce(base + '?token=' + encodeURIComponent(validToken));
  if (queryOnly.accepted) throw Error('QUERY_DEVICE_TOKEN_ACCEPTED');
  console.log('WSS_TOKEN_QUERY_ONLY=DENIED');

  const queryAndBearer = await connectOnce(base + '?token=' + encodeURIComponent(validToken), {
    headers: { Authorization: 'Bearer ' + validToken },
  });
  if (queryAndBearer.accepted) throw Error('QUERY_TOKEN_WITH_BEARER_ACCEPTED');
  console.log('WSS_TOKEN_QUERY_WITH_BEARER=DENIED');

  const missing = await connectOnce(base);
  if (missing.accepted) throw Error('MISSING_BEARER_ACCEPTED');
  console.log('WSS_MISSING_BEARER=DENIED');

  const bad = await connectOnce(base, { headers: { Authorization: 'Bearer unauthorized' } });
  if (bad.accepted) throw Error('BAD_BEARER_ACCEPTED');
  console.log('WSS_INVALID_BEARER=DENIED');

  const good = await connectOnce(base, { headers: { Authorization: 'Bearer ' + validToken } });
  if (!good.accepted) throw Error(`VALID_BEARER_REJECTED: ${good.status ?? good.errorCode}`);
  goodSocket = good.socket;
  console.log('WSS_VALID_BEARER=ACCEPTED');

  // Authenticate before rotation but deliberately delay the hello frame.
  const stale = await connectOnce(base, { headers: { Authorization: 'Bearer ' + validToken } });
  if (!stale.accepted) throw Error('SECOND_VALID_BEARER_REJECTED');
  staleSocket = stale.socket;
  const hello = {
    type: 'hello', protocol: 1,
    device: {deviceId:'sandbox-agent',name:'sandbox-agent',platform:'linux',
      hostname:'ci',arch:'x64',agentVersion:'ci',coreVersion:'ci'},
    tools: [{name:'read_file',description:'synthetic',inputSchema:{type:'object'}}],
  };

  // Only the authenticated WSS connection receives an immutable credential hash.
  // A direct SQLite re-key simulates the interval before the old socket closes.
  goodSocket.send(JSON.stringify(hello));
  let connected;
  for (let attempt = 0; attempt < 50; attempt++) {
    connected = relay.hub.get('sandbox-agent');
    if (connected) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!connected || connected.ownerId !== user.id) throw Error('AUTHENTICATED_HELLO_NOT_BOUND');
  const expectedHash = relay.store.getDevice('sandbox-agent')?.token_hash;
  const property = Object.getOwnPropertyDescriptor(connected.socket,'hermesAuthTokenHash');
  if (!expectedHash || property?.value !== expectedHash ||
      property?.writable !== false || property?.enumerable !== false ||
      property?.configurable !== false || property.value === validToken) {
    throw Error('SOCKET_AUTH_CREDENTIAL_BINDING_INVALID');
  }
  console.log('WSS_AUTH_SOCKET_TOKEN_HASH=IMMUTABLY_BOUND');

  relay.store.setDevicePaused('sandbox-agent', true);
  const pausedDevice = listUserDevices(relay.hub, relay.store, user.id)[0];
  if (!pausedDevice?.online || !pausedDevice.paused || liveTools(relay.hub, relay.store, user.id).online !== 0) {
    throw Error('PAUSED_CONNECTED_DEVICE_STATE_INVALID');
  }
  relay.store.setDevicePaused('sandbox-agent', false);

  // A second approved owner must not claim an existing device ID by polling
  // an unrelated pairing grant. No credential or ownership may change.
  const foreign = relay.store.upsertUser('foreign-ci-owner', secret());
  const foreignCode = relay.store.createDeviceCode('foreign-ci-agent', 60000);
  relay.store.approveDeviceCode(foreignCode.device_code,foreign.id,'sandbox-agent');
  const foreignAttempt = await fetch('http://127.0.0.1:' + addr.port + '/device/poll', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({device_code:foreignCode.device_code,
      device_id:'sandbox-agent',name:'untrusted-claim',platform:'linux'}),
  });
  const foreignBody = await foreignAttempt.json();
  if (foreignAttempt.status !== 409 || foreignBody.error !== 'device_id_conflict' ||
      relay.store.getDevice('sandbox-agent')?.user_id !== user.id ||
      relay.store.getDevice('sandbox-agent')?.token_hash !== expectedHash) {
    throw Error('CROSS_OWNER_DEVICE_ID_TAKEOVER');
  }
  console.log('WSS_FOREIGN_DEVICE_ID_PAIRING=DENIED');

  const ctx = {userId:user.id,clientId:'synthetic-only'};
  const args = {deviceId:'sandbox-agent',path:'/workspace/synthetic.txt'};
  const newToken = relay.store.issueDeviceToken('sandbox-agent',user.id,'sandbox-agent','linux');
  const rotated = await invokeTool(relay.hub,relay.store,ctx,'read_file',args);
  if (rotated.ok || rotated.status !== 403) throw Error('OLD_SOCKET_AUTH_AFTER_REKEY');
  if (listUserDevices(relay.hub, relay.store, user.id)[0]?.online || liveTools(relay.hub, relay.store, user.id).online !== 0) {
    throw Error('REVOKED_SOCKET_REPORTED_ONLINE');
  }
  console.log('WSS_ROTATED_OLD_SOCKET_MCP=DENIED');

  const current = await connectOnce(base, { headers: { Authorization: 'Bearer ' + newToken } });
  if (!current.accepted) throw Error('ROTATED_BEARER_REJECTED');
  rotatedSocket = current.socket;
  rotatedSocket.send(JSON.stringify(hello));
  let currentConnection;
  for (let attempt = 0; attempt < 50; attempt++) {
    currentConnection = relay.hub.get('sandbox-agent');
    if (currentConnection?.socket.hermesAuthTokenHash === relay.store.getDevice('sandbox-agent')?.token_hash) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!currentConnection || currentConnection.socket.hermesAuthTokenHash !== relay.store.getDevice('sandbox-agent')?.token_hash) {
    throw Error('ROTATED_HELLO_NOT_BOUND');
  }
  const staleOutcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('STALE_HELLO_TIMEOUT')), 4000);
    staleSocket.once('message', () => { clearTimeout(timer); resolve({type:'message'}); });
    staleSocket.once('close', code => { clearTimeout(timer); resolve({type:'close',code}); });
  });
  staleSocket.send(JSON.stringify(hello));
  const result = await staleOutcome;
  if (result.type !== 'close' || result.code !== 4401 || relay.hub.get('sandbox-agent') !== currentConnection) {
    throw Error('REVOKED_DELAYED_HELLO_REPLACED_CURRENT_SOCKET');
  }
  console.log('WSS_DELAYED_REVOKED_HELLO=DENIED');

  let calls = 0;
  rotatedSocket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== 'call') return;
    calls++;
    rotatedSocket.send(JSON.stringify({type:'result', id:message.id, result:{content:[{type:'text',text:'synthetic-ok'}]}}));
  });
  const routed = await invokeTool(relay.hub,relay.store,ctx,'read_file',args,{timeoutMs:2000});
  if (!routed.ok || routed.result.content[0]?.text !== 'synthetic-ok' || calls !== 1) {
    throw Error('CURRENT_SOCKET_FAILED_AFTER_STALE_HELLO');
  }
  console.log('WSS_CURRENT_SOCKET_AFTER_STALE_HELLO=SINGLE_CALL');

  relay.store.deleteDevice('sandbox-agent');
  const deleted = await invokeTool(relay.hub,relay.store,ctx,'read_file',args);
  if (deleted.ok || deleted.status !== 403) throw Error('DELETED_DEVICE_CALL_FORWARDED');
  console.log('WSS_DELETED_DEVICE_MCP=DENIED');


  console.log('HERMES_BRC_WSS_AUTH_E2E=PASS');
} finally {
  if (goodSocket) goodSocket.terminate();
  if (staleSocket) staleSocket.terminate();
  if (rotatedSocket) rotatedSocket.terminate();
  await relay.close();
  rmSync(temp, { recursive: true, force: true });
}
