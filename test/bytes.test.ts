import { assertEquals } from '@std/assert';
import { decodeEscapedBytes, encodeShellText, escapedByte } from '../src/bytes.ts';
import { TestShell } from './lib/test-shell.ts';

Deno.test('bytes made by escapes', async (t) => {
  await t.step('a run that is UTF-8 is the text it spells', () => {
    assertEquals(decodeEscapedBytes(escapedByte(0xc3) + escapedByte(0xa9)), 'é');
  });

  await t.step('one that is not stays bytes, and goes out as them', () => {
    const text = decodeEscapedBytes(`a${escapedByte(0xe9)}`);

    assertEquals([...encodeShellText(text)], [0x61, 0xe9]);
  });

  await t.step("printf, echo -e and $'…' agree", async () => {
    const result = await new TestShell().runAndCapture(`printf '\\303\\251|%b|\\xe2\\x9c\\x93\\n' '\\0303\\0251'; echo -e '\\xc3\\xa9'; x=$'\\303\\251'; echo "\${#x}"`);

    assertEquals(result.stdout, 'é|é|✓\né\n1\n');
  });
});
