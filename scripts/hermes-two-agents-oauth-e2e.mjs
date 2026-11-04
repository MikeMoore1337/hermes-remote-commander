#!/usr/bin/env node
// #372: complete real browser OAuth PKCE -> HTTP MCP -> two real nonroot
// brc-agent processes in distinct disposable Docker filesystem namespaces.
// This runs INSIDE isolated CI only. Never touches owner machines.
import { createHash, randomBytes } from 'node:crypto';

const base = process.env.PUBLIC_URL ?? 'http://localhost:3000';
const user = process.env.BRC_ADMIN_USER ?? 'ci-owner';
const pass = process.env.BRC_ADMIN_PASSWORD;
if (!pass) throw Error('CI_PASSWORD_NOT_PROVIDED');

const must = (ok, label) => {
  if (!ok) throw Error('TWO_NATIVE_MCP_FAILED:' + label);
  console.log(label + '=PASS');
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (res) => JSON.parse(await res.text());
const form = (obj) => new URLSearchParams(obj);
const b64 = (data) => data.toString('base64url');

let online = false;
for (let i = 0; i < 65; i++) {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1200) });
    const health = await r.json();
    if (r.ok && health.devices === 2) { online = true; break; }
  } catch {}
  await pause(250);
}
must(online, 'TWO_NATIVE_WSS_AGENTS_ONLINE');

const prm = await readJson(await fetch(base + '/.well-known/oauth-protected-resource/mcp'));
const meta = await readJson(await fetch(base + '/.well-known/oauth-authorization-server'));
must(prm.resource === base + '/mcp' && !!meta.authorization_endpoint &&
     !!meta.registration_endpoint && !!meta.token_endpoint,
     'TWO_NATIVE_OAUTH_DISCOVERY');
const redirectUri = 'https://hermes-ci.invalid/oauth-dummy';
const register = await readJson(await fetch(meta.registration_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'H15 isolated CI only',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none' }),
}));
must(!!register.client_id, 'TWO_NATIVE_CLIENT_REGISTERED');

const verifier = b64(randomBytes(32));
const challenge = b64(createHash('sha256').update(verifier).digest());
const state = b64(randomBytes(12));
const authUrl = new URL(meta.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: 'code', client_id: register.client_id,
  redirect_uri: redirectUri, code_challenge: challenge,
  code_challenge_method: 'S256', state, scope: 'mcp:tools',
  resource: prm.resource,
})) authUrl.searchParams.set(k, v);

const loginPage = await fetch(authUrl, { redirect: 'manual' });
const loginLoc = loginPage.headers.get('location') ?? '';
must(loginPage.status === 302 && loginLoc.startsWith('/auth/login'),
     'TWO_NATIVE_OAUTH_REDIRECT_TO_LOGIN');
const logged = await fetch(base + '/auth/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({
    username: user, password: pass,
    returnTo: new URL(loginLoc, base).searchParams.get('returnTo') ?? '',
  }),
});
const cookie = (logged.headers.get('set-cookie') ?? '').split(';')[0];
const consentLoc = logged.headers.get('location') ?? '';
must(logged.status === 302 && cookie.startsWith('brc_session='),
     'TWO_NATIVE_OWNER_LOGIN');
const consentPage = await fetch(new URL(consentLoc, base), { headers: { cookie } });
const html = await consentPage.text();
const pending = html.match(/name="pending" value="([^"]+)"/)?.[1];
must(consentPage.status === 200 && !!pending, 'TWO_NATIVE_OWNER_CONSENT_PAGE');
const consent = await fetch(base + '/auth/consent', {
  method: 'POST', redirect: 'manual',
  headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ pending, decision: 'allow' }),
});
const callback = new URL(consent.headers.get('location') ?? base);
const code = callback.searchParams.get('code');
must(consent.status === 302 && code && callback.searchParams.get('state') === state,
     'TWO_NATIVE_PKCE_CODE_GRANTED');
