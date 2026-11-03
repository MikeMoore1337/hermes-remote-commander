import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'brc-browser-test-')));
process.env.BRC_HOME = path.join(root, 'home');
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const chromeDir = path.join(process.env.BRC_HOME, 'puppeteer-cache', 'chrome');
const binary = process.platform === 'win32' ? ['chrome-win64', 'chrome.exe'] : ['chrome-linux64', 'chrome'];
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('browser discovery does not prune existing cached builds', async () => {
  for (const version of ['build-1', 'build-2']) {
    const dir = path.join(chromeDir, version, binary[0]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, binary[1]), 'synthetic');
  }
  const originalReaddir = fsPromises.readdir;
  const originalRm = fsPromises.rm;
  const removals = [];
  fsPromises.readdir = async (...args) => args[0] === chromeDir ?
    ['build-1', 'build-2'].map(name => ({ name, isDirectory: () => true })) : originalReaddir(...args);
  fsPromises.rm = async (...args) => { removals.push(args[0]); };
  try {
    const pdf = await import('../packages/agent/dist/core/tools/pdf/markdown.js?cached');
    pdf.ensureChromeAvailable();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removals, []);
    assert.ok(fs.existsSync(path.join(chromeDir, 'build-1', ...binary)));
  } finally {
    fsPromises.readdir = originalReaddir;
    fsPromises.rm = originalRm;
    fs.rmSync(chromeDir, { recursive: true, force: true });
  }
});

test('missing browser fails without installing or launching one', async () => {
  const cache = path.join(chromeDir, 'build-untrusted', binary[0]);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, binary[1]), 'synthetic');
  const originalExists = fs.existsSync;
  const originalSpawn = childProcess.spawn;
  let installers = 0, launches = 0;
  fs.existsSync = value => String(value).startsWith(chromeDir) ? originalExists(value) :
    /chrome|chromium|msedge/i.test(String(value)) ? false : originalExists(value);
  childProcess.spawn = () => { launches++; throw Error('UNEXPECTED_BROWSER_LAUNCH'); };
  syncBuiltinESMExports();
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@puppeteer/browsers') { installers++; throw Error('BLOCKED_INSTALLER'); }
    return next(specifier, context);
  } });
  try {
    const pdf = await import('../packages/agent/dist/core/tools/pdf/markdown.js?missing');
    await assert.rejects(pdf.parseMarkdownToPdf('# synthetic'), /HERMES_BROWSER_UNAVAILABLE/);
    assert.equal(installers, 0);
    assert.equal(launches, 0);
  } finally {
    hooks.deregister();
    fs.existsSync = originalExists;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});
