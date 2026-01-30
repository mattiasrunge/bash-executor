/**
 * Implementation of the type, command, and builtin builtins.
 *
 * These builtins provide introspection and control over command execution.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinRegistry, BuiltinResult } from './types.ts';

/**
 * Helper to capture output from a command using pipes.
 */
async function captureCommandOutput(
  ctx: ExecContextIf,
  shell: ShellIf,
  name: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdoutPipe = await shell.pipeOpen();
  const stderrPipe = await shell.pipeOpen();

  const cmdCtx = ctx.spawnContext();
  cmdCtx.redirectStdout(stdoutPipe);
  cmdCtx.redirectStderr(stderrPipe);

  try {
    const code = await shell.execute(cmdCtx, name, args, {});

    // Signal EOF
    await shell.pipeWrite(stdoutPipe, '');
    await shell.pipeWrite(stderrPipe, '');

    const stdout = await shell.pipeRead(stdoutPipe);
    const stderr = await shell.pipeRead(stderrPipe);

    return { code, stdout, stderr };
  } finally {
    await shell.pipeRemove(stdoutPipe);
    await shell.pipeRemove(stderrPipe);
  }
}

/**
 * Creates the type builtin command.
 *
 * The type builtin indicates how each name would be interpreted if used as a
 * command name. It checks in order: alias, function, builtin, external command.
 *
 * @param registry - The builtin registry to check for builtins
 * @returns The type builtin handler
 *
 * @example
 * type echo      -> "echo is a shell builtin"
 * type ls        -> "ls is /bin/ls" (or "ls is an alias for ...")
 * type -t echo   -> "builtin"
 * type -a echo   -> shows all matches
 */
export function createTypeBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (
    ctx: ExecContextIf,
    args: string[],
    shell: ShellIf,
  ): Promise<BuiltinResult> => {
    if (args.length === 0) {
      return {
        code: 1,
        stderr: 'type: usage: type [-afptP] name [name ...]\n',
      };
    }

    // Parse options
    let typeOnly = false;
    let showAll = false;
    const names: string[] = [];

    for (const arg of args) {
      if (arg.startsWith('-')) {
        for (const char of arg.slice(1)) {
          if (char === 't') typeOnly = true;
          else if (char === 'a') showAll = true;
          // -f, -p, -P are ignored for simplicity
        }
      } else {
        names.push(arg);
      }
    }

    if (names.length === 0) {
      return {
        code: 1,
        stderr: 'type: usage: type [-afptP] name [name ...]\n',
      };
    }

    let output = '';
    let allFound = true;

    for (const name of names) {
      const matches: string[] = [];

      // Check alias
      const alias = ctx.getAlias(name);
      if (alias !== undefined) {
        if (typeOnly) {
          matches.push('alias');
        } else {
          matches.push(`${name} is aliased to \`${alias}'`);
        }
      }

      // Check function
      const func = ctx.getFunction(name);
      if (func) {
        if (typeOnly) {
          matches.push('function');
        } else {
          matches.push(`${name} is a function`);
        }
      }

      // Check builtin
      if (registry.has(name)) {
        if (typeOnly) {
          matches.push('builtin');
        } else {
          matches.push(`${name} is a shell builtin`);
        }
      }

      // Check external command using 'which'
      try {
        const result = await captureCommandOutput(ctx, shell, 'which', [name]);
        if (result.code === 0 && result.stdout.trim()) {
          if (typeOnly) {
            matches.push('file');
          } else {
            matches.push(`${name} is ${result.stdout.trim()}`);
          }
        }
      } catch {
        // which failed, no external command
      }

      if (matches.length === 0) {
        if (!typeOnly) {
          output += `bash: type: ${name}: not found\n`;
        }
        allFound = false;
      } else if (showAll) {
        output += matches.join('\n') + '\n';
      } else {
        output += matches[0] + '\n';
      }
    }

    return {
      code: allFound ? 0 : 1,
      stdout: output,
    };
  };
}

/**
 * Creates the command builtin.
 *
 * The command builtin executes a command, bypassing shell functions and aliases.
 * It can be used to run an external command even if a function with the same
 * name exists.
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
    if (args.length === 0) {
      return { code: 0 };
    }

    // Parse options
    let findPath = false;
    let verbose = false;
    let cmdIndex = 0;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-v') {
        findPath = true;
        cmdIndex = i + 1;
      } else if (args[i] === '-V') {
        verbose = true;
        cmdIndex = i + 1;
      } else if (args[i] === '-p') {
        // Use default PATH - ignored for simplicity
        cmdIndex = i + 1;
      } else if (!args[i].startsWith('-')) {
        cmdIndex = i;
        break;
      }
    }

    if (cmdIndex >= args.length) {
      return { code: 0 };
    }

    const cmdName = args[cmdIndex];
    const cmdArgs = args.slice(cmdIndex + 1);

    // -v: print path or name
    if (findPath) {
      // Check builtin first
      if (registry.has(cmdName)) {
        return { code: 0, stdout: cmdName + '\n' };
      }

      // Check external command
      try {
        const result = await captureCommandOutput(ctx, shell, 'which', [cmdName]);
        if (result.code === 0 && result.stdout.trim()) {
          return { code: 0, stdout: result.stdout.trim() + '\n' };
        }
      } catch {
        // not found
      }

      return { code: 1 };
    }

    // -V: verbose info
    if (verbose) {
      if (registry.has(cmdName)) {
        return { code: 0, stdout: `${cmdName} is a shell builtin\n` };
      }

      try {
        const result = await captureCommandOutput(ctx, shell, 'which', [cmdName]);
        if (result.code === 0 && result.stdout.trim()) {
          return { code: 0, stdout: `${cmdName} is ${result.stdout.trim()}\n` };
        }
      } catch {
        // not found
      }

      return { code: 1, stderr: `bash: command: ${cmdName}: not found\n` };
    }

    // Execute the command, bypassing functions and aliases
    // First check if it's a builtin
    const builtin = registry.get(cmdName);
    if (builtin) {
      return builtin(ctx, cmdArgs, shell, execute);
    }

    // Execute as external command
    const code = await shell.execute(ctx, cmdName, cmdArgs, {});
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
        stderr: `bash: builtin: ${cmdName}: not a shell builtin\n`,
      };
    }

    return builtin(ctx, cmdArgs, shell, execute);
  };
}
