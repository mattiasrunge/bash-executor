/**
 * Implementation of the hash builtin, after bash's hash.def.
 *
 * The table itself is BASH_CMDS (see command-hash.ts). Commands do not hash
 * themselves as they run here, as they do in bash, since that would cost a
 * PATH search for each one; `hash name` and `hash -p` fill the table.
 */

import { hashCommand, hashedCommand, hashedCommands, unhashCommand } from '../command-hash.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import { lookupCommand } from './introspection.ts';
import type { BuiltinHandler, BuiltinRegistry, BuiltinResult } from './types.ts';

const USAGE = 'hash: usage: hash [-lr] [-p pathname] [-dt] [name ...]\n';

/**
 * Creates the hash builtin.
 *
 * @example
 * hash            -> the table, with how often each command was used
 * hash -r         -> forget everything
 * hash -p /bin/sh sh
 * hash -t sh      -> /bin/sh
 */
export function createHashBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
    let del = false;
    let portable = false;
    let expunge = false;
    let targets = false;
    let pathname: string | undefined;
    let i = 0;

    for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
      if (args[i] === '--') {
        i++;
        break;
      }

      for (let j = 1; j < args[i].length; j++) {
        const flag = args[i][j];

        if (flag === 'd') del = true;
        else if (flag === 'l') portable = true;
        else if (flag === 'r') expunge = true;
        else if (flag === 't') targets = true;
        else if (flag === 'p') {
          // The path is the rest of this word, or the next word
          pathname = args[i].slice(j + 1) || args[++i];

          if (pathname === undefined) return { code: 2, stderr: `hash: -p: option requires an argument\n${USAGE}` };
          break;
        } else {
          return { code: 2, stderr: `hash: -${flag}: invalid option\n${USAGE}` };
        }
      }
    }

    const names = args.slice(i);

    if (names.length === 0 && (del || targets)) {
      return { code: 1, stderr: `hash: ${del ? '-d' : '-t'}: option requires an argument\n` };
    }

    // `hash -r` is silent, `hash` and `hash -l` list
    if (names.length === 0 && !expunge) {
      const table = hashedCommands(ctx);

      if (table.length === 0) return { code: 0, stdout: 'hash: hash table empty\n' };

      const lines = portable
        ? table.map(({ name, path }) => `builtin hash -p ${path} ${name}\n`)
        : ['hits\tcommand\n', ...table.map(({ path, hits }) => `${String(hits).padStart(4)}\t${path}\n`)];

      return { code: 0, stdout: lines.join('') };
    }

    if (expunge) {
      ctx.unsetAssoc('BASH_CMDS');
    }

    let stdout = '';
    let stderr = '';
    let code = 0;

    if (targets) {
      for (const name of names) {
        const path = hashedCommand(ctx, name);

        if (path === undefined) {
          stderr += `hash: ${name}: not found\n`;
          code = 1;
        } else if (portable) {
          stdout += `builtin hash -p ${path} ${name}\n`;
        } else {
          stdout += names.length > 1 ? `${name}\t${path}\n` : `${path}\n`;
        }
      }

      return { code, stdout, stderr };
    }

    for (const name of names) {
      // A path runs as itself, and there is nothing to hash
      if (name.includes('/')) continue;

      if (pathname !== undefined) {
        hashCommand(ctx, name, pathname);
      } else if (del) {
        if (!unhashCommand(ctx, name)) {
          stderr += `hash: ${name}: not found\n`;
          code = 1;
        }
      } else if (!ctx.getFunction(name) && !registry.has(name)) {
        // Hashed anew, from where PATH finds it now
        unhashCommand(ctx, name);

        const [path] = await lookupCommand(ctx, shell, name);

        if (path === undefined) {
          stderr += `hash: ${name}: not found\n`;
          code = 1;
        } else {
          hashCommand(ctx, name, path);
        }
      }
    }

    return { code, stdout, stderr };
  };
}
