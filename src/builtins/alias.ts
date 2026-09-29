import type { BuiltinHandler } from './types.ts';

/**
 * The alias builtin - define or display aliases.
 *
 * Usage: alias [name[=value] ...]
 *
 * Without arguments, prints all defined aliases. With arguments, defines
 * aliases in the form name=value. Without =value, prints the alias for name.
 */
export const aliasBuiltin: BuiltinHandler = async (ctx, args) => {
  // `-p` lists them all as well, before anything the rest defines or prints
  let list = args.length === 0;

  while (args[0]?.startsWith('-') && args[0] !== '-') {
    const option = args.shift()!;

    if (option === '--') break;

    for (const flag of option.slice(1)) {
      if (flag !== 'p') return { code: 2, stderr: `alias: -${flag}: invalid option\nalias: usage: alias [-p] [name[=value] ... ]\n` };
    }

    list = true;
  }

  let stdout = '';
  let stderr = '';

  if (list) {
    for (const [name, value] of Object.entries(ctx.getAliases()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      stdout += `alias ${name}=${aliasQuoted(value)}\n`;
    }
  }

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');

    if (eqIdx > 0) {
      // name=value form - define alias
      ctx.setAlias(arg.substring(0, eqIdx), arg.substring(eqIdx + 1));
    } else {
      // name only form - print alias if it exists
      const alias = ctx.getAlias(arg);

      if (alias !== undefined) {
        stdout += `alias ${arg}=${aliasQuoted(alias)}\n`;
      } else {
        stderr += `alias: ${arg}: not found\n`;
      }
    }
  }

  return { code: stderr ? 1 : 0, stdout, stderr };
};

/** In single quotes, as bash's sh_single_quote writes an alias's value. */
function aliasQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The unalias builtin - remove aliases.
 *
 * Usage: unalias [-a] name [name ...]
 *
 * Remove each name from the list of defined aliases.
 *
 * Options:
 *   -a    Remove all alias definitions
 */
export const unaliasBuiltin: BuiltinHandler = async (ctx, args) => {
  if (args.length === 0) {
    return {
      code: 1,
      stderr: 'unalias: usage: unalias [-a] name [name ...]\n',
    };
  }

  for (const arg of args) {
    if (arg === '-a') {
      // Remove all aliases
      const aliases = ctx.getAliases();
      for (const name of Object.keys(aliases)) {
        ctx.unsetAlias(name);
      }
      continue;
    }
    ctx.unsetAlias(arg);
  }

  return { code: 0 };
};
