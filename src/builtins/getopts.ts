/**
 * Implementation of the getopts builtin, after bash's getopts.def and getopt.c.
 *
 * getopts takes one option per call from the positional parameters, or from
 * the arguments after the variable's name, and leaves the index of the next
 * argument in OPTIND. Within a group such as `-abc` it remembers the character
 * it stopped at; assigning OPTIND starts it over.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

const USAGE = 'getopts: usage: getopts optstring name [arg ...]\n';

/** C's atoi: leading blanks, a sign, the digits there are; 0 without any. */
function atoi(text: string | undefined): number {
  const match = (text ?? '').match(/^\s*([+-]?\d+)/);

  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * The getopts builtin command.
 *
 * @example
 * while getopts ab: opt; do case $opt in a) … ;; b) echo "$OPTARG" ;; esac; done
 * shift $((OPTIND - 1))
 */
export const getoptsBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
): Promise<BuiltinResult> => {
  // getopts has no options of its own, but takes `--` and refuses the rest
  if (args[0] === '--') {
    args = args.slice(1);
  } else if (args[0]?.startsWith('-') && args[0].length > 1) {
    return { code: 2, stderr: `getopts: ${args[0].slice(0, 2)}: invalid option\n${USAGE}` };
  }

  if (args.length < 2) {
    return { code: 2, stderr: USAGE };
  }

  let [optstring, name] = args;
  const params = ctx.getParams();
  const env = ctx.getEnv();
  const variable = (key: string) => params[key] ?? env[key];

  // argv[0] is $0 either way: it names the script in the messages
  let argv: string[];

  if (args.length > 2) {
    argv = [params['0'] ?? '', ...args.slice(2)];
  } else {
    const count = Number.parseInt(params['#'] ?? '0', 10) || 0;

    argv = [params['0'] ?? '', ...Array.from({ length: count }, (_, i) => params[String(i + 1)] ?? '')];
  }

  // A leading `:` asks for silence and for the option character in OPTARG
  const silent = optstring.startsWith(':');

  if (silent) optstring = optstring.slice(1);

  const opterrText = variable('OPTERR');
  const opterr = !silent && (opterrText ? atoi(opterrText) : 1) !== 0;

  // What sh_optind would be: OPTIND as getopts left it, or as it was assigned,
  // where 1 and less than 0 mean from the start
  let state = ctx.getGetoptsState();
  let optind = atoi(variable('OPTIND'));

  if (!state && (optind < 0 || optind === 1 || !variable('OPTIND'))) optind = 0;

  let errors = '';

  /**
   * sh_getopt: the option character or '?' or ':', or null at the end; the
   * character it looked at; its argument, '' when one is missing, and null
   * for an option that takes none or is not one.
   */
  const next = (): { c: string | null; optopt: string; optarg: string | null } => {
    const end = { c: null, optopt: '', optarg: null };

    if (optind >= argv.length || optind < 0) {
      optind = argv.length;
      return end;
    }

    if (optind === 0) {
      optind = 1;
      state = undefined;
    }

    if (!state || state.charindex >= (argv[state.curopt] ?? '').length) {
      if (optind >= argv.length) return end;

      const arg = argv[optind];

      if (arg === '--') {
        optind++;
        return end;
      }

      if (!arg.startsWith('-') || arg === '-') return end;

      state = { curopt: optind, charindex: 1 };
    }

    const word = argv[state.curopt];
    const c = word[state.charindex];

    state = { ...state, charindex: state.charindex + 1 };

    // The last character of an argument moves OPTIND on to the next one
    if (state.charindex >= word.length) {
      optind++;
      state = undefined;
    }

    const at = optstring.indexOf(c);

    if (at === -1 || c === ':') {
      if (opterr) errors += `${argv[0]}: illegal option -- ${c}\n`;
      return { c: '?', optopt: c, optarg: null };
    }

    if (optstring[at + 1] !== ':') return { c, optopt: c, optarg: null };

    if (state) {
      // The rest of this argument is the option's argument
      const optarg = word.slice(state.charindex);

      optind++;
      state = undefined;
      return { c, optopt: c, optarg };
    }

    if (optind === argv.length) {
      if (opterr) errors += `${argv[0]}: option requires an argument -- ${c}\n`;
      return { c: silent ? ':' : '?', optopt: c, optarg: '' };
    }

    return { c, optopt: c, optarg: argv[optind++] };
  };

  const { c, optopt, optarg } = next();

  if (errors) {
    // bash prints these itself, without the script's line
    await shell.pipeWrite(ctx.getStderr(), errors).catch(() => {});
  }

  const messages: string[] = [];

  /** getopts_bind_variable: the name must be one, and not readonly. */
  const bindName = (value: string): number => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      messages.push(`getopts: \`${name}': not a valid identifier`);
      return 1;
    }

    if (ctx.isReadonlyVar(name)) {
      messages.push(`${name}: readonly variable`);
      return 2;
    }

    ctx.assignVariable(name, value);
    return 0;
  };

  const bindOptarg = (value: string) => {
    if (ctx.isReadonlyVar('OPTARG')) {
      messages.push('OPTARG: readonly variable');
    } else {
      ctx.assignVariable('OPTARG', value);
    }
  };

  // bash's unbind_variable_noref: no readonly check as `unset` makes, and
  // OPTARG itself even when it is a nameref, never what it refers to
  const unbindOptarg = () => {
    ctx.unsetVariable('OPTARG', { noref: true });
  };

  // OPTIND is set whatever happened, `--` skipped included; the state goes
  // after it, since assigning OPTIND clears the state
  ctx.assignVariable('OPTIND', String(optind));
  ctx.setGetoptsState(state);

  let code: number;

  if (c === null) {
    unbindOptarg();
    bindName('?');
    code = 1;
  } else if (c === '?' && optarg === null) {
    // An option that is not in the string
    code = bindName('?');
    if (silent) bindOptarg(optopt);
    else unbindOptarg();
  } else if ((c === '?' || c === ':') && optarg === '') {
    // An option without the argument it needs
    if (silent) {
      code = bindName(':');
      bindOptarg(optopt);
    } else {
      code = bindName('?');
      unbindOptarg();
    }
  } else {
    // An option without an argument leaves OPTARG declared and without a
    // value in bash; unset is as near as this gets
    if (optarg === null) unbindOptarg();
    else bindOptarg(optarg);
    code = bindName(c);
  }

  return { code, stderr: messages.map((message) => `${message}\n`).join('') };
};
