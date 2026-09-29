import { utils } from '@ein/bash-parser';
import { exportedFunctionText, functionEnvName } from '../print-command.ts';
import type { ExecContextIf } from '../types.ts';
import type { BuiltinHandler } from './types.ts';
import { declareCommand } from './declare.ts';

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
/**
 * `export -f name`: the function goes to the commands the shell runs as
 * `BASH_FUNC_name%%`, which a bash among them defines again; `-n` takes it back.
 * A name no command could be looked up by — with `=` or `/` in it — cannot go.
 */
export async function exportFunctions(ctx: ExecContextIf, names: string[], remove: boolean) {
  let stderr = '';
  let code = 0;

  for (const name of names) {
    const fn = ctx.getFunction(name);

    if (!fn) {
      stderr += `export: ${name}: not a function\n`;
      code = 1;
    } else if (remove) {
      ctx.setEnv({ [functionEnvName(name)]: null });
    } else if (/[=/]/.test(name)) {
      stderr += `export: ${name}: cannot export\n`;
      code = 1;
    } else {
      ctx.setEnv({ [functionEnvName(name)]: await exportedFunctionText(fn) });
    }
  }

  return { code, stderr };
}

export const exportBuiltin: BuiltinHandler = (ctx, args) => declareCommand('export', ctx, args);

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
  let variablesOnly = false;
  let noref = false;
  let i = 0;

  for (; i < args.length && /^-[fvn]+$/.test(args[i]); i++) {
    unsetFunctions ||= args[i].includes('f');
    variablesOnly ||= args[i].includes('v');
    noref ||= args[i].includes('n');
  }

  if (args[i] === '--') i++;

  const names = args.slice(i);
  let stderr = '';

  for (const name of names) {
    // A name that is no variable but a function is the function, unless -v says otherwise
    if (unsetFunctions || (!variablesOnly && !noref && !ctx.getVariable(name) && ctx.getFunction(name))) {
      ctx.unsetFunction(name);
      ctx.setEnv({ [functionEnvName(name)]: null });
      continue;
    }

    // `unset -n ref` takes the reference away, not what it refers to
    if (noref && ctx.getVariable(name)?.attributes.includes('n')) {
      if (ctx.getVariable(name)?.attributes.includes('r')) {
        stderr += `unset: ${name}: cannot unset: readonly variable\n`;
      } else {
        ctx.unsetVariable(name, { noref: true });
      }

      continue;
    }

    if (ctx.isReadonlyVar(name.replace(/\[.*$/, ''))) {
      stderr += `unset: ${ctx.resolveNameref(name.replace(/\[.*$/, ''))}: cannot unset: readonly variable\n`;
      continue;
    }

    // `unset a[1]` removes one element and leaves a hole, `unset a` the whole array
    const element = subscripted(name);

    if (element) {
      // An element of a plain variable is no element at all
      const kind = ctx.getVariable(ctx.resolveNameref(element.name))?.kind;

      if (kind === 'scalar') {
        stderr += `unset: ${element.name}: not an array variable\n`;
        continue;
      }

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

  return stderr ? { code: 1, stderr } : { code: 0 };
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
export const localBuiltin: BuiltinHandler = (ctx, args) => declareCommand('local', ctx, args);
