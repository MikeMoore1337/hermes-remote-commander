import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildToolDefinitions } from '../packages/agent/dist/core/tool-definitions.js';
import { EditBlockArgsSchema, ReadFileArgsSchema, ReadMultipleFilesArgsSchema, WritePdfArgsSchema } from '../packages/agent/dist/core/tools/schemas.js';
import { MAX_JSON_ELEMENTS, withinJsonElementLimit } from '../packages/shared/dist/index.js';

test('tool input schemas preserve defaults, refinements and advertised PDF shape', () => {
  assert.deepEqual(ReadFileArgsSchema.parse({ path: 'example.txt' }), {
    path: 'example.txt', isUrl: false, offset: 0, length: 1000,
  });
  assert.equal(EditBlockArgsSchema.safeParse({ file_path: 'example.txt' }).success, false);
  assert.equal(EditBlockArgsSchema.safeParse({ file_path: 'example.txt', old_string: 'a', new_string: 'b' }).success, true);
  const pdf = buildToolDefinitions().find(tool => tool.name === 'write_pdf').inputSchema;
  assert.deepEqual(pdf.required, ['path', 'content']);
  assert.equal(pdf.additionalProperties, false);
  assert.equal(pdf.properties.content.anyOf[1].maxItems, MAX_JSON_ELEMENTS);
});

test('structured PDF input is bounded before schema traversal', () => {
  const operation = [{ type: 'delete', pageIndexes: [0, 1] }];
  assert.deepEqual(WritePdfArgsSchema.parse({ path: 'x.pdf', content: JSON.stringify(operation) }).content, operation);
  assert.equal(WritePdfArgsSchema.parse({ path: 'x.pdf', content: '[not JSON' }).content, '[not JSON');
  assert.equal(WritePdfArgsSchema.safeParse({ path: 'x.pdf', content: JSON.stringify(Array(MAX_JSON_ELEMENTS + 1).fill(null)) }).success, false);
  assert.equal(WritePdfArgsSchema.safeParse({ path: 'x.pdf', content: '[' + ' '.repeat(1_048_576) }).success, false);
  const tooManyPaths = ReadMultipleFilesArgsSchema.safeParse({ paths: Array(MAX_JSON_ELEMENTS + 1).fill(null) });
  assert.equal(tooManyPaths.success, false);
  assert.equal(tooManyPaths.error.issues.length, 1);
  assert.equal(withinJsonElementLimit({ nested: Array(MAX_JSON_ELEMENTS).fill(null) }), false);
  assert.equal(withinJsonElementLimit({ nested: [1, 2] }), true);
});

test('Zod v3 compatibility and native v4 enforce bounded nested arrays', () => {
  // The SDK retains zod/v3 compatibility. Both paths must resolve through the
  // patched Zod 4 dependency, not a second standalone Zod 3 installation.
  const agentRequire = createRequire(new URL('../packages/agent/package.json', import.meta.url));
  const sdkRequire = createRequire(new URL('../packages/relay/package.json', import.meta.url));
  const { z: z3 } = agentRequire('zod/v3');
  const { z: z4 } = agentRequire('zod/v4');
  const { CallToolRequestSchema } = sdkRequire('@modelcontextprotocol/sdk/types.js');
  assert.ok(CallToolRequestSchema._zod, 'MCP request schema must use Zod v4, not v3');

  for (const [label, z] of [['compat-v3', z3], ['native-v4', z4]]) {
    const schema = z.object({
      items: z.array(z.object({ values: z.array(z.string().min(2)).min(1).max(2) })).min(1).max(2),
    });
    assert.equal(schema.safeParse({ items: [{ values: ['ok'] }] }).success, true, label);
    assert.equal(schema.safeParse({ items: [] }).success, false, label + ' min outer');
    assert.equal(schema.safeParse({ items: [{ values: [] }] }).success, false, label + ' min inner');
    assert.equal(schema.safeParse({ items: [{ values: ['ok', 'ok', 'ok'] }] }).success, false, label + ' max inner');
    assert.equal(schema.safeParse({ items: [{ values: ['x'] }] }).success, false, label + ' min string');
    assert.equal(schema.safeParse({ items: Array(3).fill({ values: ['ok'] }) }).success, false, label + ' max outer');

    // Exercise the patched unbounded-array parser on a deliberately tiny,
    // synthetic negative input; never mount a DoS payload in CI.
    const invalid = z.array(z.string()).safeParse(Array(16).fill(null));
    assert.equal(invalid.success, false, label + ' invalid element');
    assert.ok(invalid.error.issues.length <= 16, label + ' bounded issues');
  }
});
