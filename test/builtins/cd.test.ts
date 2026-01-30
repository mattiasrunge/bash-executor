import { assertEquals } from '@std/assert';
import { cdBuiltin } from '../../src/builtins/cd.ts';
import { ExecContext } from '../../src/context.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof cdBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('cd builtin', async (t) => {
  await t.step('changes to absolute path', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/tmp');
  });

  await t.step('changes to relative path', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['documents'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user/documents');
  });

  await t.step('resolves .. in path', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user/documents');
    const result = await cdBuiltin(ctx, ['..'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user');
  });

  await t.step('resolves . in path', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['.'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user');
  });

  await t.step('resolves complex relative path', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user/documents');
    const result = await cdBuiltin(ctx, ['../pictures/../downloads'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user/downloads');
  });

  await t.step('goes to HOME with no arguments', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/tmp');
    ctx.setEnv({ HOME: '/home/user' });
    const result = await cdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user');
  });

  await t.step('fails when HOME not set', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/tmp');
    const result = await cdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'cd: HOME not set\n');
  });

  await t.step('cd - goes to OLDPWD', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    ctx.setEnv({ OLDPWD: '/tmp' });
    const result = await cdBuiltin(ctx, ['-'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/tmp');
    assertEquals(result.stdout, '/tmp\n'); // cd - prints the directory
  });

  await t.step('fails when OLDPWD not set', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['-'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'cd: OLDPWD not set\n');
  });

  await t.step('updates PWD and OLDPWD environment variables', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    await cdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    const env = ctx.getEnv();
    assertEquals(env['PWD'], '/tmp');
    assertEquals(env['OLDPWD'], '/home/user');
  });

  await t.step('handles tilde expansion', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/tmp');
    ctx.setEnv({ HOME: '/home/user' });
    const result = await cdBuiltin(ctx, ['~/documents'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user/documents');
  });

  await t.step('-L flag (logical path)', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['-L', '/tmp'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/tmp');
  });

  await t.step('-P flag (physical path)', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['-P', '/tmp'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/tmp');
  });

  await t.step('rejects invalid option', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await cdBuiltin(ctx, ['-x', '/tmp'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'cd: -x: invalid option\n');
  });
});
