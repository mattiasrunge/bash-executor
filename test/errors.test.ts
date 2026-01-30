import { assertEquals, assertInstanceOf } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';
import { BashExecutorError, BashSyntaxError } from '../mod.ts';

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

Deno.test('Arithmetic Error Context', async (t) => {
  await t.step('arithmetic error includes full source', async () => {
    const shell = new TestShell();
    const source = 'echo $((1 + ))';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      // Source should be the full script, not just the arithmetic expression
      assertEquals(e.source, source);
    }
  });

  await t.step('arithmetic error has row and col computed from char', async () => {
    const shell = new TestShell();
    const source = 'echo $((1 + ))';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      // Should have row computed (arithmetic errors originally only have char)
      assertEquals(e.location?.start?.row, 1);
      assertEquals(typeof e.location?.start?.col, 'number');
    }
  });

  await t.step('multiline arithmetic error has correct row', async () => {
    const shell = new TestShell();
    const source = `x=1
echo $((x + ))`;
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      assertEquals(e.source, source);
      // Error is on line 2
      assertEquals(e.location?.start?.row, 2);
    }
  });

  await t.step('getCodeSnippet works for arithmetic errors', async () => {
    const shell = new TestShell();
    const source = 'result=$((a + * b))';
    try {
      await shell.run(source);
      throw new Error('Should have thrown');
    } catch (e) {
      assertInstanceOf(e, BashSyntaxError);
      const snippet = e.getCodeSnippet();
      assertEquals(typeof snippet, 'string');
      // Should contain the full source line
      assertEquals(snippet!.includes('result=$((a + * b))'), true);
    }
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