const token = await readJson(await fetch(meta.token_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({
    grant_type: 'authorization_code', code, code_verifier: verifier,
    client_id: register.client_id, redirect_uri: redirectUri,
    resource: prm.resource,
  }),
}));
must(typeof token.access_token === 'string' && token.access_token.length > 20,
     'TWO_NATIVE_OAUTH_ACCESS_TOKEN');

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: 'Bearer ' + token.access_token,
};
let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(base + '/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  const m = text.match(/^data: (.+)$/m);
  const obj = JSON.parse(m?.[1] ?? text);
  if (!response.ok || obj.error) {
    throw Error('MCP_HTTP_ERROR:' + method + ':' + response.status);
  }
  return obj.result;
}
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'hermes-native-ci', version: '1' },
});
must(init.serverInfo?.name === 'brc', 'TWO_NATIVE_MCP_INITIALIZE');
const t = await rpc('tools/list', {});
const tools = new Set(t.tools.map((x) => x.name));
must(tools.has('read_file') && tools.has('write_file') &&
     tools.has('start_process') && tools.has('list_devices'),
     'TWO_NATIVE_MCP_REAL_FILE_AND_PROCESS_TOOLS');
must(!tools.has('get_config') && !tools.has('send_file_transfer') &&
     !tools.has('set_config_value') && !tools.has('get_recent_tool_calls'),
     'TWO_NATIVE_MCP_RESTRICTED_TOOLSET');
const call = (name, args) => rpc('tools/call', { name, arguments: args });

must(tools.has('list_workspaces') && tools.has('resolve_workspace'), 'WORKSPACE_TOOLS_ADVERTISED');
const catalog = JSON.parse((await call('list_workspaces', {})).content[0].text);
must(catalog.status === 'catalog' && catalog.workspaces.length === 2 &&
     catalog.workspaces.every(w => w.scope === 'sandbox' && w.device_status === 'online' && w.git_verified === false),
     'WORKSPACE_OWNER_CATALOG');
for (const [project, deviceId, root, expected] of [
  ['first project', 'ci-native-one', '/workspace/projects/alpha', 'real-ci-agent-one'],
  ['second project', 'ci-native-two', '/workspace/projects/beta', 'real-ci-agent-two'],
]) {
  const result = await call('resolve_workspace', { project });
  const resolved = JSON.parse(result.content[0].text);
  must(result.isError !== true && resolved.status === 'resolved' && resolved.deviceId === deviceId &&
       resolved.root === root && resolved.git_verified === false && resolved.verification_required_before_write === true,
       'WORKSPACE_RESOLVE_' + project.toUpperCase().replaceAll(' ', '_'));
  const file = await call('read_file', { deviceId: resolved.deviceId, path: resolved.root + '/identity.txt' });
  must(file.isError !== true && JSON.stringify(file).includes(expected), 'WORKSPACE_ROUTED_READ_' + deviceId.toUpperCase());
}
const unknownWorkspace = await call('resolve_workspace', { project: '../../production' });
must(unknownWorkspace.isError === true, 'WORKSPACE_UNKNOWN_OR_PRODUCTION_REFUSED');

const list = await call('list_devices', {});
const discovered = JSON.parse(list.content[0].text).devices;
const ids = new Set(discovered.filter((x) => x.online).map((x) => x.deviceId));
must(ids.size === 2 && ids.has('ci-native-one') && ids.has('ci-native-two'),
     'TWO_NATIVE_REAL_MCP_DISCOVERY');
const implicit = await call('read_file', { path: '/workspace/identity.txt' });
must(implicit.isError === true, 'TWO_NATIVE_AMBIGUOUS_DEVICE_REFUSED');

for (const [id, expected] of [
  ['ci-native-one', 'real-ci-agent-one'],
  ['ci-native-two', 'real-ci-agent-two'],
]) {
  const result = await call('read_file', {
    deviceId: id, path: '/workspace/identity.txt',
  });
  const text = JSON.stringify(result);
  must(result.isError !== true && text.includes(expected),
       'TWO_NATIVE_REAL_FILE_READ_' + id.toUpperCase().replaceAll('-', '_'));
  must(!text.includes(id === 'ci-native-one' ? 'real-ci-agent-two' : 'real-ci-agent-one'),
       'TWO_NATIVE_NO_CROSS_DEVICE_CONTENT_' + id.toUpperCase().replaceAll('-', '_'));
}

