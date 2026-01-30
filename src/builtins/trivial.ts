import type { BuiltinHandler } from './types.ts';

/**
 * The colon (:) builtin - does nothing, returns success.
 * This is a null command that always succeeds.
 */
export const colonBuiltin: BuiltinHandler = async () => ({ code: 0 });

/**
 * The true builtin - always returns success (exit code 0).
 */
export const trueBuiltin: BuiltinHandler = async () => ({ code: 0 });

/**
 * The false builtin - always returns failure (exit code 1).
 */
export const falseBuiltin: BuiltinHandler = async () => ({ code: 1 });
