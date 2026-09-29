/**
 * Implementation of the read builtin.
 *
 * Reads a line from standard input and assigns words to variables.
 */

import { utils } from '@ein/bash-parser';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

const USAGE = 'read: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n';

type ReadOptions = {
  prompt: string;
  delimiter: string;
  raw: boolean;
  silent: boolean;
  nChars: number | null;
  fd: string | null;
  arrayName: string | null;
  varNames: string[];
};

/** A name read can assign: a variable, or an element of one, `A[k]`. */
const assignable = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*(\[.+\])?$/s.test(name);

/**
 * The options as bash's getopt string `ersa:d:i:n:N:p:t:u:` reads them —
 * `-rs`, `-p prompt` and `-pprompt` alike — or the error bash gives.
 */
function parseOptions(args: string[]): ReadOptions | BuiltinResult {
  const options: ReadOptions = {
    prompt: '',
    delimiter: '\n',
    raw: false,
    silent: false,
    nChars: null,
    fd: null,
    arrayName: null,
    varNames: [],
  };

  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      i++;
      break;
    }
    if (!/^-./.test(arg)) break;

    for (let at = 1; at < arg.length; at++) {
      const letter = arg[at];

      if ('ers'.includes(letter)) {
        if (letter === 'r') options.raw = true;
        if (letter === 's') options.silent = true;
        continue;
      }

      if (!'adinNptu'.includes(letter)) {
        return { code: 2, stderr: `read: -${letter}: invalid option\n${USAGE}` };
      }

      // The rest of the word, or the next one, is the option's value
      const value = at + 1 < arg.length ? arg.slice(at + 1) : args[++i];

      if (value === undefined) {
        return { code: 2, stderr: `read: -${letter}: option requires an argument\n${USAGE}` };
      }

      if (letter === 'p') options.prompt = value;
      if (letter === 'd') options.delimiter = value === '' ? '' : value[0];
      if (letter === 'a') options.arrayName = value;

      if (letter === 'n' || letter === 'N') {
        if (!/^\d+$/.test(value)) return { code: 1, stderr: `read: ${value}: invalid number\n` };
        options.nChars = Number(value);
      }

      if (letter === 'u') {
        if (!/^\d+$/.test(value)) return { code: 1, stderr: `read: ${value}: invalid file descriptor specification\n` };
        options.fd = value;
      }

      // A timeout is taken and not kept to: the host's reads have no deadline
      if (letter === 't' && !/^(\d+\.?\d*|\.\d+)$/.test(value)) {
        return { code: 1, stderr: `read: ${value}: invalid timeout specification\n` };
      }

      break;
    }
  }

  options.varNames = args.slice(i);

  for (const name of [...options.varNames, ...(options.arrayName !== null ? [options.arrayName] : [])]) {
    if (!assignable(name)) return { code: 1, stderr: `read: \`${name}': not a valid identifier\n` };
  }

  // Default variable name is REPLY
  if (options.varNames.length === 0 && !options.arrayName) {
    options.varNames = ['REPLY'];
  }

  return options;
}

/**
 * Process backslash escapes in a string.
 *
 * @param str - The string to process
 * @returns The string with escapes processed
 */
function processEscapes(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      if (next === 'n') {
        result += '\n';
      } else if (next === 't') {
        result += '\t';
      } else if (next === '\\') {
        result += '\\';
      } else {
        // Other escapes: remove backslash
        result += next;
      }
      i += 2;
    } else {
      result += str[i];
      i++;
    }
  }

  return result;
}

/**
 * The read builtin command.
 *
 * Reads a line from standard input (or specified FD) and splits it into
 * words which are assigned to the named variables. If there are more
 * words than names, the remaining words are all assigned to the last name.
 *
 * Options:
 * -p prompt  Display prompt before reading
 * -d delim   Use delim as line delimiter instead of newline
 * -r         Raw mode: don't interpret backslash escapes
 * -s         Silent mode: don't echo input
 * -n num     Read exactly num characters
 * -u fd      Read from file descriptor fd instead of stdin
 *
 * If no variable names are given, the line is stored in REPLY.
 *
 * Returns 0 on success, 1 on EOF or error.
 */
export const readBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<BuiltinResult> => {
  const options = parseOptions(args);

  if ('code' in options) return options;

  // Output prompt if specified
  if (options.prompt) {
    await shell.pipeWrite(ctx.getStdout(), options.prompt);
  }

  // Determine which FD to read from
  const fd = options.fd || ctx.getStdin();

  // Read one line from the FD
  let input: string;
  try {
    if (shell.pipeReadLine) {
      const line = await shell.pipeReadLine(fd, options.delimiter);
      if (line === null) {
        // At the end of the input the names are still assigned, empty, and read fails
        return assign(ctx, options, [], 1);
      }
      input = line;
    } else {
      // Fallback for shells without pipeReadLine
      input = await shell.pipeRead(fd);
      if (input === '') {
        return { code: 1 };
      }
      // Strip trailing delimiter
      if (input.endsWith(options.delimiter)) {
        input = input.slice(0, -options.delimiter.length);
      } else if (input.endsWith('\n')) {
        input = input.slice(0, -1);
      }
    }
  } catch {
    // EOF or read error
    return { code: 1 };
  }

  // Handle -n option (read n characters)
  if (options.nChars !== null && options.nChars > 0) {
    input = input.slice(0, options.nChars);
  }

  // Process backslash escapes unless -r is specified
  if (!options.raw) {
    input = processEscapes(input);
  }

  // `IFS= read -r line` is a prefix assignment, so params come first — and an
  // IFS that is set but empty means "do not split", not "use the default"
  const ifs = ctx.getParams()['IFS'] ?? ctx.getEnv()['IFS'] ?? utils.DEFAULT_IFS;

  // Split by IFS
  const words = utils.splitByIfs(input, ifs);

  return assign(ctx, options, words, 0);
};

/** The words read, into the array or the names; `code` is read's status when they could all be assigned. */
function assign(ctx: ExecContextIf, options: ReadOptions, words: string[], code: number): BuiltinResult {
  // -a: the words become the elements of an array
  if (options.arrayName) {
    if (ctx.isReadonlyVar(options.arrayName)) return { code: 1, stderr: `${options.arrayName}: readonly variable\n` };

    ctx.setArray(options.arrayName, words);

    return { code };
  }

  // Each name takes a word, the last one the rest of the line
  const varNames = options.varNames;
  const updates: Record<string, string> = {};

  for (let i = 0; i < varNames.length; i++) {
    updates[varNames[i]] = i < varNames.length - 1 ? words[i] ?? '' : words.slice(i).join(' ');
  }

  // Readonly ones are not read into; the rest are set as any assignment sets them
  const readonly = Object.keys(updates).filter((name) => ctx.isReadonlyVar(name.replace(/\[.*$/s, '')));

  if (readonly.length > 0) {
    return { code: 1, stderr: readonly.map((name) => `${name}: readonly variable\n`).join('') };
  }

  for (const [name, value] of Object.entries(updates)) {
    const element = name.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/s);

    if (!element) {
      ctx.assignVariable(name, value);
    } else if (ctx.getAssoc(element[1])) {
      ctx.setAssocElement(element[1], element[2], value);
    } else {
      ctx.setArrayElement(element[1], Number.parseInt(element[2], 10) || 0, value);
    }
  }

  return { code };
}
