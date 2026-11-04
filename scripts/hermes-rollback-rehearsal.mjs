import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SqliteStore as OldStore, sha256 } from '/fixtures/old-store.mjs';
import { SqliteStore as NewStore } from '/fixtures/new-store.mjs';

assert.equal(typeof process.getuid, 'function', 'Linux non-root container required');
assert.notEqual(process.getuid(), 0, 'Linux non-root container required');
const root = mkdtempSync('/tmp/brc-synthetic-rollback-');
const active = path.join(root, 'active');
const backups = path.join(root, 'backups');
const scratch = path.join(root, 'scratch');
for (const dir of [active, backups, scratch]) mkdirSync(dir, { mode: 0o700 });
const database = path.join(active, 'relay.sqlite');
let old, candidate, rolledBack, restored;
try {
  old = new OldStore(database);
  const user = old.upsertUser('synthetic-owner', 'synthetic-password');
  old.insertClient({ client_id: 'synthetic-client', client_secret: null, metadata: '{}', created_at: Date.now() });
  const firstDeviceToken = old.issueDeviceToken('synthetic-device', user.id, 'fixture', 'linux');
  const accessToken = 'synthetic-access-token';
  old.insertToken({ token_hash: sha256(accessToken), kind: 'access', client_id: 'synthetic-client',
    user_id: user.id, scopes: 'mcp', resource: null, expires_at: Date.now() + 600_000,
    created_at: Date.now(), revoked: 0 });
  assert.ok(old.getDeviceByToken(firstDeviceToken));
  assert.ok(old.getToken(accessToken, 'access'));

  const backup = spawnSync('python3', ['/fixtures/backup.py', '--database', database, '--backup-dir', backups], { encoding: 'utf8' });
  assert.equal(backup.status, 0, 'online backup failed');
  const files = readdirSync(backups).filter(name => name.endsWith('.sqlite3'));
  assert.equal(files.length, 1);
  const snapshot = path.join(backups, files[0]);
  const rehearsal = spawnSync('python3', ['/fixtures/restore.py', '--snapshot', snapshot, '--scratch-dir', scratch], { encoding: 'utf8' });
  assert.equal(rehearsal.status, 0, 'disposable restore failed');
  assert.match(rehearsal.stdout, /H15_SQLITE_RESTORE_REHEARSAL=PASS_DISPOSABLE_ONLY/);
  old.db.close(); old = undefined;

  candidate = new NewStore(database);
  assert.ok(candidate.getDeviceByToken(firstDeviceToken));
  assert.ok(candidate.getToken(accessToken, 'access'));
  candidate.revokeToken(accessToken);
  const nextDeviceToken = candidate.issueDeviceToken('synthetic-device', user.id, 'fixture', 'linux');
  candidate.db.close(); candidate = undefined;

  rolledBack = new OldStore(database);
  assert.equal(rolledBack.getToken(accessToken, 'access'), undefined);
  assert.equal(rolledBack.getDeviceByToken(firstDeviceToken), undefined);
  assert.ok(rolledBack.getDeviceByToken(nextDeviceToken));
  rolledBack.db.close(); rolledBack = undefined;

  const restoredFile = path.join(scratch, 'restore-copy.sqlite');
  copyFileSync(snapshot, restoredFile);
  restored = new OldStore(restoredFile);
  assert.ok(restored.getToken(accessToken, 'access'));
  assert.ok(restored.getDeviceByToken(firstDeviceToken));
  restored.db.close(); restored = undefined;
  console.log('SYNTHETIC_ONLINE_BACKUP_AND_DISPOSABLE_RESTORE=PASS');
  console.log('SYNTHETIC_OLD_TO_FORK_TO_OLD_STORE=PASS');
  console.log('SYNTHETIC_STALE_BACKUP_REVERSES_REVOCATION=CONFIRMED');
  console.log('PRODUCTION_STATE_ACCESSED=NO');
} finally {
  for (const store of [old, candidate, rolledBack, restored]) store?.db.close();
  rmSync(root, { recursive: true, force: true });
}
