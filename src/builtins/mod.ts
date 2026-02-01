/**
 * Bash builtins implementation for bash-executor.
 *
 * This module provides implementations of common bash builtin commands
 * that can be used with the AstExecutor.
 */

// Export types
export * from './types.ts';

// Export individual builtins
export { argBuiltin } from './arg.ts';
export { aliasBuiltin, unaliasBuiltin } from './alias.ts';
export { cdBuiltin } from './cd.ts';
export { clearAttributes, declareBuiltin, isReadonly, typesetBuiltin } from './declare.ts';
export { clearDirStack, dirsBuiltin, getDirStack, popdBuiltin, pushdBuiltin } from './dirstack.ts';
export { echoBuiltin } from './echo.ts';
export { evalBuiltin } from './eval.ts';
export {
  EXIT_SIGNAL_BASE,
  EXIT_SIGNAL_MAX,
  exitBuiltin,
  getExitCode,
  getReturnCode,
  isExitSignal,
  isReturnSignal,
  makeExitSignal,
  makeReturnSignal,
  RETURN_SIGNAL_BASE,
  RETURN_SIGNAL_MAX,
  returnBuiltin,
} from './exit.ts';
export { createBuiltinBuiltin, createCommandBuiltin, createTypeBuiltin } from './introspection.ts';
export { letBuiltin } from './let.ts';
export { printfBuiltin } from './printf.ts';
export { pwdBuiltin } from './pwd.ts';
export { readBuiltin } from './read.ts';
export { readonlyBuiltin } from './readonly.ts';
export { getShellOption, resetShellOptions, setBuiltin, setShellOption } from './set.ts';
export { shiftBuiltin } from './shift.ts';
export { dotBuiltin, sourceBuiltin } from './source.ts';
export { bracketBuiltin, testBuiltin } from './test.ts';
export { colonBuiltin, falseBuiltin, trueBuiltin } from './trivial.ts';
export { exportBuiltin, localBuiltin, unsetBuiltin } from './variables.ts';

import { argBuiltin } from './arg.ts';
import { aliasBuiltin, unaliasBuiltin } from './alias.ts';
import { cdBuiltin } from './cd.ts';
import { declareBuiltin, typesetBuiltin } from './declare.ts';
import { dirsBuiltin, popdBuiltin, pushdBuiltin } from './dirstack.ts';
import { echoBuiltin } from './echo.ts';
import { evalBuiltin } from './eval.ts';
import { exitBuiltin, returnBuiltin } from './exit.ts';
import { createBuiltinBuiltin, createCommandBuiltin, createTypeBuiltin } from './introspection.ts';
import { letBuiltin } from './let.ts';
import { printfBuiltin } from './printf.ts';
import { pwdBuiltin } from './pwd.ts';
import { readBuiltin } from './read.ts';
import { readonlyBuiltin } from './readonly.ts';
import { setBuiltin } from './set.ts';
import { shiftBuiltin } from './shift.ts';
import { dotBuiltin, sourceBuiltin } from './source.ts';
import { bracketBuiltin, testBuiltin } from './test.ts';
import { colonBuiltin, falseBuiltin, trueBuiltin } from './trivial.ts';
import type { BuiltinHandler, BuiltinRegistry } from './types.ts';
import { exportBuiltin, localBuiltin, unsetBuiltin } from './variables.ts';

/**
 * Create a new builtin registry with all implemented builtins.
 *
 * @returns A Map of builtin names to their handlers
 */
export function createBuiltinRegistry(): BuiltinRegistry {
  const registry: BuiltinRegistry = new Map();

  // Phase 1: Trivial builtins
  registry.set(':', colonBuiltin);
  registry.set('true', trueBuiltin);
  registry.set('false', falseBuiltin);
  registry.set('echo', echoBuiltin);
  registry.set('pwd', pwdBuiltin);
  registry.set('exit', exitBuiltin);
  registry.set('return', returnBuiltin);

  // Phase 2: Context-modifying builtins
  registry.set('cd', cdBuiltin);
  registry.set('export', exportBuiltin);
  registry.set('unset', unsetBuiltin);
  registry.set('local', localBuiltin);
  registry.set('alias', aliasBuiltin);
  registry.set('unalias', unaliasBuiltin);

  // Phase 3: Test and conditionals
  registry.set('test', testBuiltin);
  registry.set('[', bracketBuiltin);

  // Phase 3: Script execution
  registry.set('eval', evalBuiltin);
  registry.set('source', sourceBuiltin);
  registry.set('.', dotBuiltin);

  // Phase 3: Parameter manipulation
  registry.set('shift', shiftBuiltin);

  // Phase 3: Output formatting
  registry.set('printf', printfBuiltin);

  // Phase 3: Introspection (need registry reference)
  registry.set('type', createTypeBuiltin(registry));
  registry.set('command', createCommandBuiltin(registry));
  registry.set('builtin', createBuiltinBuiltin(registry));

  // Phase 3: Arithmetic
  registry.set('let', letBuiltin);

  // Phase 3: Input
  registry.set('read', readBuiltin);

  // Phase 4: Variable attributes
  registry.set('declare', declareBuiltin);
  registry.set('typeset', typesetBuiltin);
  registry.set('readonly', readonlyBuiltin);

  // Phase 4: Directory stack
  registry.set('dirs', dirsBuiltin);
  registry.set('pushd', pushdBuiltin);
  registry.set('popd', popdBuiltin);

  // Phase 4: Shell options
  registry.set('set', setBuiltin);

  // Phase 5: Argument parsing
  registry.set('arg', argBuiltin);

  return registry;
}

/**
 * Register a builtin handler in the registry.
 *
 * @param registry - The builtin registry
 * @param name - The builtin name
 * @param handler - The builtin handler function
 */
export function registerBuiltin(
  registry: BuiltinRegistry,
  name: string,
  handler: BuiltinHandler,
): void {
  registry.set(name, handler);
}

/**
 * Get a builtin handler from the registry.
 *
 * @param registry - The builtin registry
 * @param name - The builtin name
 * @returns The builtin handler or undefined if not found
 */
export function getBuiltin(
  registry: BuiltinRegistry,
  name: string,
): BuiltinHandler | undefined {
  return registry.get(name);
}

/**
 * Check if a name is a registered builtin.
 *
 * @param registry - The builtin registry
 * @param name - The name to check
 * @returns True if the name is a builtin
 */
export function isBuiltin(registry: BuiltinRegistry, name: string): boolean {
  return registry.has(name);
}

/**
 * Get all builtin names.
 *
 * @param registry - The builtin registry
 * @returns Set of all builtin names
 */
export function getBuiltinNames(registry: BuiltinRegistry): Set<string> {
  return new Set(registry.keys());
}
