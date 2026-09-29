import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script, bar the `bash: line N: ` before each message
const run = async (script: string) => await new TestShell().runAndCapture(script);

const cases: Array<[string, string, string]> = [
  ['exec -i x; echo $?', '2\n', 'exec: -i: invalid option\nexec: usage: exec [-cl] [-a name] [command [argument ...]] [redirection ...]\n'],
  ['return 1; echo $?', '2\n', "return: can only `return' from a function or sourced script\n"],
  [
    'f() { :; }; readonly -f f; f() { echo new; }; unset -f f; declare -f +r f; declare -Fr',
    'declare -fr f\n',
    'f: readonly function\nunset: f: cannot unset: readonly function\ndeclare: f: readonly function\n',
  ],
  ['unset -f -v x; echo $?', '1\n', 'unset: cannot simultaneously unset a function and a variable\n'],
  ['logout; echo $?', '1\n', "logout: not login shell: use `exit'\n"],
  ['set +h; hash; echo $?', '1\n', 'hash: hashing disabled\n'],
  ['set -q; echo $?', '2\n', 'set: -q: invalid option\nset: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]\n'],
  ['shopt -s -u extglob; echo $?', '1\n', 'shopt: cannot set and unset shell options simultaneously\n'],
  ['read -t x v; echo $?', '1\n', 'read: x: invalid timeout specification\n'],
  ['eval -i x; echo $?', '2\n', 'eval: -i: invalid option\neval: usage: eval [arg ...]\n'],
  ['trap -s INT; echo $?', '2\n', 'trap: -s: invalid option\ntrap: usage: trap [-lp] [[arg] signal_spec ...]\n'],
  ['echo ${$x}\necho next', 'next\n', '${$x}: bad substitution\n'],
  ['echo ran < nope.txt; echo $?', '1\n', 'nope.txt: No such file or directory\n'],
  ['exit 3 || echo not', '', ''],
];

Deno.test('builtins refuse as bash refuses, and the script goes on', async (t) => {
  for (const [script, stdout, stderr] of cases) {
    await t.step(script, async () => {
      const result = await run(script);

      assertEquals([result.stdout, result.stderr], [stdout, stderr]);
    });
  }
});
