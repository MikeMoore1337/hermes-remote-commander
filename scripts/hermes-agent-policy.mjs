import { listTools, hasTool, callTool } from '../packages/agent/dist/dispatcher.js';

const denied = ['get_config', 'get_recent_tool_calls', 'set_config_value',
  'prepare_file_transfer', 'send_file_transfer', 'receive_file_transfer'];
const advertised = new Set(listTools().map(tool => tool.name));
for (const tool of denied) {
  if (hasTool(tool) || advertised.has(tool) || !(await callTool(tool, {})).isError) {
    throw Error('POLICY_BYPASS:' + tool);
  }
}
if (!hasTool('start_process') || !hasTool('write_file')) throw Error('REQUIRED_TOOL_MISSING');
const result = await callTool('read_file', { path: 'https://example.invalid/', isUrl: true });
if (!result.isError || !JSON.stringify(result).includes('HERMES_REMOTE_URL_FETCH_DENIED')) {
  throw Error('EXTERNAL_URL_READ_ALLOWED');
}
console.log('HERMES_AGENT_POLICY=PASS');
