import { assertEquals } from 'jsr:@std/assert';
import { ExecContext } from '../../src/context.ts';
import { pwdBuiltin } from '../../src/builtins/pwd.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof pwdBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('pwd builtin', async (t) => {
  await t.step('returns current working directory', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    const result = await pwdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, '/home/user\n');
  });

  await t.step('returns root directory', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/');
    const result = await pwdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, '/\n');
  });

  await t.step('reflects cwd changes', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/tmp');
    let result = await pwdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.stdout, '/tmp\n');

    ctx.setCwd('/var/log');
    result = await pwdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.stdout, '/var/log\n');
  });

  await t.step('-L flag (logical path)', async () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user/symlink');
    const result = await pwdBuiltin(ctx, ['-L'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, '/home/user/symlink\n');
  });

  await t.step('-P flag (physical path)', async () => {
    // Note: Without shell callback for resolving symlinks,
    // -P behaves the same as -L
    const ctx = new ExecContext();
    ctx.setCwd('/home/user/symlink');
    const result = await pwdBuiltin(ctx, ['-P'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, '/home/user/symlink\n');
  });

  await t.step('inherits cwd from parent context', async () => {
    const parent = new ExecContext();
    parent.setCwd('/parent/dir');
    const child = parent.spawnContext();
    const result = await pwdBuiltin(child, [], mockShell, noopExecute);
    assertEquals(result.stdout, '/parent/dir\n');
  });
});
