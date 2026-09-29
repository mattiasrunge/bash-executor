import { assertEquals } from '@std/assert';
import { globToRegExp, posixRegexToSource } from '../src/pattern.ts';

const matches = (pattern: string, value: string) => globToRegExp(pattern).test(value);

Deno.test('shell patterns', async (t) => {
  await t.step('*, ? and bracket expressions, negated both ways', () => {
    assertEquals(matches('a*c', 'abbc'), true);
    assertEquals(matches('a?c', 'abc'), true);
    assertEquals(matches('[!0-9]x', 'ax'), true);
    assertEquals(matches('[^0-9]x', '1x'), false);
    assertEquals(matches('[]a]', ']'), true);
  });

  await t.step('POSIX classes', () => {
    assertEquals(matches('[[:digit:]][[:alpha:]]', '1a'), true);
    assertEquals(matches('[![:space:]]', ' '), false);
  });

  await t.step('a backslash quotes', () => {
    assertEquals(matches('a\\*', 'a*'), true);
    assertEquals(matches('a\\*', 'ab'), false);
  });

  await t.step('extended patterns', () => {
    assertEquals(matches('*.@(c|h)', 'x.h'), true);
    assertEquals(matches('*.@(c|h)', 'x.o'), false);
    assertEquals(matches('+(ab)', 'ababab'), true);
    assertEquals(matches('a?(b)c', 'ac'), true);
    assertEquals(matches('a*(b)c', 'abbbc'), true);
    assertEquals(matches('@(ab|+([^/]))/..?(/)', 'ab/../'), true);
  });

  await t.step('!(…) matches what the group does not', () => {
    assertEquals(matches('!(x*)', 'abc'), true);
    assertEquals(matches('!(x*)', 'xbc'), false);
    assertEquals(matches('!(*.c).o', 'main.o'), true);
  });
});

Deno.test('POSIX regular expressions', () => {
  assertEquals(new RegExp(posixRegexToSource('^[[:alpha:]]+[^[:space:]]$')).test('ab1'), true);
  assertEquals(new RegExp(posixRegexToSource('[]x]')).test(']'), true);
});
