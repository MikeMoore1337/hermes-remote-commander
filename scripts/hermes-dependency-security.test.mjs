import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const agent = createRequire(path.resolve('packages/agent/package.json'));
const excel = createRequire(agent.resolve('exceljs'));
const globPackage = createRequire(agent.resolve('glob'));

test('ExcelJS uuid dependency refuses a short v5 output buffer', () => {
  const { v5 } = excel('uuid');
  assert.throws(() => v5('fixture', v5.DNS, new Uint8Array(8), 4), RangeError);
});

test('glob minimatch bounds optimized pattern expansion', () => {
  const { Minimatch } = globPackage('minimatch');
  const pattern = Array(8).fill('**/../a/b').join('/');
  const match = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 16 });
  assert.ok(match.set.length <= 16, `expanded to ${match.set.length} patterns`);
  assert.equal(new Minimatch('**/../a/b', { optimizationLevel: 2 }).match('x/a/b'), true);
});

test('glob does not keep walking after an aborted async traversal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brc-glob-abort-'));
  const controller = new AbortController();
  let reads = 0;
  try {
    for (let i = 0; i < 8; i++) {
      const child = path.join(dir, `dir-${i}`, 'nested');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(child, 'fixture.txt'), 'fixture');
    }
    const customFs = { readdir: (file, options, callback) => {
      reads++;
      return fs.readdir(file, options, (error, entries) => {
        if (!controller.signal.aborted) controller.abort();
        callback(error, entries);
      });
    } };
    await assert.rejects(agent('glob').glob('**/*', { cwd: dir, signal: controller.signal, fs: customFs }));
    assert.ok(reads > 0, 'traversal did not start');
    const atRejection = reads;
    await delay(200);
    assert.equal(reads, atRejection, 'traversal continued after rejection');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
