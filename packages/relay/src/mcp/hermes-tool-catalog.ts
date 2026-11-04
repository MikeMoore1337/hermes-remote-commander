/* Static MCP tool advertisement for ChatGPT custom connectors.
 * Import only the reviewed, compiled BRC agent tool SCHEMA module; never
 * import the agent dispatcher or execute agent handlers on the relay.
 * This catalog is independent of agent online state, so an OAuth connection
 * made before pairing can discover the same operations after pairing.
 * Actual calls still require the relay's immutable allowlist, owner/device
 * authorization, an online non-paused agent, and its OS sandbox.
 */
import { isPermittedRemoteTool } from './hermes-policy.js';

type CatalogTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
};

const schemaModule = await import('brc-agent/dist/core/tool-definitions.js') as {
  buildToolDefinitions?: () => CatalogTool[];
};
if (typeof schemaModule.buildToolDefinitions !== 'function') {
  throw Error('HERMES_PINNED_AGENT_SCHEMA_UNAVAILABLE');
}
const definitions = schemaModule.buildToolDefinitions();
if (!Array.isArray(definitions)) throw Error('HERMES_PINNED_AGENT_SCHEMA_INVALID');
const selected = definitions.filter(t => isPermittedRemoteTool(t.name, {}));
const names = new Set(selected.map(t => t.name));
if (names.size !== selected.length ||
    !['read_file', 'write_file', 'start_process'].every(t => names.has(t))) {
  throw Error('HERMES_PINNED_TOOL_CATALOG_MISSING_OR_DUPLICATE');
}
if (selected.some(t => !t.description || !t.inputSchema ||
    typeof t.inputSchema !== 'object')) {
  throw Error('HERMES_PINNED_TOOL_CATALOG_INVALID_SCHEMA');
}
const catalog = selected.sort((a, b) => a.name.localeCompare(b.name));

export function pinnedToolCatalog(): CatalogTool[] {
  return catalog;
}
