import { execFile } from 'child_process';
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';

const execFileAsync = promisify(execFile);
const MAX_PROC_ENTRIES = 1024;

/** Minimal Linux fallback: never read argv, environment or process files. */
export async function listLinuxProcfs(
  root = '/proc', limit = MAX_PROC_ENTRIES,
): Promise<{ processes: ProcessInfo[]; truncated: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROC_ENTRIES) {
    throw new Error('invalid_procfs_limit');
  }
  const directory = await opendir(root);
  const processes: ProcessInfo[] = [];
  let truncated = false;
  let scanned = 0;
  for await (const entry of directory) {
    if (!entry.isDirectory() || !/^[1-9][0-9]{0,9}$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue;
    if (scanned >= limit) { truncated = true; break; }
    scanned += 1;
    let file;
    try {
      file = await open(path.join(root, entry.name, 'comm'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      const command = buffer.subarray(0, bytesRead).toString('utf8')
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() || '[unknown]';
      processes.push({ pid, command, cpu: 'n/a', memory: 'n/a' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(code ?? '')) throw error;
    } finally {
      if (file) await file.close();
    }
  }
  if (!processes.length) throw new Error('procfs_unavailable');
  return { processes, truncated };
}

/**
 * Parse `tasklist /FO CSV /NH` output (#662). Fields per row, all quoted:
 * [Image Name, PID, Session Name, Session#, Mem Usage]. CSV instead of the
 * default table: image names can contain spaces and Mem Usage contains
 * thousands separators, so positional whitespace splitting can't work.
 * tasklist has no live per-process CPU%, so cpu is reported as n/a.
 */
export function parseWindowsTasklistCsv(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const fields = (line.match(/"([^"]*)"/g) || []).map(f => f.slice(1, -1));
      return {
        pid: parseInt(fields[1], 10),
        command: fields[0] ?? '',
        cpu: 'n/a',
        memory: fields[4] ?? '',
      } as ProcessInfo;
    })
    .filter(p => !Number.isNaN(p.pid));
}

/**
 * Parse `ps aux` output: 11 whitespace-separated columns, COMMAND from
 * column 10 onward (it can contain spaces, so it must be rejoined, not
 * taken as the last token).
 */
export function parsePsAux(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[1], 10),
        command: parts.slice(10).join(' ') || parts[parts.length - 1],
        cpu: parts[2],
        memory: parts[3],
      } as ProcessInfo;
    })
    .filter(p => !Number.isNaN(p.pid));
}

export async function listProcesses(): Promise<ServerResult> {
  const isWindows = os.platform() === 'win32';
  try {
    let processes: ProcessInfo[];
    let note = '';
    try {
      const { stdout } = isWindows
        ? await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000, maxBuffer: 1024 * 1024 })
        : await execFileAsync('ps', ['aux'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      processes = isWindows ? parseWindowsTasklistCsv(stdout) : parsePsAux(stdout);
    } catch (error) {
      if (os.platform() !== 'linux' || (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      const fallback = await listLinuxProcfs();
      processes = fallback.processes;
      note = `\n[Linux procfs fallback: names only; CPU and memory unavailable${fallback.truncated ? '; list truncated' : ''}]`;
    }

    return {
      content: [{
        type: "text",
        text: processes.map(p =>
          `PID: ${p.pid}, Command: ${p.command}, CPU: ${p.cpu}, Memory: ${p.memory}`
        ).join('\n') + note
      }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: Failed to list processes: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function killProcess(args: unknown): Promise<ServerResult> {
  const parsed = KillProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for kill_process: ${parsed.error}` }],
      isError: true,
    };
  }

  if (parsed.data.pid === process.pid) {
    return {
      content: [{ type: "text", text: "Error: Refusing to terminate the agent process" }],
      isError: true,
    };
  }

  try {
    if (!process.kill(parsed.data.pid)) {
      return {
        content: [{ type: "text", text: `Error: Failed to signal process ${parsed.data.pid}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Termination signal sent to process ${parsed.data.pid}; exit is not verified` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: Failed to kill process: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
