/**
 * Implementation of the let builtin.
 *
 * Evaluates arithmetic expressions using bash-parser.
 */

import { parseArithmetic } from '@ein/bash-parser';
import { evaluateArithmetic } from '../arithmetic-eval.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The let builtin command.
 *
 * Evaluates arithmetic expressions. Each argument is an arithmetic expression
 * to be evaluated. Returns 0 if the last expression evaluates to non-zero,
 * or 1 if it evaluates to zero.
 *
 * @example
 * let "x = 5"          -> x=5, returns 0
 * let "x = 0"          -> x=0, returns 1
 * let "x = 5" "y = 10" -> x=5, y=10, returns 0
 * let "x++"            -> increments x
 * let "a = 5, b = 10"  -> a=5, b=10
 */
export const letBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  if (args.length === 0) {
    return {
      code: 1,
      stderr: 'let: expression expected\n',
    };
  }

  let lastResult = 0;

  for (const arg of args) {
    try {
      // Parse the arithmetic expression using bash-parser
      const ast = parseArithmetic(arg);
      // Evaluate the AST (use setEnv for variable assignment in let builtin)
      lastResult = await evaluateArithmetic(ast, ctx, { useEnvForAssignment: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        code: 1,
        stderr: `let: ${arg}: ${message}\n`,
      };
    }
  }

  // Return 0 if last expression is non-zero, 1 otherwise
  return { code: lastResult === 0 ? 1 : 0 };
};
