/**
 * Implementation of the source and . builtins.
 *
 * Reads and executes commands from a file in the current shell environment.
 */

import { BashSyntaxError } from '../errors.ts';
import { getReturnCode, isReturnSignal, makeExitSignal } from './exit.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult, BuiltinServices } from './types.ts';

/**
 * The source builtin command.
 *
 * Reads and executes commands from a file in the current shell environment.
 * Unlike executing a script as a subshell, source runs commands in the
 * current shell context, so variable assignments persist.
 *
 * Usage: source filename [arguments]
 *        . filename [arguments]
 *
 * If arguments are provided, they become the positional parameters when
 * executing the file. The previous positional parameters are restored
 * after the file is executed.
 *
 * @example
 * source ./config.sh       -> executes config.sh in current shell
 * . ~/.bashrc             -> executes .bashrc in current shell
 * source script.sh arg1 arg2 -> $1=arg1, $2=arg2 during execution
 */
export const sourceBuiltin: BuiltinHandler = (ctx, args, shell, execute, services) => sourceAs('source', ctx, args, shell, execute, services);

/** `source` and `.` are one builtin, which says its errors under the name it was called by. */
async function sourceAs(
  command: string,
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
  execute: (script: string, opts?: { file?: string }) => Promise<number>,
  services?: BuiltinServices,
): Promise<BuiltinResult> {
  const usage = `${command}: usage: ${command} filename [arguments]\n`;

  if (args[0] === '--') {
    args = args.slice(1);
  } else if (/^-./.test(args[0] ?? '')) {
    return { code: 2, stderr: `${command}: ${args[0].slice(0, 2)}: invalid option\n${usage}` };
  }

  if (args.length === 0) {
    return { code: 2, stderr: `${command}: filename argument required\n${usage}` };
  }

  const [filename, ...params] = args;
  const name = filename.includes('/') ? filename : await findSourcePath(ctx, shell, filename);

  // Not on PATH is the end of a POSIX shell, as any error in a special builtin
  if (name === undefined) {
    return { code: makeExitSignal(1), stderr: `.: ${filename}: file not found\n` };
  }

  let content: string;

  try {
    if (!shell.readFile) {
      throw new Error(`'could not read file, readFile is not defined in shell`);
    }

    content = await shell.readFile(ctx, name);
  } catch (error) {
    // A file that cannot be read is said the way bash says it, and ends a POSIX shell
    const status = ctx.getShellOption('posix') ? makeExitSignal(1) : 1;

    if (error instanceof Deno.errors.IsADirectory) return { code: status, stderr: `source: ${filename}: is a directory\n` };

    const reason = error instanceof Deno.errors.NotFound
      ? 'No such file or directory'
      : error instanceof Deno.errors.PermissionDenied
      ? 'Permission denied'
      : error instanceof Error
      ? error.message.split('\n')[0]
      : String(error);

    return { code: status, stderr: `${filename}: ${reason}\n` };
  }

  // Arguments are the file's positional parameters while it runs; without
  // any it sees the caller's
  const saved = params.length > 0 ? positional(ctx) : undefined;

  if (saved) setPositional(ctx, params);

  try {
    // Execute the file content in the current shell context
    const code = await execute(content, { file: filename });

    // `return` ends the file, not the function or script around the `source`
    return { code: isReturnSignal(code) ? getReturnCode(code) : code };
  } catch (error) {
    // A syntax error is 2, as in bash; the script sourcing it carries on
    if (error instanceof BashSyntaxError) {
      if (services) {
        await services.reportSyntaxError(error, { file: filename }, content);
        return { code: 2 };
      }

      return { code: 2, stderr: `${filename}: syntax error: ${error.message.split('\n')[0]}\n` };
    }

    throw error;
  } finally {
    if (saved) setPositional(ctx, saved);
  }
}

/**
 * Where `source name` finds a name without a slash: on PATH, under `shopt -s
 * sourcepath`, and otherwise in the current directory — except in POSIX mode,
 * where not being on PATH is an error, and undefined says so.
 */
async function findSourcePath(ctx: ExecContextIf, shell: ShellIf, filename: string): Promise<string | undefined> {
  if (ctx.getShellOption('sourcepath') && shell.testPath) {
    const path = ctx.getParams().PATH ?? ctx.getEnv().PATH ?? '';

    for (const dir of path.split(':')) {
      const candidate = `${dir || '.'}/${filename}`;

      if (await shell.testPath(ctx, candidate, 'REGULAR_FILE')) return candidate;
    }

    if (ctx.getShellOption('posix')) return undefined;
  }

  return filename;
}

/** The positional parameters there are now. */
function positional(ctx: ExecContextIf): string[] {
  const params = ctx.getParams();

  return Array.from({ length: Number(params['#'] ?? 0) }, (_, i) => params[String(i + 1)] ?? '');
}

/** Set the positional parameters, as `set --` does. */
function setPositional(ctx: ExecContextIf, values: string[]): void {
  const old = positional(ctx);
  const update: Record<string, string | null> = { '#': String(values.length) };

  old.forEach((_, i) => update[String(i + 1)] = null);
  values.forEach((value, i) => update[String(i + 1)] = value);

  ctx.setParams(update);
}

/**
 * The . builtin command.
 *
 * This is an alias for the source builtin.
 */
export const dotBuiltin: BuiltinHandler = (ctx, args, shell, execute, services) => sourceAs('.', ctx, args, shell, execute, services);
