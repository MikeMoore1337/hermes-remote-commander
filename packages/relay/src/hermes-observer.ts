import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DeviceHub } from './device-hub.js';
import type { SqliteStore } from './store/sqlite.js';
import { deviceGrantStatus } from './mcp/invoke.js';
import type { Workspace } from './mcp/hermes-workspaces.js';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

/** Owner-scoped metadata only; presence never grants filesystem or tool access. */
export function observation(hub: DeviceHub, store: SqliteStore, owner: string, workspaces: Workspace[], now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 1_600_000_000_000) throw Error('observer_invalid_clock');
  const rows = store.listDevices(owner);
  if (rows.length > 64 || workspaces.length > 64) throw Error('observer_too_many_records');
  const names = new Set<string>();
  const byId = new Map<string, { name: string; status: string }>();
  const devices = rows.map(row => {
    if (row.user_id !== owner || !LABEL.test(row.name) || row.name === row.device_id || names.has(row.name)) {
      throw Error('observer_invalid_device');
    }
    names.add(row.name);
    const grant = deviceGrantStatus(hub, store, owner, row.device_id);
    const connected = grant === 'ready' ? hub.get(row.device_id) : undefined;
    const last = connected?.lastSeen ?? row.last_seen ?? 0;
    if (!Number.isSafeInteger(last) || last < 0 || last > now + 60_000) throw Error('observer_invalid_time');
    const age = Math.min(86_400, Math.max(0, Math.floor((now - last) / 1000)));
    const status = grant === 'paused' ? 'paused' : !connected ? 'offline' : age > 300 ? 'stale' : 'online';
    byId.set(row.device_id, { name: row.name, status });
    return { name: row.name, status, last_seen_age_seconds: age, command_execution: 'not_verified' };
  });
  const projects = workspaces.flatMap(workspace => {
    const device = byId.get(workspace.deviceId);
    if (!device) return [];
    return [{ name: workspace.name, root: workspace.root, branch: workspace.branch,
      device_name: device.name, git_verified: false,
      state: device.status === 'online' ? 'reachable_not_git_verified' : 'not_ready' }];
  });
  const online = devices.filter(device => device.status === 'online').length;
  return { schema: 2, source: 'hermes_brc_fork', observed_at: new Date(now).toISOString(),
    status: online && online === devices.length ? 'online' : online ? 'partial' : 'unavailable',
    execution_verified: false, native_host_access: 'not_verified', onboarding_enabled: false,
    devices, workspaces: projects };
}

function trustedDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || process.getuid?.() === undefined || process.getuid?.() === 0) throw Error('observer_directory_untrusted');
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw Error('observer_directory_untrusted');
  }
}

/** An owner-owned 0600 marker in a private directory is the explicit opt-in. */
export function observerEnabled(directory: string): boolean {
  let fd: number | undefined;
  try {
    trustedDirectory(directory);
    const marker = path.join(directory, '.hermes-brc-observer-enable');
    const before = fs.lstatSync(marker);
    if (!before.isFile() || before.isSymbolicLink()) return false;
    fd = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const info = fs.fstatSync(fd);
    return info.isFile() && info.ino === before.ino && info.dev === before.dev && info.nlink === 1 && info.uid === process.getuid?.() &&
      (info.mode & 0o777) === 0o600 && info.size === 8 && fs.readFileSync(fd, 'utf8') === 'enabled\n';
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function publishObservation(directory: string, value: ReturnType<typeof observation>): boolean {
  if (!observerEnabled(directory)) return false;
  const payload = Buffer.from(JSON.stringify(value) + '\n');
  if (payload.length > 16_384) throw Error('observer_oversize');
  const target = path.join(directory, 'hermes-brc-observation.json');
  try {
    const current = fs.lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        current.uid !== process.getuid?.() || (current.mode & 0o022)) throw Error('observer_target_untrusted');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temporary = path.join(directory, '.hermes-brc-observation-' + randomUUID());
  let created = false;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o640);
    created = true;
    try { fs.fchmodSync(fd, 0o640); fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    created = false;
    const dirfd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
    return true;
  } finally { if (created) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } } }
}
