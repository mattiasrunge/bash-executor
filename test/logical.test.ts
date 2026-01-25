import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Logical AND (&&)', async (t) => {
  await t.step('true && true executes both', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "first" && echo "second"');
    assertEquals(result.stdout, 'first\nsecond\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('false && true skips second (short-circuit)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false && echo "skipped"');
    assertEquals(result.stdout, '');
    assertEquals(result.exitCode, 1);
  });

  await t.step('true && false returns failure', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('true && false');
    assertEquals(result.exitCode, 1);
  });

  await t.step('chained && operators - all succeed', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "1" && echo "2" && echo "3"');
    assertEquals(result.stdout, '1\n2\n3\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('chained && operators - middle fails', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "1" && false && echo "3"');
    assertEquals(result.stdout, '1\n');
    assertEquals(result.exitCode, 1);
  });

  await t.step('&& with command producing output', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('true && echo "success"');
    assertEquals(result.stdout, 'success\n');
  });
});

Deno.test('Logical OR (||)', async (t) => {
  await t.step('false || true executes second', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false || echo "fallback"');
    assertEquals(result.stdout, 'fallback\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('true || false skips second (short-circuit)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "first" || echo "skipped"');
    assertEquals(result.stdout, 'first\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('false || false returns failure', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false || false');
    assertEquals(result.exitCode, 1);
  });

  await t.step('chained || operators', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false || false || echo "finally"');
    assertEquals(result.stdout, 'finally\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('|| provides error recovery', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false || echo "recovered"');
    assertEquals(result.stdout, 'recovered\n');
    assertEquals(result.exitCode, 0);
  });
});

Deno.test('Mixed Logical Operators', async (t) => {
  await t.step('&& and || together - success path', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('true && echo "yes" || echo "no"');
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('&& and || together - failure path', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false && echo "yes" || echo "no"');
    assertEquals(result.stdout, 'no\n');
  });

  await t.step('complex logical chain - recovery', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('true && false || echo "recovered"');
    assertEquals(result.stdout, 'recovered\n');
  });

  await t.step('|| followed by &&', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false || true && echo "yes"');
    assertEquals(result.stdout, 'yes\n');
  });
});

Deno.test('Logical Operators with Conditions', async (t) => {
  await t.step('&& with test command', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '5' });
    const result = await shell.runAndCapture('[ $x -gt 3 ] && echo "big"');
    assertEquals(result.stdout, 'big\n');
  });

  await t.step('|| with test command failure', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '1' });
    const result = await shell.runAndCapture('[ $x -gt 3 ] || echo "small"');
    assertEquals(result.stdout, 'small\n');
  });

  await t.step('&& with arithmetic condition', async () => {
    const shell = new TestShell();
    // Use non-zero arithmetic result to get exit 0
    const result = await shell.runAndCapture('(( 5 )) && echo "yes"');
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('|| with arithmetic condition', async () => {
    const shell = new TestShell();
    // Use zero arithmetic result to get exit 1, then || triggers
    const result = await shell.runAndCapture('(( 0 )) || echo "no"');
    assertEquals(result.stdout, 'no\n');
  });
});

Deno.test('Logical Operators in Scripts', async (t) => {
  await t.step('&& for conditional execution', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      check() {
        true
      }
      check && echo "check passed"
    `);
    assertEquals(result.stdout, 'check passed\n');
  });

  await t.step('|| for error handling', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      might_fail() {
        false
      }
      might_fail || echo "handling error"
    `);
    assertEquals(result.stdout, 'handling error\n');
  });

  await t.step('combined for typical patterns', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      command_exists() {
        true
      }
      command_exists && echo "found" || echo "not found"
    `);
    assertEquals(result.stdout, 'found\n');
  });
});
