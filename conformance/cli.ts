/**
 * `bash-ts`: a bash-compatible command line around bash-parser and
 * bash-executor, so bash's own test suite can use it as `THIS_SH`.
 *
 *   cli.ts [-abefhkmnptuvxBCHP] [-o option] [-O shopt] [--long-option…]
 *          (-c command [name [args…]] | file [args…] | < script)
 *
 * Whatever the executor cannot do is left for the conformance report to find:
 * syntax errors and uncaught exceptions are logged to `$BASH_TS_GAPLOG` as well
 * as printed, and so are options it has no counterpart for.
 */
import { dirname, fromFileUrl, join } from '@std/path';
import {
  AstExecutor,
  BashSyntaxError,
  createBuiltinRegistry,
  DEFAULT_SHELL_OPTIONS,
  DEFAULT_SHOPT_OPTIONS,
  ExecContext,
  getExitCode,
  logoutBuiltin,
  SHELL_OPTION_FLAG_MAP,
  SIGNALS,
  syntaxErrorLines,
} from '../mod.ts';
import { parse } from '@ein/bash-parser';
import { logGap, RealShell } from './host-shell.ts';

const BASH_VERSION = '5.2.21(1)-release';

/** Long options that only matter to an interactive or startup-file-reading bash. */
const IGNORED_LONG = new Set(['--norc', '--noprofile', '--noediting', '--login', '--debugger', '--dump-strings', '--wordexp']);

type Invocation = {
  options: Record<string, boolean>;
  command?: string;
  file?: string;
  name: string;
  args: string[];
};

function parseArgs(argv: string[]): Invocation {
  const inv: Invocation = { options: {}, name: 'bash', args: [] };
  let i = 0;
  let readCommand = false;

  const setOption = (name: string, on: boolean) => {
    if (name in DEFAULT_SHELL_OPTIONS) {
      inv.options[name] = on;
    } else {
      logGap({ kind: 'host-limit', name: `set -o ${name}` });
    }
  };

  for (; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--' || arg === '-') {
      i++;
      break;
    }

    if (arg.startsWith('--')) {
      if (arg === '--version') {
        console.log(`GNU bash, version ${BASH_VERSION} (bash-ts)`);
        Deno.exit(0);
      } else if (arg === '--posix') {
        setOption('posix', true);
      } else if (arg === '--rcfile' || arg === '--init-file') {
        i++;
      } else if (!IGNORED_LONG.has(arg)) {
        logGap({ kind: 'host-limit', name: arg });
      }
      continue;
    }

    if (!/^[-+]./.test(arg)) {
      break;
    }

    const on = arg[0] === '-';

    for (const letter of arg.slice(1)) {
      if (letter === 'c') {
        readCommand = true;
      } else if (letter === 'o' || letter === 'O') {
        const name = argv[++i];

        if (letter === 'o') {
          setOption(name, on);
        } else if (name in DEFAULT_SHOPT_OPTIONS) {
          // `-O globstar`: shopt's, which the context keeps with set's
          inv.options[name] = on;
        } else {
          logGap({ kind: 'host-limit', name: `shopt ${name}` });
        }
      } else if (letter in SHELL_OPTION_FLAG_MAP) {
        setOption(SHELL_OPTION_FLAG_MAP[letter], on);
      } else if (!'ils'.includes(letter)) {
        logGap({ kind: 'host-limit', name: `set -${letter}` });
      }
    }
  }

  const rest = argv.slice(i);

  if (readCommand) {
    inv.command = rest[0] ?? '';
    inv.name = rest[1] ?? Deno.env.get('BASH_TS_ARGV0') ?? 'bash';
    inv.args = rest.slice(2);
  } else if (rest.length > 0) {
    inv.file = rest[0];
    inv.name = rest[0];
    inv.args = rest.slice(1);
  }

  return inv;
}

/** How to start another copy of this shell: the wrapper when there is one, else deno on this file. */
function selfCommand(): string[] {
  const wrapper = Deno.env.get('BASH_TS_SELF');

  if (wrapper) {
    return [wrapper];
  }

  const config = fromFileUrl(new URL('../deno.jsonc', import.meta.url));

  return [Deno.execPath(), 'run', '-A', '--no-check', '--quiet', '--config', config, fromFileUrl(import.meta.url)];
}

