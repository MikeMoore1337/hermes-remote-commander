import { test } from 'node:test';
import assert from 'node:assert/strict';
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
