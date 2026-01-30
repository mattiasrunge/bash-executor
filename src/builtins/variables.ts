import type { BuiltinHandler } from './types.ts';

/**
 * The export builtin - set environment variables.
 *
 * Usage: export [name[=value] ...]
 *
 * Set export attribute for shell variables. If name=value is given,
 * the variable is assigned the value before exporting.
 *
 * Options:
 *   -n    Remove the export property from each name
 *   -p    Display all exported variables (not implemented)
 */
export const exportBuiltin: BuiltinHandler = async (ctx, args) => {
  if (args.length === 0) {
    // With no arguments, list all exported variables
    // For now, just return success
    return { code: 0 };
  }

  let removeExport = false;
  const varArgs: string[] = [];

  for (const arg of args) {
    if (arg === '-n') {
      removeExport = true;
    } else if (arg === '-p') {
      // Print exports - not implemented yet
      return { code: 0 };
    } else if (arg === '--') {
      continue;
    } else {
      varArgs.push(arg);
    }
  }

  for (const arg of varArgs) {
    const eqIdx = arg.indexOf('=');

    if (eqIdx > 0) {
      // name=value form
      const name = arg.substring(0, eqIdx);
      const value = arg.substring(eqIdx + 1);

      if (removeExport) {
        // Remove from env but keep in params
        ctx.setEnv({ [name]: null });
        ctx.setParams({ [name]: value });
      } else {
        // Export and set value
        ctx.setEnv({ [name]: value });
        ctx.setParams({ [name]: value });
      }
    } else {
      // name only form - export existing variable
      const name = arg;
      const params = ctx.getParams();
      const value = params[name] ?? '';

      if (removeExport) {
        ctx.setEnv({ [name]: null });
      } else {
        ctx.setEnv({ [name]: value });
      }
    }
  }

  return { code: 0 };
};

/**
 * The unset builtin - remove variables or functions.
 *
 * Usage: unset [-fv] [name ...]
 *
 * Remove variables or functions.
 *
 * Options:
 *   -f    Treat each name as a function
 *   -v    Treat each name as a variable (default)
 */
export const unsetBuiltin: BuiltinHandler = async (ctx, args) => {
  let unsetFunctions = false;
  const names: string[] = [];

  for (const arg of args) {
    if (arg === '-f') {
      unsetFunctions = true;
    } else if (arg === '-v') {
      unsetFunctions = false;
    } else if (arg === '--') {
      continue;
    } else {
      names.push(arg);
    }
  }

  for (const name of names) {
    if (unsetFunctions) {
      ctx.unsetFunction(name);
    } else {
      // Unset both env and params
      ctx.setEnv({ [name]: null });
      ctx.setParams({ [name]: null });
    }
  }

  return { code: 0 };
};

/**
 * The local builtin - create local variables.
 *
 * Usage: local [name[=value] ...]
 *
 * Create a local variable with the specified name. When used inside a
 * function, the variable's value and export status are restored when
 * the function returns.
 */
export const localBuiltin: BuiltinHandler = async (ctx, args) => {
  for (const arg of args) {
    const eqIdx = arg.indexOf('=');

    if (eqIdx > 0) {
      // name=value form
      const name = arg.substring(0, eqIdx);
      const value = arg.substring(eqIdx + 1);
      ctx.setLocalParams({ [name]: value });
    } else {
      // name only form - declare as local with empty value
      ctx.setLocalParams({ [arg]: '' });
    }
  }

  return { code: 0 };
};
