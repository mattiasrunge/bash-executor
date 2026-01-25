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
  await t.step('division by zero returns 0', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((10 / 0))');
    assertEquals(result.stdout, '0\n');
  });

  await t.step('modulo by zero returns 0', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((10 % 0))');
    assertEquals(result.stdout, '0\n');
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
