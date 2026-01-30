import { assertEquals } from '@std/assert';
import { aliasBuiltin, unaliasBuiltin } from '../../src/builtins/alias.ts';
import { ExecContext } from '../../src/context.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof aliasBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('alias builtin', async (t) => {
  await t.step('creates alias', async () => {
    const ctx = new ExecContext();
    const result = await aliasBuiltin(ctx, ['ll=ls -l'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getAlias('ll'), 'ls -l');
  });

  await t.step('creates multiple aliases', async () => {
    const ctx = new ExecContext();
    const result = await aliasBuiltin(ctx, ['ll=ls -l', 'la=ls -a'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getAlias('ll'), 'ls -l');
    assertEquals(ctx.getAlias('la'), 'ls -a');
  });

  await t.step('prints existing alias', async () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -l');
    const result = await aliasBuiltin(ctx, ['ll'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "alias ll='ls -l'\n");
  });

  await t.step('reports not found alias', async () => {
    const ctx = new ExecContext();
    const result = await aliasBuiltin(ctx, ['nonexistent'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stdout, 'alias: nonexistent: not found\n');
  });

  await t.step('returns success with no arguments', async () => {
    const ctx = new ExecContext();
    const result = await aliasBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('handles alias with equals in value', async () => {
    const ctx = new ExecContext();
    const result = await aliasBuiltin(ctx, ['test=echo a=b'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getAlias('test'), 'echo a=b');
  });

  await t.step('overwrites existing alias', async () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -l');
    const result = await aliasBuiltin(ctx, ['ll=ls -la'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getAlias('ll'), 'ls -la');
  });
});

Deno.test('unalias builtin', async (t) => {
  await t.step('removes alias', async () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -l');
    const result = await unaliasBuiltin(ctx, ['ll'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getAlias('ll'), undefined);
  });

  await t.step('removes multiple aliases', async () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -l');
    ctx.setAlias('la', 'ls -a');
    const result = await unaliasBuiltin(ctx, ['ll', 'la'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getAlias('ll'), undefined);
    assertEquals(ctx.getAlias('la'), undefined);
  });

  await t.step('returns error with no arguments', async () => {
    const ctx = new ExecContext();
    const result = await unaliasBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'unalias: usage: unalias [-a] name [name ...]\n');
  });

  await t.step('removes non-existent alias silently', async () => {
    const ctx = new ExecContext();
    const result = await unaliasBuiltin(ctx, ['nonexistent'], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });
});
