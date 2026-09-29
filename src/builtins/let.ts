/**
 * Implementation of the let builtin.
 *
 * Evaluates arithmetic expressions using bash-parser.
 */

import { contextVariables, evaluateArithmeticText } from '../arith.ts';
import { ArithmeticError, ReadonlyVariableError } from '../errors.ts';
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
  _execute,
  services,
): Promise<BuiltinResult> => {
  if (args.length === 0) {
    return {
      code: 1,
      stderr: 'let: expression expected\n',
    };
  }

  let lastResult = 0n;

  for (const arg of args) {
    try {
      lastResult = await evaluateArithmeticText(arg, contextVariables(ctx, services?.expandSubscript));
    } catch (error) {
      // A readonly variable is said as any assignment says it, without let's name
      if (error instanceof ReadonlyVariableError) {
        return { code: 1, stderr: `${error.message}\n` };
      }

      if (error instanceof ArithmeticError) {
        return { code: 1, stderr: error.nameless ? `${error.message}\n` : `let: ${error.message}\n` };
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        code: 1,
        stderr: `let: ${arg}: ${message}\n`,
      };
    }
  }

  // Return 0 if last expression is non-zero, 1 otherwise
  return { code: lastResult === 0n ? 1 : 0 };
};
