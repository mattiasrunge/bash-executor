/**
 * Implementation of the read builtin.
 *
 * Reads a line from standard input and assigns words to variables.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * Parse options from arguments.
 */
function parseOptions(args: string[]): {
  prompt: string;
  delimiter: string;
  raw: boolean;
  silent: boolean;
  nChars: number | null;
  varNames: string[];
} {
  const options = {
    prompt: '',
    delimiter: '\n',
    raw: false,
    silent: false,
    nChars: null as number | null,
    varNames: [] as string[],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '-p' && i + 1 < args.length) {
      // Prompt string
      options.prompt = args[++i];
    } else if (arg === '-d' && i + 1 < args.length) {
      // Delimiter
      options.delimiter = args[++i];
    } else if (arg === '-r') {
      // Raw mode (don't interpret backslashes)
      options.raw = true;
    } else if (arg === '-s') {
      // Silent mode (don't echo input)
      options.silent = true;
    } else if (arg === '-n' && i + 1 < args.length) {
      // Read exactly n characters
      options.nChars = Number.parseInt(args[++i], 10);
    } else if (!arg.startsWith('-')) {
      // Variable names start here
      options.varNames = args.slice(i);
      break;
    }

    i++;
  }

  // Default variable name is REPLY
  if (options.varNames.length === 0) {
    options.varNames = ['REPLY'];
  }

  return options;
}

/**
 * Split a line into words respecting IFS.
 *
 * @param line - The line to split
 * @param ifs - The Internal Field Separator (defaults to space, tab, newline)
 * @returns Array of words
 */
function splitByIFS(line: string, ifs: string = ' \t\n'): string[] {
  if (ifs === '') {
    // Empty IFS: no splitting
    return [line];
  }

  const words: string[] = [];
  let current = '';
  let inWord = false;

  for (const char of line) {
    if (ifs.includes(char)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      // Skip consecutive IFS characters
    } else {
      current += char;
      inWord = true;
    }
  }

  if (current) {
    words.push(current);
  }

  return words;
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
 * Reads a line from standard input and splits it into words which are
 * assigned to the named variables. If there are more words than names,
 * the remaining words are all assigned to the last name.
 *
 * Options:
 * -p prompt  Display prompt before reading
 * -d delim   Use delim as line delimiter instead of newline
 * -r         Raw mode: don't interpret backslash escapes
 * -s         Silent mode: don't echo input
 * -n num     Read exactly num characters
 *
 * If no variable names are given, the line is stored in REPLY.
 *
 * Returns 0 on success, 1 on EOF or error.
 *
 * @example
 * read name age      -> reads "John 25" into name=John, age=25
 * read -p "Name: " n -> prompts "Name: " then reads into n
 * read -r line       -> reads without backslash processing
 */
export const readBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<BuiltinResult> => {
  const options = parseOptions(args);

  // Output prompt if specified
  if (options.prompt) {
    await shell.pipeWrite(ctx.getStdout(), options.prompt);
  }

  // Read from stdin
  let input: string;
  try {
    input = await shell.pipeRead(ctx.getStdin());
  } catch {
    // EOF or read error
    return { code: 1 };
  }

  // Handle empty input
  if (input === '') {
    return { code: 1 };
  }

  // Handle -n option (read n characters)
  if (options.nChars !== null && options.nChars > 0) {
    input = input.slice(0, options.nChars);
  }

  // Remove trailing delimiter
  if (input.endsWith(options.delimiter)) {
    input = input.slice(0, -options.delimiter.length);
  } else if (input.endsWith('\n')) {
    input = input.slice(0, -1);
  }

  // Process backslash escapes unless -r is specified
  if (!options.raw) {
    input = processEscapes(input);
  }

  // Get IFS from environment
  const ifs = ctx.getEnv()['IFS'] ?? ' \t\n';

  // Split by IFS
  const words = splitByIFS(input, ifs);

  // Assign to variables
  const varNames = options.varNames;
  const updates: Record<string, string> = {};

  for (let i = 0; i < varNames.length; i++) {
    if (i < varNames.length - 1) {
      // Assign one word
      updates[varNames[i]] = words[i] ?? '';
    } else {
      // Last variable gets all remaining words
      updates[varNames[i]] = words.slice(i).join(' ');
    }
  }

  ctx.setEnv(updates);

  return { code: 0 };
};
