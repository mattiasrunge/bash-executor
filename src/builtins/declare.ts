/**
 * Implementation of the declare and typeset builtins.
 *
 * Declares variables and/or gives them attributes.
 */

import { parseArithmetic } from '@ein/bash-parser';
import { evaluateArithmetic } from '../arithmetic-eval.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';
import { assignArrayArg } from './variables.ts';

/**
 * Render an array the way `declare -p` does: `declare -a a=([0]="x" [1]="y")`.
 */
function printArray(name: string, values: string[]): string {
  const elements = Object.entries(values).map(([index, value]) => `[${index}]="${value}"`);

  return `declare -a ${name}=(${elements.join(' ')})\n`;
}

/**
 * Render an associative array: `declare -A a=([k]="v")`.
 */
function printAssoc(name: string, values: Record<string, string>): string {
  const elements = Object.entries(values).map(([key, value]) => `[${key}]="${value}"`);

  return `declare -A ${name}=(${elements.join(' ')})\n`;
}

/**
 * Parse a variable assignment from an argument.
 *
 * @param arg - The argument to parse (e.g., "foo=bar" or "foo")
 * @returns The variable name and optional value
 */
function parseAssignment(arg: string): { name: string; value?: string } {
  const eqIndex = arg.indexOf('=');
  if (eqIndex === -1) {
    return { name: arg };
  }
  return {
    name: arg.slice(0, eqIndex),
    value: arg.slice(eqIndex + 1),
  };
}

/**
 * Check if a variable name is valid.
 *
 * @param name - The variable name to check
 * @returns True if the name is valid
 */
function isValidName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * The declare builtin command.
 *
 * Declares variables and/or gives them attributes. Without any arguments,
 * displays all variables. With -p, displays variables with their values.
 *
 * Options:
 * -p    Display the attributes and values of variables
 * -r    Make variables readonly
 * -x    Export variables to the environment
 * -i    Treat variables as integers
 * -a    Declare indexed array variables
 * -A    Declare associative array variables
 * -f    Display function definitions (limited support)
 * -F    Display function names only (limited support)
 * +r/+x/+i  Remove attributes (where applicable)
 *
 * @example
 * declare x=5            -> declares x=5
 * declare -r CONST=10    -> declares readonly CONST=10
 * declare -x PATH        -> exports PATH
 * declare -i num=5+3     -> declares num as integer, evaluates to 8
 * declare -p x           -> prints "declare -- x=5"
 */
