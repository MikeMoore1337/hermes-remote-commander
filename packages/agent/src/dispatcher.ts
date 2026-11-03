/**
 * BRC agent tool dispatcher: name -> handler, ported from upstream server.ts CallTool switch.
 * Returns MCP-shaped results; errors become { isError: true } text blocks (never throws).
 */
import * as handlers from './core/handlers/index.js';
import { getUsageStats } from './core/tools/usage.js';
import { buildToolDefinitions, EXCLUDED_TOOLS, type ToolDefinition } from './core/tool-definitions.js';
import { usageTracker } from './core/utils/usageTracker.js';
import type { ToolResult } from 'brc-shared';

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, Handler> = {
  get_usage_stats: () => getUsageStats(),
  start_process: (a) => handlers.handleStartProcess(a),
  read_process_output: (a) => handlers.handleReadProcessOutput(a),
  interact_with_process: (a) => handlers.handleInteractWithProcess(a),
  force_terminate: (a) => handlers.handleForceTerminate(a),
  list_sessions: () => handlers.handleListSessions(),
  list_processes: () => handlers.handleListProcesses(),
  kill_process: (a) => handlers.handleKillProcess(a),
  read_file: (a) => a.isUrl === true
    ? Promise.resolve({ isError: true, content: [{ type: 'text', text: 'HERMES_REMOTE_URL_FETCH_DENIED' }] })
    : handlers.handleReadFile(a),
  read_multiple_files: (a) => handlers.handleReadMultipleFiles(a),
  write_file: (a) => handlers.handleWriteFile(a),
  write_pdf: (a) => handlers.handleWritePdf(a),
  create_directory: (a) => handlers.handleCreateDirectory(a),
  list_directory: (a) => handlers.handleListDirectory(a),
  move_file: (a) => handlers.handleMoveFile(a),
  get_file_info: (a) => handlers.handleGetFileInfo(a),
  edit_block: (a) => handlers.handleEditBlock(a),
  start_search: (a) => handlers.handleStartSearch(a),
  get_more_search_results: (a) => handlers.handleGetMoreSearchResults(a),
  stop_search: (a) => handlers.handleStopSearch(a),
  list_searches: () => handlers.handleListSearches(),
};

const h454FileMutations = new Set(['write_file', 'write_pdf', 'create_directory', 'move_file', 'edit_block']);
let h454FileMutationBusy = false;
let cachedDefs: ToolDefinition[] | null = null;

export function listTools(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = buildToolDefinitions().filter((t) => t.name in TOOL_HANDLERS && !EXCLUDED_TOOLS.has(t.name));
  }
  return cachedDefs;
}

export function hasTool(name: string): boolean {
  return name in TOOL_HANDLERS;
}

export async function callTool(name: string, args: Args): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const h454Mutation = h454FileMutations.has(name);
  if (h454Mutation && h454FileMutationBusy) {
    void usageTracker.trackFailure(name);
    return { content: [{ type: 'text', text: 'HERMES_FILE_MUTATION_BUSY: another file mutation is in progress; retry after it completes.' }], isError: true };
  }
  if (h454Mutation) h454FileMutationBusy = true;
  try {
    const result = (await handler(args ?? {})) as ToolResult;
    if (!result.isError) void usageTracker.trackSuccess(name);
    else void usageTracker.trackFailure(name);
    return result;
  } catch (err) {
    void usageTracker.trackFailure(name);
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error in ${name}: ${message}` }], isError: true };
  } finally {
    if (h454Mutation) h454FileMutationBusy = false;
  }
}
