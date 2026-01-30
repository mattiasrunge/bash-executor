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
  if (args.length === 0) {
    // List all aliases
    const aliases = ctx.getAliases();
    let output = '';
    for (const [name, value] of Object.entries(aliases).sort()) {
      output += `alias ${name}='${value}'\n`;
    }
    return { code: 0, stdout: output };
  }

  let output = '';
  let allFound = true;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');

    if (eqIdx > 0) {
      // name=value form - define alias
      const name = arg.substring(0, eqIdx);
      const value = arg.substring(eqIdx + 1);
      ctx.setAlias(name, value);
    } else {
      // name only form - print alias if it exists
      const alias = ctx.getAlias(arg);
      if (alias !== undefined) {
        output += `alias ${arg}='${alias}'\n`;
      } else {
        output += `alias: ${arg}: not found\n`;
        allFound = false;
      }
    }
  }

  if (output) {
    return { code: allFound ? 0 : 1, stdout: output };
  }

  return { code: 0 };
};

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
