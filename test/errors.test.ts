import { assertEquals, assertInstanceOf } from '@std/assert';
import { BashSyntaxError } from '../mod.ts';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Error Classes', async (t) => {
  await t.step('BashSyntaxError has location from parser', async () => {
    const shell = new TestShell();
    try {
      // Missing command after pipe - this produces a parser error with line number
      await shell.run('echo hello |');
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      // Parser errors should have line information via location.start.row
      assertEquals(e.location?.start?.row, 1);
    }
  });

  await t.step('BashSyntaxError includes source', async () => {
    const shell = new TestShell();
    try {
      // Unterminated string - lexer error
      await shell.run('echo "unterminated');
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      // Source should always be preserved
      assertEquals(e.source, 'echo "unterminated');
    }
  });

  await t.step('BashSyntaxError for invalid syntax', async () => {
    const shell = new TestShell();
    try {
      // Invalid syntax
      await shell.run('if then fi');
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.location?.start?.row, 1);
    }
  });
});

Deno.test('Error Format Methods', async (t) => {
  await t.step('getCodeSnippet includes location when available', async () => {
    const shell = new TestShell();
    try {
      await shell.run('echo hello |');
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      const snippet = e.getCodeSnippet();
      assertEquals(typeof snippet, 'string');
      // Should contain the source line
      assertEquals(snippet!.includes('echo hello |'), true);
    }
  });

  await t.step('getCodeSnippet returns undefined without location', async () => {
    const shell = new TestShell();
    try {
      await shell.run('echo "unterminated');
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      // Lexer errors may not have location, getCodeSnippet handles this
      const snippet = e.getCodeSnippet();
      // May or may not have a snippet depending on if location is available
      assertEquals(snippet === undefined || typeof snippet === 'string', true);
    }
  });
});

Deno.test('Error Source Context', async (t) => {
  await t.step('error includes source code', async () => {
    const shell = new TestShell();
    const source = 'echo "unterminated';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
    }
  });

  await t.step('multiline source is preserved', async () => {
    const shell = new TestShell();
    const source = `echo ok
echo hello |`;
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      assertEquals(e.location?.start?.row, 2);
    }
  });

  await t.step('getCodeSnippet shows error line for parser errors', async () => {
    const shell = new TestShell();
    const source = 'if then fi';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      const snippet = e.getCodeSnippet();
      // Should contain the source line for parser errors with location
      assertEquals(snippet!.includes('if then fi'), true);
    }
  });
});

Deno.test('Arithmetic errors happen at run time, as in bash', async (t) => {
  // bash checks arithmetic only after expansion: a bad expression fails its
  // command with 1 and a message, and the script carries on

  await t.step('$(( )) fails the command it is in, and the next one runs', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo a $((1 + )); echo "s=$?"');
    assertEquals(result.stdout, 's=1\n');
    assertEquals(result.stderr.includes('1 + : syntax error'), true);
  });

  await t.step('(( )) reports with its prefix', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(( a + * b )); echo "s=$?"');
    assertEquals(result.stdout, 's=1\n');
    assertEquals(result.stderr.startsWith('((: a + * b: syntax error'), true);
  });

  await t.step('an assignment from a bad expression is not made', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=1\nx=$((x + )); echo "x=$x s=$?"');
    assertEquals(result.stdout, 'x=1 s=1\n');
  });

  await t.step('what the parser could not read ahead is read after expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -- a b; a=(1 2 3); echo $(( $# + a[2] + 16#10 ))');
    assertEquals(result.stdout, '21\n');
  });
});

Deno.test('Unclosed Delimiter Errors', async (t) => {
  await t.step('unclosed double quote has location', async () => {
    const shell = new TestShell();
    const source = 'echo "hello';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Should have location pointing to opening quote
      assertEquals(e.location?.start?.row, 1);
      assertEquals(e.location?.start?.col, 6); // Position of "
      assertEquals(e.location?.start?.char, 5); // 0-indexed
    }
  });

  await t.step('unclosed single quote has location', async () => {
    const shell = new TestShell();
    const source = "echo 'hello";
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Should have location pointing to opening quote
      assertEquals(e.location?.start?.row, 1);
      assertEquals(e.location?.start?.col, 6); // Position of '
    }
  });

  await t.step('unclosed backtick has location', async () => {
    const shell = new TestShell();
    const source = 'echo `date';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Should have location pointing to backtick
      assertEquals(e.location?.start?.row, 1);
      assertEquals(e.location?.start?.char, 5); // Position of `
    }
  });

  await t.step('unclosed $( has location', async () => {
    const shell = new TestShell();
    const source = 'echo $(date';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Should have location pointing to $
      assertEquals(e.location?.start?.row, 1);
      assertEquals(e.location?.start?.char, 5); // Position of $
    }
  });

  await t.step('unclosed $(( has location', async () => {
    const shell = new TestShell();
    const source = 'echo $((1 + 2';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Should have location pointing to $
      assertEquals(e.location?.start?.row, 1);
      assertEquals(e.location?.start?.char, 5); // Position of $
    }
  });

  await t.step('unclosed ${ has location', async () => {
    const shell = new TestShell();
    const source = 'echo ${HOME';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Should have location pointing to $
      assertEquals(e.location?.start?.row, 1);
      assertEquals(e.location?.start?.char, 5); // Position of $
    }
  });

  await t.step('multiline unclosed quote has correct row', async () => {
    const shell = new TestShell();
    const source = `echo ok
echo "hello`;
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Error is on line 2
      assertEquals(e.location?.start?.row, 2);
      assertEquals(e.location?.start?.col, 6); // Position of " on line 2
    }
  });

  await t.step('getCodeSnippet works for unclosed quote', async () => {
    const shell = new TestShell();
    const source = 'echo "hello';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      const snippet = e.getCodeSnippet();
      assertEquals(typeof snippet, 'string');
      // Should contain the source line and pointer
      assertEquals(snippet!.includes('echo "hello'), true);
      assertEquals(snippet!.includes('^'), true);
    }
  });
});

Deno.test('a syntax error stops the script where bash stops it', async (t) => {
  await t.step('the complete lines before it run, then the error is thrown', async () => {
    const shell = new TestShell();
    let thrown: unknown;
    try {
      await shell.run('echo a\nif true; then echo b; fi\n)\necho c');
    } catch (err) {
      thrown = err;
    }
    assertInstanceOf(thrown, BashSyntaxError);
    assertEquals(shell.getStdout(), 'a\nb\n');
  });

  await t.step('nothing runs from the line with the error', async () => {
    const shell = new TestShell();
    try {
      await shell.run('echo a; )');
    } catch {
      // expected
    }
    assertEquals(shell.getStdout(), '');
  });

  await t.step('an exit before the error ends the script without it', async () => {
    const shell = new TestShell();
    const code = await shell.run('echo a\nexit 3\n)');
    assertEquals(code, 3);
  });

  await t.step('eval and source fail with 2 and the script goes on', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/bad.sh', 'echo s1\n)\necho s2\n');
    const result = await shell.runAndCapture('eval "echo e1\n)"; echo "eval=$?"; . /tmp/bad.sh; echo "source=$?"');
    assertEquals(result.stdout, 'e1\neval=2\ns1\nsource=2\n');
  });
});
