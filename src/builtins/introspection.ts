/**
 * Implementation of the type, command, and builtin builtins.
 *
 * These builtins provide introspection and control over command execution.
 * `type` and `command -v`/`-V` describe a name the way bash's describe_command
 * does: alias, keyword, function, builtin, hashed command, file on PATH.
 */

import { hashedCommand } from '../command-hash.ts';
import { singleQuoted } from '../quote.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinRegistry, BuiltinResult } from './types.ts';

/** bash's reserved words. */
const KEYWORDS = new Set(
  '! [[ ]] case coproc do done elif else esac fi for function if in select then time until while { }'.split(' '),
);

/** The PATH `command -p` searches: the system's standard one, as confstr(_CS_PATH) gives it. */
const STANDARD_PATH = '/bin:/usr/bin';

/**
 * Helper to capture output from a command using pipes.
 */
async function captureCommandOutput(
  ctx: ExecContextIf,
  shell: ShellIf,
  name: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdoutPipe = await shell.pipeOpen();
  const stderrPipe = await shell.pipeOpen();

  const cmdCtx = ctx.spawnContext();
  cmdCtx.redirectStdout(stdoutPipe);
  cmdCtx.redirectStderr(stderrPipe);
  cmdCtx.setLocalEnv(env);

  try {
    const code = await shell.execute(cmdCtx, name, args, {});

    // Signal EOF
    await shell.pipeClose(stdoutPipe);
    await shell.pipeClose(stderrPipe);

    const stdout = await shell.pipeRead(stdoutPipe);
    const stderr = await shell.pipeRead(stderrPipe);

    return { code, stdout, stderr };
  } finally {
    await shell.pipeRemove(stdoutPipe);
    await shell.pipeRemove(stderrPipe);
  }
}

/**
 * The files a command name could run, in PATH order: the host's own answer, or
 * what `which -a` says when it has none.
 */
export async function lookupCommand(ctx: ExecContextIf, shell: ShellIf, name: string, path?: string): Promise<string[]> {
  if (shell.lookupCommand) {
    return await shell.lookupCommand(ctx, name, path);
  }

  try {
    const result = await captureCommandOutput(ctx, shell, 'which', ['-a', name], path === undefined ? {} : { PATH: path });

    return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** How describe_command describes a name. */
type Describe = {
  /** Every way the name resolves, not only the first */
  all?: boolean;
  /** `x is a shell builtin`: type, command -V */
  short?: boolean;
  /** What reads back as the same command: command -v */
  reusable?: boolean;
  /** One word, `builtin` or `file`: type -t */
  type?: boolean;
  /** The file only: type -p */
  pathOnly?: boolean;
  /** Only the files on PATH: type -P */
  forcePath?: boolean;
  /** Functions are not looked at: type -f */
  noFuncs?: boolean;
  /** Search the standard PATH: command -p */
  stdPath?: boolean;
};

/**
 * Describe a name as bash's describe_command does, into `out`. False when it
 * is nothing at all.
 */
async function describeCommand(
  ctx: ExecContextIf,
  shell: ShellIf,
  registry: BuiltinRegistry,
  name: string,
  flags: Describe,
  out: string[],
): Promise<boolean> {
  let found = false;

  /** One way the name resolves; true when that is enough. */
  const say = (type: string, short: string, reusable: string | null): boolean => {
    if (flags.type) out.push(type);
    else if (flags.short) out.push(short);
    else if (flags.reusable && reusable !== null) out.push(reusable);

    found = true;
    return !flags.all;
  };

  if (!flags.forcePath) {
    const alias = ctx.getShellOption('expand_aliases') ? ctx.getAlias(name) : undefined;

    if (alias !== undefined && say('alias', `${name} is aliased to \`${alias}'`, `alias ${name}=${singleQuoted(alias)}`)) return true;

    if (KEYWORDS.has(name) && say('keyword', `${name} is a shell keyword`, name)) return true;

    if (!flags.noFuncs && ctx.getFunction(name) && say('function', `${name} is a function`, name)) return true;

    if (registry.has(name) && say('builtin', `${name} is a shell builtin`, name)) return true;
  }

  const file = (path: string) => {
    if (flags.type) out.push('file');
    else if (flags.short) out.push(`${name} is ${path}`);
    else if (flags.reusable || flags.pathOnly) out.push(path);
  };

  // A path is itself, and neither the hash table nor PATH is asked about it
  if (name.includes('/')) {
    if ((await lookupCommand(ctx, shell, name)).length > 0) {
      file(name);
      return true;
    }

    return found;
  }

  if (!flags.all || flags.forcePath) {
    const hashed = hashedCommand(ctx, name);

    if (hashed !== undefined) {
      if (flags.type) out.push('file');
      else if (flags.short) out.push(`${name} is hashed (${hashed})`);
      else if (flags.reusable || flags.pathOnly) out.push(hashed);

      return true;
    }
  }

  const paths = await lookupCommand(ctx, shell, name, flags.stdPath ? STANDARD_PATH : undefined);

  for (const path of flags.all ? paths : paths.slice(0, 1)) {
    file(path);
    found = true;
  }

  return found;
}

/**
 * Creates the type builtin command.
 *
 * The type builtin indicates how each name would be interpreted if used as a
 * command name. It checks in order: alias, keyword, function, builtin, hashed
 * command, file on PATH.
 *
 * @param registry - The builtin registry to check for builtins
 * @returns The type builtin handler
 *
 * @example
 * type echo      -> "echo is a shell builtin"
 * type ls        -> "ls is /bin/ls" (or "ls is aliased to `…'")
 * type -t echo   -> "builtin"
 * type -a echo   -> shows all matches
 */
export function createTypeBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (
    ctx: ExecContextIf,
    args: string[],
    shell: ShellIf,
  ): Promise<BuiltinResult> => {
    const flags: Describe = { short: true };
    let i = 0;

    for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
      if (args[i] === '--') {
        i++;
        break;
      }

      // The obsolescent long forms
      const long = { '-type': 't', '--type': 't', '-path': 'p', '--path': 'p', '-all': 'a', '--all': 'a' }[args[i]];

      for (const flag of long ?? args[i].slice(1)) {
        if (flag === 'a') {
          flags.all = true;
        } else if (flag === 'f') {
          flags.noFuncs = true;
        } else if (flag === 'p') {
          Object.assign(flags, { pathOnly: true, type: false, short: false });
        } else if (flag === 't') {
          Object.assign(flags, { type: true, pathOnly: false, short: false });
        } else if (flag === 'P') {
          Object.assign(flags, { pathOnly: true, forcePath: true, type: false, short: false });
        } else {
          return { code: 2, stderr: `type: -${flag}: invalid option\ntype: usage: type [-afptP] name [name ...]\n` };
        }
      }
    }

    const out: string[] = [];
    let errors = '';
    let failed = false;

    for (const name of args.slice(i)) {
      const found = await describeCommand(ctx, shell, registry, name, flags, out);

      if (!found && !flags.pathOnly && !flags.type) errors += `type: ${name}: not found\n`;

      failed ||= !found;
    }

    return { code: failed ? 1 : 0, stdout: out.map((line) => `${line}\n`).join(''), stderr: errors };
  };
}

