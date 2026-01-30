import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Conditional Command [[]]', async (t) => {
  // String tests
  await t.step('[[ -z "" ]] returns true (exit 0)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ -z "" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ -z "hello" ]] returns false (exit 1)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ -z "hello" ]]');
    assertEquals(result.exitCode, 1);
  });

  await t.step('[[ -n "hello" ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ -n "hello" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ -n "" ]] returns false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ -n "" ]]');
    assertEquals(result.exitCode, 1);
  });

  // String comparison
  await t.step('[[ "foo" == "foo" ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "foo" == "foo" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "foo" == "bar" ]] returns false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "foo" == "bar" ]]');
    assertEquals(result.exitCode, 1);
  });

  await t.step('[[ "foo" != "bar" ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "foo" != "bar" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "foo" != "foo" ]] returns false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "foo" != "foo" ]]');
    assertEquals(result.exitCode, 1);
  });

  // Lexicographic comparison
  await t.step('[[ "a" < "b" ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" < "b" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "b" > "a" ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "b" > "a" ]]');
    assertEquals(result.exitCode, 0);
  });

  // Numeric comparison
  await t.step('[[ 5 -eq 5 ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ 5 -eq 5 ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ 5 -ne 3 ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ 5 -ne 3 ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ 5 -lt 10 ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ 5 -lt 10 ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ 10 -gt 5 ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ 10 -gt 5 ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ 5 -le 5 ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ 5 -le 5 ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ 5 -ge 5 ]] returns true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ 5 -ge 5 ]]');
    assertEquals(result.exitCode, 0);
  });

  // Variable expansion
  await t.step('variable expansion in conditional', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'hello' });
    const result = await shell.runAndCapture('[[ -n "$VAR" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('empty variable with -z', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: '' });
    const result = await shell.runAndCapture('[[ -z "$VAR" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('unset variable with -z', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ -z "$UNSET_VAR" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('variable comparison', async () => {
    const shell = new TestShell();
    shell.setParams({ A: '10', B: '10' });
    const result = await shell.runAndCapture('[[ $A -eq $B ]]');
    assertEquals(result.exitCode, 0);
  });

  // Pattern matching with ==
  await t.step('[[ "hello" == h* ]] pattern matching', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "hello" == h* ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "hello" == *lo ]] pattern matching', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "hello" == *lo ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "hello" == *ell* ]] pattern matching', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "hello" == *ell* ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "hello" != x* ]] pattern non-match', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "hello" != x* ]]');
    assertEquals(result.exitCode, 0);
  });

  // Regex matching
  await t.step('[[ "123" =~ ^[0-9]+$ ]] regex matching', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "123" =~ ^[0-9]+$ ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ "abc" =~ ^[0-9]+$ ]] regex non-match', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "abc" =~ ^[0-9]+$ ]]');
    assertEquals(result.exitCode, 1);
  });

  await t.step('[[ "hello world" =~ hello ]] regex partial match', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "hello world" =~ hello ]]');
    assertEquals(result.exitCode, 0);
  });

  // Logical operators
  await t.step('[[ cond1 && cond2 ]] both true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" == "a" && "b" == "b" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ cond1 && cond2 ]] first false (short-circuit)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" == "x" && "b" == "b" ]]');
    assertEquals(result.exitCode, 1);
  });

  await t.step('[[ cond1 || cond2 ]] first true (short-circuit)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" == "a" || "x" == "y" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ cond1 || cond2 ]] first false, second true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" == "x" || "b" == "b" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ cond1 || cond2 ]] both false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" == "x" || "b" == "y" ]]');
    assertEquals(result.exitCode, 1);
  });

  // Negation
  await t.step('[[ ! cond ]] negates true to false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ ! "a" == "a" ]]');
    assertEquals(result.exitCode, 1);
  });

  await t.step('[[ ! cond ]] negates false to true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ ! "a" == "b" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('[[ ! -z "hello" ]] negates empty test', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ ! -z "hello" ]]');
    assertEquals(result.exitCode, 0);
  });

  // Integration with if statement
  await t.step('[[ ]] in if condition (true branch)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('if [[ 1 -eq 1 ]]; then echo yes; fi');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('[[ ]] in if condition (false branch)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('if [[ 1 -eq 2 ]]; then echo yes; else echo no; fi');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'no\n');
  });

  // Integration with while loop
  await t.step('[[ ]] in while condition', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('i=0; while [[ $i -lt 3 ]]; do echo $i; i=$((i+1)); done');
    assertEquals(result.stdout, '0\n1\n2\n');
  });

  // Complex expressions
  await t.step('complex expression with && and ||', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "a" == "a" && "b" == "b" || "c" == "d" ]]');
    assertEquals(result.exitCode, 0);
  });

  // Note: [[ ! ! "a" == "a" ]] (nested negation) is not supported by the parser

  // Edge cases
  await t.step('standalone non-empty word is true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ hello ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('command substitution in conditional', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ "$(echo hello)" == "hello" ]]');
    assertEquals(result.exitCode, 0);
  });

  await t.step('arithmetic expansion in conditional', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[[ $((2+3)) -eq 5 ]]');
    assertEquals(result.exitCode, 0);
  });
});
