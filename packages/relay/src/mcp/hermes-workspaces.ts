import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type Workspace = {
  name: string;
  aliases: string[];
  deviceId: string;
  root: string;
  origin: string;
  branch: string;
  scope: 'sandbox';
};
export type DeviceState = 'ready' | 'offline' | 'paused' | 'revoked' | 'foreign';

export const LIST_WORKSPACES_TOOL = {
  name: 'list_workspaces',
  description: 'List owner-configured development workspaces and device availability. Git state is not verified.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'List workspaces', readOnlyHint: true },
};
export const RESOLVE_WORKSPACE_TOOL = {
  name: 'resolve_workspace',
  description: 'Resolve an approved project name to its sandbox workspace and online device. Verify Git before writing.',
  inputSchema: { type: 'object', properties: { project: { type: 'string', minLength: 1, maxLength: 100 } },
    required: ['project'], additionalProperties: false },
  annotations: { title: 'Resolve workspace', readOnlyHint: true },
};

const invalid = (): never => { throw new Error('HERMES_WORKSPACE_REGISTRY_INVALID'); };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = (value: string) => value.replace(/_/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');

export function parseWorkspaceRegistry(input: unknown): Workspace[] {
  if (!record(input) || Object.keys(input).sort().join(',') !== 'schema,workspaces' || input.schema !== 2 ||
      !Array.isArray(input.workspaces) || input.workspaces.length > 64) return invalid();
  const aliases = new Map<string, string>();
  const workspaceNames = new Set<string>();
  const roots = new Set<string>();
  return input.workspaces.map((item): Workspace => {
    if (!record(item) || Object.keys(item).sort().join(',') !== 'aliases,branch,deviceId,name,origin,root,scope' ||
        typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.name) ||
        !Array.isArray(item.aliases) || item.aliases.length > 12 ||
        typeof item.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(item.deviceId) ||
        typeof item.root !== 'string' || !/^\/workspace\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.root) ||
        typeof item.origin !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.origin) ||
        typeof item.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(item.branch) ||
        item.branch.includes('..') || item.branch.includes('//') || item.branch.endsWith('/') ||
        item.branch.endsWith('.') || item.branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) ||
        item.scope !== 'sandbox') return invalid();
    const names = [item.name, ...item.aliases];
    if (names.some(name => typeof name !== 'string' || name.length > 100 || !normalized(name) || /[\x00-\x1f\x7f]/.test(name))) return invalid();
    if (workspaceNames.has(normalized(item.name))) return invalid();
    workspaceNames.add(normalized(item.name));
    for (const name of names as string[]) {
      const key = normalized(name);
      if (aliases.has(key) && aliases.get(key) !== item.name) return invalid();
      aliases.set(key, item.name);
    }
    const rootKey = item.deviceId + ':' + item.root;
    if (roots.has(rootKey)) return invalid();
    roots.add(rootKey);
    return { name: item.name, aliases: [...item.aliases] as string[], deviceId: item.deviceId,
      root: item.root, origin: item.origin, branch: item.branch, scope: 'sandbox' };
  });
}

export function loadWorkspaceRegistry(path?: string): Workspace[] {
  if (!path) return [];
  if (!isAbsolute(path)) return invalid();
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) return invalid();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || stat.ino !== before.ino || stat.dev !== before.dev ||
        (process.platform !== 'win32' && ((stat.mode & 0o022) !== 0 ||
          (stat.uid !== 0 && stat.uid !== process.getuid?.())))) return invalid();
    const bytes = Buffer.alloc(16_385);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== stat.size || count > 16_384 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs) return invalid();
    return parseWorkspaceRegistry(JSON.parse(bytes.subarray(0, count).toString('utf8')));
  } catch { return invalid(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function listWorkspaces(workspaces: Workspace[], state: (deviceId: string) => DeviceState) {
  return { schema: 2, status: 'catalog', workspaces: workspaces.flatMap(w => {
    const deviceState = state(w.deviceId);
    if (deviceState === 'foreign') return [];
    return [{ name: w.name, aliases: w.aliases, root: w.root, origin: w.origin, branch: w.branch,
      scope: w.scope, device_status: deviceState === 'ready' ? 'online' : deviceState, git_verified: false,
      process_execution_verified: false, ...(deviceState === 'ready' ? { deviceId: w.deviceId } : {}) }];
  }) };
}

export function resolveWorkspace(args: unknown, workspaces: Workspace[], state: (deviceId: string) => DeviceState) {
  if (!record(args) || Object.keys(args).join(',') !== 'project' || typeof args.project !== 'string' ||
      !normalized(args.project) || args.project.length > 100 || /[\x00-\x1f\x7f]/.test(args.project)) {
    return { schema: 2, status: 'refused', reason: 'invalid_arguments' };
  }
  const key = normalized(args.project);
  const workspace = workspaces.find(w => [w.name, ...w.aliases].some(alias => normalized(alias) === key));
  if (!workspace) return { schema: 2, status: 'refused', reason: 'unknown_workspace' };
  const deviceState = state(workspace.deviceId);
  if (deviceState === 'foreign') return { schema: 2, status: 'refused', reason: 'unknown_workspace' };
  if (deviceState !== 'ready') return { schema: 2, status: 'refused', reason: 'device_unavailable' };
  return { schema: 2, status: 'resolved', workspace: workspace.name, root: workspace.root,
    origin: workspace.origin, branch: workspace.branch, deviceId: workspace.deviceId, scope: workspace.scope, device_status: 'online',
    git_verified: false, process_execution_verified: false, verification_required_before_write: true };
}
