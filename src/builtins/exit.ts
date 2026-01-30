import type { BuiltinHandler } from './types.ts';

/**
 * Special exit code marker used to signal script exit.
 * Exit signals use the range -1000 to -1999.
 */
export const EXIT_SIGNAL_BASE = -1000;
export const EXIT_SIGNAL_MAX = -1999;

/**
 * Check if an exit code represents an exit signal.
 */
export function isExitSignal(code: number): boolean {
  return code <= EXIT_SIGNAL_BASE && code >= EXIT_SIGNAL_MAX;
}

/**
 * Extract the actual exit code from an exit signal.
 */
export function getExitCode(code: number): number {
  if (isExitSignal(code)) {
    return EXIT_SIGNAL_BASE - code;
  }
  return code;
}

/**
 * Create an exit signal code from an exit code.
 */
export function makeExitSignal(code: number): number {
  return EXIT_SIGNAL_BASE - code;
}

/**
 * The exit builtin - exit the shell with a status.
 *
 * Usage: exit [n]
 *
 * Exit the shell with a status of n. If n is omitted, the exit status
 * is that of the last command executed.
 *
 * Note: This returns a special exit signal that can be detected by the
 * executor to terminate script execution.
 */
export const exitBuiltin: BuiltinHandler = async (ctx, args) => {
  let exitCode = 0;

  if (args.length > 0) {
    const parsed = Number.parseInt(args[0], 10);
    if (Number.isNaN(parsed)) {
      return {
        code: 2,
        stderr: `exit: ${args[0]}: numeric argument required\n`,
      };
    }
    // Bash uses modulo 256 for exit codes
    exitCode = ((parsed % 256) + 256) % 256;
  } else {
    // Use last exit code from context if available
    const lastExitCode = ctx.getParams()['?'];
    if (lastExitCode !== undefined) {
      exitCode = Number.parseInt(lastExitCode, 10) || 0;
    }
  }

  // Return a special signal code that the executor can detect
  return { code: makeExitSignal(exitCode) };
};

/**
 * Special return code marker used to signal function return.
 * Return signals use the range -2000 to -2999.
 */
export const RETURN_SIGNAL_BASE = -2000;
export const RETURN_SIGNAL_MAX = -2999;

/**
 * Check if an exit code represents a return signal.
 */
export function isReturnSignal(code: number): boolean {
  return code <= RETURN_SIGNAL_BASE && code >= RETURN_SIGNAL_MAX;
}

/**
 * Extract the actual return code from a return signal.
 */
export function getReturnCode(code: number): number {
  if (isReturnSignal(code)) {
    return RETURN_SIGNAL_BASE - code;
  }
  return code;
}

/**
 * Create a return signal code from a return code.
 */
export function makeReturnSignal(code: number): number {
  return RETURN_SIGNAL_BASE - code;
}

/**
 * The return builtin - return from a function.
 *
 * Usage: return [n]
 *
 * Causes a function to stop execution and return the value specified by n
 * to its caller. If n is omitted, the return status is that of the last
 * command executed in the function body.
 *
 * Note: This returns a special return signal that can be detected by the
 * executor to stop function execution.
 */
export const returnBuiltin: BuiltinHandler = async (ctx, args) => {
  let returnCode = 0;

  if (args.length > 0) {
    const parsed = Number.parseInt(args[0], 10);
    if (Number.isNaN(parsed)) {
      return {
        code: 2,
        stderr: `return: ${args[0]}: numeric argument required\n`,
      };
    }
    // Bash uses modulo 256 for return codes
    returnCode = ((parsed % 256) + 256) % 256;
  } else {
    // Use last exit code from context if available
    const lastExitCode = ctx.getParams()['?'];
    if (lastExitCode !== undefined) {
      returnCode = Number.parseInt(lastExitCode, 10) || 0;
    }
  }

  // Return a special signal code that the executor can detect
  return { code: makeReturnSignal(returnCode) };
};
