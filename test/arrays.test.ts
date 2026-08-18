import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

const run = async (script: string) => {
  const shell = new TestShell();
  const result = await shell.runAndCapture(script);

  return result;
};

Deno.test('Array assignment', async (t) => {
  await t.step('an array literal keeps one element per word', async () => {
    const result = await run('a=(1 2 3); echo "${a[@]}" "${#a[@]}"');
    assertEquals(result.stdout, '1 2 3 3\n');
  });

  await t.step('a quoted element keeps its blanks', async () => {
    const result = await run('a=(x "b c" d); for e in "${a[@]}"; do echo "[$e]"; done');
    assertEquals(result.stdout, '[x]\n[b c]\n[d]\n');
  });

  await t.step('an empty literal has no elements', async () => {
    const result = await run('a=(); echo "${#a[@]}"; for e in "${a[@]}"; do echo bad; done; echo done');
    assertEquals(result.stdout, '0\ndone\n');
  });

  await t.step('a quoted empty element is an element', async () => {
    const result = await run('a=("" x); echo "${#a[@]}"');
    assertEquals(result.stdout, '2\n');
  });

  await t.step('+= appends to the array', async () => {
    const result = await run('a=(x y); a+=(z); echo "${a[@]}"');
    assertEquals(result.stdout, 'x y z\n');
  });

  await t.step('an element can be assigned by index', async () => {
    const result = await run('a=(x y); a[1]=q; a[3]=r; echo "${a[@]}" "${#a[@]}"');
    assertEquals(result.stdout, 'x q r 3\n');
  });

  await t.step('+= on an element appends to that element', async () => {
    const result = await run('a=(x); a[0]+=y; echo "${a[0]}"');
    assertEquals(result.stdout, 'xy\n');
  });

  await t.step('an unquoted expansion in the literal is field split', async () => {
    const result = await run('V="p q"; a=($V); echo "${#a[@]}"');
    assertEquals(result.stdout, '2\n');
  });

  await t.step('a quoted expansion in the literal is one element', async () => {
    const result = await run('V="p q"; a=("$V"); echo "${#a[@]}"');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('the elements of a literal are words, not IFS fields', async () => {
    const result = await run('IFS=:; a=(x y); echo "${#a[@]}"');
    assertEquals(result.stdout, '2\n');
  });

  await t.step('a plain assignment writes element 0 and keeps the rest', async () => {
    const result = await run('a=(1 2); a=9; echo "${a[@]}"');
    assertEquals(result.stdout, '9 2\n');
  });
});

Deno.test('Array expansion', async (t) => {
  await t.step('${a[i]} takes one element', async () => {
    const result = await run('a=(x y z); echo "${a[1]}"');
    assertEquals(result.stdout, 'y\n');
  });

  await t.step('a negative index counts from the end', async () => {
    const result = await run('a=(x y z); echo "${a[-1]}"');
    assertEquals(result.stdout, 'z\n');
  });

  await t.step('the subscript is an arithmetic expression', async () => {
    const result = await run('a=(x y z); i=1; echo "${a[$i]}${a[i]}${a[i+1]}"');
    assertEquals(result.stdout, 'yyz\n');
  });

  await t.step('$a is the first element', async () => {
    const result = await run('a=(x y); echo "$a"');
    assertEquals(result.stdout, 'x\n');
  });

  await t.step('"${a[@]}" is one field per element', async () => {
    const shell = new TestShell();
    let seen: string[] = [];
    shell.mockCommand('args', async (_ctx, args) => {
      seen = args;
      return { code: 0 };
    });

    await shell.runAndCapture('a=(x "b c" d); args "${a[@]}"');
    assertEquals(seen, ['x', 'b c', 'd']);
  });

  await t.step('an unquoted ${a[@]} is field split again', async () => {
    const shell = new TestShell();
    let seen: string[] = [];
    shell.mockCommand('args', async (_ctx, args) => {
      seen = args;
      return { code: 0 };
    });

    await shell.runAndCapture('a=(x "b c"); args ${a[@]}');
    assertEquals(seen, ['x', 'b', 'c']);
  });

  await t.step('an empty array in a word of its own passes no argument', async () => {
    const shell = new TestShell();
    let seen: string[] = [];
    shell.mockCommand('args', async (_ctx, args) => {
      seen = args;
      return { code: 0 };
    });

    await shell.runAndCapture('a=(); args "${a[@]}"');
    assertEquals(seen, []);
  });

  await t.step('${a[*]} joins on the first character of IFS', async () => {
    const result = await run('a=(x y); echo "${a[*]}"; IFS=:; echo "${a[*]}"');
    assertEquals(result.stdout, 'x y\nx:y\n');
  });

  await t.step('${!a[@]} is the indices that are set', async () => {
    const result = await run('a=(x y); a[5]=z; echo "${!a[@]}"');
    assertEquals(result.stdout, '0 1 5\n');
  });

  await t.step('a prefix and suffix stay attached to the outer elements', async () => {
    const shell = new TestShell();
    let seen: string[] = [];
    shell.mockCommand('args', async (_ctx, args) => {
      seen = args;
      return { code: 0 };
    });

    await shell.runAndCapture('a=(1 2 3); args "pre${a[@]}post"');
    assertEquals(seen, ['pre1', '2', '3post']);
  });

  await t.step('operators work on one element', async () => {
    const result = await run('a=(one.jpg); echo "${a[0]%.jpg}" "${#a[0]}" "${a[9]:-fallback}"');
    assertEquals(result.stdout, 'one 7 fallback\n');
  });

  await t.step('a scalar behaves like a one-element array', async () => {
    const result = await run('x=5; echo "${x[0]} ${#x[@]}"');
    assertEquals(result.stdout, '5 1\n');
  });

  await t.step('an unset array expands to nothing', async () => {
    const result = await run('echo "[${nothing[@]}][${#nothing[@]}]"');
    assertEquals(result.stdout, '[][0]\n');
  });
});

Deno.test('Array builtins', async (t) => {
  await t.step('unset removes the whole array', async () => {
    const result = await run('a=(1 2); unset a; echo "${#a[@]}"');
    assertEquals(result.stdout, '0\n');
  });

  await t.step('unset removes one element and leaves a hole', async () => {
    const result = await run('a=(1 2 3); unset "a[1]"; echo "${a[@]} / ${!a[@]}"');
    assertEquals(result.stdout, '1 3 / 0 2\n');
  });

  await t.step('declare -a makes an empty array', async () => {
    const result = await run('declare -a a; echo "${#a[@]}"; a+=(q); echo "${a[@]}"');
    assertEquals(result.stdout, '0\nq\n');
  });

  await t.step('declare -a takes a literal', async () => {
    const result = await run('declare -a a=(1 2); echo "${a[@]}"');
    assertEquals(result.stdout, '1 2\n');
  });

  await t.step('declare -p prints an array', async () => {
    const result = await run('a=(1 2); declare -p a');
    assertEquals(result.stdout, 'declare -a a=([0]="1" [1]="2")\n');
  });

  await t.step('local keeps an array inside the function', async () => {
    const result = await run('f() { local -a a=(x y); echo "${#a[@]}"; }; a=(1 2 3); f; echo "${#a[@]}"');
    assertEquals(result.stdout, '2\n3\n');
  });

  await t.step('a declaration command does not field split its argument', async () => {
    const result = await run('V="a b"; declare x=$V; echo "[$x]"');
    assertEquals(result.stdout, '[a b]\n');
  });

  await t.step('read -a fills an array', async () => {
    const result = await run('echo "x y z" | { read -a a; echo "${#a[@]} ${a[2]}"; }');
    assertEquals(result.stdout, '3 z\n');
  });

  await t.step('mapfile -t reads one element per line, blanks and all', async () => {
    const result = await run('printf "one file\\ntwo file\\n" | { mapfile -t a; echo "${#a[@]} [${a[1]}]"; }');
    assertEquals(result.stdout, '2 [two file]\n');
  });

  await t.step('mapfile keeps the delimiter without -t', async () => {
    const result = await run('printf "a\\nb\\n" | { mapfile a; echo "[${a[0]}]"; }');
    assertEquals(result.stdout, '[a\n]\n');
  });

  await t.step('readarray is the same builtin', async () => {
    const result = await run('printf "a\\nb\\n" | { readarray -t a; echo "${#a[@]}"; }');
    assertEquals(result.stdout, '2\n');
  });

  await t.step('mapfile -s skips and -n limits', async () => {
    const result = await run('printf "1\\n2\\n3\\n4\\n" | { mapfile -t -s 1 -n 2 a; echo "${a[@]}"; }');
    assertEquals(result.stdout, '2 3\n');
  });

  await t.step('BASH_REMATCH is an array', async () => {
    const result = await run('[[ "a1" =~ ([a-z])([0-9]) ]] && echo "${BASH_REMATCH[0]}/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"');
    assertEquals(result.stdout, 'a1/a/1\n');
  });
});

Deno.test('Arrays and subshells', async (t) => {
  await t.step('a subshell cannot change the caller array', async () => {
    const result = await run('a=(1 2); (a+=(3); echo "sub=${#a[@]}"); echo "outer=${#a[@]}"');
    assertEquals(result.stdout, 'sub=3\nouter=2\n');
  });

  await t.step('an array is visible in a command substitution', async () => {
    const result = await run('a=(x y); echo "$(echo "${a[1]}")"');
    assertEquals(result.stdout, 'y\n');
  });
});

Deno.test('Associative arrays', async (t) => {
  await t.step('declare -A makes the subscripts keys', async () => {
    const result = await run('declare -A m; m[one]=1; m[two]=2; echo "${m[one]} ${m[two]} ${#m[@]}"');
    assertEquals(result.stdout, '1 2 2\n');
  });

  await t.step('a key can hold blanks', async () => {
    const result = await run('declare -A m; m["two words"]=v; echo "[${m[two words]}]"');
    assertEquals(result.stdout, '[v]\n');
  });

  await t.step('a key can come from a variable', async () => {
    const result = await run('declare -A m; m[x]=1; k=x; echo "${m[$k]}"');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('${!m[@]} is the keys and ${m[@]} the values', async () => {
    const result = await run('declare -A m; m[a]=1; m[b]=2; echo "${!m[@]} / ${m[@]}"');
    assertEquals(result.stdout, 'a b / 1 2\n');
  });

  await t.step('a literal takes [key]=value elements', async () => {
    const result = await run('declare -A m=([k]=v [j]="w x"); echo "${m[k]}/${m[j]}/${#m[@]}"');
    assertEquals(result.stdout, 'v/w x/2\n');
  });

  await t.step('unset removes one key', async () => {
    const result = await run('declare -A m; m[a]=1; m[b]=2; unset "m[a]"; echo "${!m[@]} ${#m[@]}"');
    assertEquals(result.stdout, 'b 1\n');
  });

  await t.step('declare -p prints it as an associative array', async () => {
    const result = await run('declare -A m; m[a]=1; declare -p m');
    assertEquals(result.stdout, 'declare -A m=([a]="1")\n');
  });

  await t.step('local -A keeps it inside the function', async () => {
    const result = await run('f() { local -A m; m[k]=v; echo "${m[k]}"; }; f; echo "outside=${#m[@]}"');
    assertEquals(result.stdout, 'v\noutside=0\n');
  });

  await t.step('a missing key is unset, so the default applies', async () => {
    const result = await run('declare -A m; echo "${m[nope]:-fallback}"');
    assertEquals(result.stdout, 'fallback\n');
  });

  await t.step('an indexed array takes [index]=value elements too', async () => {
    const result = await run('a=([2]=x [0]=y); echo "${!a[@]} / ${a[2]}"');
    assertEquals(result.stdout, '0 2 / x\n');
  });
});

Deno.test('Operators over a whole array', async (t) => {
  await t.step('a suffix is stripped from each element', async () => {
    const result = await run('a=(one.jpg "two three.jpg"); for e in "${a[@]%.jpg}"; do echo "[$e]"; done');
    assertEquals(result.stdout, '[one]\n[two three]\n');
  });

  await t.step('a prefix and a replacement distribute too', async () => {
    const result = await run('a=(x/1 x/2); echo "${a[@]#x/}"; b=(ab cd); echo "${b[@]/b/B}"');
    assertEquals(result.stdout, '1 2\naB cd\n');
  });

  await t.step('case conversion distributes', async () => {
    const result = await run('a=(abc def); echo "${a[@]^^}"; echo "${a[0]^}"');
    assertEquals(result.stdout, 'ABC DEF\nAbc\n');
  });

  await t.step('a slice takes elements, not characters', async () => {
    const result = await run('a=(1 2 3 4); echo "${a[@]:1:2}"; echo "${a[@]:2}"');
    assertEquals(result.stdout, '2 3\n3 4\n');
  });

  await t.step('the positional parameters work the same way', async () => {
    const result = await run('set -- a.x b.x; echo "${@%.x}"; echo "${@:2}"');
    assertEquals(result.stdout, 'a b\nb.x\n');
  });

  await t.step('${#a[@]} is still the count', async () => {
    const result = await run('a=(one.jpg two.jpg); echo "${#a[@]}"');
    assertEquals(result.stdout, '2\n');
  });
});

Deno.test('Prefix element assignment', async (t) => {
  await t.step('is scoped to the command, like any prefix assignment', async () => {
    const shell = new TestShell();
    shell.mockCommand('show', async (ctx) => ({ code: 0, stdout: `inside=${(ctx.getArray('a') ?? []).join(' ')}\n` }));

    const result = await shell.runAndCapture('a=(1 2); a[0]=x show; echo "after=${a[@]}"');
    assertEquals(result.stdout, 'inside=x 2\nafter=1 2\n');
  });
});