const write = await call('write_file', {
  deviceId: 'ci-native-one', path: '/workspace/mcp-owner-proof.txt',
  content: 'owner-approved-ephemeral-mcp-file', mode: 'rewrite',
});
must(write.isError !== true, 'TWO_NATIVE_REAL_FILE_WRITE');
const readBack = await call('read_file', {
  deviceId: 'ci-native-one', path: '/workspace/mcp-owner-proof.txt',
});
must(readBack.isError !== true &&
     JSON.stringify(readBack).includes('owner-approved-ephemeral-mcp-file'),
     'TWO_NATIVE_WRITTEN_FILE_READ_BACK');

const deniedPath = await call('write_file', {
  deviceId: 'ci-native-two', path: '/app/package.json',
  content: 'unauthorized', mode: 'rewrite',
});
must(deniedPath.isError === true, 'TWO_NATIVE_SOURCE_WRITE_DENIED');
const deniedRead = await call('read_file', {
  deviceId: 'ci-native-two', path: '/root/.ssh/id_ed25519',
});
must(deniedRead.isError === true, 'TWO_NATIVE_HOST_PRIVATE_KEY_UNAVAILABLE');

const terminal = await call('start_process', {
  deviceId: 'ci-native-two', command: 'echo hermes-two-native-ci-shell',
  timeout_ms: 10000,
});
must(terminal.isError !== true &&
     JSON.stringify(terminal).includes('hermes-two-native-ci-shell'),
     'TWO_NATIVE_REAL_SHELL_ECHO');

// A rejected group PID must not kill the agent or its isolated siblings.
const badPid = await call('kill_process', { deviceId: 'ci-native-two', pid: -1 });
must(badPid.isError === true, 'TWO_NATIVE_GROUP_PID_REFUSED');
const running = await call('start_process', {
  deviceId: 'ci-native-two', timeout_ms: 1000,
  command: `exec node -e 'setInterval(() => {}, 1000)'`,
});
const pidText = JSON.stringify(running).match(/Process started with PID (\d+)/)?.[1];
const pid = Number(pidText);
must(running.isError !== true && Number.isSafeInteger(pid) && pid > 1,
     'TWO_NATIVE_LONG_PROCESS_STARTED');
const signalled = await call('kill_process', { deviceId: 'ci-native-two', pid });
must(signalled.isError !== true && JSON.stringify(signalled).includes('signal sent'),
     'TWO_NATIVE_PROCESS_SIGNAL_SENT');
let exited = false;
for (let attempt = 0; attempt < 20 && !exited; attempt++) {
  const check = await call('start_process', {
    deviceId: 'ci-native-two', timeout_ms: 1000,
    command: `if kill -0 ${pid} 2>/dev/null; then echo PID_STILL_RUNNING; else echo PID_EXITED; fi`,
  });
  exited = check.isError !== true && JSON.stringify(check).includes('PID_EXITED');
  if (!exited) await new Promise(resolve => setTimeout(resolve, 100));
}
must(exited, 'TWO_NATIVE_PROCESS_EXIT_OBSERVED');

const development = await call('start_process', {
  deviceId: 'ci-native-two', timeout_ms: 10000,
  command: "mkdir -p /workspace/git-fixture && printf fixture > /workspace/git-fixture/fixture.txt && git -C /workspace/git-fixture init -q -b fixture && git -C /workspace/git-fixture add fixture.txt && git -C /workspace/git-fixture -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture && test -z \"$(git -C /workspace/git-fixture status --porcelain)\" && git -C /workspace/git-fixture rev-parse --abbrev-ref HEAD && python3 -c 'print(\"python-ok\")'",
});
must(development.isError !== true && JSON.stringify(development).includes('fixture') &&
     JSON.stringify(development).includes('python-ok'), 'TWO_NATIVE_REAL_GIT_AND_PYTHON');

