import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('subscripts in arithmetic are expanded once, and keep what they expand to', async (t) => {
  await t.step('a key holding ] and $( ) is the key it is, and runs nothing', async () => {
    const result = await run(`declare -A A; key='x],b[$(echo uname >&2)'; (( A[$key]++ )); (( A['$key']++ )); (( A["$key"]++ )); declare -p A`);

    assertEquals(result.stdout, 'declare -A A=(["\\$key"]="1" ["x],b[\\$(echo uname >&2)"]="2" )\n');
    assertEquals(result.stderr, '');
  });

  await t.step('the expression is the text as written: a quoted one is no expression', async () => {
    const result = await run(`declare -A A; (( 'A[k]++' ))`);

    assertEquals(result.stderr, `((: 'A[k]++' : syntax error: operand expected (error token is "'A[k]++' ")\n`);
  });

  await t.step('an index that is no expression is said without the command, as bash says it', async () => {
    const result = await run('a=(1 2); key="x],b"; echo $(( a[$key] ))\ni=1; echo $(( a[i] + a[$i] + a["$i"] + a[i-1] ))');

    assertEquals(result.stdout, '7\n');
    assertEquals(result.stderr, 'x\\],b: syntax error: invalid arithmetic operator (error token is "\\],b")\n');
  });

  await t.step('a character that is no operator is an error where it stands', async () => {
    const result = await run('(( 1 ] 2 )); (( ] ))');

    assertEquals(
      result.stderr,
      '((: 1 ] 2 : syntax error: invalid arithmetic operator (error token is "] 2 ")\n((: ] : syntax error: operand expected (error token is "] ")\n',
    );
  });

  await t.step('let and local -i expand their subscripts too', async () => {
    const result = await run('a=(); i=2; let "a[$i]=5" \'a[$i+1]=6\'; declare -A h; let "h[\\" \\"]=11"; declare -p a h; f() { local -i n="a[\\$i]+1"; echo $n; }; f');

    assertEquals(result.stdout, 'declare -a a=([2]="5" [3]="6")\ndeclare -A h=([" "]="11" )\n6\n');
  });
});

Deno.test('an assignment subscript runs to its own ], and the value is what follows it', async (t) => {
  await t.step('keys holding = and ], quoted or escaped', async () => {
    const result = await run(`declare -A s; p="a=b"; s[$p]=1; k="]"; s[$k]=2; s["x y"]=3; s[\\]]=4; s[']']+=5; declare -p s`);

    assertEquals(result.stdout, 'declare -A s=(["]"]="45" [a=b]="1" ["x y"]="3" )\n');
  });

  await t.step('an index that is no expression ends the line', async () => {
    const result = await run('key="x],b"; a[$key]=42; echo not here\necho next');

    assertEquals(result.stdout, 'next\n');
    assertEquals(result.stderr, 'x],b: syntax error: invalid arithmetic operator (error token is "],b")\n');
  });
});
