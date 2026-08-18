import { utils } from '@ein/bash-parser';
import type { ExecContextIf } from '../types.ts';
import type { BuiltinHandler } from './types.ts';

/**
 * Split `a[1]` into the array name and the index it names.
 */
const subscripted = (name: string): { name: string; index: number } | null => {
  const match = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(-?\d+)\]$/);

  return match ? { name: match[1], index: Number(match[2]) } : null;
};

/**
 * Store an array literal argument, `x=(a b)` as passed to local/declare.
 */
export const assignArrayArg = (ctx: ExecContextIf, arg: string, local: boolean): boolean => {
  const parts = utils.parseAssignmentWord(arg);

  if (!parts?.list) {
    return false;
  }

  const existing = parts.append ? ctx.getArray(parts.name) ?? [] : [];
  const elements = parts.value === '' ? [] : parts.value.split(utils.ARRAY_ELEMENT_SEPARATOR);
  const values = existing.concat(elements);

  if (local) {
    ctx.setLocalArray(parts.name, values);
    ctx.setLocalParams({ [parts.name]: null });
  } else {
    ctx.setArray(parts.name, values);
    ctx.setParams({ [parts.name]: null });
  }

  return true;
};

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
      continue;
    }

    // `unset a[1]` removes one element and leaves a hole, `unset a` the whole array
    const element = subscripted(name);

    if (element) {
      const array = ctx.getArray(element.name);
      const index = element.index < 0 ? (array?.length ?? 0) + element.index : element.index;

      ctx.unsetArrayElement(element.name, index);
      continue;
    }

    // Unset env, params and any array
    ctx.setEnv({ [name]: null });
    ctx.setParams({ [name]: null });
    ctx.unsetArray(name);
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
export const localBuiltin: BuiltinHandler = async (cmdCtx, args) => {
  // Every command runs in a context of its own, which is dropped as soon as it
  // returns — a local set there would be gone before the next command in the
  // function body ran. The enclosing context is the function's, which is the
  // scope `local` is about.
  const ctx = cmdCtx.getParent() ?? cmdCtx;

  let array = false;

  for (const arg of args) {
    if (arg === '-a' || arg === '-A') {
      array = true;
      continue;
    }

    if (assignArrayArg(ctx, arg, true)) {
      continue;
    }

    const eqIdx = arg.indexOf('=');

    if (array && eqIdx === -1) {
      ctx.setLocalArray(arg, ctx.getArray(arg) ?? []);
      continue;
    }

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
