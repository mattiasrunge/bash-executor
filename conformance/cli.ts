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
import { fromFileUrl } from '@std/path';
import { AstExecutor, BashSyntaxError, createBuiltinRegistry, DEFAULT_SHELL_OPTIONS, ExecContext, getExitCode, SHELL_OPTION_FLAG_MAP } from '../mod.ts';
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
    inv.name = rest[1] ?? 'bash';
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
  const self = selfCommand();

  Deno.env.set('BASH_TS_SCRIPT', inv.file ?? (inv.command !== undefined ? '-c' : 'stdin'));

  const shell = new RealShell({ selfCommand: self, name: () => inv.name, hostEnv });
  const executor = new AstExecutor(shell, { builtins: createBuiltinRegistry() });
  const ctx = new ExecContext();

  ctx.setCwd(Deno.cwd());
  ctx.setEnv(Object.fromEntries(Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith('BASH_TS_'))));

  const positional: Record<string, string> = { '0': inv.name, '#': String(inv.args.length) };

  inv.args.forEach((arg, n) => positional[String(n + 1)] = arg);
  ctx.setParams({
    ...positional,
    '$': String(Deno.pid),
    PPID: String(Deno.ppid),
    BASH: self.length === 1 ? self[0] : 'bash-ts',
    BASH_VERSION,
  });
  ctx.setArray('BASH_VERSINFO', ['5', '2', '21', '1', 'release', 'x86_64-pc-linux-gnu']);

  for (const [name, on] of Object.entries(inv.options)) {
    ctx.setShellOption(name, on);
  }

  let source: string;

  try {
    source = inv.command ?? (inv.file !== undefined ? await readScript(inv.file) : await new Response(Deno.stdin.readable).text());
  } catch (err) {
    const [message, code] = err instanceof Deno.errors.IsADirectory
      ? ['Is a directory', 126]
      : err instanceof BinaryScriptError
      ? ['cannot execute binary file', 126]
      : ['No such file or directory', 127];

    console.error(`${inv.name}: ${inv.file}: ${message}`);

    return code as number;
  }

  let code: number;

  try {
    code = getExitCode(await executor.execute(source, ctx));
  } catch (err) {
    if (err instanceof BashSyntaxError) {
      const line = err.location?.start?.row;

      logGap({ kind: 'syntax-error', name: firstLine(err.message) });
      console.error(`${inv.name}: ${Number.isFinite(line) ? `line ${line}: ` : ''}syntax error: ${firstLine(err.message)}`);

      code = 2;
    } else {
      const message = err instanceof Error ? err.message : String(err);

      logGap({ kind: 'exception', name: err instanceof Error ? err.constructor.name : 'unknown', detail: firstLine(message) });
      console.error(`${inv.name}: ${firstLine(message)}`);

      // For whoever is chasing the crash
      if (Deno.env.get('BASH_TS_STACK') && err instanceof Error) {
        console.error(err.stack);
      }

      code = 1;
    }
  }

  await shell.waitForBackground();

  return code & 0xff;
}

class BinaryScriptError extends Error {}

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
