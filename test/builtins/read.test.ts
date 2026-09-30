import { assertEquals } from '@std/assert';
import { readBuiltin } from '../../src/builtins/read.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';
import { TestShell } from '../lib/test-shell.ts';

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

// Mock shell that provides input via pipeRead
function createMockShell(input: string): ShellIf & { writtenOutput: string } {
  const shell = {
    writtenOutput: '',
    pipeRead: async (_name: string): Promise<string> => {
      return input;
    },
    pipeWrite: async (_name: string, data: string): Promise<void> => {
      shell.writtenOutput += data;
    },
    execute: async () => 0,
    pipeOpen: async () => 'pipe',
    pipeClose: async () => {},
    pipeRemove: async () => {},
    isPipe: () => true,
    pipeFromFile: async () => {},
    pipeToFile: async () => {},
  };
  return shell;
}

Deno.test('read builtin', async (t) => {
  await t.step('reads into REPLY by default', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('hello world\n');
    const result = await readBuiltin(ctx, [], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['REPLY'], 'hello world');
  });

  await t.step('reads into named variable', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('hello\n');
    const result = await readBuiltin(ctx, ['name'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['name'], 'hello');
  });

  await t.step('splits input into multiple variables', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('John 25 Engineer\n');
    const result = await readBuiltin(ctx, ['name', 'age', 'job'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['name'], 'John');
    assertEquals(ctx.getParams()['age'], '25');
    assertEquals(ctx.getParams()['job'], 'Engineer');
  });

  await t.step('last variable gets remaining words', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('a b c d e\n');
    const result = await readBuiltin(ctx, ['first', 'rest'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['first'], 'a');
    assertEquals(ctx.getParams()['rest'], 'b c d e');
  });

  await t.step('handles fewer words than variables', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('one\n');
    const result = await readBuiltin(ctx, ['a', 'b', 'c'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['a'], 'one');
    assertEquals(ctx.getParams()['b'], '');
    assertEquals(ctx.getParams()['c'], '');
  });

  await t.step('returns 1 on empty input', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('');
    const result = await readBuiltin(ctx, ['name'], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('prompt option', async (t) => {
    await t.step('-p outputs prompt', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell('John\n');
      const result = await readBuiltin(ctx, ['-p', 'Name: ', 'name'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(shell.writtenOutput, 'Name: ');
      assertEquals(ctx.getParams()['name'], 'John');
    });
  });

  await t.step('raw mode option', async (t) => {
    await t.step('-r preserves backslashes', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell('path\\file\n');
      const result = await readBuiltin(ctx, ['-r', 'path'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['path'], 'path\\file');
    });

    await t.step('without -r a backslash makes the next character itself', async () => {
      const ctx = new ExecContext();
      // As in bash: `\n` is an n, and `\ ` a blank that does not split
      const shell = createMockShell('hello\\nworld\\ x y\n');
      const result = await readBuiltin(ctx, ['text', 'rest'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals([ctx.getParams()['text'], ctx.getParams()['rest']], ['hellonworld x', 'y']);
    });
  });

  await t.step('respects IFS', async (t) => {
    await t.step('custom IFS', async () => {
      const ctx = new ExecContext();
      ctx.setEnv({ IFS: ':' });
      const shell = createMockShell('a:b:c\n');
      const result = await readBuiltin(ctx, ['x', 'y', 'z'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], 'a');
      assertEquals(ctx.getParams()['y'], 'b');
      assertEquals(ctx.getParams()['z'], 'c');
    });

    await t.step('empty IFS means no splitting', async () => {
      const ctx = new ExecContext();
      ctx.setEnv({ IFS: '' });
      const shell = createMockShell('a b c\n');
      const result = await readBuiltin(ctx, ['line'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['line'], 'a b c');
    });
  });

  await t.step('handles multiple whitespace', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('  a   b   c  \n');
    const result = await readBuiltin(ctx, ['x', 'y', 'z'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], 'a');
    assertEquals(ctx.getParams()['y'], 'b');
    assertEquals(ctx.getParams()['z'], 'c');
  });

  await t.step('-n reads limited characters', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('hello world\n');
    const result = await readBuiltin(ctx, ['-n', '5', 'chars'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['chars'], 'hello');
  });
});

Deno.test('read -u fd', async (t) => {
  await t.step('reads from specified FD', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/data', 'hello\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/data
      read -u 3 line
      echo "$line"
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('reads multiple lines from FD', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/data', 'first\nsecond\nthird\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/data
      read -u 3 a
      read -u 3 b
      read -u 3 c
      echo "$a,$b,$c"
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'first,second,third\n');
  });

  await t.step('while read -u collects all lines', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/lines', 'one\ntwo\nthree\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/lines
      OUT=""
      while read -u 3 -r line; do
        OUT="$OUT$line "
      done
      echo "$OUT"
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'one two three \n');
  });
});

Deno.test('read splits a line as bash does', async (t) => {
  // Each expected value is bash 5.2's
  const cases: Array<[string, string]> = [
    ['IFS=: read -r user pass uid rest <<< "root:x:0:0:root:/root:/bin/bash"; echo "[$user][$pass][$uid][$rest]"', '[root][x][0][0:root:/root:/bin/bash]'],
    ['IFS== read -r key value <<< "url=a=b"; echo "[$key][$value]"', '[url][a=b]'],
    ['IFS=, read -r a b <<< "1,2,"; echo "[$a][$b]"', '[1][2]'],
    ['IFS=, read -r a b <<< "1,2,,"; echo "[$a][$b]"', '[1][2,,]'],
    ['IFS=": " read x y <<< ":::"; echo "($x)($y)"', '()(::)'],
    ['IFS=": " read x y <<< " a : b : c "; echo "($x)($y)"', '(a)(b : c)'],
    ['IFS=: read x y z <<< "a::b"; echo "[$x][$y][$z]"', '[a][][b]'],
    ['IFS=, read -r -a arr <<< "a,,b,"; echo "${#arr[@]} [${arr[1]}]"', '3 []'],
    ['read a b <<< "  one   two  three  "; echo "[$a][$b]"', '[one][two  three]'],
    ['read a b <<< "x\\ y z"; echo "[$a][$b]"', '[x y][z]'],
    ['read <<< "  a \\b  "; echo "[$REPLY]"', '[  a b  ]'],
    ['IFS= read a b <<< "  p q  "; echo "[$a][$b]"', '[  p q  ][]'],
  ];

  for (const [script, expected] of cases) {
    await t.step(script, async () => {
      assertEquals((await new TestShell().runAndCapture(script)).stdout, `${expected}\n`);
    });
  }
});
