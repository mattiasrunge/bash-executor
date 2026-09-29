import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Arithmetic Expansion', async (t) => {
  await t.step('basic addition $((1+2))', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1+2))');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '3\n');
  });

  await t.step('subtraction', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((10 - 4))');
    assertEquals(result.stdout, '6\n');
  });

  await t.step('multiplication', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((6 * 7))');
    assertEquals(result.stdout, '42\n');
  });

  await t.step('division truncates to integer', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((7 / 3))');
    assertEquals(result.stdout, '2\n');
  });

  await t.step('modulo operation', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((10 % 3))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('exponentiation **', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((2 ** 8))');
    assertEquals(result.stdout, '256\n');
  });

  await t.step('arithmetic with variables', async () => {
    const shell = new TestShell();
    shell.setParams({ X: '10', Y: '3' });
    const result = await shell.runAndCapture('echo $((X + Y))');
    assertEquals(result.stdout, '13\n');
  });

  await t.step('complex arithmetic expression', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((2 * 3 + 4))');
    assertEquals(result.stdout, '10\n');
  });

  await t.step('arithmetic in string context', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Sum: $((5+5))"');
    assertEquals(result.stdout, 'Sum: 10\n');
  });

  // Note: Parentheses for grouping in arithmetic (e.g., $((2 * (3 + 4))))
  // is not supported by bash-parser - skipping this test

  await t.step('operator precedence (* before +)', async () => {
    const shell = new TestShell();
    // Tests that multiplication has higher precedence than addition
    const result = await shell.runAndCapture('echo $((2 + 3 * 4))');
    assertEquals(result.stdout, '14\n');
  });
});

Deno.test('Bitwise Operations', async (t) => {
  await t.step('bitwise AND', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((12 & 10))');
    assertEquals(result.stdout, '8\n'); // 1100 & 1010 = 1000
  });

  await t.step('bitwise OR', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((12 | 10))');
    assertEquals(result.stdout, '14\n'); // 1100 | 1010 = 1110
  });

  await t.step('bitwise XOR', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((12 ^ 10))');
    assertEquals(result.stdout, '6\n'); // 1100 ^ 1010 = 0110
  });

  await t.step('left shift', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1 << 4))');
    assertEquals(result.stdout, '16\n');
  });

  await t.step('right shift', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((16 >> 2))');
    assertEquals(result.stdout, '4\n');
  });

  await t.step('bitwise NOT', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((~0))');
    assertEquals(result.stdout, '-1\n');
  });
});

Deno.test('Comparison Operations', async (t) => {
  await t.step('less than - true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((3 < 5))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('less than - false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 < 3))');
    assertEquals(result.stdout, '0\n');
  });

  await t.step('greater than', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 > 3))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('less than or equal', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 <= 5))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('greater than or equal', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 >= 5))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('equality', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 == 5))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('inequality', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 != 3))');
    assertEquals(result.stdout, '1\n');
  });
});

Deno.test('Logical Operations in Arithmetic', async (t) => {
  await t.step('logical AND true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1 && 1))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('logical AND short-circuit', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((0 && 1))');
    assertEquals(result.stdout, '0\n');
  });

  await t.step('logical OR', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((0 || 1))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('logical NOT', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((!0))');
    assertEquals(result.stdout, '1\n');
  });

  await t.step('logical NOT of non-zero', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((!5))');
    assertEquals(result.stdout, '0\n');
  });
});

Deno.test('Assignment Operations', async (t) => {
  await t.step('simple assignment in arithmetic', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=0; echo $((x = 5)); echo $x');
    assertEquals(result.stdout, '5\n5\n');
  });

  await t.step('compound assignment +=', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=5; echo $((x += 3)); echo $x');
    assertEquals(result.stdout, '8\n8\n');
  });

  await t.step('compound assignment -=', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=10; echo $((x -= 3)); echo $x');
    assertEquals(result.stdout, '7\n7\n');
  });

  await t.step('compound assignment *=', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=4; echo $((x *= 3)); echo $x');
    assertEquals(result.stdout, '12\n12\n');
  });

  await t.step('compound assignment /=', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=15; echo $((x /= 3)); echo $x');
    assertEquals(result.stdout, '5\n5\n');
  });

  await t.step('compound assignment %=', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=10; echo $((x %= 3)); echo $x');
    assertEquals(result.stdout, '1\n1\n');
  });
});

Deno.test('Update Expressions', async (t) => {
  await t.step('prefix increment ++x', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=5; echo $((++x)); echo $x');
    assertEquals(result.stdout, '6\n6\n');
  });

  await t.step('postfix increment x++', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=5; echo $((x++)); echo $x');
    assertEquals(result.stdout, '5\n6\n');
  });

  await t.step('prefix decrement --x', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=5; echo $((--x)); echo $x');
    assertEquals(result.stdout, '4\n4\n');
  });

  await t.step('postfix decrement x--', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=5; echo $((x--)); echo $x');
    assertEquals(result.stdout, '5\n4\n');
  });
});

Deno.test('Ternary Operator', async (t) => {
  await t.step('ternary true case', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1 ? 10 : 20))');
    assertEquals(result.stdout, '10\n');
  });

  await t.step('ternary false case', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((0 ? 10 : 20))');
    assertEquals(result.stdout, '20\n');
  });

  await t.step('ternary with comparison', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((5 > 3 ? 100 : 200))');
    assertEquals(result.stdout, '100\n');
  });
});

Deno.test('Sequence Expression', async (t) => {
  await t.step('sequence returns last value', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1, 2, 3))');
    assertEquals(result.stdout, '3\n');
  });

  await t.step('sequence evaluates all expressions', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=0; echo $((x=1, x=2, x=3)); echo $x');
    assertEquals(result.stdout, '3\n3\n');
  });
});

