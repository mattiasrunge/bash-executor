import type { BashSyntaxError } from '@ein/bash-parser';
import type { ExecContextIf, ShellIf } from '../types.ts';

/**
 * Result from a builtin command execution.
 */
export type BuiltinResult = {
  /** Exit code (0 = success, non-zero = failure) */
  code: number;
  /** Optional stdout output */
  stdout?: string;
  /** Optional stderr output */
  stderr?: string;
  /**
   * Output in the order it was made, where stdout and stderr interleave —
   * printf's complaint about an argument comes before that pass's text.
   * Written before `stdout` and `stderr`.
   */
  output?: { stdout?: string; stderr?: string }[];
};

/**
 * Handler function for a builtin command.
 *
 * @param ctx - The execution context
 * @param args - Command arguments (excluding the command name)
 * @param shell - The shell interface for executing subcommands
 * @param execute - Function to execute a script and return its exit code
 * @param services - What else the executor lends, for a builtin that needs its expansions
 * @returns Promise resolving to the builtin result
 */
export type BuiltinHandler = (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
  execute: (script: string, opts?: { file?: string }) => Promise<number>,
  services?: BuiltinServices,
) => Promise<BuiltinResult>;

/** What the executor lends a builtin beyond running script text. */
export type BuiltinServices = {
  /**
   * A subscript expanded as arithmetic expands `a[$i]` before it uses it — a
   * key as a word, an index as in double quotes: `let 'a[$i]=1'` and
   * `declare -i n='a[$i]'` need it.
   */
  expandSubscript: (subscript: string, keyed: boolean) => Promise<string>;
  /**
   * The arguments written as `name[sub]`, bash's W_ARRAYREF words, whose
   * subscripts were expanded with the word: `unset a["$k"]` removes the key
   * $k holds, where `unset 'a[$k]'` expands the subscript itself.
   */
  arrayRefs?: Set<string>;
  /**
   * Say a syntax error in text the builtin ran as bash says it, and on the
   * shell's stderr: `$0: eval: line N: …` for eval's string, `file: line N: …`
   * for a sourced file.
   */
  reportSyntaxError: (err: BashSyntaxError, where: { eval: true } | { file: string }, source: string) => Promise<void>;
  /**
   * Run text as the shell's own input, a line at a time: kept in the history
   * and history-expanded as bash does with what it reads, and with `echo`
   * each line said on stderr as it is read — what `fc` runs once edited.
   */
  readInput?: (text: string, opts?: { echo?: boolean }) => Promise<number>;
};

/**
 * Registry mapping builtin names to their handlers.
 */
export type BuiltinRegistry = Map<string, BuiltinHandler>;

/** POSIX's special builtins: an assignment before one stays, in posix mode an error in one ends the shell. */
export const SPECIAL_BUILTINS: ReadonlySet<string> = new Set([
  'break',
  ':',
  '.',
  'continue',
  'eval',
  'exec',
  'exit',
  'export',
  'readonly',
  'return',
  'set',
  'shift',
  'source',
  'times',
  'trap',
  'unset',
]);

/** Builtins the executor carries out itself, which are in no registry. */
export const EXECUTOR_BUILTINS: ReadonlySet<string> = new Set(['break', 'continue', 'exec']);
