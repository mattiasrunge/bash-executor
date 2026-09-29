import { isAbsolute, join, normalize } from '@std/path';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler } from './types.ts';

/**
 * Resolve a path relative to a base directory.
 */
function resolvePath(basePath: string, targetPath: string): string {
  if (isAbsolute(targetPath)) {
    return normalize(targetPath);
  }
  return normalize(join(basePath, targetPath));
}

/**
 * The cd builtin - change directory.
 *
 * Usage: cd [-L|-P] [dir]
 *
 * Change the current directory to dir. If dir is not supplied, the value
 * of the HOME environment variable is used. If dir is -, the current
 * directory is changed to the value of OLDPWD.
 *
 * Options:
 *   -L    Follow symbolic links (default)
 *   -P    Use physical directory structure
 *
 * Note: The -L and -P options currently behave the same as we don't have
 * access to filesystem operations to resolve symlinks.
 */
export const cdBuiltin: BuiltinHandler = async (ctx, args, shell) => {
  // Parse options
  let _logical = true;
  const pathArgs: string[] = [];

  for (const arg of args) {
    if (arg === '-L') {
      _logical = true;
    } else if (arg === '-P') {
      _logical = false;
    } else if (arg === '--') {
      // End of options
      continue;
    } else if (arg.startsWith('-') && arg !== '-') {
      return {
        code: 1,
        stderr: `cd: ${arg}: invalid option\n`,
      };
    } else {
      pathArgs.push(arg);
    }
  }

  // HOME and OLDPWD are shell variables, exported or not
  const env = { ...ctx.getEnv(), ...ctx.getParams() };
  const currentDir = ctx.getCwd();
  let targetDir: string;

  if (pathArgs.length === 0) {
    // cd with no args goes to HOME
    const home = env['HOME'];
    if (!home) {
      return {
        code: 1,
        stderr: 'cd: HOME not set\n',
      };
    }
    targetDir = home;
  } else if (pathArgs[0] === '-') {
    // cd - goes to OLDPWD
    const oldpwd = env['OLDPWD'];
    if (!oldpwd) {
      return {
        code: 1,
        stderr: 'cd: OLDPWD not set\n',
      };
    }
    targetDir = oldpwd;
    // Check if the directory exists
    const missing = await notADirectory(ctx, shell, targetDir);
    if (missing) return { code: 1, stderr: `cd: ${targetDir}: ${missing}\n` };
    // Print the new directory when using cd -
    ctx.setCwd(targetDir);
    ctx.setEnv({ OLDPWD: currentDir, PWD: targetDir });
    return {
      code: 0,
      stdout: targetDir + '\n',
    };
  } else {
    targetDir = pathArgs[0];
  }

  // Handle tilde expansion if not already expanded
  if (targetDir.startsWith('~')) {
    const home = env['HOME'];
    if (home) {
      targetDir = home + targetDir.slice(1);
    }
  }

  // Resolve the target directory
  targetDir = resolvePath(currentDir, targetDir);

  // Check if the directory exists
  const missing = await notADirectory(ctx, shell, targetDir);
  if (missing) return { code: 1, stderr: `cd: ${pathArgs[0] || targetDir}: ${missing}\n` };

  // Update the context
  ctx.setCwd(targetDir);
  ctx.setEnv({ OLDPWD: currentDir, PWD: targetDir });

  return { code: 0 };
};

/** Why a path is no directory to change to, as the system says it, or undefined when it is one. */
async function notADirectory(ctx: ExecContextIf, shell: ShellIf, path: string): Promise<string | undefined> {
  if (!shell.testPath || await shell.testPath(ctx, path, 'DIRECTORY')) return undefined;

  return await shell.testPath(ctx, path, 'EXISTS') ? 'Not a directory' : 'No such file or directory';
}
