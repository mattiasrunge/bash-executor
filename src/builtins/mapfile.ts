/**
 * Implementation of the mapfile / readarray builtin.
 *
 * Reads lines into an array. This is the way to iterate over output that may
 * contain spaces — `mapfile -t FILES < list` keeps one line per element, where
 * `for f in $(cat list)` would split every line on IFS.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * Parse options from arguments.
 */
function parseOptions(args: string[]): {
  delimiter: string;
  strip: boolean;
  count: number | null;
  skip: number;
  origin: number;
  truncate: boolean;
  fd: string | null;
  arrayName: string;
} {
  const options = {
    delimiter: '\n',
    strip: false,
    count: null as number | null,
    skip: 0,
    origin: 0,
    truncate: true,
    fd: null as string | null,
    arrayName: 'MAPFILE',
  };

  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '-d' && i + 1 < args.length) {
      options.delimiter = args[++i];
    } else if (arg === '-t') {
      options.strip = true;
    } else if (arg === '-n' && i + 1 < args.length) {
      options.count = Number.parseInt(args[++i], 10);
    } else if (arg === '-s' && i + 1 < args.length) {
      options.skip = Number.parseInt(args[++i], 10) || 0;
    } else if (arg === '-O' && i + 1 < args.length) {
      options.origin = Number.parseInt(args[++i], 10) || 0;
      options.truncate = false;
    } else if (arg === '-u' && i + 1 < args.length) {
      options.fd = args[++i];
    } else if (arg === '-C' || arg === '-c') {
      // Callback options are accepted and ignored
      i++;
    } else if (!arg.startsWith('-')) {
      options.arrayName = arg;
      break;
    }

    i++;
  }

  return options;
}

/**
 * The mapfile builtin command.
 *
 * Reads lines from standard input (or -u fd) into an indexed array, one line
 * per element. Without -t the delimiter stays on the end of each line.
 *
 * Options:
 * -d delim   Use delim instead of newline
 * -t         Strip the delimiter from each line
 * -n count   Read at most count lines (0 means all)
 * -s count   Skip the first count lines
 * -O origin  Assign starting at index origin, keeping earlier elements
 * -u fd      Read from file descriptor fd
 *
 * If no array name is given the lines go into MAPFILE.
 *
 * Returns 0, or 1 when the shell cannot read a line at a time.
 */
export const mapfileBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<BuiltinResult> => {
  const options = parseOptions(args);

  if (!shell.pipeReadLine) {
    return { code: 1, stderr: 'mapfile: reading line by line is not supported by this shell\n' };
  }

  const fd = options.fd || ctx.getStdin();
  const values = options.truncate ? [] : (ctx.getArray(options.arrayName) ?? []).slice(0, options.origin);

  let read = 0;
  let skipped = 0;

  while (options.count === null || options.count <= 0 || read < options.count) {
    let line: string | null;

    try {
      line = await shell.pipeReadLine(fd, options.delimiter);
    } catch {
      break;
    }

    if (line === null) {
      break;
    }

    if (skipped < options.skip) {
      skipped++;
      continue;
    }

    values[options.origin + read] = options.strip ? line : line + options.delimiter;
    read++;
  }

  ctx.setArray(options.arrayName, values);
  ctx.setParams({ [options.arrayName]: null });

  return { code: 0 };
};
