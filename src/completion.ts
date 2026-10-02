/**
 * Programmable completion, as bash has it (pcomplete.c, complete.def): the
 * completion specifications `complete` defines, the words each of their
 * actions offers, and how a command line is cut into the words a completion
 * function sees in COMP_WORDS.
 *
 * Running a function (`-F`), a command (`-C`) or expanding a word list
 * (`-W`) needs the executor; that part is `AstExecutor.completeLine` and the
 * generator it lends `compgen`.
 */

import { bashHashOrder } from './hash-order.ts';
import { globToRegExp } from './pattern.ts';
import { DEFAULT_SHELL_OPTIONS, DEFAULT_SHOPT_OPTIONS, type ExecContextIf, type ShellIf } from './types.ts';
import { SIGNALS } from './builtins/trap.ts';
import type { BuiltinRegistry } from './builtins/types.ts';

/** A completion specification: what `complete` says to offer for a command. */
export type CompSpec = {
  /** Action names, as `-A` takes them */
  actions: string[];
  /** `-o` options */
  options: string[];
  globpat?: string;
  words?: string;
  prefix?: string;
  suffix?: string;
  funcname?: string;
  command?: string;
  filterpat?: string;
};

/** The names bash keeps `-D`, `-E` and `-I` specifications under. */
export const DEFAULT_CMD = '_DefaultCmD_';
export const EMPTY_CMD = '_EmptycmD_';
export const INITIAL_WORD = '_InitialWorD_';

/** The actions in bash's order, with the option letter of those that have one. */
export const COMPLETE_ACTIONS: [string, string][] = [
  ['alias', 'a'],
  ['arrayvar', ''],
  ['binding', ''],
  ['builtin', 'b'],
  ['command', 'c'],
  ['directory', 'd'],
  ['disabled', ''],
  ['enabled', ''],
  ['export', 'e'],
  ['file', 'f'],
  ['function', ''],
  ['helptopic', ''],
  ['hostname', ''],
  ['group', 'g'],
  ['job', 'j'],
  ['keyword', 'k'],
  ['running', ''],
  ['service', 's'],
  ['setopt', ''],
  ['shopt', ''],
  ['signal', ''],
  ['stopped', ''],
  ['user', 'u'],
  ['variable', 'v'],
];

/** `-o` options, in bash's order. */
export const COMPLETE_OPTIONS = ['bashdefault', 'default', 'dirnames', 'filenames', 'noquote', 'nosort', 'nospace', 'plusdirs'];

const ACTION_BY_LETTER: Record<string, string> = Object.fromEntries(COMPLETE_ACTIONS.filter(([, letter]) => letter).map(([name, letter]) => [letter, name]));

/** The characters COMP_WORDBREAKS has until a script sets it. */
export const DEFAULT_WORDBREAKS = ' \t\n"\'><=;|&(:';

/** What `complete`, `compgen` and `compopt` took from their options. */
export type SpecArgs = {
  spec: CompSpec;
  /** Any option given at all */
  given: boolean;
  print: boolean;
  remove: boolean;
  /** -D, -E or -I: the name the specification goes under */
  special?: string;
  rest: string[];
};

