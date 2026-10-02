/**
 * The programmable completion builtins, as bash's complete.def has them:
 * `complete` defines, lists and removes completion specifications, `compgen`
 * prints the words one would offer, and `compopt` changes their options —
 * those of the completion a function is generating, when it names none.
 *
 * The specifications are the context's (`getCompletionSpecs()`); what they
 * generate is the executor's (`completeLine`, `generateCompletions`). What
 * needs the system itself — users, groups, hostnames, services — gives
 * nothing here.
 */

import {
  actionCompletions,
  COMPLETE_OPTIONS,
  compoptText,
  type CompSpec,
  DEFAULT_CMD,
  EMPTY_CMD,
  INITIAL_WORD,
  parseSpecArgs,
  pathWords,
  specOrder,
  specText,
} from '../completion.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinRegistry, BuiltinResult, BuiltinServices } from './types.ts';

const COMPGEN_USAGE =
  'compgen: usage: compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]\n';
const COMPLETE_USAGE =
  'complete: usage: complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]\n';
const COMPOPT_USAGE = 'compopt: usage: compopt [-o|+o option] [-DEI] [name ...]\n';

const specsOf = (ctx: ExecContextIf): Map<string, CompSpec> => ctx.getCompletionSpecs?.() ?? new Map();

/**
 * Creates the compgen builtin.
 *
 * @example
 * compgen -A function      -> every function's name
 * compgen -v HO            -> HOME HOSTNAME …
 * compgen -W "start stop" -- st
 */
export function createCompgenBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (ctx: ExecContextIf, args: string[], shell: ShellIf, _execute, services?: BuiltinServices): Promise<BuiltinResult> => {
    if (args.length === 0) return { code: 0 };

    const parsed = parseSpecArgs('compgen', args, '', COMPGEN_USAGE);

    if ('code' in parsed) return parsed;
    if (!parsed.given) return { code: 0 };

    const { spec } = parsed;
    const word = parsed.rest[0] ?? '';
    let stderr = '';

    if (spec.funcname !== undefined) stderr += 'compgen: warning: -F option may not work as you expect\n';
    if (spec.command !== undefined) stderr += 'compgen: warning: -C option may not work as you expect\n';

    let words = services?.generateCompletions ? await services.generateCompletions(spec, word) : await actionCompletions(ctx, shell, registry, spec.actions, word);

    // The shell's own completion and file names, when the specification asks for them and found nothing
    if (words.length === 0 && (spec.options.includes('bashdefault') || spec.options.includes('default'))) {
      words = await pathWords(ctx, shell, word, false);
    }

    if (words.length === 0) return { code: 1, stderr: stderr || undefined };

    return { code: 0, stdout: words.map((w) => `${w}\n`).join(''), stderr: stderr || undefined };
  };
}

/**
 * complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G glob]
 * [-W words] [-F function] [-C command] [-X filter] [-P prefix] [-S suffix]
 * [name …]: define how each name's arguments are completed; with -p or no
 * options list the definitions, with -r remove them.
 */
export const completeBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  const specs = specsOf(ctx);
  const listAll = () => specOrder(specs).map((name) => specText(name, specs.get(name)!)).join('');

  if (args.length === 0) return Promise.resolve({ code: 0, stdout: listAll() || undefined });

  const parsed = parseSpecArgs('complete', args, 'prDEI', COMPLETE_USAGE);

  if ('code' in parsed) return Promise.resolve(parsed);

  const names = parsed.special ? [parsed.special] : parsed.rest;
  const missing = (name: string) => `complete: ${name}: no completion specification\n`;

  if (parsed.print || (parsed.rest.length === 0 && !parsed.given)) {
    if (names.length === 0) return Promise.resolve({ code: 0, stdout: listAll() || undefined });

    let stdout = '';
    let stderr = '';

    for (const name of names) {
      const spec = specs.get(name);

      if (spec) stdout += specText(name, spec);
      else stderr += missing(name);
    }

    return Promise.resolve({ code: stderr ? 1 : 0, stdout: stdout || undefined, stderr: stderr || undefined });
  }

  if (parsed.remove) {
    if (names.length === 0) {
      specs.clear();
      return Promise.resolve({ code: 0 });
    }

    let stderr = '';

    for (const name of names) {
      if (!specs.delete(name)) stderr += missing(name);
    }

    return Promise.resolve({ code: stderr ? 1 : 0, stderr: stderr || undefined });
  }

  if (names.length === 0) return Promise.resolve({ code: 2, stderr: COMPLETE_USAGE });

  // One specification for every name, as bash shares it: a name defined again keeps its place
  for (const name of names) specs.set(name, parsed.spec);

  return Promise.resolve({ code: 0 });
};

/**
 * compopt [-o|+o option] [-DEI] [name …]: turn options of the names'
 * specifications on or off, or of the completion being generated when no
 * name is given; with no option, say which are on.
 */
export const compoptBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[], _shell, _execute, services?: BuiltinServices): Promise<BuiltinResult> => {
  const on: string[] = [];
  const off: string[] = [];
  let special: string | undefined;
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      i++;
      break;
    }

    if (!/^[-+]./.test(arg)) break;

    for (let j = 1; j < arg.length; j++) {
      const c = arg[j];

      if (c === 'o') {
        const value = arg.slice(j + 1) || args[++i];

        if (value === undefined) return Promise.resolve({ code: 2, stderr: `compopt: -o: option requires an argument\n${COMPOPT_USAGE}` });
        if (!COMPLETE_OPTIONS.includes(value)) return Promise.resolve({ code: 2, stderr: `compopt: ${value}: invalid option name\n` });
        (arg[0] === '-' ? on : off).push(value);
        break;
      }

      if (c === 'D' || c === 'E' || c === 'I') special ??= c === 'D' ? DEFAULT_CMD : c === 'E' ? EMPTY_CMD : INITIAL_WORD;
      else return Promise.resolve({ code: 2, stderr: `compopt: ${arg[0]}${c}: invalid option\n${COMPOPT_USAGE}` });
    }
  }

  const change = (spec: CompSpec) => {
    spec.options = COMPLETE_OPTIONS.filter((option) => (spec.options.includes(option) || on.includes(option)) && !off.includes(option));
  };
  const names = special ? [special] : args.slice(i);

  if (names.length === 0) {
    const current = services?.currentCompletion?.();

    if (!current) return Promise.resolve({ code: 1, stderr: 'compopt: not currently executing completion function\n' });
    if (on.length === 0 && off.length === 0) return Promise.resolve({ code: 0, stdout: compoptText(current.cmd, current.spec) });

    change(current.spec);
    return Promise.resolve({ code: 0 });
  }

  const specs = specsOf(ctx);
  let stdout = '';
  let stderr = '';

  for (const name of names) {
    const spec = specs.get(name);

    if (!spec) {
      stderr += `compopt: ${name}: no completion specification\n`;
    } else if (on.length === 0 && off.length === 0) {
      stdout += compoptText(name, spec);
    } else {
      change(spec);
    }
  }

  return Promise.resolve({ code: stderr ? 1 : 0, stdout: stdout || undefined, stderr: stderr || undefined });
};
