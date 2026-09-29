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
