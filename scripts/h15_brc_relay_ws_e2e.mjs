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
const adminPassword = secret();
const relay = buildRelay({
  port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1',
  trustProxy: false,
  dbFile: path.join(temp, 'relay.sqlite'),
  sessionSecret: secret(), adminUser: 'unit-only', adminPassword,
  relayVersion: 'test-pinned',
}, () => {});
let goodSocket = null;
let staleSocket = null;
let rotatedSocket = null;
const inflightSockets = [];

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

  // The owner approved a new device, not replacement of an unrelated
  // already-paired device of the same owner. The poller's device_id alone
  // must not authorize a silent re-key or displace the active socket.
  const unboundCode = relay.store.createDeviceCode('same-owner-unbound', 60000);
  relay.store.approveDeviceCode(unboundCode.device_code, user.id, '');
  const unboundAttempt = await fetch('http://127.0.0.1:' + addr.port + '/device/poll', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_code: unboundCode.device_code,
      device_id: 'sandbox-agent', name: 'unauthorized-replacement', platform: 'linux',
    }),
  });
  const unboundBody = await unboundAttempt.json();
  if (unboundAttempt.status !== 409 || unboundBody.error !== 'device_id_conflict' ||
      relay.store.getDevice('sandbox-agent')?.token_hash !== expectedHash ||
      relay.hub.get('sandbox-agent')?.socket !== connected) {
    throw Error('SAME_OWNER_UNBOUND_DEVICE_ID_TAKEOVER');
  }
  console.log('WSS_SAME_OWNER_UNBOUND_REPLACEMENT=DENIED');

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

  // Mutate the grant between dispatch and a real WebSocket result. This also
  // covers a result already in flight while the administrative close races it.
  for (const operation of ['rotate', 'delete']) {
    const id = `inflight-${operation}`;
    const token = relay.store.issueDeviceToken(id, user.id, id, 'linux');
    const connection = await connectOnce(base, {headers:{Authorization:'Bearer ' + token}});
    if (!connection.accepted) throw Error('INFLIGHT_SOCKET_REJECTED');
    const socket = connection.socket;
    inflightSockets.push(socket);
    socket.send(JSON.stringify({...hello, device:{...hello.device, deviceId:id, name:id}}));
    for (let attempt = 0; attempt < 50 && !relay.hub.get(id); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!relay.hub.get(id)) throw Error('INFLIGHT_HELLO_NOT_BOUND');
    const call = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('INFLIGHT_CALL_TIMEOUT')), 2000);
      socket.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'call') { clearTimeout(timer); resolve(message); }
      });
    });
    const outcome = invokeTool(relay.hub, relay.store, ctx, 'read_file',
      {deviceId:id, path:'/workspace/synthetic.txt'}, {timeoutMs:2000});
    const request = await call;
    if (operation === 'rotate') relay.store.issueDeviceToken(id, user.id, id, 'linux');
    else relay.store.deleteDevice(id);
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('REVOKED_SOCKET_NOT_CLOSED')), 2000);
      socket.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    socket.send(JSON.stringify({type:'result', id:request.id, result:{content:[{type:'text',text:'late'}]}}));
    const response = await outcome;
    if (response.ok) throw Error(`INFLIGHT_${operation.toUpperCase()}_RESULT_ACCEPTED`);
    if ((await closed) !== 4401) throw Error('REVOKED_SOCKET_CLOSE_CODE');
    const audit = relay.store.recentAudit(user.id, 100).find(row => row.device_id === id);
    if (!audit || audit.ok !== 0) throw Error('REVOKED_RESULT_RECORDED_SUCCESS');
  }
  console.log('WSS_INFLIGHT_REVOKED_RESULTS=DENIED_AND_AUDITED');

  const login = await fetch(`http://127.0.0.1:${addr.port}/auth/login`, {
    method:'POST', redirect:'manual', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({username:'unit-only',password:adminPassword}),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (login.status !== 302 || !cookie) throw Error('SYNTHETIC_ADMIN_LOGIN_FAILED');
  for (const operation of ['rotate', 'delete']) {
    const id = `admin-inflight-${operation}`;
    const token = relay.store.issueDeviceToken(id, user.id, id, 'linux');
    const connection = await connectOnce(base, {headers:{Authorization:'Bearer ' + token}});
    if (!connection.accepted) throw Error('ADMIN_INFLIGHT_SOCKET_REJECTED');
    const socket = connection.socket;
    inflightSockets.push(socket);
    socket.send(JSON.stringify({...hello, device:{...hello.device, deviceId:id, name:id}}));
    for (let attempt = 0; attempt < 50 && !relay.hub.get(id); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!relay.hub.get(id)) throw Error('ADMIN_INFLIGHT_HELLO_NOT_BOUND');
    const call = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('ADMIN_INFLIGHT_CALL_TIMEOUT')), 2000);
      socket.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'call') { clearTimeout(timer); resolve(message); }
      });
    });
    const outcome = invokeTool(relay.hub, relay.store, ctx, 'read_file',
      {deviceId:id, path:'/workspace/synthetic.txt'}, {timeoutMs:5000});
    const oldCall = await call;
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('ADMIN_REVOKED_SOCKET_NOT_CLOSED')), 2000);
      socket.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    let nextToken;
    if (operation === 'rotate') {
      const code = relay.store.createDeviceCode('synthetic-repair', 60000);
      relay.store.approveDeviceCode(code.device_code, user.id, id);
      const response = await fetch(`http://127.0.0.1:${addr.port}/device/poll`, {
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({device_code:code.device_code,device_id:id}),
      });
      if (!response.ok) throw Error('SYNTHETIC_ROTATION_FAILED');
      nextToken = (await response.json()).device_token;
    } else {
      const response = await fetch(`http://127.0.0.1:${addr.port}/admin/device`, {
        method:'POST',redirect:'manual',
        headers:{cookie,origin:'http://127.0.0.1','content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({device_id:id,action:'delete'}),
      });
      if (response.status !== 302) throw Error('SYNTHETIC_DELETE_FAILED');
    }
    const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
    if (!result || result.ok || !result.message.includes('DEVICE_DISCONNECTED')) throw Error('REVOKED_PENDING_NOT_REJECTED');
    if ((await closed) !== 4401) throw Error('ADMIN_REVOKED_SOCKET_CLOSE_CODE');
    const audit = relay.store.recentAudit(user.id, 100).find(row => row.device_id === id);
    if (!audit || audit.ok !== 0) throw Error('ADMIN_REVOKED_RESULT_RECORDED_SUCCESS');

    if (nextToken) {
      const fresh = await connectOnce(base, {headers:{Authorization:'Bearer ' + nextToken}});
      if (!fresh.accepted) throw Error('REPAIRED_SOCKET_REJECTED');
      const freshSocket = fresh.socket;
      inflightSockets.push(freshSocket);
      const messages = [];
      freshSocket.on('message', raw => messages.push(JSON.parse(String(raw))));
      freshSocket.send(JSON.stringify({...hello, device:{...hello.device, deviceId:id, name:id}}));
      for (let attempt = 0; attempt < 50 && !relay.hub.get(id); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (messages.some(message => message.type === 'call')) throw Error('OLD_CALL_REPLAYED');
      const next = invokeTool(relay.hub, relay.store, ctx, 'read_file',
        {deviceId:id,path:'/workspace/next.txt'}, {timeoutMs:2000});
      for (let attempt = 0; attempt < 50 && !messages.some(message => message.type === 'call'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const nextCall = messages.find(message => message.type === 'call');
      if (!nextCall || nextCall.id === oldCall.id) throw Error('NEW_CALL_NOT_DISTINCT');
      freshSocket.send(JSON.stringify({type:'result',id:oldCall.id,result:{content:[{type:'text',text:'old'}]}}));
      const early = await Promise.race([next, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
      if (early) throw Error('OLD_RESULT_RESOLVED_NEW_CALL');
      freshSocket.send(JSON.stringify({type:'result',id:nextCall.id,result:{content:[{type:'text',text:'new'}]}}));
      const delivered = await next;
      if (!delivered.ok || delivered.result.content[0]?.text !== 'new') throw Error('NEW_CALL_FAILED');
    }
  }
  console.log('WSS_ADMIN_REVOKE_REJECTS_PENDING_NO_REPLAY=PASS');

  for (const [index, frame] of [
    {type:'hello',protocol:1},
    {...hello,device:null},
    {...hello,tools:[null]},
  ].entries()) {
    const id = `malformed-${index}`;
    const token = relay.store.issueDeviceToken(id, user.id, id, 'linux');
    const connection = await connectOnce(base, {headers:{Authorization:'Bearer ' + token}});
    if (!connection.accepted) throw Error('MALFORMED_SOCKET_REJECTED_TOO_EARLY');
    const socket = connection.socket;
    inflightSockets.push(socket);
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('MALFORMED_HELLO_NOT_CLOSED')), 2000);
      socket.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    socket.send(JSON.stringify(frame));
    if ((await closed) !== 1002 || relay.hub.get(id)) throw Error('MALFORMED_HELLO_ACCEPTED');
  }
  const closingId = 'closing-socket';
  const closingToken = relay.store.issueDeviceToken(closingId, user.id, closingId, 'linux');
  const closing = await connectOnce(base, {headers:{Authorization:'Bearer ' + closingToken}});
  if (!closing.accepted) throw Error('CLOSING_SOCKET_REJECTED');
  inflightSockets.push(closing.socket);
  closing.socket.send(JSON.stringify({...hello,device:{...hello.device,deviceId:closingId,name:closingId}}));
  for (let attempt = 0; attempt < 50 && !relay.hub.get(closingId); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const closingServer = relay.hub.get(closingId);
  if (!closingServer) throw Error('CLOSING_SOCKET_NOT_BOUND');
  closingServer.socket.close(1000, 'synthetic close');
  if (relay.hub.get(closingId) || relay.hub.list(user.id).some(device => device.deviceId === closingId) ||
      listUserDevices(relay.hub, relay.store, user.id).find(device => device.deviceId === closingId)?.online) {
    throw Error('CLOSING_SOCKET_REPORTED_ONLINE');
  }
  console.log('WSS_MALFORMED_HELLO_AND_CLOSING_SOCKET=DENIED');

  console.log('HERMES_BRC_WSS_AUTH_E2E=PASS');
} finally {
  if (goodSocket) goodSocket.terminate();
  if (staleSocket) staleSocket.terminate();
  if (rotatedSocket) rotatedSocket.terminate();
  for (const socket of inflightSockets) socket.terminate();
  await relay.close();
  rmSync(temp, { recursive: true, force: true });
}
