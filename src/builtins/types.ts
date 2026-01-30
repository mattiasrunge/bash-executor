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
};

/**
 * Handler function for a builtin command.
 *
 * @param ctx - The execution context
 * @param args - Command arguments (excluding the command name)
 * @param shell - The shell interface for executing subcommands
 * @param execute - Function to execute a script and return its exit code
 * @returns Promise resolving to the builtin result
 */
export type BuiltinHandler = (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
  execute: (script: string) => Promise<number>,
) => Promise<BuiltinResult>;

/**
 * Registry mapping builtin names to their handlers.
 */
export type BuiltinRegistry = Map<string, BuiltinHandler>;
