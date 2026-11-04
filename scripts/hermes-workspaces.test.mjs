import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseWorkspaceRegistry, loadWorkspaceRegistry, listWorkspaces, resolveWorkspace } from '../packages/relay/dist/mcp/hermes-workspaces.js';
import { deviceGrantStatus, invokeTool } from '../packages/relay/dist/mcp/invoke.js';

const entry = (name, deviceId) => ({ name, aliases: [name + ' project'], deviceId,
  root: '/workspace/projects/' + name, origin: 'https://github.com/example/' + name + '.git',
  branch: 'main', scope: 'sandbox' });
const registry = () => ({ schema: 2, workspaces: [entry('alpha', 'device-001'), entry('beta', 'device-002')] });

test('ambiguous aliases, unsafe roots and malformed registry entries are refused', () => {
  for (const mutate of [
    r => { r.workspaces[1].aliases = ['ALPHA project']; },
    r => { r.workspaces[1].name = 'alpha'; },
    r => { r.workspaces[0].root = '/srv/production'; },
    r => { r.workspaces[0].root = '/workspace/projects/../production'; },
    r => { r.workspaces[0].origin = 'https://user:secret@github.com/example/repo'; },
    r => { r.workspaces[0].branch = 'main;echo injected'; },
    r => { r.workspaces[0].scope = 'production'; },
    r => { r.workspaces[0].aliases = ['___']; },
    r => { r.workspaces[0].extra = true; },
  ]) {
    const value = registry();
    mutate(value);
    assert.throws(() => parseWorkspaceRegistry(value), /HERMES_WORKSPACE_REGISTRY_INVALID/);
  }
});

test('resolution uses the owner grant, socket token binding and live device state', () => {
  const workspaces = parseWorkspaceRegistry(registry());
  let grants = { 'device-001': {user_id:'owner',token_hash:'hash-one',paused:false},
    'device-002': {user_id:'other',token_hash:'hash-two',paused:false} };
  let devices = { 'device-001': {ownerId:'owner',socket:{hermesAuthTokenHash:'hash-one'}},
    'device-002': {ownerId:'other',socket:{hermesAuthTokenHash:'hash-two'}} };
  const state = id => deviceGrantStatus({get:id => devices[id]}, {getDevice:id => grants[id]}, 'owner', id);
  const result = resolveWorkspace({project:'ALPHA_PROJECT'}, workspaces, state);
  assert.equal(result.status, 'resolved');
  assert.equal(result.deviceId, 'device-001');
  assert.equal(result.git_verified, false);
  assert.equal(result.verification_required_before_write, true);
  assert.equal(listWorkspaces(workspaces, state).workspaces.length, 1);
  assert.equal(resolveWorkspace({project:'beta'}, workspaces, state).reason, 'unknown_workspace');
  assert.equal(resolveWorkspace({project:'alpha',deviceId:'device-002'}, workspaces, state).reason, 'invalid_arguments');
  grants['device-001'].paused = true;
  assert.equal(resolveWorkspace({project:'alpha'}, workspaces, state).reason, 'device_unavailable');
  grants['device-001'].paused = false;
  grants['device-001'].token_hash = 'rotated';
  assert.equal(resolveWorkspace({project:'alpha'}, workspaces, state).reason, 'device_unavailable');
  delete devices['device-001'];
  assert.equal(resolveWorkspace({project:'alpha'}, workspaces, state).reason, 'device_unavailable');
});

test('registry loading is bounded and refuses invalid or linked files', () => {
  assert.deepEqual(loadWorkspaceRegistry(), []);
  const dir = mkdtempSync(path.join(tmpdir(), 'brc-registry-'));
  const file = path.join(dir, 'registry.json');
  const link = path.join(dir, 'link.json');
  let linkCreated = false;
  try {
    writeFileSync(file, JSON.stringify(registry()), {mode:0o600});
    assert.equal(loadWorkspaceRegistry(file).length, 2);
    const relative = path.relative(process.cwd(), file);
    if (!path.isAbsolute(relative)) assert.throws(() => loadWorkspaceRegistry(relative), /HERMES_WORKSPACE_REGISTRY_INVALID/);
    if (process.platform !== 'win32') {
      chmodSync(file, 0o666);
      assert.throws(() => loadWorkspaceRegistry(file), /HERMES_WORKSPACE_REGISTRY_INVALID/);
      chmodSync(file, 0o600);
      symlinkSync(file, link);
      linkCreated = true;
      assert.throws(() => loadWorkspaceRegistry(link), /HERMES_WORKSPACE_REGISTRY_INVALID/);
    }
    writeFileSync(file, 'x'.repeat(16_385));
    assert.throws(() => loadWorkspaceRegistry(file), /HERMES_WORKSPACE_REGISTRY_INVALID/);
  } finally {
    if (linkCreated) unlinkSync(link);
    unlinkSync(file);
    rmdirSync(dir);
  }
});

test('a device that disappears during authorization is not dispatched', async () => {
  const device = {ownerId:'owner',info:{name:'fixture'},socket:{hermesAuthTokenHash:'hash'}};
  let reads = 0, dispatched = false;
  const hub = {get:() => ++reads === 1 ? device : undefined, call:() => { dispatched = true; }};
  const store = {getDevice:() => ({user_id:'owner',token_hash:'hash',paused:false})};
  const result = await invokeTool(hub, store, {userId:'owner',clientId:'fixture'}, 'read_file', {deviceId:'device-001'});
  assert.equal(result.status, 404);
  assert.equal(dispatched, false);
});

test('an explicit invalid device ID never falls back to the only device', async () => {
  const device = {ownerId:'owner',info:{name:'fixture'},socket:{hermesAuthTokenHash:'hash'}};
  let dispatched = 0;
  const hub = {resolveDefault:() => 'device-001',get:() => device,
    call:async () => { dispatched++; return {content:[{type:'text',text:'ok'}]}; }};
  const store = {getDevice:() => ({user_id:'owner',token_hash:'hash',paused:false}),audit:()=>{},touchDevice:()=>{}};
  for (const deviceId of ['', null, false, 0, {}, []]) {
    const result = await invokeTool(hub, store, {userId:'owner',clientId:'fixture'}, 'write_file', {deviceId});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.message, 'HERMES_INVALID_DEVICE_ID');
    assert.equal(dispatched, 0);
  }
  const implicit = await invokeTool(hub, store, {userId:'owner',clientId:'fixture'}, 'write_file', {});
  assert.equal(implicit.ok, true);
  assert.equal(dispatched, 1);
  const explicit = await invokeTool(hub, store, {userId:'owner',clientId:'fixture'}, 'write_file', {deviceId:'device-001'});
  assert.equal(explicit.ok, true);
  assert.equal(dispatched, 2);
});