/** fetch.sh's exec-as, beside the wrapper or this file, when it has been built. */
function execAsHelper(): string | undefined {
  const wrapper = Deno.env.get('BASH_TS_SELF');
  const helper = wrapper ? join(dirname(wrapper), '.cache', 'helpers', 'exec-as') : fromFileUrl(new URL('./.cache/helpers/exec-as', import.meta.url));

  try {
    return Deno.statSync(helper).isFile ? helper : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wrapper's and the runner's variables, taken out of the environment the
 * script sees (tests print theirs) and handed back to every process it starts,
 * so a nested bash-ts logs and finds itself the same way.
 */
function takeHostEnv(): Record<string, string> {
  if (Deno.env.has('BASH_TS_TMPDIR_SET')) {
    if (Deno.env.get('BASH_TS_TMPDIR_SET') === 'set') {
      Deno.env.set('TMPDIR', Deno.env.get('BASH_TS_TMPDIR') ?? '');
    } else {
      Deno.env.delete('TMPDIR');
    }

    Deno.env.delete('BASH_TS_TMPDIR');
    Deno.env.delete('BASH_TS_TMPDIR_SET');
  }

  const host: Record<string, string> = {};

  for (const name of ['BASH_TS_SELF', 'BASH_TS_GAPLOG', 'BASH_TS_TEST']) {
    const value = Deno.env.get(name);

    if (value !== undefined) {
      host[name] = value;
    }
  }

  return host;
}

async function main(): Promise<number> {
  const hostEnv = takeHostEnv();
  const inv = parseArgs(Deno.args);

  // Run as sh, bash starts in posix mode
  if ((Deno.env.get('BASH_TS_INVOKED') ?? '').split('/').pop() === 'sh' && !('posix' in inv.options)) inv.options.posix = true;
  const self = selfCommand();

  Deno.env.set('BASH_TS_SCRIPT', inv.file ?? (inv.command !== undefined ? '-c' : 'stdin'));

  const shell: RealShell = new RealShell({
    selfCommand: self,
    execAs: execAsHelper(),
    name: () => inv.name,
    hostEnv,
    // `kill -SIG $$`: the trap for it, or what the signal does by default —
    // most end the shell with 128 + the signal's number, EXIT trap first
    onSignal: async (signal) => {
      if (await executor.trapSignal(ctx, signal)) return;
      if (['0', 'CHLD', 'CONT', 'URG', 'WINCH'].includes(signal)) return;

      const number = SIGNALS.find(([, name]) => name === signal)?.[0] ?? 15;

      Deno.exit(await executor.runExitTrap(ctx, 128 + number));
    },
  });
  // bash's logout, which a host of its own leaves out of the default registry
  const builtins = createBuiltinRegistry();

  builtins.set('logout', logoutBuiltin);

  const executor = new AstExecutor(shell, { builtins, lineNumbers: true, unterminatedHereDocuments: 'end' });
  const ctx = new ExecContext();

  ctx.setCwd(Deno.cwd());
  ctx.setUmask(Deno.umask());
  ctx.setEnv(Object.fromEntries(Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith('BASH_TS_'))));
  await executor.importFunctions(ctx);

  const positional: Record<string, string> = { '0': inv.name, '#': String(inv.args.length) };

  inv.args.forEach((arg, n) => positional[String(n + 1)] = arg);
  ctx.setParams({
    ...positional,
    '$': String(Deno.pid),
    PPID: String(Deno.ppid),
    BASH: self.length === 1 ? self[0] : 'bash-ts',
    BASH_VERSION,
    OPTIND: '1',
    OPTERR: '1',
    // Set, as bash sets it at startup, whatever the environment says: `${IFS+x}` is x
    IFS: ' \t\n',
    UID: String(Deno.uid() ?? 0),
    EUID: String(Deno.uid() ?? 0),
  });
  ctx.setArray('BASH_VERSINFO', ['5', '2', '21', '1', 'release', 'x86_64-pc-linux-gnu']);

  // bash's own, which no script assigns
  for (const name of ['UID', 'EUID', 'PPID']) ctx.setReadonlyVar(name, true);

  for (const [name, on] of Object.entries(inv.options)) {
    ctx.setShellOption(name, on);
  }

  /** Run script text, starting at `line` of the script; a syntax error said as bash says it. */
  const run = async (source: string, line = 1): Promise<{ code: number; exited: boolean }> => {
    const exited = { value: false };

    try {
      const code = getExitCode(
        await executor.execute(source, ctx, {
          file: inv.command === undefined ? inv.file : undefined,
          command: inv.command !== undefined,
          line,
          exited,
          history: inv.command === undefined,
        }),
      );

      return { code, exited: exited.value };
    } catch (err) {
      if (err instanceof BashSyntaxError) {
        // The executor has run the complete commands before the error already
        // …and says it as bash does, a `-c` string naming itself so
        const { line: at, lines } = syntaxErrorLines(err, source);
        const prefix = `${inv.name}: ${inv.command !== undefined ? '-c: ' : ''}line ${at + line - 1}: `;

        logGap({ kind: 'syntax-error', name: firstLine(err.message) });

        for (const text of lines) console.error(prefix + text);

        return { code: 2, exited: true };
      }

      const message = err instanceof Error ? err.message : String(err);

      logGap({ kind: 'exception', name: err instanceof Error ? err.constructor.name : 'unknown', detail: firstLine(message) });
      console.error(`${inv.name}: ${firstLine(message)}`);

      // For whoever is chasing the crash
      if (Deno.env.get('BASH_TS_STACK') && err instanceof Error) {
        console.error(err.stack);
      }

      return { code: 1, exited: true };
    }
  };

  let code = 0;

  if (inv.command === undefined && inv.file === undefined) {
    // From stdin a command at a time, leaving the rest for what it runs to read
    for await (const { text, line } of stdinCommands()) {
      const result = await run(text, line);

      code = result.code;
      if (result.exited) break;
    }
  } else {
    let source: string;

    try {
      source = inv.command ?? await readScript(inv.file!);
    } catch (err) {
      const [message, status] = err instanceof Deno.errors.IsADirectory
        ? ['Is a directory', 126]
        : err instanceof BinaryScriptError
        ? ['cannot execute binary file', 126]
        : ['No such file or directory', 127];

      console.error(`${inv.name}: ${inv.file}: ${message}`);

      return status as number;
    }

    code = (await run(source)).code;
  }

  // The shell ends: its EXIT trap runs, and may change the status
  code = await executor.runExitTrap(ctx, code);

  // Its descriptors close as it exits, which a coprocess reading from one sees as the end of its input
  for (let fd = 0; fd < 256; fd++) {
    const target = ctx.getFd(String(fd));

    if (target !== undefined && shell.isPipe(target)) await shell.pipeClose(target);
  }

  await shell.waitForBackground();

  return code & 0xff;
}

class BinaryScriptError extends Error {}

/**
 * A script on stdin, as bash reads one: a byte at a time to the end of each
 * line, and handed on once what has been read is complete commands. Nothing
 * past them is read, so a command the script starts reads the lines after it.
 */
async function* stdinCommands(): AsyncGenerator<{ text: string; line: number }> {
  const byte = new Uint8Array(1);
  const decoder = new TextDecoder();
  let pending = '';
  let start = 1;
  let lines = 0;
  let eof = false;

  while (!eof) {
    const bytes: number[] = [];

    for (;;) {
      const n = await Deno.stdin.read(byte);

      if (n === null || n === 0) {
        eof = true;
        break;
      }

      bytes.push(byte[0]);
      if (byte[0] === 10) break;
    }

    if (bytes.length > 0) {
      pending += decoder.decode(Uint8Array.from(bytes));
      lines++;
    }

    if (pending === '' || (!eof && !(await complete(pending)))) continue;

    yield { text: pending, line: start };
    pending = '';
    start = lines + 1;
  }
}

/** Whether text parses as whole commands, rather than ending inside one. */
async function complete(text: string): Promise<boolean> {
  try {
    await parse(text);
    return true;
  } catch (err) {
    return !(err instanceof BashSyntaxError && (err.detail?.kind === 'eof' || err.detail?.kind === 'unclosed'));
  }
}

/** A script file, refused as bash refuses one: a NUL in its first line makes it binary. */
async function readScript(path: string): Promise<string> {
  if ((await Deno.stat(path)).isDirectory) {
    throw new Deno.errors.IsADirectory(path);
  }

  const bytes = await Deno.readFile(path);
  const firstLineEnd = bytes.indexOf(10);

  if (bytes.subarray(0, firstLineEnd === -1 ? 80 : firstLineEnd).includes(0)) {
    throw new BinaryScriptError(path);
  }

  return new TextDecoder().decode(bytes);
}

function firstLine(text: string): string {
  return text.split('\n')[0];
}

Deno.exit(await main());
