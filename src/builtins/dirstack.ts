/**
 * Implementation of the pushd, popd, and dirs builtins.
 *
 * These builtins manage a directory stack for easy navigation.
 */

import { isAbsolute, join, normalize } from '@std/path';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * Normalize a path by resolving . and .. components.
 */
function normalizePath(path: string, cwd: string): string {
  if (!isAbsolute(path)) {
    path = join(cwd, path);
  }
  return normalize(path);
}

/**
 * The dirs builtin command.
 *
 * Displays the directory stack. Without options, displays the stack
 * as a space-separated list with the current directory at the left.
 *
 * Options:
 * -c    Clear the directory stack
 * -l    Produce a longer listing (full paths)
 * -p    Print one entry per line
 * -v    Print one entry per line with stack position
 *
 * @example
 * dirs        -> displays: /home/user /tmp /var
 * dirs -v     -> displays: 0  /home/user
 *                          1  /tmp
 *                          2  /var
 * dirs -c     -> clears the stack
 */
export const dirsBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  let clear = false;
  let verbose = false;
  let perLine = false;

  for (const arg of args) {
    if (arg === '-c') clear = true;
    if (arg === '-v') verbose = true;
    if (arg === '-p') perLine = true;
    if (arg === '-l') {
      // -l is default behavior (full paths)
    }
  }

  if (clear) {
    ctx.clearDirStack();
    return { code: 0 };
  }

  // Build the stack display (current directory + stack)
  const stack = [ctx.getCwd(), ...ctx.getDirStack()];

  let output: string;
  if (verbose) {
    output = stack.map((dir, i) => `${i}  ${dir}`).join('\n') + '\n';
  } else if (perLine) {
    output = stack.join('\n') + '\n';
  } else {
    output = stack.join(' ') + '\n';
  }

  return { code: 0, stdout: output };
};

/**
 * The pushd builtin command.
 *
 * Saves the current directory on the stack and changes to the specified
 * directory. With no arguments, exchanges the top two directories.
 *
 * Options:
 * -n    Suppress directory change, only rotate/add to stack
 *
 * @example
 * pushd /tmp      -> saves current dir, changes to /tmp
 * pushd           -> exchanges top two directories
 * pushd +1        -> rotates stack by 1
 */
export const pushdBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  let noChange = false;
  let target: string | null = null;

  for (const arg of args) {
    if (arg === '-n') {
      noChange = true;
    } else if (!arg.startsWith('-')) {
      target = arg;
    }
  }

  const currentDir = ctx.getCwd();
  const dirStack = ctx.getDirStack();

  // No arguments: exchange top two directories
  if (target === null) {
    if (dirStack.length === 0) {
      return {
        code: 1,
        stderr: 'pushd: no other directory\n',
      };
    }

    const top = ctx.popDirStack()!;
    if (!noChange) {
      ctx.setCwd(top);
      ctx.pushDirStack(currentDir);
    } else {
      // Just rotate without changing - put it back
      ctx.pushDirStack(top);
    }

    // Display stack
    const stack = [ctx.getCwd(), ...ctx.getDirStack()];
    return { code: 0, stdout: stack.join(' ') + '\n' };
  }

  // Handle +N or -N rotation
  if (/^[+-]\d+$/.test(target)) {
    const n = Number.parseInt(target, 10);
    const stack = [currentDir, ...dirStack];
    const len = stack.length;

    if (Math.abs(n) >= len) {
      return {
        code: 1,
        stderr: `pushd: ${target}: directory stack index out of range\n`,
      };
    }

    // Rotate the stack
    const index = n >= 0 ? n : len + n;
    const rotated = [...stack.slice(index), ...stack.slice(0, index)];

    if (!noChange) {
      ctx.setCwd(rotated[0]);
      ctx.clearDirStack();
      for (const dir of rotated.slice(1).reverse()) {
        ctx.pushDirStack(dir);
      }
    }

    const newStack = [ctx.getCwd(), ...ctx.getDirStack()];
    return { code: 0, stdout: newStack.join(' ') + '\n' };
  }

  // Push directory
  const newDir = normalizePath(target, currentDir);

  if (!noChange) {
    ctx.pushDirStack(currentDir);
    ctx.setCwd(newDir);
    ctx.setEnv({ PWD: newDir, OLDPWD: currentDir });
  } else {
    ctx.pushDirStack(newDir);
  }

  const stack = [ctx.getCwd(), ...ctx.getDirStack()];
  return { code: 0, stdout: stack.join(' ') + '\n' };
};

/**
 * The popd builtin command.
 *
 * Removes the top directory from the stack and changes to the new top.
 * With no arguments, removes the top directory and changes to it.
 *
 * Options:
 * -n    Suppress directory change, only remove from stack
 *
 * @example
 * popd       -> changes to directory at stack top, removes it
 * popd +1    -> removes second entry from stack
 * popd -n    -> removes from stack without changing directory
 */
export const popdBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  let noChange = false;
  let target: string | null = null;

  for (const arg of args) {
    if (arg === '-n') {
      noChange = true;
    } else if (!arg.startsWith('-')) {
      target = arg;
    }
  }

  const dirStack = ctx.getDirStack();

  if (dirStack.length === 0) {
    return {
      code: 1,
      stderr: 'popd: directory stack empty\n',
    };
  }

  const currentDir = ctx.getCwd();

  // Handle +N or -N
  if (target !== null && /^[+-]\d+$/.test(target)) {
    const n = Number.parseInt(target, 10);
    const stack = [currentDir, ...dirStack];
    const len = stack.length;

    if (Math.abs(n) >= len) {
      return {
        code: 1,
        stderr: `popd: ${target}: directory stack index out of range\n`,
      };
    }

    const index = n >= 0 ? n : len + n;

    if (index === 0) {
      // Pop current directory
      if (!noChange) {
        const newDir = ctx.popDirStack()!;
        ctx.setCwd(newDir);
        ctx.setEnv({ PWD: newDir, OLDPWD: currentDir });
      } else {
        ctx.popDirStack();
      }
    } else {
      // Remove from stack at index - 1 (since index 0 is current dir)
      ctx.removeDirStackAt(index - 1);
    }

    const newStack = [ctx.getCwd(), ...ctx.getDirStack()];
    return { code: 0, stdout: newStack.join(' ') + '\n' };
  }

  // Default: pop top of stack
  const newDir = ctx.popDirStack()!;

  if (!noChange) {
    ctx.setCwd(newDir);
    ctx.setEnv({ PWD: newDir, OLDPWD: currentDir });
  }

  const stack = [ctx.getCwd(), ...ctx.getDirStack()];
  return { code: 0, stdout: stack.join(' ') + '\n' };
};

/**
 * Clear the directory stack (no-op for backwards compatibility).
 * @deprecated Use ctx.clearDirStack() instead. Directory stack is now per-context.
 */
export function clearDirStack(): void {
  // No-op - directory stack is now in context
}

/**
 * Get the current directory stack (returns empty for backwards compatibility).
 * @deprecated Use ctx.getDirStack() instead. Directory stack is now per-context.
 */
export function getDirStack(): string[] {
  // Returns empty - directory stack is now in context
  return [];
}
