import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

test('MCP XLSX read/write/edit and the ExcelJS streaming reader remain usable', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brc-xlsx-'));
  process.env.BRC_HOME = path.join(dir, 'home');
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
  const { callTool } = await import('../packages/agent/dist/dispatcher.js');
  const { configManager } = await import('../packages/agent/dist/core/config-manager.js');
  const { usageTracker } = await import('../packages/agent/dist/core/utils/usageTracker.js');
  configManager.getConfig = async () => ({ allowedDirectories: [dir], fileReadLineLimit: 1000 });
  usageTracker.trackSuccess = usageTracker.trackFailure = async () => {};
  const require = createRequire(path.resolve('packages/agent/package.json'));
  const ExcelJS = require('exceljs');
  const fromExcel = createRequire(require.resolve('exceljs'));
  const JSZip = fromExcel('jszip');
  const file = path.join(dir, 'fixture.xlsx');
  try {
    const written = await callTool('write_file', { path: file, content: JSON.stringify([['alpha', 10], ['beta', 20]]), mode: 'rewrite' });
    assert.notEqual(written.isError, true, JSON.stringify(written));
    const edited = await callTool('edit_block', { file_path: file, range: 'Sheet1!B2', content: [[42]] });
    assert.notEqual(edited.isError, true, JSON.stringify(edited));
    const read = await callTool('read_file', { path: file });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.match(JSON.stringify(read), /alpha/);
    assert.match(JSON.stringify(read), /42/);

    // ExcelJS's streaming reader requires workbook metadata before worksheets,
    // even when reading archives produced by its own writer.
    const archive = await JSZip.loadAsync(readFileSync(file));
    const ordered = new JSZip();
    const rank = name => name === 'xl/workbook.xml' ? 0 : name === 'xl/_rels/workbook.xml.rels' ? 1 :
      name === 'xl/sharedStrings.xml' ? 2 : name.startsWith('xl/worksheets/') ? 4 : 3;
    const entries = Object.values(archive.files).filter(entry => !entry.dir).sort((a, b) => rank(a.name) - rank(b.name));
    for (const entry of entries) ordered.file(entry.name, await entry.async('nodebuffer'));
    const streamedFile = path.join(dir, 'streamed.xlsx');
    writeFileSync(streamedFile, await ordered.generateAsync({ type: 'nodebuffer' }));
    const rows = [];
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(streamedFile, { worksheets: 'emit', sharedStrings: 'cache' });
    for await (const worksheet of reader) for await (const row of worksheet) rows.push([row.getCell(1).value, row.getCell(2).value]);
    assert.deepEqual(rows, [['alpha', 10], ['beta', 42]]);

    const invalid = path.join(dir, 'invalid.xlsx');
    writeFileSync(invalid, 'not a zip');
    assert.equal((await callTool('read_file', { path: invalid })).isError, true);
    assert.equal(/^\s+buffers@/m.test(readFileSync('pnpm-lock.yaml', 'utf8')), false, 'buffers remains in the lockfile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
