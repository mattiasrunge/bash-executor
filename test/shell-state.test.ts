import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('a tilde is expanded as the word runs, with HOME as it is then', async () => {
  const result = await run('HOME=/h1; echo ~ ~/a a=~:~/b; HOME=/h2; f() { echo ~; }; f; x=~/c:~; echo "$x" "~" \\~');

  assertEquals(result.stdout, '/h1 /h1/a a=/h1:/h1/b\n/h2\n/h2/c:/h2 ~ ~\n');
});

Deno.test('the directory stack: pushd, popd, dirs and DIRSTACK', async () => {
  const shell = new TestShell();

  // A directory is one a file is in
  shell.setFile('/usr/.keep', '');

  const result = await shell.runAndCapture(
    'HOME=/h; cd /; pushd /tmp >/dev/null; pushd /usr >/dev/null; dirs; dirs -v; dirs -l +1; echo "${DIRSTACK[@]}" ~1; popd +1 >/dev/null; dirs; DIRSTACK[1]=/x; dirs; popd -n >/dev/null; dirs; dirs -c; dirs; pushd; echo $?',
  );

  assertEquals(result.stdout, '/usr /tmp /\n 0  /usr\n 1  /tmp\n 2  /\n/tmp\n/usr /tmp / /tmp\n/usr /\n/usr /x\n/usr\n/usr\n1\n');
  assertEquals(result.stderr, 'pushd: no other directory\n');
});

Deno.test('ulimit keeps the limits per shell, a subshell its own copy', async () => {
  const result = await run('ulimit -n 256; ulimit -n; (ulimit -n 100; ulimit -n); ulimit -n; ulimit -Hn unlimited; echo $?');

  assertEquals(result.stdout, '256\n100\n256\n1\n');
  assertEquals(result.stderr, 'ulimit: open files: cannot modify limit: Operation not permitted\n');
});

Deno.test('a last line with no newline', async (t) => {
  await t.step('read assigns it and fails; mapfile adds no newline to it', async () => {
    const result = await run(`printf 'a\\nb' | while read l; do echo "[$l]"; done; printf 'x' | { read v; echo "$? $v"; }; printf 'p\\nq' | { mapfile y; declare -p y; }`);

    assertEquals(result.stdout, `[a]\n1 x\ndeclare -a y=([0]=$'p\\n' [1]="q")\n`);
  });
});

Deno.test('mapfile -C calls back every -c lines, and -O keeps the array', async () => {
  const result = await run(`printf '1\\n2\\n3\\n' | { mapfile -C 'echo cb' -c 2 a; declare -p a; }; b=(0 1 2 3 4); printf 'x\\n' | { mapfile -t -O 1 b; declare -p b; }`);

  assertEquals(result.stdout, `cb 1 2\n\ndeclare -a a=([0]=$'1\\n' [1]=$'2\\n' [2]=$'3\\n')\ndeclare -a b=([0]="0" [1]="x" [2]="2" [3]="3" [4]="4")\n`);
});

Deno.test('unset: a name that is none, and the @ subscript', async () => {
  const result = await run(
    `declare -A d=([k]=1); k='$(echo k)'; unset -v d[$k]; echo $?; a=(1 2 3); unset 'a[@]'; declare -p a; declare -A h=([@]=1 [x]=2); unset 'h[@]'; declare -p h`,
  );

  assertEquals(result.stdout, '1\ndeclare -a a=()\ndeclare -A h=([x]="2" )\n');
  assertEquals(result.stderr, "unset: `d[$(echo': not a valid identifier\nunset: `k)]': not a valid identifier\n");
});

Deno.test('LINENO of a command over several lines is the line it ends on', async () => {
  const result = await run('echo "a\nb" $LINENO; echo $LINENO \\\n x; echo $LINENO $(\necho y)');

  assertEquals(result.stdout, 'a\nb 2\n2 x\n3 y\n');
});
