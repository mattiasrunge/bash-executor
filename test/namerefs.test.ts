import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('name references', async (t) => {
  await t.step('a nameref reads and assigns what it refers to; declare -p shows the reference', async () => {
    const result = await run('bar=one; declare -n ref=bar; echo $ref; ref=two; echo $bar; declare -p ref');

    assertEquals(result.stdout, 'one\ntwo\ndeclare -n ref="bar"\n');
  });

  await t.step("local -n in a function assigns the caller's variable", async () => {
    assertEquals((await run('bar=x; f() { local -n v=$1; v="set by f"; }; f bar; echo $bar')).stdout, 'set by f\n');
  });

  await t.step('a reference to an element reads and assigns that element', async () => {
    assertEquals((await run('x=(zero one two); declare -n el=\'x[1]\'; el=ONE; echo "${x[@]}" $el')).stdout, 'zero ONE two ONE\n');
  });

  await t.step('as the loop variable it refers to each word in turn', async () => {
    assertEquals((await run('x=(zero); bar=b; declare -n ref; for ref in x bar; do echo "${!ref}=$ref"; done')).stdout, 'x=zero\nbar=b\n');
  });

  await t.step('one with no value takes the name assigned; unset -n removes the reference, unset the referent', async () => {
    const result = await run('declare -n r; r=target; declare -p r; unset -n r; declare -p r; bar=1; declare -n q=bar; unset q; echo "${bar-unset}"');

    assertEquals(result.stdout, 'declare -n r="target"\nunset\n');
    assertEquals(result.stderr, 'declare: r: not found\n');
  });

  await t.step('a reference to itself is refused', async () => {
    const result = await run('declare -n self=self; echo $?');

    assertEquals(result.stdout, '1\n');
    assertEquals(result.stderr, 'declare: self: nameref variable self references not allowed\n');
  });
});

Deno.test('indirect expansion', async (t) => {
  await t.step('${!name} expands the variable name holds, operators and all', async () => {
    assertEquals((await run('a=v; v=val; echo ${!a} ${!a/l/L}; x="arr[1]"; arr=(p q); echo ${!x}; set -- one two; n=2; echo ${!n}')).stdout, 'val vaL\nq\ntwo\n');
  });

  await t.step('${!prefix*} lists the names that begin with it', async () => {
    assertEquals((await run('a=v; ab=1; echo ${!a*}; for n in "${!a@}"; do echo "<$n>"; done')).stdout, 'a ab\n<a>\n<ab>\n');
  });

  await t.step('an unset or unusable name is an error that ends the line', async () => {
    const result = await run('unset x; echo ${!x}; echo same line\necho next; y="a b"; echo ${!y}');

    assertEquals(result.stdout, 'next\n');
    assertEquals(result.stderr, 'x: invalid indirect expansion\na b: invalid variable name\n');
  });
});

Deno.test('circular name references', async (t) => {
  await t.step("a function's reference to its own name warns, and reads and assigns the shell's variable", async () => {
    const result = await run('f() { typeset -n v=$1; v+=X; echo "in $v"; }; v=g; f v; echo $v');

    assertEquals(result.stdout, 'in gX\ngX\n');
    assertEquals(
      result.stderr,
      'typeset: warning: v: circular name reference\nwarning: v: circular name reference\nwarning: v: circular name reference\nwarning: v: circular name reference\n',
    );
  });

  await t.step('a chain round at the top level has no value, and assigning it ends the line', async () => {
    const result = await run('declare -n v=w w=x x=v; echo "[$x]"; x=4; echo not here\necho next');

    assertEquals(result.stdout, '[]\nnext\n');
    assertEquals(result.stderr, 'warning: x: circular name reference\nwarning: x: circular name reference\n');
  });

  await t.step("a function's reference to its own element cannot be assigned", async () => {
    const result = await run("f() { local -n a=$1; a=X; }; a=(0); f 'a[0]'; echo not here\ndeclare -p a");

    assertEquals(result.stdout, 'declare -a a=([0]="0")\n');
    assertEquals(result.stderr.split('\n').slice(2).join('\n'), "`a[0]': not a valid identifier\n");
  });

  await t.step('ref+= adds to the name a reference holds, and may not make it its own', async () => {
    const result = await run('typeset -n ref=re ref+=f; declare -n r=var r+=[@]; declare -p ref r; r=1; echo not here');

    assertEquals(result.stdout, 'declare -n ref="re"\ndeclare -n r="var[@]"\n');
    assertEquals(result.stderr, 'ref: nameref variable self references not allowed\nvar[@]: bad array subscript\n');
  });

  await t.step('an element assigned to a reference makes it an array', async () => {
    const result = await run('declare -n x=array; declare -a x[1]=one; declare -n a=b b=a[1]; a=foo; declare -p x a');

    assertEquals(result.stdout, 'declare -a x=([1]="one")\ndeclare -a a=([1]="foo")\n');
    assertEquals(result.stderr, 'warning: x: removing nameref attribute\nwarning: a: removing nameref attribute\n');
  });
});

Deno.test('[[ -v ]] on arrays is about the element named, 0 when none is', async () => {
  const result = await run('a=(0); b=([1]=x); declare -A h=([k]=v); for t in a "a[0]" "a[1]" b "b[@]" "h[k]" h; do [[ -v $t ]] && echo "$t"; done; echo "${b-unset}"');

  assertEquals(result.stdout, 'a\na[0]\nb[@]\nh[k]\nunset\n');
});
