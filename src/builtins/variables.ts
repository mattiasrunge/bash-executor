import { utils } from '@ein/bash-parser';
import { contextVariables, evaluateArithmeticText, subscriptEnd } from '../arith.ts';
import { assocEntries } from '../assoc-list.ts';
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

    for (const { key, value } of assocEntries(parts.name, elements).entries) entries[key] = value;

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
 * A name unset can take: an identifier, or `name[sub]` as bash's
 * valid_array_reference reads it — its subscript quotes and all, or, for a
 * word written so (`unset a["$k"]`), whatever lies between the brackets.
 */
const isVariableName = (name: string, arrayRef: boolean): boolean => {
  const open = name.indexOf('[');

  if (open === -1) return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.slice(0, open))) return false;

  const close = arrayRef ? name.length - 1 : subscriptEnd(name, open);

  return close > open + 1 && close === name.length - 1 && name[close] === ']';
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
export const unsetBuiltin: BuiltinHandler = async (ctx, args, _shell, _io, services) => {
  let unsetFunctions = false;
  let variablesOnly = false;
  let noref = false;
  let i = 0;

  for (; i < args.length && /^-[fvn]+$/.test(args[i]); i++) {
    unsetFunctions ||= args[i].includes('f');
    variablesOnly ||= args[i].includes('v');
    noref ||= args[i].includes('n');
  }

  if (args[i] === '--') {
    i++;
  } else if (/^-./.test(args[i] ?? '')) {
    const bad = args[i].slice(1).split('').find((letter) => !'fvn'.includes(letter));

    return { code: 2, stderr: `unset: -${bad}: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]\n` };
  }

  if (unsetFunctions && variablesOnly) {
    return { code: 1, stderr: 'unset: cannot simultaneously unset a function and a variable\n' };
  }

  const names = args.slice(i);
  let stderr = '';

  for (const name of names) {
    // A name that is neither a variable nor an element: an error under -v,
    // else possibly a function's — `unset -v a[$k]` with k='$(echo foo)' splits
    if (!unsetFunctions && !isVariableName(name, services?.arrayRefs?.has(name) === true)) {
      if (variablesOnly || noref) {
        stderr += `unset: \`${name}': not a valid identifier\n`;
      } else if (ctx.getFunction(name)) {
        ctx.unsetFunction(name);
      }

      continue;
    }

    // A name that is no variable but a function is the function, unless -v says otherwise
    if (unsetFunctions || (!variablesOnly && !noref && !ctx.getVariable(name) && ctx.getFunction(name))) {
      if (ctx.getFunction(name)?.readonly) {
        stderr += `unset: ${name}: cannot unset: readonly function\n`;
        continue;
      }

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

    // `unset a[1]` removes one element and leaves a hole, `unset a` the whole array; so
    // does `unset ref` after `declare -n ref='a[1]'`
    const element = subscripted(name) ?? subscripted(ctx.resolveNameref(name));

    if (element) {
      // An element of a plain variable is no element at all
      const kind = ctx.getVariable(ctx.resolveNameref(element.name))?.kind;

      if (kind === 'scalar') {
        stderr += `unset: ${element.name}: not an array variable\n`;
        continue;
      }

      // `@` and `*` are keys of an associative array like any other; of an
      // indexed one, every element, which leaves it empty, as bash 5.2 has it.
      // Up to BASH_COMPAT=51 they unset the array itself
      if (element.subscript === '@' || element.subscript === '*') {
        const compat = String(ctx.getParams().BASH_COMPAT ?? '').replace('.', '');

        if (/^[1-9][0-9]$/.test(compat) && Number(compat) <= 51) ctx.unsetVariable(element.name);
        else if (ctx.getAssoc(element.name)) ctx.unsetAssocElement(element.name, element.subscript);
        else if (ctx.getArray(element.name)) ctx.setArray(element.name, []);
        continue;
      }

      // The subscript is expanded, as bash expands it once more, unless
      // assoc_expand_once makes a key what it says
      if (ctx.getAssoc(element.name)) {
        const literal = ctx.getShellOption('assoc_expand_once') || !services || services.arrayRefs?.has(name) === true;

        ctx.unsetAssocElement(element.name, literal ? element.subscript : await services.expandSubscript(element.subscript, true));
        continue;
      }

      const array = ctx.getArray(element.name);
      const expanded = services ? await services.expandSubscript(element.subscript, false) : element.subscript;
      const parsed = Number(await evaluateArithmeticText(expanded, contextVariables(ctx, services?.expandSubscript)));
      const index = parsed < 0 ? (array?.length ?? 0) + parsed : parsed;

      // Counting back from the end past the first element
      if (index < 0) {
        stderr += `unset: [${element.subscript}]: bad array subscript\n`;
        continue;
      }

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
export const localBuiltin: BuiltinHandler = (ctx, args, _shell, _execute, services) => declareCommand('local', ctx, args, services);