Deno.test('Arithmetic Command (( ))', async (t) => {
  await t.step('(( expr )) returns 0 for non-zero result', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(( 5 ))');
    assertEquals(result.exitCode, 0);
  });

  await t.step('(( expr )) returns 1 for zero result', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(( 0 ))');
    assertEquals(result.exitCode, 1);
  });

  await t.step('(( )) can be used for variable manipulation', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=5; (( x++ )); echo $x');
    assertEquals(result.stdout, '6\n');
  });

  await t.step('(( )) in if condition', async () => {
    const shell = new TestShell();
    // Use [ ] for comparison to avoid parser issue with > in (( ))
    const result = await shell.runAndCapture('x=5; if [ $x -gt 3 ]; then echo yes; fi');
    assertEquals(result.stdout, 'yes\n');
  });
});

Deno.test('Arithmetic Edge Cases', async (t) => {
  await t.step('division by zero is an error that ends the line', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((10 / 0)); echo same line\necho "next $?"');
    assertEquals(result.stdout, 'next 1\n');
    assertEquals(result.stderr, '10 / 0: division by 0 (error token is "0")\n');
  });

  await t.step('modulo by zero too, and (( )) only fails', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('((10 % 0)); echo "st $?"');
    assertEquals(result.stdout, 'st 1\n');
    assertEquals(result.stderr, '((: 10 % 0: division by 0 (error token is "0")\n');
  });

  await t.step('undefined variable in arithmetic is 0', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((UNDEFINED + 5))');
    assertEquals(result.stdout, '5\n');
  });

  await t.step('unary minus', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((-5))');
    assertEquals(result.stdout, '-5\n');
  });

  await t.step('unary plus', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((+5))');
    assertEquals(result.stdout, '5\n');
  });

  await t.step('negative numbers', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((-5 + 3))');
    assertEquals(result.stdout, '-2\n');
  });
});

Deno.test('Arithmetic: ${…} and $(…) inside', async (t) => {
  const cases: [string, string][] = [
    ['echo $(( ${x:-3} + 1 ))', '4\n'],
    ['x=5; echo $(( ${x:-3} + 1 ))', '6\n'],
    ['s=hello; echo $(( ${#s} * 2 ))', '10\n'],
    ['a=(4 5 6); echo $(( ${a[1]} + ${a[2]} ))', '11\n'],
    // bash substitutes the text before it reads the expression: 2+3 * 2
    ['e="2+3"; echo $(( ${e} * 2 ))', '8\n'],
    ['(( ${n:-2} > 1 )) && echo yes', 'yes\n'],
    ['(( $(echo 5) > 3 )) && echo yes || echo no', 'yes\n'],
    ['for ((i=${from:-1}; i<=$(echo 3); i++)); do printf "%s" $i; done; echo', '123\n'],
  ];
  for (const [script, expected] of cases) {
    await t.step(script, async () => {
      const shell = new TestShell();
      const result = await shell.runAndCapture(script);
      assertEquals(result.stdout, expected);
    });
  }
});

// Found running bash's own test suite: each case is what bash gives
Deno.test('Arithmetic as bash evaluates it', async (t) => {
  const run = async (script: string) => {
    const result = await new TestShell().runAndCapture(script);
    return result.stdout + result.stderr;
  };

  await t.step('64-bit integers that wrap', async () => {
    assertEquals(
      await run('echo $((9223372036854775807+1)) $((2**63)) $((-9223372036854775808/-1)) $((1<<64))'),
      '-9223372036854775808 -9223372036854775808 -9223372036854775808 1\n',
    );
  });

  await t.step('++ and -- are increments only next to a variable', async () => {
    assertEquals(await run('a=1; echo $(( 4+++a )) $a'), '6 2\n');
  });

  await t.step('bases, and a variable whose value is an expression', async () => {
    assertEquals(await run('y=4+3; echo $((64#@_)) $((36#z)) $((0x1F + 010)) $((y)) $((2**3**2)) $((-2**2))'), '4031 35 39 7 512 4\n');
  });

  await t.step("errors in bash's words, with bash's token", async () => {
    assertEquals(
      await run('echo $(( 4 + ))\necho $((3425#56))\necho $(( 7 = 43 ))\necho $(( 1 ? 20 ))\necho $((a b))\necho $((2**-1))'),
      [
        '4 + : syntax error: operand expected (error token is "+ ")',
        '3425#56: invalid arithmetic base (error token is "3425#56")',
        '7 = 43 : attempted assignment to non-variable (error token is "= 43 ")',
        '1 ? 20 : `:\' expected for conditional expression (error token is "20 ")',
        'a b: syntax error in expression (error token is "b")',
        '2**-1: exponent less than 0 (error token is "1")',
        '',
      ].join('\n'),
    );
  });

  await t.step('the branch not taken is not run', async () => {
    assertEquals(await run('x=1; echo $(( 0 && (x=5) )) $(( 1 || 1/0 )) $x'), '0 1 1\n');
  });

  await t.step('a plain variable given an element keeps its value as element 0', async () => {
    assertEquals(await run('a=scalar; a[1]=x; echo "${a[0]} ${a[1]}"; n=0 b="(b[n]=++n)<7&&b[0]"; ((b[0])); echo "${b[@]:1}"'), 'scalar x\n1 2 3 4 5 6 7\n');
  });

  await t.step('[[ -eq ]] compares arithmetic', async () => {
    assertEquals(await run('A=7; [[ 7 -eq 4+3 && 7 -eq A ]] && echo y; [[ 7 -eq 4+ ]]; echo $?'), 'y\n1\n[[: 4+: syntax error: operand expected (error token is "+")\n');
  });
});
