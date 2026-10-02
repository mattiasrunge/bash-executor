/**
 * The help builtin: what each builtin is for, and how it is called. The
 * synopses are bash's; the descriptions are short ones of this executor's own.
 */

import { globToRegExp } from '../pattern.ts';
import type { BuiltinHandler, BuiltinRegistry } from './types.ts';

/** Each builtin's synopsis and what it does. */
const TOPICS: Record<string, [string, string]> = {
  '.': ['. filename [arguments]', 'Run the commands of a file in this shell.'],
  ':': [':', 'Do nothing, successfully.'],
  '[': ['[ arg... ]', 'Evaluate a test expression, as test does; the last argument is `]`.'],
  alias: ['alias [-p] [name[=value] ... ]', 'Define or show aliases.'],
  bg: ['bg [job_spec ...]', 'Resume jobs in the background.'],
  break: ['break [n]', 'Leave the innermost n enclosing loops.'],
  builtin: ['builtin [shell-builtin [arg ...]]', 'Run a builtin, passing over a function of the same name.'],
  caller: ['caller [expr]', 'Say where the current function or sourced file was called from.'],
  cd: ['cd [-L|[-P [-e]] [-@]] [dir]', 'Change the working directory.'],
  command: ['command [-pVv] command [arg ...]', 'Run a command, passing over functions, or say what it is.'],
  compgen: [
    'compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]',
    'Print the completions of a word.',
  ],
  complete: [
    'complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]',
    'Define, list or remove how arguments are completed.',
  ],
  compopt: ['compopt [-o|+o option] [-DEI] [name ...]', 'Change completion options.'],
  continue: ['continue [n]', 'Go on with the next round of the nth enclosing loop.'],
  declare: ['declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]', 'Declare variables, set their attributes, or show them.'],
  dirs: ['dirs [-clpv] [+N] [-N]', 'Show the directory stack.'],
  disown: ['disown [-h] [-ar] [jobspec ... | pid ...]', 'Remove jobs from the job table.'],
  echo: ['echo [-neE] [arg ...]', 'Write the arguments to standard output.'],
  enable: ['enable [-a] [-dnps] [-f filename] [name ...]', 'Turn builtins on or off.'],
  eval: ['eval [arg ...]', 'Run the arguments, joined, as a command.'],
  exec: ['exec [-cl] [-a name] [command [argument ...]] [redirection ...]', 'Replace the shell with a command, or make redirections last.'],
  exit: ['exit [n]', 'Leave the shell with status n.'],
  export: ['export [-fn] [name[=value] ...] or export -p', 'Hand variables to the commands the shell runs.'],
  false: ['false', 'Fail.'],
  fc: ['fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]', 'List, edit or run again commands from the history.'],
  fg: ['fg [job_spec]', 'Bring a job to the foreground.'],
  getopts: ['getopts optstring name [arg ...]', 'Take the next option from the arguments.'],
  hash: ['hash [-lr] [-p pathname] [-dt] [name ...]', 'Remember or show where commands are.'],
  help: ['help [-dms] [pattern ...]', 'Show what builtins do and how they are called.'],
  history: ['history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]', 'Show or change the command history.'],
  jobs: ['jobs [-lnprs] [jobspec ...] or jobs -x command [args]', 'List jobs.'],
  kill: ['kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', 'Send a signal to processes or jobs.'],
  let: ['let arg [arg ...]', 'Evaluate arithmetic expressions.'],
  local: ['local [option] name[=value] ...', 'Make variables local to a function.'],
  logout: ['logout [n]', 'Leave a login shell.'],
  mapfile: ['mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]', 'Read lines into an indexed array.'],
  popd: ['popd [-n] [+N | -N]', 'Take a directory off the directory stack.'],
  printf: ['printf [-v var] format [arguments]', 'Write the arguments as a format says.'],
  pushd: ['pushd [-n] [+N | -N | dir]', 'Put a directory on the directory stack.'],
  pwd: ['pwd [-LP]', 'Print the working directory.'],
  read: [
    'read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]',
    'Read a line and split it into variables.',
  ],
  readarray: ['readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]', 'Read lines into an indexed array.'],
  readonly: ['readonly [-aAf] [name[=value] ...] or readonly -p', 'Make variables unchangeable.'],
  return: ['return [n]', 'Leave a function or sourced file with status n.'],
  set: ['set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]', 'Set shell options or the positional parameters.'],
  shift: ['shift [n]', 'Move the positional parameters down by n.'],
  shopt: ['shopt [-pqsu] [-o] [optname ...]', 'Set or show shell options.'],
  source: ['source filename [arguments]', 'Run the commands of a file in this shell.'],
  suspend: ['suspend [-f]', 'Stop the shell until it is continued.'],
  test: ['test [expr]', 'Evaluate a test expression.'],
  times: ['times', 'Show the time used by the shell and its children.'],
  trap: ['trap [-lp] [[arg] signal_spec ...]', 'Run a command when the shell gets a signal or other event.'],
  true: ['true', 'Succeed.'],
  type: ['type [-afptP] name [name ...]', 'Say what a name is when used as a command.'],
  typeset: ['typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]', 'Declare variables, as declare does.'],
  ulimit: ['ulimit [-SHabcdefiklmnpqrstuvxPRT] [limit]', 'Show or set resource limits.'],
  umask: ['umask [-p] [-S] [mode]', 'Show or set the file creation mask.'],
  unalias: ['unalias [-a] name [name ...]', 'Remove aliases.'],
  unset: ['unset [-f] [-v] [-n] [name ...]', 'Remove variables or functions.'],
  wait: ['wait [-fn] [-p var] [id ...]', 'Wait for jobs to finish.'],
};

const USAGE = 'help: usage: help [-dms] [pattern ...]\n';

/**
 * Creates the help builtin, which knows the builtins `registry` has.
 *
 * @example
 * help            -> every builtin's synopsis
 * help -d 'p*'    -> what pushd, pwd, printf … do
 */
export function createHelpBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  return async (ctx, args, shell) => {
    let mode: 'd' | 's' | 'full' = 'full';
    let i = 0;

    for (; i < args.length && /^-./.test(args[i]); i++) {
      if (args[i] === '--') {
        i++;
        break;
      }

      for (const letter of args[i].slice(1)) {
        if (letter === 'd' || letter === 's') mode = letter;
        else if (letter !== 'm') return { code: 2, stderr: `help: -${letter}: invalid option\n${USAGE}` };
      }
    }

    const known = Object.keys(TOPICS).filter((name) => registry.has(name)).sort();
    const patterns = args.slice(i);
    let text = '';

    if (patterns.length === 0) {
      text = 'These are the builtins of this shell. Type `help name` for more about one.\n\n' +
        known.map((name) => ` ${TOPICS[name][0]}\n`).join('');
    } else {
      for (const pattern of patterns) {
        const matching = known.filter((name) => name === pattern || globToRegExp(pattern).test(name) || (!/[*?[]/.test(pattern) && name.startsWith(pattern)));

        if (matching.length === 0) {
          return { code: 1, stderr: `help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.\n` };
        }

        for (const name of matching) {
          const [synopsis, description] = TOPICS[name];

          text += mode === 's' ? `${name}: ${synopsis}\n` : mode === 'd' ? `${name} - ${description}\n` : `${name}: ${synopsis}\n    ${description}\n`;
        }
      }
    }

    // As bash's help, which does not look at what its writes come to: `help >&-` says nothing
    await shell.pipeWrite(ctx.getStdout(), text).catch(() => {});

    return { code: 0 };
  };
}
