import { assertEquals } from '@std/assert';
import { bracketBuiltin, testBuiltin } from '../../src/builtins/test.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';
import { TestShell } from '../lib/test-shell.ts';

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

// Mock shell that delegates file tests to return specific values
function createMockShell(fileTestResults: Record<string, boolean> = {}): ShellIf {
  return {
    execute: async (): Promise<number> => {
      return 1;
    },
    pipeOpen: async () => 'pipe',
    pipeClose: async () => {},
    pipeRemove: async () => {},
    pipeRead: async () => '',
    pipeWrite: async () => {},
    isPipe: () => true,
    pipeFromFile: async () => {},
    pipeToFile: async () => {},
    testPath: async (_ctx, path, op) => {
      // For file tests, look up the result in our mock data
      // Key format: "op:path" e.g., "-f:/tmp/file"
      const key = `${op}:${path}`;
      if (key in fileTestResults) {
        return fileTestResults[key];
      }
      // Default: file does not exist
      return true;
    },
  };
}

Deno.test('test builtin', async (t) => {
  await t.step('empty expression returns false', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await testBuiltin(ctx, [], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('single non-empty string returns true', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await testBuiltin(ctx, ['hello'], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('single empty string returns false', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await testBuiltin(ctx, [''], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('string tests', async (t) => {
    await t.step('-z with empty string returns true', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['-z', ''], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-z with non-empty string returns false', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['-z', 'hello'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('-n with non-empty string returns true', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['-n', 'hello'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-n with empty string returns false', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['-n', ''], shell, noopExecute);
      assertEquals(result.code, 1);
    });
  });

  await t.step('string comparisons', async (t) => {
    await t.step('= returns true for equal strings', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '=', 'foo'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('= returns false for unequal strings', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '=', 'bar'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('== returns true for equal strings', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '==', 'foo'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('!= returns true for unequal strings', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '!=', 'bar'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('!= returns false for equal strings', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '!=', 'foo'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('< returns true for lexically smaller', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['abc', '<', 'xyz'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('> returns true for lexically greater', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['xyz', '>', 'abc'], shell, noopExecute);
      assertEquals(result.code, 0);
    });
  });

  await t.step('numeric comparisons', async (t) => {
    await t.step('-eq returns true for equal numbers', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['42', '-eq', '42'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-eq returns false for unequal numbers', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['42', '-eq', '43'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('-ne returns true for unequal numbers', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['42', '-ne', '43'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-lt returns true for less than', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['5', '-lt', '10'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-lt returns false for greater or equal', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['10', '-lt', '5'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('-le returns true for less or equal', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      let result = await testBuiltin(ctx, ['5', '-le', '10'], shell, noopExecute);
      assertEquals(result.code, 0);
      result = await testBuiltin(ctx, ['10', '-le', '10'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-gt returns true for greater than', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['10', '-gt', '5'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-ge returns true for greater or equal', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      let result = await testBuiltin(ctx, ['10', '-ge', '5'], shell, noopExecute);
      assertEquals(result.code, 0);
      result = await testBuiltin(ctx, ['10', '-ge', '10'], shell, noopExecute);
      assertEquals(result.code, 0);
    });
  });

  await t.step('logical operators', async (t) => {
    await t.step('! negates expression', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      // !true = false
      let result = await testBuiltin(ctx, ['!', 'hello'], shell, noopExecute);
      assertEquals(result.code, 1);
      // !false = true
      result = await testBuiltin(ctx, ['!', ''], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-a (AND) returns true when both are true', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '=', 'foo', '-a', 'bar', '=', 'bar'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-a (AND) returns false when one is false', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '=', 'foo', '-a', 'bar', '=', 'baz'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('-o (OR) returns true when one is true', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '=', 'bar', '-o', 'baz', '=', 'baz'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-o (OR) returns false when both are false', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell();
      const result = await testBuiltin(ctx, ['foo', '=', 'bar', '-o', 'baz', '=', 'qux'], shell, noopExecute);
      assertEquals(result.code, 1);
    });
  });

  await t.step('file tests delegate to shell', async (t) => {
    await t.step('-f returns true for regular file', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell({ 'REGULAR_FILE:/tmp/file': true });
      const result = await testBuiltin(ctx, ['-f', '/tmp/file'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-f returns false for non-existent file', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell({ 'REGULAR_FILE:/tmp/file': false });
      const result = await testBuiltin(ctx, ['-f', '/tmp/file'], shell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('-d returns true for directory', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell({ 'DIRECTORY:/tmp': true });
      const result = await testBuiltin(ctx, ['-d', '/tmp'], shell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('-e returns true for existing path', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell({ 'EXISTS:/tmp/file': true });
      const result = await testBuiltin(ctx, ['-e', '/tmp/file'], shell, noopExecute);
      assertEquals(result.code, 0);
    });
  });
});

Deno.test('[ builtin', async (t) => {
  await t.step('requires closing ]', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await bracketBuiltin(ctx, ['foo', '=', 'foo'], shell, noopExecute);
    assertEquals(result.code, 2);
    assertEquals(result.stderr, "[: missing `]'\n");
  });

  await t.step('works with closing ]', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await bracketBuiltin(ctx, ['foo', '=', 'foo', ']'], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('empty expression with ] returns false', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await bracketBuiltin(ctx, [']'], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('string test with ]', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await bracketBuiltin(ctx, ['-z', '', ']'], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('numeric test with ]', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await bracketBuiltin(ctx, ['5', '-lt', '10', ']'], shell, noopExecute);
    assertEquals(result.code, 0);
  });
});

// Each status and message is bash 5.2's for the same command
const cases: Array<[string, number, string?]> = [
  ['test', 1],
  ['test -n', 0],
  ['test a b', 2, 'test: a: unary operator expected'],
  ['test a b c', 2, 'test: b: binary operator expected'],
  ['test a b c d e', 2, 'test: too many arguments'],
  ['test 1 -eq 1 -o 1 -eq', 2, "test: syntax error: `-eq' unexpected"],
  ['test a -a b -o', 2, 'test: argument expected'],
  ["test '(' -n x ')' -a '(' -z '' ')'", 0],
  ["test ! '(' a ')'", 1],
  ['test -z -a -z', 0],
  ['test = = =', 0],
  ['test " 3 " -eq 3', 0],
  ['test 12 -eq 012', 0],
  ['test 0x10 -eq 16', 2, 'test: 0x10: integer expression expected'],
  ['test 99999999999999999999 -gt 1', 2, 'test: 99999999999999999999: integer expression expected'],
  ['test -o errexit', 1],
  ['set -e; test -o errexit', 0],
  ['declare -n r=x; test -R r', 0],
  ["a=(1 2); test -v 'a[1]' && test -v 'a[@]' && ! test -v 'a[5]'", 0],
  ['[ a -eq ]', 2, '[: a: unary operator expected'],
  ['[ ! ]', 0],
];

Deno.test('test and [ decide as bash does', async (t) => {
  for (const [script, code, message] of cases) {
    await t.step(script, async () => {
      const result = await new TestShell().runAndCapture(`${script}; echo $?`);

      assertEquals([result.stdout, result.stderr], [`${code}\n`, message ? `${message}\n` : '']);
    });
  }
});
