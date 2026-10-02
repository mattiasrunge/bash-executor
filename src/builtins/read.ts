/**
 * Implementation of the read builtin.
 *
 * Reads a line from standard input and assigns words to variables.
 */

import { utils } from '@ein/bash-parser';
import type { ExecContextIf, ShellIf } from '../types.ts';
import { assignReference, type NameReference, nameReference } from './element.ts';
import { readRecord } from './read-record.ts';
import type { BuiltinHandler, BuiltinResult, BuiltinServices } from './types.ts';

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
  /** No names were given: REPLY takes the line as it is, blanks and all */
  whole?: boolean;
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

  if (options.arrayName !== null && !assignable(options.arrayName)) {
    return { code: 1, stderr: `read: \`${options.arrayName}': not a valid identifier\n` };
  }

  // Default variable name is REPLY, which takes the line whole, unsplit
  if (options.varNames.length === 0 && !options.arrayName) {
    options.varNames = ['REPLY'];
    options.whole = true;
  }

  return options;
}

/** A character of the line, and whether a backslash made it stand for itself. */
type Char = { c: string; escaped: boolean };

/** The line as characters: without -r a backslash is taken off, and the one after it is literal. */
function characters(line: string, raw: boolean): Char[] {
  const chars: Char[] = [];

  for (let i = 0; i < line.length; i++) {
    if (!raw && line[i] === '\\') {
      if (i + 1 < line.length) chars.push({ c: line[++i], escaped: true });
      continue;
    }

    chars.push({ c: line[i], escaped: false });
  }

  return chars;
}

/**
 * Words taken off the line one at a time, as bash's read takes them: a word
 * runs to an IFS character not escaped, and with it goes the delimiter — the
 * IFS blanks around it, and one other IFS character among them.
 */
class Words {
  private pos = 0;

  constructor(private readonly chars: Char[], private readonly ifs: string) {
    this.skipBlanks();
  }

  get done(): boolean {
    return this.pos >= this.chars.length;
  }

  private separates(ch: Char | undefined): boolean {
    return ch !== undefined && !ch.escaped && this.ifs.includes(ch.c);
  }

  private blank(ch: Char | undefined): boolean {
    return this.separates(ch) && ' \t\n'.includes(ch!.c);
  }

  private skipBlanks(): void {
    while (this.blank(this.chars[this.pos])) this.pos++;
  }

  word(): string {
    let word = '';

    while (!this.done && !this.separates(this.chars[this.pos])) word += this.chars[this.pos++].c;

    this.skipBlanks();

    if (this.separates(this.chars[this.pos]) && !this.blank(this.chars[this.pos])) {
      this.pos++;
      this.skipBlanks();
    }

    return word;
  }

  /**
   * What the last name gets: the rest of the line, separators and all, less
   * the IFS blanks at its end — or, when the rest is one word and its
   * delimiter, just the word: `1,2,` read into two names gives 2.
   */
  rest(): string {
    const from = this.pos;
    const word = this.word();

    if (this.done) return word;

    let end = this.chars.length;

    while (end > from && this.blank(this.chars[end - 1])) end--;

    return this.chars.slice(from, end).map((ch) => ch.c).join('');
  }
}

/** The values read assigns: one per name, the last the rest of the line; every word for -a. */
function split(line: string, options: ReadOptions, ifs: string): string[] {
  const chars = characters(line, options.raw);

  if (options.whole || ifs === '') {
    const text = chars.map((ch) => ch.c).join('');

    return options.arrayName ? (text === '' ? [] : [text]) : [text];
  }

  const words = new Words(chars, ifs);
  const values: string[] = [];

  if (options.arrayName) {
    while (!words.done) values.push(words.word());

    return values;
  }

  for (let i = 0; i < options.varNames.length - 1 && !words.done; i++) values.push(words.word());

  if (!words.done) values.push(words.rest());

  return values;
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
  _io?,
  services?,
): Promise<BuiltinResult> => {
  const options = parseOptions(args);

  if ('code' in options) return options;

  const refs: NameReference[] = [];

  for (const name of options.varNames) {
    const ref = nameReference(name, ctx);

    if (!ref) return { code: 1, stderr: `read: \`${name}': not a valid identifier\n` };
    refs.push(ref);
  }

  // Output prompt if specified
  if (options.prompt) {
    await shell.pipeWrite(ctx.getStdout(), options.prompt);
  }

  // Determine which FD to read from
  // A descriptor the command or the shell opened is the context's to name; one `exec` opened, the host's
  const fd = options.fd ? (ctx.getFd(options.fd) ?? options.fd) : ctx.getStdin();

  if (options.fd && ctx.getFd(options.fd) === undefined && (ctx.isFdHidden?.(options.fd) || !shell.isPipe(options.fd))) {
    return { code: 1, stderr: `read: ${options.fd}: invalid file descriptor: Bad file descriptor\n` };
  }

  // Read one line from the FD; one the input ended before its delimiter is
  // still assigned, and read fails, as bash's does
  let input: string;
  let delimited = true;
  try {
    if (shell.pipeReadLine) {
      const record = await readRecord(shell, fd, options.delimiter);
      if (record === null) {
        // At the end of the input the names are still assigned, empty, and read fails
        return await assign(ctx, options, refs, [], 1, services);
      }
      input = record.text;
      delimited = record.delimited;

      // Without -r a backslash at the end of a line joins the next one to it
      while (delimited && !options.raw && options.delimiter === '\n' && /(^|[^\\])(\\\\)*\\$/.test(input)) {
        const next = await readRecord(shell, fd, options.delimiter);

        input = input.slice(0, -1) + (next?.text ?? '');
        delimited = next?.delimited ?? false;
        if (next === null) break;
      }
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

  // Handle -n option (read n characters): having them is success, newline or not
  if (options.nChars !== null && options.nChars > 0) {
    if (input.length >= options.nChars) delimited = true;
    input = input.slice(0, options.nChars);
  }

  // `IFS= read -r line` is a prefix assignment, so params come first — and an
  // IFS that is set but empty means "do not split", not "use the default"
  const ifs = ctx.getParam('IFS') ?? utils.DEFAULT_IFS;

  return await assign(ctx, options, refs, split(input, options, ifs), delimited ? 0 : 1, services);
};

/** The words read, into the array or the names; `code` is read's status when they could all be assigned. */
async function assign(
  ctx: ExecContextIf,
  options: ReadOptions,
  refs: NameReference[],
  words: string[],
  code: number,
  services?: BuiltinServices,
): Promise<BuiltinResult> {
  // -a: the words become the elements of an array
  if (options.arrayName) {
    if (ctx.isReadonlyVar(options.arrayName)) return { code: 1, stderr: `${options.arrayName}: readonly variable\n` };

    ctx.setArray(options.arrayName, words);

    return { code };
  }

  // Each name takes its value, and a name there is none for is emptied.
  // Readonly ones are not read into; the rest are set as any assignment sets them
  const readonly = refs.filter((ref) => ctx.isReadonlyVar(ref.name));

  if (readonly.length > 0) {
    return { code: 1, stderr: readonly.map((ref) => `${ref.name}${ref.subscript !== undefined ? `[${ref.subscript}]` : ''}: readonly variable\n`).join('') };
  }

  for (const [i, ref] of refs.entries()) await assignReference(ctx, ref, words[i] ?? '', services);

  return { code };
}
