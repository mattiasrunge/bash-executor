import { utils } from '@ein/bash-parser';
import type { ExecContextIf } from '../types.ts';
import type { BuiltinHandler } from './types.ts';

/**
 * Split `a[1]` or `a[key]` into the array name and the subscript it names.
 */
const subscripted = (name: string): { name: string; subscript: string } | null => {
  const match = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.*)\]$/s);

  return match ? { name: match[1], subscript: match[2] } : null;
};

/**
 * Store an array literal argument, `x=(a b)` as passed to local/declare.
 */
export const assignArrayArg = (ctx: ExecContextIf, arg: string, local: boolean): boolean => {
  const parts = utils.parseAssignmentWord(arg);

  if (!parts?.list) {
    return false;
  }

  const elements = parts.value === '' ? [] : parts.value.split(utils.ARRAY_ELEMENT_SEPARATOR);

  // An associative array takes `[key]=value` elements; the name has to have been
  // declared -A already, which is what tells the two kinds apart
  if (ctx.getAssoc(parts.name)) {
    const entries = parts.append ? { ...ctx.getAssoc(parts.name) } : {};

    for (const element of elements) {
      const keyed = element.match(/^\[([^\]]*)\]=(.*)$/s);

      if (keyed) {
        entries[keyed[1]] = keyed[2];
      }
    }

    if (local) {
      ctx.setLocalAssoc(parts.name, entries);
    } else {
      ctx.setAssoc(parts.name, entries);
    }

    return true;
  }

  const existing = parts.append ? ctx.getArray(parts.name) ?? [] : [];
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
      if (ctx.getAssoc(element.name)) {
        ctx.unsetAssocElement(element.name, element.subscript);
        continue;
      }

      const array = ctx.getArray(element.name);
      const parsed = Number.parseInt(element.subscript, 10) || 0;
      const index = parsed < 0 ? (array?.length ?? 0) + parsed : parsed;

      ctx.unsetArrayElement(element.name, index);
      continue;
    }

    // Unset env, params and either kind of array
    ctx.setEnv({ [name]: null });
    ctx.setParams({ [name]: null });
    ctx.unsetArray(name);
    ctx.unsetAssoc(name);
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
  let assoc = false;

  for (const arg of args) {
    if (assoc && !arg.startsWith('-')) {
      const assocName = arg.indexOf('=') === -1 ? arg : arg.slice(0, arg.indexOf('='));

      if (!ctx.getAssoc(assocName)) {
        ctx.setLocalAssoc(assocName, {});
      }
    }

    if (arg === '-a') {
      array = true;
      continue;
    }

    if (arg === '-A') {
      assoc = true;
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

    if (assoc && eqIdx === -1) {
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
