/**
 * Implementation of the compgen builtin: the words that complete a word, from
 * the lists bash's programmable completion draws on. What needs the system
 * itself — users, groups, hostnames, services — gives nothing here.
 */

import { globToRegExp } from '../pattern.ts';
import { DEFAULT_SHELL_OPTIONS, DEFAULT_SHOPT_OPTIONS, type ExecContextIf, type ShellIf } from '../types.ts';
import { SIGNALS } from './trap.ts';
import type { BuiltinHandler, BuiltinRegistry, BuiltinResult } from './types.ts';

const USAGE =
  'compgen: usage: compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]\n';

/** The actions by their one-letter options. */
const LETTERS: Record<string, string> = {
  a: 'alias',
  b: 'builtin',
  c: 'command',
  d: 'directory',
  e: 'export',
  f: 'file',
  g: 'group',
  j: 'job',
  k: 'keyword',
  s: 'service',
  u: 'user',
  v: 'variable',
};

const ACTIONS = new Set([
  ...Object.values(LETTERS),
  'arrayvar',
  'binding',
  'disabled',
  'enabled',
  'function',
  'helptopic',
  'hostname',
  'running',
  'setopt',
  'shopt',
  'signal',
  'stopped',
]);

/** bash's reserved words, in its own order. */
const KEYWORDS = 'if then else elif fi case esac for select while until do done in function time { } ! [[ ]] coproc'.split(' ');

const byteOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const isName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/**
 * Creates the compgen builtin.
 *
 * @example
 * compgen -A function      -> every function's name
 * compgen -v HO            -> HOME HOSTNAME …
 * compgen -W "start stop" -- st
 */
export function createCompgenBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
    const actions: string[] = [];
    let wordlist: string | undefined;
    let globpat: string | undefined;
    let filter: string | undefined;
    let prefix = '';
    let suffix = '';
    let i = 0;

    for (; i < args.length && args[i].startsWith('-') && args[i].length > 1; i++) {
      if (args[i] === '--') {
        i++;
        break;
      }

      for (let j = 1; j < args[i].length; j++) {
        const flag = args[i][j];

        if (flag in LETTERS) {
          actions.push(LETTERS[flag]);
          continue;
        }

        if (!'oAGWFCXPS'.includes(flag)) return { code: 2, stderr: `compgen: -${flag}: invalid option\n${USAGE}` };

        // The option's argument: the rest of this word, or the next
        const value = args[i].slice(j + 1) || args[++i];

        if (value === undefined) return { code: 2, stderr: `compgen: -${flag}: option requires an argument\n${USAGE}` };

        if (flag === 'A') {
          if (!ACTIONS.has(value)) return { code: 2, stderr: `compgen: ${value}: invalid action name\n` };
          actions.push(value);
        } else if (flag === 'W') {
          wordlist = value;
        } else if (flag === 'G') {
          globpat = value;
        } else if (flag === 'X') {
          filter = value;
        } else if (flag === 'P') {
          prefix = value;
        } else if (flag === 'S') {
          suffix = value;
        }

        break;
      }
    }

    const word = args[i] ?? '';
    const matches: string[] = [];
    const add = (names: Iterable<string>) => {
      for (const name of names) {
        if (name.startsWith(word)) matches.push(name);
      }
    };

    for (const action of actions) {
      add(await actionWords(ctx, shell, registry, action, word));
    }

    if (globpat !== undefined && shell.resolvePath) {
      matches.push(...await shell.resolvePath(ctx, globpat));
    }

    if (wordlist !== undefined) {
      const ifs = ctx.getParams().IFS ?? ' \t\n';

      add(wordlist.split(new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&')}]+`)).filter(Boolean));
    }

    // -X drops what matches it; `!pat` keeps only that
    let words = matches;

    if (filter !== undefined) {
      const keep = filter.startsWith('!');
      const pattern = globToRegExp(keep ? filter.slice(1) : filter);

      words = words.filter((w) => pattern.test(w) === keep);
    }

    if (words.length === 0) return { code: 1 };

    return { code: 0, stdout: words.map((w) => `${prefix}${w}${suffix}\n`).join('') };
  };
}

/** The words one action offers, before they are matched against the word. */
async function actionWords(ctx: ExecContextIf, shell: ShellIf, registry: BuiltinRegistry, action: string, word: string): Promise<string[]> {
  switch (action) {
    case 'alias':
      return Object.keys(ctx.getAliases()).sort(byteOrder);
    case 'arrayvar':
      return [...Object.keys(ctx.getArrays()), ...Object.keys(ctx.getAssocs())].sort(byteOrder);
    case 'builtin':
    case 'enabled':
      return [...registry.keys()].sort(byteOrder);
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
        ...[...registry.keys()],
        ...Object.keys(ctx.getFunctions()),
        ...KEYWORDS,
        ...await commandFiles(ctx, shell, word),
      ];
    default:
      // users, groups, hostnames, services, jobs, bindings, help topics: not known here
      return [];
  }
}

/** The files, or only the directories, whose names start with `word`. */
async function pathWords(ctx: ExecContextIf, shell: ShellIf, word: string, directories: boolean): Promise<string[]> {
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
