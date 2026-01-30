/**
 * Implementation of the test and [ builtins.
 *
 * Supports:
 * - File tests: -e, -f, -d, -r, -w, -x, -s, -L (delegated to shell)
 * - String tests: -z, -n, =, ==, !=
 * - Numeric comparisons: -eq, -ne, -lt, -le, -gt, -ge
 * - Logical operators: !, -a, -o
 * - Parentheses for grouping: ( expr )
 */

import type { ExecContextIf, PathTestOperation, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

// File test operators that require shell delegation
const FILE_TEST_OPS = new Set([
  '-e', // exists
  '-f', // regular file
  '-d', // directory
  '-r', // readable
  '-w', // writable
  '-x', // executable
  '-s', // size > 0
  '-L', // symbolic link
  '-h', // symbolic link (same as -L)
  '-b', // block device
  '-c', // character device
  '-p', // named pipe
  '-S', // socket
  '-g', // set-group-id
  '-u', // set-user-id
  '-k', // sticky bit
  '-O', // owned by effective uid
  '-G', // owned by effective gid
  '-N', // modified since last read
  '-t', // fd is terminal
]);

// Two-argument file comparison operators
const FILE_CMP_OPS = new Set([
  '-nt', // newer than
  '-ot', // older than
  '-ef', // same device and inode
]);

/**
 * Evaluate a test expression.
 *
 * @param ctx - Execution context
 * @param args - Arguments to evaluate
 * @param shell - Shell interface for file tests
 * @returns Promise resolving to true if test passes
 */
async function evaluateExpr(
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<boolean> {
  if (args.length === 0) {
    return false;
  }

  // Single argument: true if non-empty string
  if (args.length === 1) {
    return args[0].length > 0;
  }

  // Handle ! (negation) at the start
  if (args[0] === '!') {
    return !(await evaluateExpr(ctx, args.slice(1), shell));
  }

  // Handle parentheses
  if (args[0] === '(' && args[args.length - 1] === ')') {
    return evaluateExpr(ctx, args.slice(1, -1), shell);
  }

  // Find -o (OR) at the top level (lowest precedence)
  let parenDepth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '(') parenDepth++;
    else if (args[i] === ')') parenDepth--;
    else if (args[i] === '-o' && parenDepth === 0) {
      const left = await evaluateExpr(ctx, args.slice(0, i), shell);
      if (left) return true;
      return evaluateExpr(ctx, args.slice(i + 1), shell);
    }
  }

  // Find -a (AND) at the top level
  parenDepth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '(') parenDepth++;
    else if (args[i] === ')') parenDepth--;
    else if (args[i] === '-a' && parenDepth === 0) {
      const left = await evaluateExpr(ctx, args.slice(0, i), shell);
      if (!left) return false;
      return evaluateExpr(ctx, args.slice(i + 1), shell);
    }
  }

  // Two arguments: unary operator
  if (args.length === 2) {
    const [op, val] = args;

    // String tests
    if (op === '-z') return val.length === 0;
    if (op === '-n') return val.length > 0;

    // File tests - delegate to shell
    if (FILE_TEST_OPS.has(op)) {
      if (shell.testPath) {
        return await shell.testPath(ctx, val, op as PathTestOperation, undefined);
      }

      throw new Error(`'${op}' could not be evaluated, testPath is not defined in shell`);
    }
  }

  // Three arguments: binary operator
  if (args.length === 3) {
    const [left, op, right] = args;

    // String comparisons
    if (op === '=' || op === '==') return left === right;
    if (op === '!=') return left !== right;
    if (op === '<') return left < right;
    if (op === '>') return left > right;

    // Numeric comparisons
    if (op === '-eq') return Number.parseInt(left, 10) === Number.parseInt(right, 10);
    if (op === '-ne') return Number.parseInt(left, 10) !== Number.parseInt(right, 10);
    if (op === '-lt') return Number.parseInt(left, 10) < Number.parseInt(right, 10);
    if (op === '-le') return Number.parseInt(left, 10) <= Number.parseInt(right, 10);
    if (op === '-gt') return Number.parseInt(left, 10) > Number.parseInt(right, 10);
    if (op === '-ge') return Number.parseInt(left, 10) >= Number.parseInt(right, 10);

    // File comparisons - delegate to shell
    if (FILE_CMP_OPS.has(op)) {
      if (shell.testPath) {
        return await shell.testPath(ctx, left, op as PathTestOperation, right);
      }

      throw new Error(`'${op}' could not be evaluated, testPath is not defined in shell`);
    }
  }

  // Compound expressions with more than 3 args that aren't handled above
  // Try to find binary operators
  if (args.length >= 3) {
    const op = args[1];
    // Check if it's a binary string/numeric operator
    if (
      ['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op)
    ) {
      const left = args[0];
      const right = args[2];
      let result: boolean;

      if (op === '=' || op === '==') result = left === right;
      else if (op === '!=') result = left !== right;
      else if (op === '<') result = left < right;
      else if (op === '>') result = left > right;
      else if (op === '-eq') result = Number.parseInt(left, 10) === Number.parseInt(right, 10);
      else if (op === '-ne') result = Number.parseInt(left, 10) !== Number.parseInt(right, 10);
      else if (op === '-lt') result = Number.parseInt(left, 10) < Number.parseInt(right, 10);
      else if (op === '-le') result = Number.parseInt(left, 10) <= Number.parseInt(right, 10);
      else if (op === '-gt') result = Number.parseInt(left, 10) > Number.parseInt(right, 10);
      else if (op === '-ge') result = Number.parseInt(left, 10) >= Number.parseInt(right, 10);
      else result = false;

      // If there are more args after the first expression, handle them
      if (args.length > 3) {
        const rest = args.slice(3);
        if (rest[0] === '-a') {
          return result && (await evaluateExpr(ctx, rest.slice(1), shell));
        }
        if (rest[0] === '-o') {
          return result || (await evaluateExpr(ctx, rest.slice(1), shell));
        }
      }
      return result;
    }
  }

  // Fallback: non-empty first argument is true
  return args[0].length > 0;
}

/**
 * The test builtin command.
 *
 * Evaluates conditional expressions and returns 0 (true) or 1 (false).
 */
export const testBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<BuiltinResult> => {
  try {
    const result = await evaluateExpr(ctx, args, shell);
    return { code: result ? 0 : 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 2, stderr: `test: expression error: ${message}\n` };
  }
};

/**
 * The [ builtin command.
 *
 * Same as test, but requires a closing ] argument.
 */
export const bracketBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<BuiltinResult> => {
  // Check for closing ]
  if (args.length === 0 || args[args.length - 1] !== ']') {
    return { code: 2, stderr: "[: missing `]'\n" };
  }

  // Remove the closing ] and evaluate
  const testArgs = args.slice(0, -1);

  try {
    const result = await evaluateExpr(ctx, testArgs, shell);
    return { code: result ? 0 : 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 2, stderr: `[: expression error: ${message}\n` };
  }
};