/** sh_single_quote */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** sh_contains_shell_metas: what would need quoting to stay one word as written. */
const hasShellMetas = (text: string): boolean => /[ \t\n'"\\|&;()<>!{}*[?\]^$`]/.test(text) || /^[~#]|[=:]~/.test(text);

/**
 * build_actions: the options of `complete`/`compgen`. `allow` holds the
 * letters only `complete` takes (`p`, `r`, `D`, `E`, `I`). Returns the
 * error text and status for a bad option.
 */
export function parseSpecArgs(name: string, args: string[], allow: string, usage: string): SpecArgs | { code: number; stderr: string } {
  const spec: CompSpec = { actions: [], options: [] };
  const result: SpecArgs = { spec, given: false, print: false, remove: false, rest: [] };
  const addAction = (action: string) => {
    if (!spec.actions.includes(action)) spec.actions.push(action);
  };
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      i++;
      break;
    }

    if (!arg.startsWith('-') || arg === '-') break;

    for (let j = 1; j < arg.length; j++) {
      const c = arg[j];

      result.given = true;

      if (c in ACTION_BY_LETTER) {
        addAction(ACTION_BY_LETTER[c]);
        continue;
      }

      if ('prDEI'.includes(c)) {
        if (!allow.includes(c)) return { code: 2, stderr: `${name}: -${c}: invalid option\n${usage}` };
        if (c === 'p') result.print = true;
        else if (c === 'r') result.remove = true;
        else result.special ??= c === 'D' ? DEFAULT_CMD : c === 'E' ? EMPTY_CMD : INITIAL_WORD;
        continue;
      }

      if (!'oAGWPSXFC'.includes(c)) return { code: 2, stderr: `${name}: -${c}: invalid option\n${usage}` };

      // The option's argument: the rest of this word, or the next
      const value = arg.slice(j + 1) || args[++i];

      if (value === undefined) return { code: 2, stderr: `${name}: -${c}: option requires an argument\n${usage}` };

      if (c === 'o') {
        if (!COMPLETE_OPTIONS.includes(value)) return { code: 2, stderr: `${name}: ${value}: invalid option name\n` };
        if (!spec.options.includes(value)) spec.options.push(value);
      } else if (c === 'A') {
        if (!COMPLETE_ACTIONS.some(([action]) => action === value)) return { code: 2, stderr: `${name}: ${value}: invalid action name\n` };
        addAction(value);
      } else if (c === 'F') {
        if (!/^[^ \t\n|&;()<>$`\\"'=]+$/.test(value)) return { code: 2, stderr: `${name}: \`${value}': not a valid identifier\n` };
        spec.funcname = value;
      } else {
        const key = ({ G: 'globpat', W: 'words', P: 'prefix', S: 'suffix', X: 'filterpat', C: 'command' } as const)[c as 'G'];

        spec[key] = value;
      }

      break;
    }
  }

  result.rest = args.slice(i);

  return result;
}

/** print_one_completion: the `complete` command that would define `spec` for `name`. */
export function specText(name: string, spec: CompSpec): string {
  let out = 'complete ';

  for (const option of COMPLETE_OPTIONS) {
    if (spec.options.includes(option)) out += `-o ${option} `;
  }

  for (const [action, letter] of COMPLETE_ACTIONS) {
    if (letter && spec.actions.includes(action)) out += `-${letter} `;
  }

  for (const [action, letter] of COMPLETE_ACTIONS) {
    if (!letter && spec.actions.includes(action)) out += `-A ${action} `;
  }

  for (const [flag, value] of [['-G', spec.globpat], ['-W', spec.words], ['-P', spec.prefix], ['-S', spec.suffix], ['-X', spec.filterpat], ['-C', spec.command]]) {
    if (value !== undefined) out += `${flag} ${shellQuote(value)} `;
  }

  if (spec.funcname !== undefined) out += `-F ${hasShellMetas(spec.funcname) ? shellQuote(spec.funcname) : spec.funcname} `;

  return `${out}${commandName(name)}\n`;
}

/** print_compopts: the `compopt` command that would set `spec`'s options, every one named. */
export function compoptText(name: string, spec: CompSpec): string {
  const options = COMPLETE_OPTIONS.map((option) => `${spec.options.includes(option) ? '-o' : '+o'} ${option} `).join('');

  return `compopt ${options}${commandName(name)}\n`;
}

/** How a specification's command is written: `-D`, `-E`, `-I`, or the name, quoted if it needs it. */
function commandName(name: string): string {
  if (name === DEFAULT_CMD) return '-D';
  if (name === EMPTY_CMD) return '-E';
  if (name === INITIAL_WORD) return '-I';
  if (name === '') return "''";

  return hasShellMetas(name) ? shellQuote(name) : name;
}

/** The specifications in the order bash's table of 512 buckets lists them. */
export function specOrder(specs: Map<string, CompSpec>): string[] {
  return bashHashOrder([...specs.keys()], 512);
}

/** bash's reserved words, in its own order. */
const KEYWORDS = 'if then else elif fi case esac for select while until do done in function time { } ! [[ ]] coproc'.split(' ');

const byteOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const isName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** gen_action_completions: the words the spec's actions offer that start with `word`. */
export async function actionCompletions(ctx: ExecContextIf, shell: ShellIf, registry: BuiltinRegistry | undefined, actions: string[], word: string): Promise<string[]> {
  const matches: string[] = [];

  for (const action of actions) {
    for (const name of await actionWords(ctx, shell, registry, action, word)) {
      if (name.startsWith(word)) matches.push(name);
    }
  }

  return matches;
}

/** The words one action offers, before they are matched against the word. */
async function actionWords(ctx: ExecContextIf, shell: ShellIf, registry: BuiltinRegistry | undefined, action: string, word: string): Promise<string[]> {
  const builtins = [...(registry?.keys() ?? [])];

  switch (action) {
    case 'alias':
      return Object.keys(ctx.getAliases()).sort(byteOrder);
    case 'arrayvar':
      return [...Object.keys(ctx.getArrays()), ...Object.keys(ctx.getAssocs())].sort(byteOrder);
    case 'builtin':
    case 'enabled':
      return builtins.sort(byteOrder);
    case 'export':
      return Object.keys(ctx.getEnv()).filter(isName).sort(byteOrder);
    case 'function':
      return Object.keys(ctx.getFunctions()).sort(byteOrder);
    case 'keyword':
      return KEYWORDS;
    case 'setopt':
      return Object.keys(DEFAULT_SHELL_OPTIONS).sort(byteOrder);
    case 'shopt':
      return Object.keys(DEFAULT_SHOPT_OPTIONS);
    case 'signal':
      return SIGNALS.map(([, name]) => `SIG${name}`);
    case 'job':
    case 'running':
    case 'stopped': {
      // A job by the first word of its command
      const state = action === 'running' ? 'Running' : action === 'stopped' ? 'Stopped' : undefined;

      return ctx.getJobTable().list().filter((job) => !state || job.state === state).map((job) => job.command.trim().split(/\s+/)[0]);
    }
    case 'variable': {
      const names = new Set([...Object.keys(ctx.getEnv()), ...Object.keys(ctx.getParams()), ...Object.keys(ctx.getArrays()), ...Object.keys(ctx.getAssocs())]);

      return [...names].filter(isName).sort(byteOrder);
    }
    case 'directory':
    case 'file':
      return await pathWords(ctx, shell, word, action === 'directory');
    case 'command':
      return [
        ...Object.keys(ctx.getAliases()),
        ...builtins,
        ...Object.keys(ctx.getFunctions()),
        ...KEYWORDS,
        ...await commandFiles(ctx, shell, word),
      ];
    default:
      // users, groups, hostnames, services, bindings, help topics: not known here
      return [];
  }
}

/** The files, or only the directories, whose names start with `word`. */
export async function pathWords(ctx: ExecContextIf, shell: ShellIf, word: string, directories: boolean): Promise<string[]> {
  if (!shell.resolvePath) return [];

  const escaped = word.replace(/[\\*?[\]]/g, '\\$&');
  const found = await shell.resolvePath(ctx, `${escaped}*`).catch(() => [] as string[]);

  // A glob that matches nothing is itself
  const paths = found.filter((path) => path !== `${escaped}*`);

  if (!directories) return paths;

  const dirs: string[] = [];

  for (const path of paths) {
    if (await shell.testPath?.(ctx, path, 'DIRECTORY')) dirs.push(path);
  }

  return dirs;
}

/** The commands on PATH whose names start with `word`. */
async function commandFiles(ctx: ExecContextIf, shell: ShellIf, word: string): Promise<string[]> {
  if (word.includes('/')) return await pathWords(ctx, shell, word, false);
  if (!shell.resolvePath) return [];

  const names = new Set<string>();

  for (const dir of (ctx.getParams().PATH ?? ctx.getEnv().PATH ?? '').split(':')) {
    const escaped = word.replace(/[\\*?[\]]/g, '\\$&');

    for (const path of await shell.resolvePath(ctx, `${dir || '.'}/${escaped}*`).catch(() => [] as string[])) {
      const name = path.slice(path.lastIndexOf('/') + 1);

      if (name !== `${escaped}*` && (await shell.testPath?.(ctx, path, 'EXECUTABLE') ?? true)) names.add(name);
    }
  }

  return [...names];
}

