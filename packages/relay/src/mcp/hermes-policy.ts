/* Immutable Hermes MCP gateway policy. Do not remotely expose config or
 * history, unreviewed tools, external transfers, or URL reads. This filter
 * is not a replacement for the per-device OS shell/file sandbox.
 */
const ALLOWED = new Set([
  'start_process', 'read_process_output', 'interact_with_process',
  'force_terminate', 'list_sessions', 'list_processes', 'kill_process',
  'read_file', 'read_multiple_files', 'write_file', 'write_pdf',
  'create_directory', 'list_directory', 'move_file', 'get_file_info',
  'edit_block', 'start_search', 'get_more_search_results',
  'stop_search', 'list_searches',
]);

export function isPermittedRemoteTool(name: string, args: Record<string, unknown>): boolean {
  if (!ALLOWED.has(name)) return false;
  if (name === 'read_file' && args.isUrl === true) return false;
  return true;
}
