/**
 * Bash builtins implementation for bash-executor.
 *
 * This module provides implementations of common bash builtin commands
 * that can be used with the AstExecutor.
 */

export * from './types.ts';

export { argBuiltin } from './arg.ts';
export { aliasBuiltin, unaliasBuiltin } from './alias.ts';
export { callerBuiltin } from './caller.ts';
export { timesBuiltin } from './times.ts';
export { cdBuiltin } from './cd.ts';
export { completeBuiltin, compoptBuiltin, createCompgenBuiltin } from './compgen.ts';
export { declareBuiltin, typesetBuiltin } from './declare.ts';
export { dirsBuiltin, popdBuiltin, pushdBuiltin } from './dirstack.ts';
export { echoBuiltin } from './echo.ts';
export { createEnableBuiltin } from './enable.ts';
export { evalBuiltin } from './eval.ts';
export {
  EXIT_SIGNAL_BASE,
  EXIT_SIGNAL_MAX,
  exitBuiltin,
  getExitCode,
  getReturnCode,
  isExitSignal,
  isReturnSignal,
  logoutBuiltin,
  makeExitSignal,
  makeReturnSignal,
  RETURN_SIGNAL_BASE,
  RETURN_SIGNAL_MAX,
  returnBuiltin,
} from './exit.ts';
export { createBuiltinBuiltin, createCommandBuiltin, createTypeBuiltin, lookupCommand } from './introspection.ts';
export { createHelpBuiltin } from './help.ts';
export { getoptsBuiltin } from './getopts.ts';
export { createHashBuiltin } from './hash.ts';
export { letBuiltin } from './let.ts';
export { mapfileBuiltin } from './mapfile.ts';
export { printfBuiltin } from './printf.ts';
export { pwdBuiltin } from './pwd.ts';
export { readBuiltin } from './read.ts';
export { readonlyBuiltin } from './readonly.ts';
export { setBuiltin } from './set.ts';
export { shiftBuiltin } from './shift.ts';
export { shoptBuiltin } from './shopt.ts';
export { SIGNALS, trapBuiltin, trapName } from './trap.ts';
export { bgBuiltin, disownBuiltin, fgBuiltin, JOB_BUILTINS, jobsBuiltin, killBuiltin, waitBuiltin } from './jobs.ts';
export { dotBuiltin, sourceBuiltin } from './source.ts';
export { umaskBuiltin } from './umask.ts';
export { ulimitBuiltin } from './ulimit.ts';
export { appendHistory, fcBuiltin, historyBuiltin, loadHistory, saveHistory, truncateHistoryFile } from './history.ts';
export { bracketBuiltin, testBuiltin } from './test.ts';
export { colonBuiltin, falseBuiltin, trueBuiltin } from './trivial.ts';
export { exportBuiltin, localBuiltin, unsetBuiltin } from './variables.ts';

import { argBuiltin } from './arg.ts';
import { aliasBuiltin, unaliasBuiltin } from './alias.ts';
import { callerBuiltin } from './caller.ts';
import { timesBuiltin } from './times.ts';
import { cdBuiltin } from './cd.ts';
import { completeBuiltin, compoptBuiltin, createCompgenBuiltin } from './compgen.ts';
import { declareBuiltin, typesetBuiltin } from './declare.ts';
import { dirsBuiltin, popdBuiltin, pushdBuiltin } from './dirstack.ts';
import { echoBuiltin } from './echo.ts';
import { createEnableBuiltin } from './enable.ts';
import { evalBuiltin } from './eval.ts';
import { exitBuiltin, returnBuiltin } from './exit.ts';
import { createBuiltinBuiltin, createCommandBuiltin, createTypeBuiltin } from './introspection.ts';
import { createHelpBuiltin } from './help.ts';
import { getoptsBuiltin } from './getopts.ts';
import { createHashBuiltin } from './hash.ts';
import { letBuiltin } from './let.ts';
import { mapfileBuiltin } from './mapfile.ts';
import { printfBuiltin } from './printf.ts';
import { pwdBuiltin } from './pwd.ts';
import { readBuiltin } from './read.ts';
import { readonlyBuiltin } from './readonly.ts';
import { setBuiltin } from './set.ts';
import { shiftBuiltin } from './shift.ts';
import { shoptBuiltin } from './shopt.ts';
import { trapBuiltin } from './trap.ts';
import { bgBuiltin, disownBuiltin, fgBuiltin, jobsBuiltin, killBuiltin, waitBuiltin } from './jobs.ts';
import { dotBuiltin, sourceBuiltin } from './source.ts';
import { umaskBuiltin } from './umask.ts';
import { ulimitBuiltin } from './ulimit.ts';
import { fcBuiltin, historyBuiltin } from './history.ts';
import { bracketBuiltin, testBuiltin } from './test.ts';
import { colonBuiltin, falseBuiltin, trueBuiltin } from './trivial.ts';
import type { BuiltinRegistry } from './types.ts';
import { exportBuiltin, localBuiltin, unsetBuiltin } from './variables.ts';

