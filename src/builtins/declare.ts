/**
 * Implementation of the declare and typeset builtins.
 *
 * Declares variables and/or gives them attributes.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

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
 * -a    Declare array variables (basic support)
 * -A    Declare associative array variables (basic support)
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
  let unsetReadonly = false;
  let unsetExport = false;
  let showFunctions = false;
  let showFunctionNames = false;

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
          case 'A':
            // Array support - just acknowledge, limited implementation
            break;
          case 'f':
            showFunctions = true;
            break;
          case 'F':
            showFunctionNames = true;
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

      return { code: 0, stdout: output };
    }

    // No args and no -p: just return success
    return { code: 0 };
  }

  // Process variable arguments
  let hasError = false;
  let output = '';

  for (const arg of varArgs) {
    const { name, value } = parseAssignment(arg);

    if (!isValidName(name)) {
      output += `declare: \`${arg}': not a valid identifier\n`;
      hasError = true;
      continue;
    }

    // Print mode: show variable declaration
    if (printMode && value === undefined) {
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

      // For integer variables, evaluate as arithmetic
      if (ctx.isIntegerVar(name) || setInteger) {
        try {
          // Simple integer evaluation
          const num = Number.parseInt(value, 10);
          finalValue = Number.isNaN(num) ? '0' : String(num);
        } catch {
          finalValue = '0';
        }
      }

      if (setExport) {
        // Export to environment
        ctx.setEnv({ [name]: finalValue });
      } else {
        // Set as local parameter
        ctx.setEnv({ [name]: finalValue });
      }
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
