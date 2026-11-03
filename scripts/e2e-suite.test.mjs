import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from './e2e-suite.mjs';

test('a suite that prints PASS then exits nonzero still fails', async () => {
  const result = await runSuite('-e', "console.log('PASS first'); process.exit(1)");
  assert.equal(result.failures, 1);
});

test('successful suites pass and explicit failures are counted', async () => {
  assert.equal((await runSuite('-e', "console.log('PASS ok')")).failures, 0);
  assert.equal((await runSuite('-e', "console.log('PASS one\\nFAIL two')")).failures, 1);
});