const disallowed = await call('get_config', { deviceId: 'ci-native-one' });
must(disallowed.isError === true, 'TWO_NATIVE_DIRECT_CONFIG_ACCESS_DENIED');

// The synthetic admin can pause exactly one device while the other
// remains available. Validate through the same MCP HTTP client.
const paused = await fetch(base + '/admin/device', {
  method: 'POST', redirect: 'manual',
  headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ device_id: 'ci-native-two', action: 'pause' }),
});
must(paused.status === 302, 'TWO_NATIVE_OWNER_PAUSE_APPLIED');
const pauseResult = await call('read_file', {
  deviceId: 'ci-native-two', path: '/workspace/identity.txt',
});
must(pauseResult.isError === true, 'TWO_NATIVE_PAUSED_DEVICE_REFUSED');
const pausedWorkspace = await call('resolve_workspace', { project: 'second project' });
must(pausedWorkspace.isError === true, 'WORKSPACE_PAUSED_DEVICE_REFUSED');
const unaffected = await call('read_file', {
  deviceId: 'ci-native-one', path: '/workspace/identity.txt',
});
must(unaffected.isError !== true && JSON.stringify(unaffected).includes('real-ci-agent-one'),
     'TWO_NATIVE_OTHER_DEVICE_UNAFFECTED');

const oversized = await fetch(base + '/mcp', {
  method: 'POST', headers,
  body: JSON.stringify({ jsonrpc: '2.0', id: 98, method: 'tools/call', params: {
    name: 'read_multiple_files', arguments: { deviceId: 'ci-native-one', paths: Array(10001).fill('/workspace/identity.txt') },
  } }),
});
must(oversized.status === 413, 'TWO_NATIVE_OVERSIZED_MCP_COLLECTION_REFUSED');
const afterOversized = await call('read_file', { deviceId: 'ci-native-one', path: '/workspace/identity.txt' });
must(afterOversized.isError !== true && JSON.stringify(afterOversized).includes('real-ci-agent-one'),
     'TWO_NATIVE_NORMAL_REQUEST_AFTER_OVERSIZED');
const largeWrite = await call('write_file', {
  deviceId: 'ci-native-one', path: '/workspace/large-fixture.txt', content: 'x'.repeat(256 * 1024), mode: 'rewrite',
});
must(largeWrite.isError !== true, 'TWO_NATIVE_LARGE_STRING_WRITE_ACCEPTED');
const largeInfo = await call('get_file_info', { deviceId: 'ci-native-one', path: '/workspace/large-fixture.txt' });
must(largeInfo.isError !== true && JSON.stringify(largeInfo).includes('262144'),
     'TWO_NATIVE_LARGE_STRING_SIZE_VERIFIED');

const malformedToken = await fetch(base + '/mcp', {
  method: 'POST',
  headers: { ...headers, authorization: 'Bearer denied-fixture' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
});
must(malformedToken.status === 401, 'TWO_NATIVE_WRONG_OAUTH_TOKEN_REFUSED');
for (const [value, hint] of [[token.access_token, 'access_token'], [token.refresh_token, 'refresh_token']]) {
  const revoked = await fetch(meta.revocation_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: register.client_id, token: value, token_type_hint: hint }),
  });
  must(revoked.status === 200, 'TWO_NATIVE_OAUTH_' + hint.toUpperCase() + '_REVOKED');
}
const revokedAccess = await fetch(base + '/mcp', {
  method: 'POST', headers,
  body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} }),
});
must(revokedAccess.status === 401, 'TWO_NATIVE_REVOKED_ACCESS_REFUSED');
const revokedRefresh = await fetch(meta.token_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ grant_type: 'refresh_token', client_id: register.client_id, refresh_token: token.refresh_token }),
});
must(revokedRefresh.status === 400, 'TWO_NATIVE_REVOKED_REFRESH_REFUSED');
console.log('HERMES_BRC_TWO_REAL_NATIVE_AGENTS_OAUTH_MCP_E2E=PASS');