/**
 * Create a new builtin registry with all implemented builtins.
 *
 * @returns A Map of builtin names to their handlers
 */
export function createBuiltinRegistry(): BuiltinRegistry {
  const registry: BuiltinRegistry = new Map();

  // Trivial builtins
  registry.set(':', colonBuiltin);
  registry.set('true', trueBuiltin);
  registry.set('false', falseBuiltin);
  registry.set('echo', echoBuiltin);
  registry.set('pwd', pwdBuiltin);
  registry.set('exit', exitBuiltin);
  registry.set('return', returnBuiltin);

  // Context-modifying builtins
  registry.set('cd', cdBuiltin);
  registry.set('umask', umaskBuiltin);
  registry.set('ulimit', ulimitBuiltin);
  registry.set('export', exportBuiltin);
  registry.set('unset', unsetBuiltin);
  registry.set('local', localBuiltin);
  registry.set('alias', aliasBuiltin);
  registry.set('unalias', unaliasBuiltin);

  // Test and conditionals
  registry.set('test', testBuiltin);
  registry.set('[', bracketBuiltin);

  // Script execution
  registry.set('eval', evalBuiltin);
  registry.set('shopt', shoptBuiltin);
  registry.set('trap', trapBuiltin);

  // Job control: the executor drops these again when the host has none
  registry.set('jobs', jobsBuiltin);
  registry.set('wait', waitBuiltin);
  registry.set('kill', killBuiltin);
  registry.set('disown', disownBuiltin);
  registry.set('fg', fgBuiltin);
  registry.set('bg', bgBuiltin);
  registry.set('source', sourceBuiltin);
  registry.set('.', dotBuiltin);

  // Parameter manipulation
  registry.set('shift', shiftBuiltin);
  registry.set('getopts', getoptsBuiltin);

  // Output formatting
  registry.set('printf', printfBuiltin);

  // Introspection, which needs the registry
  registry.set('type', createTypeBuiltin(registry));
  registry.set('command', createCommandBuiltin(registry));
  registry.set('builtin', createBuiltinBuiltin(registry));
  registry.set('hash', createHashBuiltin(registry));
  registry.set('enable', createEnableBuiltin(registry));
  registry.set('caller', callerBuiltin);
  registry.set('times', timesBuiltin);
  registry.set('compgen', createCompgenBuiltin(registry));
  registry.set('complete', completeBuiltin);
  registry.set('compopt', compoptBuiltin);

  // Arithmetic
  registry.set('let', letBuiltin);

  // Input
  registry.set('read', readBuiltin);
  registry.set('mapfile', mapfileBuiltin);
  registry.set('readarray', mapfileBuiltin);

  // Variable attributes
  registry.set('declare', declareBuiltin);
  registry.set('typeset', typesetBuiltin);
  registry.set('readonly', readonlyBuiltin);

  // Directory stack
  registry.set('dirs', dirsBuiltin);
  registry.set('pushd', pushdBuiltin);
  registry.set('popd', popdBuiltin);

  // The command history
  registry.set('history', historyBuiltin);
  registry.set('help', createHelpBuiltin(registry));
  registry.set('fc', fcBuiltin);

  // Shell options
  registry.set('set', setBuiltin);

  // Argument parsing
  registry.set('arg', argBuiltin);

  return registry;
}