export const declareBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  // Options
  let printMode = false;
  let setReadonly = false;
  let setExport = false;
  let setInteger = false;
  let setArray = false;
  let setAssoc = false;
  let unsetReadonly = false;
  let unsetExport = false;
  let showFunctions = false;
  let showFunctionNames = false;
  let global = false;

  const varArgs: string[] = [];

  // Parse arguments
  for (const arg of args) {
    if (arg.startsWith('-') || arg.startsWith('+')) {
      const remove = arg.startsWith('+');
      for (const char of arg.slice(1)) {
        switch (char) {
          case 'p':
            printMode = true;
            break;
          case 'r':
            if (remove) unsetReadonly = true;
            else setReadonly = true;
            break;
          case 'x':
            if (remove) unsetExport = true;
            else setExport = true;
            break;
          case 'i':
            setInteger = !remove;
            break;
          case 'a':
            setArray = !remove;
            break;
          case 'A':
            setAssoc = !remove;
            break;
          case 'f':
            showFunctions = true;
            break;
          case 'F':
            showFunctionNames = true;
            break;
          case 'g':
            global = true;
            break;
        }
      }
    } else {
      varArgs.push(arg);
    }
  }

  // Handle -f or -F (show functions)
  if (showFunctions || showFunctionNames) {
    const functions = ctx.getFunctions();
    let output = '';

    for (const [name] of Object.entries(functions)) {
      if (showFunctionNames) {
        output += `declare -f ${name}\n`;
      } else {
        output += `${name} ()\n{\n    # function body\n}\n`;
      }
    }

    return { code: 0, stdout: output };
  }

  // No variable arguments - display variables
  if (varArgs.length === 0) {
    if (printMode) {
      // Print all variables
      const env = ctx.getEnv();
      const params = ctx.getParams();
      let output = '';

      for (const [name, value] of Object.entries({ ...env, ...params })) {
        if (!isValidName(name)) continue;

        let attrs = '--';
        if (ctx.isReadonlyVar(name)) attrs = '-r';
        if (ctx.isIntegerVar(name)) attrs = '-i';

        output += `declare ${attrs} ${name}="${value}"\n`;
      }

      for (const [name, values] of Object.entries(ctx.getArrays())) {
        output += printArray(name, values);
      }

      for (const [name, values] of Object.entries(ctx.getAssocs())) {
        output += printAssoc(name, values);
      }

      return { code: 0, stdout: output };
    }

    // No args and no -p: just return success
    return { code: 0 };
  }

  // In a function, what declare sets is the function's own, as with local
  const scope = global ? undefined : ctx.getFunctionScope();
  const attributesOnly = setReadonly || setExport || setInteger || unsetReadonly || unsetExport;

  // Process variable arguments
  let hasError = false;
  let output = '';

  for (const arg of varArgs) {
    // An associative array has to exist before an element list can be read as
    // keys, so the declaration is made first
    if (setAssoc) {
      const assocName = parseAssignment(arg).name;

      if (isValidName(assocName) && !ctx.getAssoc(assocName)) {
        ctx.setAssoc(assocName, {});
      }
    }

    // `declare -a x=(1 2)` — the element list survives quote removal as one word
    if (assignArrayArg(ctx, arg, false)) {
      continue;
    }

    const { name, value } = parseAssignment(arg);

    if (!isValidName(name)) {
      output += `declare: \`${arg}': not a valid identifier\n`;
      hasError = true;
      continue;
    }

    // -a/-A with no value declares an empty array, keeping any already there
    if (setArray && value === undefined && !printMode) {
      ctx.setArray(name, ctx.getArray(name) ?? []);
      continue;
    }

    if (setAssoc && value === undefined && !printMode) {
      continue;
    }

    // Print mode: show variable declaration
    if (printMode && value === undefined) {
      const assoc = ctx.getAssoc(name);

      if (assoc) {
        output += printAssoc(name, assoc);
        continue;
      }

      const array = ctx.getArray(name);

      if (array) {
        output += printArray(name, array);
        continue;
      }

      const env = ctx.getEnv();
      const params = ctx.getParams();
      const currentValue = env[name] ?? params[name];

      if (currentValue !== undefined) {
        let attrs = '--';
        if (ctx.isReadonlyVar(name)) attrs = '-r';
        if (ctx.isIntegerVar(name)) attrs = '-i';

        output += `declare ${attrs} ${name}="${currentValue}"\n`;
      } else {
        output += `declare: ${name}: not found\n`;
        hasError = true;
      }
      continue;
    }

    // Check if trying to modify readonly variable
    if (ctx.isReadonlyVar(name) && !unsetReadonly) {
      output += `declare: ${name}: readonly variable\n`;
      hasError = true;
      continue;
    }

    // Set attributes
    if (setReadonly) {
      ctx.setReadonlyVar(name, true);
    }
    if (unsetReadonly) {
      ctx.setReadonlyVar(name, false);
    }
    if (setInteger) {
      ctx.setIntegerVar(name, true);
    }
    if (unsetExport) {
      // Remove export attribute - move from env to params
      const env = ctx.getEnv();
      if (env[name] !== undefined) {
        const currentValue = env[name];
        ctx.setEnv({ [name]: null }); // Remove from env
        ctx.setParams({ [name]: currentValue }); // Keep as local param
      }
    }

    // Set value if provided
    if (value !== undefined) {
      let finalValue = value;

      // An integer's value is arithmetic: `declare -i n=5+3` is 8
      if (ctx.isIntegerVar(name) || setInteger) {
        try {
          finalValue = String(await evaluateArithmetic(parseArithmetic(value || '0'), ctx, { useEnvForAssignment: true }));
        } catch {
          finalValue = '0';
        }
      }

      const exported = setExport || (ctx.getParams()[name] === undefined && name in ctx.getEnv());

      if (scope) {
        // In a function, declare makes the variable the function's own, as local does
        scope.setLocalParams({ [name]: exported ? null : finalValue });

        if (exported) {
          scope.setLocalEnv({ [name]: finalValue });
        }
      } else if (exported) {
        ctx.setEnv({ [name]: finalValue });
      } else {
        ctx.setParams({ [name]: finalValue });
      }
    } else if (scope && !printMode && !attributesOnly && !ctx.getArray(name) && !ctx.getAssoc(name)) {
      // `declare x` in a function: a local of its own, empty until assigned
      scope.setLocalParams({ [name]: '' });
    } else if (setExport) {
      // Export existing variable
      const env = ctx.getEnv();
      const params = ctx.getParams();
      const currentValue = env[name] ?? params[name] ?? '';
      ctx.setEnv({ [name]: currentValue });
    }
  }

  return {
    code: hasError ? 1 : 0,
    stdout: output || undefined,
    stderr: hasError ? output : undefined,
  };
};

/**
 * The typeset builtin command.
 *
 * This is an alias for the declare builtin for compatibility with older
 * scripts and other shells.
 */
export const typesetBuiltin: BuiltinHandler = declareBuiltin;

/**
 * Check if a variable is readonly.
 * @deprecated Use ctx.isReadonlyVar(name) instead. This function is kept for backwards compatibility.
 *
 * @param _name - The variable name (ignored)
 * @returns Always returns false since readonly tracking is now per-context
 */
export function isReadonly(_name: string): boolean {
  // Readonly vars are now tracked in the context, not globally
  // This function is kept for backwards compatibility but always returns false
  return false;
}

/**
 * Clear all tracked attributes (no-op for backwards compatibility).
 * @deprecated No longer needed since attributes are tracked per-context.
 */
export function clearAttributes(): void {
  // No-op - attributes are now tracked in the context
}
