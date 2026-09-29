import { assertEquals, assertRejects } from '@std/assert';
import { BashSyntaxError, parse } from '@ein/bash-parser';
import { syntaxErrorLines } from '../src/syntax-error.ts';
import { TestShell } from './lib/test-shell.ts';

/** How bash words the syntax error in a script, bar the name before each line. */
const said = async (source: string) => syntaxErrorLines(await assertRejects(() => parse(source), BashSyntaxError), source);

// Each expected text is bash 5.2's for the same script
Deno.test('syntax errors are said as bash says them', async (t) => {
  await t.step('a token, with the line it is on after it', async () => {
    assertEquals(await said('echo 1\nif x\nthen\n  fi fi'), { line: 4, lines: ["syntax error near unexpected token `fi'", "`  fi fi'"] });
  });

  await t.step('the end of the input, on the line after the last', async () => {
    assertEquals(await said('if x; then'), { line: 2, lines: ['syntax error: unexpected end of file'] });
    assertEquals(await said('if x; then\n\n\n'), { line: 4, lines: ['syntax error: unexpected end of file'] });
  });

  await t.step('a quote on its line, an open $( at the end', async () => {
    assertEquals(await said('echo "a\nb\n'), { line: 1, lines: ['unexpected EOF while looking for matching `"\''] });
    assertEquals(await said('echo $(\n'), { line: 2, lines: ["unexpected EOF while looking for matching `)'"] });
  });

  await t.step("eval's own, counting from the eval's line, and the script goes on", async () => {
    const result = await new TestShell().runAndCapture('eval "fi"\necho after $?');

    assertEquals(result.stdout, 'after 2\n');
    assertEquals(result.stderr, "eval: syntax error near unexpected token `fi'\neval: `fi'\n");
  });
});