/**
 * Creates the command builtin.
 *
 * The command builtin runs a command bypassing shell functions, or with -v or -V
 * describes how a name would be interpreted.
 *
 * @param registry - The builtin registry
 * @returns The command builtin handler
 *
 * @example
 * command ls    -> runs /bin/ls, not an ls function
 * command -v ls -> prints path to ls (like which)
 * command -V ls -> verbose info about ls
 */
export function createCommandBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (
    ctx: ExecContextIf,
    args: string[],
    shell: ShellIf,
    execute: (script: string) => Promise<number>,
  ): Promise<BuiltinResult> => {
    let stdPath = false;
    let verbose: 'short' | 'reusable' | undefined;
    let i = 0;

    for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
      if (args[i] === '--') {
        i++;
        break;
      }

      for (const flag of args[i].slice(1)) {
        if (flag === 'p') stdPath = true;
        else if (flag === 'V') verbose = 'short';
        else if (flag === 'v') verbose = 'reusable';
        else return { code: 2, stderr: `command: -${flag}: invalid option\ncommand: usage: command [-pVv] command [arg ...]\n` };
      }
    }

    const words = args.slice(i);

    if (words.length === 0) {
      return { code: 0 };
    }

    if (verbose) {
      const out: string[] = [];
      let errors = '';
      let anyFound = false;

      for (const name of words) {
        const found = await describeCommand(ctx, shell, registry, name, { [verbose]: true, stdPath }, out);

        if (!found && verbose === 'short') errors += `command: ${name}: not found\n`;

        anyFound ||= found;
      }

      return { code: anyFound ? 0 : 1, stdout: out.map((line) => `${line}\n`).join(''), stderr: errors };
    }

    const [cmdName, ...cmdArgs] = words;

    // Execute the command, bypassing functions and aliases
    // First check if it's a builtin
    const builtin = registry.get(cmdName);
    if (builtin) {
      return builtin(ctx, cmdArgs, shell, execute);
    }

    // Execute as external command, from the standard PATH with -p
    const path = stdPath && !cmdName.includes('/') ? (await lookupCommand(ctx, shell, cmdName, STANDARD_PATH))[0] : undefined;
    const code = await shell.execute(ctx, path ?? cmdName, cmdArgs, {});
    return { code };
  };
}

/**
 * Creates the builtin builtin.
 *
 * The builtin builtin executes a shell builtin, bypassing functions and aliases.
 * It only looks up builtins, not external commands.
 *
 * @param registry - The builtin registry
 * @returns The builtin builtin handler
 *
 * @example
 * builtin echo "hello"   -> runs builtin echo, not /bin/echo or echo function
 */
export function createBuiltinBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (
    ctx: ExecContextIf,
    args: string[],
    shell: ShellIf,
    execute: (script: string) => Promise<number>,
  ): Promise<BuiltinResult> => {
    if (args.length === 0) {
      return { code: 0 };
    }

    const cmdName = args[0];
    const cmdArgs = args.slice(1);

    const builtin = registry.get(cmdName);
    if (!builtin) {
      return {
        code: 1,
        stderr: `builtin: ${cmdName}: not a shell builtin\n`,
      };
    }

    return builtin(ctx, cmdArgs, shell, execute);
  };
}
