import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// The expected text is what bash 5.2 prints for the same definitions.

const DEFINITION = `f() {
\techo "a b" $( echo  1 ) >&2
\tif x; then y; elif z; then :; fi
\tfor i in 1 2; do echo $i; done | cat
\tcat <<EOF
body $x
EOF
\tv=$'\\t' w=([k]=v)
\t(( i < 3 )) && [[ -n $v ]] || case $v in a|b) ;; esac
} 2>&1
g() ( echo sub ) >/dev/null
`;

Deno.test('printing a function', async (t) => {
  await t.step('type prints it as bash does, quoting kept and $( ) reformatted', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`${DEFINITION}type f`);

    assertEquals(
      result.stdout,
      [
        'f is a function',
        'f () ',
        '{ ',
        '    echo "a b" $(echo 1) 1>&2;',
        '    if x; then',
        '        y;',
        '    else',
        '        if z; then',
        '            :;',
        '        fi;',
        '    fi;',
        '    for i in 1 2;',
        '    do',
        '        echo $i;',
        '    done | cat;',
        '    cat <<EOF',
        'body $x',
        'EOF',
        '',
        "    v='\t' w=([k]=v);",
        '    (( i < 3 )) && [[ -n $v ]] || case $v in ',
        '        a | b)',
        '',
        '        ;;',
        '    esac',
        '} 2>&1',
        '',
      ].join('\n'),
    );
  });

  await t.step('a body that is no group is printed whole, with its redirections', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`${DEFINITION}declare -f g`);

    assertEquals(result.stdout, 'g () \n{ \n    ( echo sub ) > /dev/null\n}\n');
  });

  await t.step('declare -F lists the names, exported ones marked', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`${DEFINITION}export -f g; declare -F; declare -F g nope; echo $?; declare -xF`);

    assertEquals(result.stdout, 'declare -f f\ndeclare -fx g\ng\n1\ndeclare -fx g\n');
  });
});

Deno.test('exported functions', async (t) => {
  await t.step('export -f puts the function in the environment, as bash names and writes it', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('f() { echo a; if x; then y; fi; }; export -f f');

    assertEquals(result.env['BASH_FUNC_f%%'], '() {  echo a;\n if x; then\n y;\n fi\n}');
  });

  await t.step('defining it again exports the new definition; unset -f takes it away', async () => {
    const shell = new TestShell();
    let result = await shell.runAndCapture('f() { echo a; }; export -f f; f() { echo b; }');

    assertEquals(result.env['BASH_FUNC_f%%'], '() {  echo b\n}');

    result = await shell.runAndCapture('unset -f f');
    assertEquals(result.env['BASH_FUNC_f%%'], undefined);
  });

  await t.step('what cannot be exported says so', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture("export -f nope; echo $?; function a=b { :; }; export -f 'a=b'; echo $?");

    assertEquals(result.stdout, '1\n1\n');
    assertEquals(result.stderr, 'export: nope: not a function\nexport: a=b: cannot export\n');
  });

  await t.step('a shell defines the functions its environment carries, and nothing more', async () => {
    const shell = new TestShell();

    shell.setEnv({
      'BASH_FUNC_f%%': '() {  echo imported\n}',
      'BASH_FUNC_bad%%': '() { :; }; echo BAD',
    });
    await shell.importFunctions();

    const result = await shell.runAndCapture('f; declare -F');

    assertEquals(result.stdout, 'imported\ndeclare -fx f\n');
  });
});

Deno.test('${var:=word} and ${var=word} assign', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('echo ${a:=one}; b=; : ${b=two}; : ${c=three}; : ${b:=four}; echo "$a [$b] $c"');

  assertEquals(result.stdout, 'one\none [four] three\n');
});
