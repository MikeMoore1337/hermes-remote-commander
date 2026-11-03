import { spawn } from 'node:child_process';

export function runSuite(script, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { out += data; });
    child.on('error', reject);
    child.on('close', code => resolve({
      out,
      failures: Math.max((out.match(/^FAIL/gm) ?? []).length, code === 0 && /^PASS/m.test(out) ? 0 : 1),
    }));
  });
}
