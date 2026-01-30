import type { BuiltinHandler } from './types.ts';

/**
 * The pwd builtin - print working directory.
 *
 * Options:
 *   -L    Print the logical path (with symlinks, default)
 *   -P    Print the physical path (resolved symlinks)
 *
 * Note: Currently only logical path is supported as the context
 * stores the logical path. Physical path would require shell callback.
 */
export const pwdBuiltin: BuiltinHandler = async (ctx, args) => {
  // Parse options (currently -L and -P behave the same)
  let _logical = true;

  for (const arg of args) {
    if (arg === '-L') {
      _logical = true;
    } else if (arg === '-P') {
      _logical = false;
      // Note: Physical path would require resolving symlinks
      // For now, we just use the stored path
    }
  }

  const cwd = ctx.getCwd();
  return { code: 0, stdout: cwd + '\n' };
};
