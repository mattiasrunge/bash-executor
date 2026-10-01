/**
 * The ulimit builtin: the shell's resource limits, as bash's ulimit.def
 * shows and sets them on Linux.
 *
 * The limits are kept on the context (`getResourceLimits`), as the umask is,
 * for the host to apply to what it starts; the executor runs in one process
 * for many shells and limits none of them itself. Until set, a limit is what
 * a Linux login shell usually starts with.
 */

import type { ExecContextIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

type Resource = { letter: string; description: string; unit?: string; soft: string; hard: string; readonly?: boolean };

/** In bash's order, with its descriptions and units. */
const RESOURCES: Resource[] = [
  { letter: 'R', description: 'real-time non-blocking time', unit: 'microseconds', soft: 'unlimited', hard: 'unlimited' },
  { letter: 'c', description: 'core file size', unit: 'blocks', soft: '0', hard: 'unlimited' },
  { letter: 'd', description: 'data seg size', unit: 'kbytes', soft: 'unlimited', hard: 'unlimited' },
  { letter: 'e', description: 'scheduling priority', soft: '0', hard: '0' },
  { letter: 'f', description: 'file size', unit: 'blocks', soft: 'unlimited', hard: 'unlimited' },
  { letter: 'i', description: 'pending signals', soft: '63432', hard: '63432' },
  { letter: 'l', description: 'max locked memory', unit: 'kbytes', soft: '8192', hard: '8192' },
  { letter: 'm', description: 'max memory size', unit: 'kbytes', soft: 'unlimited', hard: 'unlimited' },
  { letter: 'n', description: 'open files', soft: '1024', hard: '524288' },
  { letter: 'p', description: 'pipe size', unit: '512 bytes', soft: '8', hard: '8', readonly: true },
  { letter: 'q', description: 'POSIX message queues', unit: 'bytes', soft: '819200', hard: '819200' },
  { letter: 'r', description: 'real-time priority', soft: '0', hard: '0' },
  { letter: 's', description: 'stack size', unit: 'kbytes', soft: '8192', hard: 'unlimited' },
  { letter: 't', description: 'cpu time', unit: 'seconds', soft: 'unlimited', hard: 'unlimited' },
  { letter: 'u', description: 'max user processes', soft: '63432', hard: '63432' },
  { letter: 'v', description: 'virtual memory', unit: 'kbytes', soft: 'unlimited', hard: 'unlimited' },
  { letter: 'x', description: 'file locks', soft: 'unlimited', hard: 'unlimited' },
];

const USAGE = 'ulimit: usage: ulimit [-SHabcdefiklmnpqrstuvxPRT] [limit]\n';

/** A resource's soft and hard limits as the shell has them now. */
const limitOf = (ctx: ExecContextIf, resource: Resource) => ctx.getResourceLimits?.()[resource.letter] ?? { soft: resource.soft, hard: resource.hard };

/** `unlimited` is past every number. */
const above = (a: string, b: string): boolean => b !== 'unlimited' && (a === 'unlimited' || BigInt(a) > BigInt(b));

/** One line of `ulimit -a`: the description, its unit and letter, and the value. */
const describe = (resource: Resource, value: string): string =>
  `${resource.description.padEnd(20)} ${(resource.unit ? `(${resource.unit}, -${resource.letter}) ` : `(-${resource.letter}) `).padStart(20)}${value}\n`;

/**
 * ulimit [-SHa] [-resource [limit]]…: show a limit (the file size one when
 * none is named), or set it, soft and hard both unless -S or -H says which.
 */
export const ulimitBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  let hard = false;
  let soft = false;
  let all = false;
  const wanted: { resource: Resource; value?: string }[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      if (i + 1 < args.length) wanted.push({ resource: RESOURCES.find((r) => r.letter === 'f')!, value: args[i + 1] });
      break;
    }

    if (!arg.startsWith('-') || arg === '-') {
      // A limit with no resource named is the file size one
      if (wanted.length === 0) wanted.push({ resource: RESOURCES.find((r) => r.letter === 'f')! });
      wanted[wanted.length - 1].value = arg;
      continue;
    }

    for (const letter of arg.slice(1)) {
      if (letter === 'H') hard = true;
      else if (letter === 'S') soft = true;
      else if (letter === 'a') all = true;
      else {
        const resource = RESOURCES.find((r) => r.letter === letter);

        if (!resource) return Promise.resolve({ code: 2, stderr: `ulimit: -${letter}: invalid option\n${USAGE}` });

        wanted.push({ resource });
      }
    }
  }

  const shown = (resource: Resource) => {
    const limit = limitOf(ctx, resource);

    return hard && !soft ? limit.hard : limit.soft;
  };

  if (all) {
    return Promise.resolve({ code: 0, stdout: RESOURCES.map((resource) => describe(resource, shown(resource))).join('') });
  }

  if (wanted.length === 0) wanted.push({ resource: RESOURCES.find((r) => r.letter === 'f')! });

  let stdout = '';
  let stderr = '';

  for (const { resource, value } of wanted) {
    if (value === undefined) {
      stdout += wanted.length > 1 ? describe(resource, shown(resource)) : `${shown(resource)}\n`;
      continue;
    }

    const current = limitOf(ctx, resource);
    const given = value === 'hard' ? current.hard : value === 'soft' ? current.soft : value;

    if (given !== 'unlimited' && !/^\d+$/.test(given)) {
      stderr += `ulimit: ${value}: invalid number\n`;
      continue;
    }

    const next = { soft: hard && !soft ? current.soft : given, hard: soft && !hard ? current.hard : given };

    if (resource.readonly) {
      stderr += `ulimit: ${resource.description}: cannot modify limit: Invalid argument\n`;
    } else if (above(next.hard, current.hard)) {
      stderr += `ulimit: ${resource.description}: cannot modify limit: Operation not permitted\n`;
    } else if (above(next.soft, next.hard)) {
      stderr += `ulimit: ${resource.description}: cannot modify limit: Invalid argument\n`;
    } else {
      ctx.setResourceLimit?.(resource.letter, next);
    }
  }

  return Promise.resolve({ code: stderr ? 1 : 0, stdout: stdout || undefined, stderr: stderr || undefined });
};