/**
 * filter_stringlist: `-X` drops the words that match the pattern, `!pat`
 * keeps only those; a `&` in it is the word being completed.
 */
export function filterWords(words: string[], filterpat: string, word: string, extglob: boolean): string[] {
  const pattern = /(^|[^\\])&/.test(filterpat) ? filterpat.replace(/\\&|&/g, (m) => m === '&' ? word.replace(/[\\*?[\]@+!()|]/g, '\\$&') : m) : filterpat;
  const not = pattern[0] === '!' && (!extglob || pattern[1] !== '(');
  const regex = globToRegExp(not ? pattern.slice(1) : pattern);

  return words.filter((w) => regex.test(w) === not);
}

/** A word of a command line, and where it is in it. */
export type LineWord = { text: string; start: number; end: number };

/** skip_to_delim for completion: past quoted text and substitutions, to the next delimiter. */
function skipToDelim(text: string, i: number, delims: string): number {
  while (i < text.length) {
    const c = text[i];

    if (c === '\\') {
      i += 2;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);

      i = close === -1 ? text.length : close + 1;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '`') {
      const close = text.indexOf('`', i + 1);

      i = close === -1 ? text.length : close + 1;
    } else if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
      const open = text[i + 1];
      const shut = open === '(' ? ')' : '}';
      let depth = 1;

      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') i++;
        else if (text[i] === open) depth++;
        else if (text[i] === shut) depth--;
        i++;
      }
    } else if (delims.includes(c)) {
      return i;
    } else {
      i++;
    }
  }

  return Math.min(i, text.length);
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';

/**
 * split_at_delims as completion uses it: the words of `text` split at
 * `delims`, a delimiter that is not a blank being a word of its own, and the
 * index of the word that holds `sentinel` (the cursor) — an empty word made
 * for it when it is between words.
 */
export function splitAtDelims(text: string, delims: string, sentinel: number): { words: LineWord[]; current: number } {
  const words: LineWord[] = [];
  const marks = [...delims].filter((c) => !isBlank(c)).join('');
  let current = -1;
  let i = 0;
  let te = 0;

  while (i < text.length && delims.includes(text[i]) && isBlank(text[i])) i++;

  if (i >= text.length) {
    return { words: [{ text: '', start: sentinel, end: sentinel }], current: 0 };
  }

  let ts = i;

  for (;;) {
    te = skipToDelim(text, ts, delims);

    if (ts === te && marks.includes(text[ts])) {
      te = ts + 1;
      while (te < text.length && marks.includes(text[te]) && text[te] !== "'" && text[te] !== '"') te++;
    }

    words.push({ text: text.slice(ts, te), start: ts, end: te });

    if (sentinel >= ts && sentinel <= te && current === -1) current = words.length - 1;

    // On the blank just before a word is on that word
    if (current === -1 && sentinel === ts - 1) current = words.length - 1;

    if (current === -1 && sentinel < ts) {
      // Between words: an empty one is made where the cursor is
      words.splice(words.length - 1, 0, { text: '', start: sentinel, end: sentinel });
      current = words.length - 2;
    }

    if (te >= text.length) break;

    i = te;
    while (i < text.length && delims.includes(text[i]) && isBlank(text[i])) i++;

    if (i >= text.length) break;
    ts = i;
  }

  if (current === -1) {
    if (isBlank(text[sentinel - 1])) words.push({ text: '', start: sentinel, end: sentinel });
    current = words.length - 1;
  }

  return { words, current };
}

/** Where the command around `point` starts and ends: after and before `;`, `|`, `&`, `(`, `{` or a backquote. */
export function commandBounds(line: string, point: number): { start: number; end: number } {
  const separators = ';|&{(`\n';
  let start = 0;
  let i = 0;

  while (i < point) {
    const next = skipToDelim(line, i, separators);

    if (next >= point) break;
    start = next + 1;
    i = next + 1;
  }

  // The command starts at its first word
  while (start < point && isBlank(line[start])) start++;

  const end = skipToDelim(line, point, separators);

  return { start, end: Math.min(end, line.length) };
}
