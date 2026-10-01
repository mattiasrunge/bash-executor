import { assert, assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('associative arrays list their keys in bash hash-table order', async (t) => {
  await t.step('${!h[@]}, ${h[@]} and set agree', async () => {
    const result = await run('declare -A h=([one]=1 [two]=2 [three]=3 [four]=4); echo "${!h[@]}"; echo "${h[@]}"; set');

    assertEquals(result.stdout.split('\n').slice(0, 2), ['four two three one', '4 2 3 1']);
    assert(result.stdout.includes('\nh=([four]="4" [two]="2" [three]="3" [one]="1" )\n'));
  });

  await t.step('BASH_ALIASES keeps the alias table size', async () => {
    const result = await run('alias zz=a yy=b xx=c; echo "${!BASH_ALIASES[@]}"');

    assertEquals(result.stdout, 'zz xx yy\n');
  });
});

Deno.test('a ( … ) list on an associative array', async (t) => {
  await t.step('quoted, it is a string for element 0', async () => {
    const result = await run(`declare -A T; T='([a]=1)'; declare -p T`);

    assertEquals(result.stdout, 'declare -A T=([0]="([a]=1)" )\n');
  });

  await t.step('without [key]= it is keys and values in turn, each one word', async () => {
    const result = await run('declare -A f; v="s p"; f=(a 1 "$v" 2 z); declare -p f; declare -A g=(k v k2); declare -p g');

    assertEquals(result.stdout, 'declare -A f=([z]="" [a]="1" ["s p"]="2" )\ndeclare -A g=([k]="v" [k2]="" )\n');
  });

  await t.step('a key holding ] is the key, expanded or quoted', async () => {
    const result = await run('k="]"; declare -A h=([$k]=x ["a]b"]=y [\\]]+=z); declare -p h');

    assertEquals(result.stdout, 'declare -A h=(["]"]="z" ["a]b"]="y" )\n');
  });

  await t.step('[k]+=v adds to what k held before the list', async () => {
    const result = await run(
      'declare -A h=([a]=1); h=([a]+=2); declare -p h; h=([a]=5 [a]+=6); declare -p h; h+=([a]+=7); declare -p h; declare -A g=([b]=1 [b]+=2); declare -p g',
    );

    assertEquals(result.stdout, 'declare -A h=([a]="12" )\ndeclare -A h=([a]="126" )\ndeclare -A h=([a]="1267" )\ndeclare -A g=([b]="2" )\n');
  });
});

Deno.test('@K, @k and @A on a whole array', async () => {
  const result = await run(
    'a=(x "y z"); declare -A h=([k]=v); echo ${a[@]@K}; printf "<%s>" "${h[@]@k}"; echo; echo "${h[@]@A}"; printf "<%s>" "${a[@]@Q}"; echo; set -- "p q" r; echo "${*@A}"',
  );

  assertEquals(result.stdout, `0 "x" 1 "y z"\n<k><v>\ndeclare -A h=([k]="v" )\n<'x'><'y z'>\nset -- 'p q' 'r'\n`);
});

Deno.test('assoc_expand_once', async (t) => {
  await t.step('read and printf -v take a key as it stands only with it on', async () => {
    const result = await run(
      `declare -A a; b="80's"; read a[$b] <<< x; declare -p a; shopt -s assoc_expand_once; read a[$b] <<< y; declare -p a; printf -v a[$b] "%s" z; declare -p a`,
    );

    assertEquals(result.stdout, 'declare -A a\ndeclare -A a=(["80\'s"]="y" )\ndeclare -A a=(["80\'s"]="z" )\n');
    assertEquals(result.stderr, "read: `a[80's]': not a valid identifier\n");
  });

  await t.step('let reads a key to the first ]', async () => {
    const result = await run(`declare -A a; b="80's"; shopt -s assoc_expand_once; let "a[$b]+=2"; declare -p a`);

    assertEquals(result.stdout, 'declare -A a=(["80\'s"]="2" )\n');
  });

  await t.step('declare takes a key holding [', async () => {
    const result = await run('shopt -s assoc_expand_once; declare -A m; declare m["x[y"]=1; declare -p m');

    assertEquals(result.stdout, 'declare -A m=(["x[y"]="1" )\n');
  });
});

Deno.test('unset expands a subscript once more, unless written as name[sub]', async () => {
  const result = await run(
    `declare -A d=([q]=1 ["x y"]=2); k="x y"; unset d["$k"]; declare -p d; d[\\$k]=3; unset 'd[$k]'; declare -p d; a=(0 1 2 3); i=1; unset "a[i+1]"; declare -p a`,
  );

  assertEquals(result.stdout, 'declare -A d=([q]="1" )\ndeclare -A d=([q]="1" ["\\$k"]="3" )\ndeclare -a a=([0]="0" [1]="1" [3]="3")\n');
});

Deno.test('a subscript with an operator is expanded once', async () => {
  const result = await run('declare -A A; A[k]=v; echo "${A[$(echo k; echo once >&2)]%v}x"');

  assertEquals(result.stdout, 'x\n');
  assertEquals(result.stderr, 'once\n');
});

Deno.test('@ as an index is a bad subscript, and ends the line', async () => {
  const result = await run('declare -a ia; ia[@]=x; echo no\necho yes');

  assertEquals(result.stdout, 'yes\n');
  assertEquals(result.stderr, 'ia[@]: bad array subscript\n');
});
