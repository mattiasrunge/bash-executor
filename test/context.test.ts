import { assertEquals, assertNotEquals } from '@std/assert';
import { ExecContext } from '../src/context.ts';

Deno.test('ExecContext - Basic Construction', async (t) => {
  await t.step('creates context with default IO', () => {
    const ctx = new ExecContext();
    assertEquals(ctx.getStdin(), '0');
    assertEquals(ctx.getStdout(), '1');
    assertEquals(ctx.getStderr(), '2');
  });

  await t.step('creates context with default cwd', () => {
    const ctx = new ExecContext();
    assertEquals(ctx.getCwd(), '/');
  });

  await t.step('creates context with empty env and params', () => {
    const ctx = new ExecContext();
    assertEquals(ctx.getEnv(), {});
    assertEquals(ctx.getParams(), {});
  });
});

Deno.test('ExecContext - CWD Management', async (t) => {
  await t.step('setCwd updates cwd and PWD env', () => {
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');
    assertEquals(ctx.getCwd(), '/home/user');
    assertEquals(ctx.getEnv()['PWD'], '/home/user');
  });

  await t.step('setCwd returns the new cwd', () => {
    const ctx = new ExecContext();
    const result = ctx.setCwd('/tmp');
    assertEquals(result, '/tmp');
  });
});

Deno.test('ExecContext - Environment Variables', async (t) => {
  await t.step('setEnv adds environment variables', () => {
    const ctx = new ExecContext();
    ctx.setEnv({ FOO: 'bar', BAZ: 'qux' });
    assertEquals(ctx.getEnv()['FOO'], 'bar');
    assertEquals(ctx.getEnv()['BAZ'], 'qux');
  });

  await t.step('setEnv with null removes variable', () => {
    const ctx = new ExecContext();
    ctx.setEnv({ FOO: 'bar' });
    assertEquals(ctx.getEnv()['FOO'], 'bar');
    ctx.setEnv({ FOO: null });
    assertEquals(ctx.getEnv()['FOO'], undefined);
  });

  await t.step('setEnv returns updated env', () => {
    const ctx = new ExecContext();
    const result = ctx.setEnv({ KEY: 'value' });
    assertEquals(result['KEY'], 'value');
  });

  await t.step('setLocalEnv sets local variables only', () => {
    const ctx = new ExecContext();
    ctx.setLocalEnv({ LOCAL: 'local_value' });
    assertEquals(ctx.getEnv()['LOCAL'], 'local_value');
  });

  await t.step('setLocalEnv with null removes local variable', () => {
    const ctx = new ExecContext();
    ctx.setLocalEnv({ LOCAL: 'value' });
    ctx.setLocalEnv({ LOCAL: null });
    assertEquals(ctx.getEnv()['LOCAL'], undefined);
  });
});

Deno.test('ExecContext - Parameters', async (t) => {
  await t.step('setParams adds parameters', () => {
    const ctx = new ExecContext();
    ctx.setParams({ x: '10', y: '20' });
    assertEquals(ctx.getParams()['x'], '10');
    assertEquals(ctx.getParams()['y'], '20');
  });

  await t.step('setParams with null removes parameter', () => {
    const ctx = new ExecContext();
    ctx.setParams({ x: '10' });
    ctx.setParams({ x: null });
    assertEquals(ctx.getParams()['x'], undefined);
  });

  await t.step('setLocalParams sets local parameters only', () => {
    const ctx = new ExecContext();
    ctx.setLocalParams({ '1': 'arg1', '2': 'arg2' });
    assertEquals(ctx.getParams()['1'], 'arg1');
    assertEquals(ctx.getParams()['2'], 'arg2');
  });

  await t.step('setLocalParams with null removes local parameter', () => {
    const ctx = new ExecContext();
    ctx.setLocalParams({ x: 'value' });
    ctx.setLocalParams({ x: null });
    assertEquals(ctx.getParams()['x'], undefined);
  });
});

Deno.test('ExecContext - spawnContext (Child Context)', async (t) => {
  await t.step('spawnContext creates child with inherited IO', () => {
    const parent = new ExecContext();
    parent.redirectStdin('input.txt');
    parent.redirectStdout('output.txt');
    parent.redirectStderr('error.txt');

    const child = parent.spawnContext();
    assertEquals(child.getStdin(), 'input.txt');
    assertEquals(child.getStdout(), 'output.txt');
    assertEquals(child.getStderr(), 'error.txt');
  });

  await t.step('spawnContext child inherits parent cwd', () => {
    const parent = new ExecContext();
    parent.setCwd('/home/user');

    const child = parent.spawnContext();
    assertEquals(child.getCwd(), '/home/user');
  });

  await t.step('spawnContext child cwd change affects parent', () => {
    const parent = new ExecContext();
    parent.setCwd('/home/user');

    const child = parent.spawnContext();
    child.setCwd('/tmp');

    assertEquals(parent.getCwd(), '/tmp');
    assertEquals(child.getCwd(), '/tmp');
  });

  await t.step('spawnContext child inherits parent env', () => {
    const parent = new ExecContext();
    parent.setEnv({ PARENT_VAR: 'parent_value' });

    const child = parent.spawnContext();
    assertEquals(child.getEnv()['PARENT_VAR'], 'parent_value');
  });

  await t.step('spawnContext child env changes propagate to parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.setEnv({ CHILD_VAR: 'child_value' });
    assertEquals(parent.getEnv()['CHILD_VAR'], 'child_value');
  });

  await t.step('spawnContext child local env does not affect parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.setLocalEnv({ LOCAL_VAR: 'local_value' });
    assertEquals(child.getEnv()['LOCAL_VAR'], 'local_value');
    assertEquals(parent.getEnv()['LOCAL_VAR'], undefined);
  });

  await t.step('spawnContext child inherits parent params', () => {
    const parent = new ExecContext();
    parent.setParams({ x: '10' });

    const child = parent.spawnContext();
    assertEquals(child.getParams()['x'], '10');
  });

  await t.step('spawnContext child param changes propagate to parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.setParams({ y: '20' });
    assertEquals(parent.getParams()['y'], '20');
  });

  await t.step('spawnContext child local params do not affect parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.setLocalParams({ local: 'value' });
    assertEquals(child.getParams()['local'], 'value');
    assertEquals(parent.getParams()['local'], undefined);
  });
});

Deno.test('ExecContext - subContext (Copy Context)', async (t) => {
  await t.step('subContext creates independent copy', () => {
    const original = new ExecContext();
    original.setCwd('/original');
    original.setEnv({ ENV_VAR: 'env_value' });
    original.setParams({ PARAM: 'param_value' });

    const copy = original.subContext();

    assertEquals(copy.getCwd(), '/original');
    assertEquals(copy.getEnv()['ENV_VAR'], 'env_value');
    assertEquals(copy.getParams()['PARAM'], 'param_value');
  });

  await t.step('subContext changes do not affect original', () => {
    const original = new ExecContext();
    original.setCwd('/original');
    original.setEnv({ KEY: 'original' });

    const copy = original.subContext();
    copy.setCwd('/modified');
    copy.setEnv({ KEY: 'modified' });

    assertEquals(original.getCwd(), '/original');
    assertEquals(original.getEnv()['KEY'], 'original');
  });

  await t.step('subContext copies IO settings', () => {
    const original = new ExecContext();
    original.redirectStdin('in.txt');
    original.redirectStdout('out.txt');
    original.redirectStderr('err.txt');

    const copy = original.subContext();
    assertEquals(copy.getStdin(), 'in.txt');
    assertEquals(copy.getStdout(), 'out.txt');
    assertEquals(copy.getStderr(), 'err.txt');
  });

  await t.step('subContext copies functions', () => {
    const original = new ExecContext();
    const mockBody = { type: 'CompoundList', commands: [] } as never;
    original.setFunction('testfn', mockBody, original);

    const copy = original.subContext();
    const fn = copy.getFunction('testfn');
    assertEquals(fn?.name, 'testfn');
  });

  await t.step('subContext copies aliases', () => {
    const original = new ExecContext();
    original.setAlias('ll', 'ls -la');

    const copy = original.subContext();
    assertEquals(copy.getAlias('ll'), 'ls -la');
  });
});

Deno.test('ExecContext - Functions', async (t) => {
  await t.step('setFunction registers a function', () => {
    const ctx = new ExecContext();
    const mockBody = { type: 'CompoundList', commands: [] } as never;
    ctx.setFunction('myfunc', mockBody, ctx);

    const fn = ctx.getFunction('myfunc');
    assertEquals(fn?.name, 'myfunc');
    assertEquals(fn?.body, mockBody);
  });

  await t.step('getFunction returns falsy for undefined function', () => {
    const ctx = new ExecContext();
    assertEquals(!!ctx.getFunction('nonexistent'), false);
  });

  await t.step('unsetFunction removes a function', () => {
    const ctx = new ExecContext();
    const mockBody = { type: 'CompoundList', commands: [] } as never;
    ctx.setFunction('myfunc', mockBody, ctx);

    ctx.unsetFunction('myfunc');
    assertEquals(!!ctx.getFunction('myfunc'), false);
  });

  await t.step('getFunctions returns all functions', () => {
    const ctx = new ExecContext();
    const mockBody1 = { type: 'CompoundList', commands: [] } as never;
    const mockBody2 = { type: 'CompoundList', commands: [] } as never;

    ctx.setFunction('fn1', mockBody1, ctx);
    ctx.setFunction('fn2', mockBody2, ctx);

    const fns = ctx.getFunctions();
    assertEquals(Object.keys(fns).length, 2);
    assertEquals(fns['fn1']?.name, 'fn1');
    assertEquals(fns['fn2']?.name, 'fn2');
  });

  await t.step('child context function set affects parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();
    const mockBody = { type: 'CompoundList', commands: [] } as never;

    child.setFunction('childfn', mockBody, child);
    assertEquals(parent.getFunction('childfn')?.name, 'childfn');
  });

  await t.step('child context inherits parent functions', () => {
    const parent = new ExecContext();
    const mockBody = { type: 'CompoundList', commands: [] } as never;
    parent.setFunction('parentfn', mockBody, parent);

    const child = parent.spawnContext();
    assertEquals(child.getFunction('parentfn')?.name, 'parentfn');
  });

  await t.step('unsetFunction on child unsets from parent', () => {
    const parent = new ExecContext();
    const mockBody = { type: 'CompoundList', commands: [] } as never;
    parent.setFunction('fn', mockBody, parent);

    const child = parent.spawnContext();
    child.unsetFunction('fn');

    assertEquals(!!parent.getFunction('fn'), false);
  });

  await t.step('unsetFunction on nonexistent function is safe', () => {
    const ctx = new ExecContext();
    ctx.unsetFunction('nonexistent');
    assertEquals(!!ctx.getFunction('nonexistent'), false);
  });
});

Deno.test('ExecContext - Aliases', async (t) => {
  await t.step('setAlias adds an alias', () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -la');
    assertEquals(ctx.getAlias('ll'), 'ls -la');
  });

  await t.step('getAlias returns undefined for unknown alias', () => {
    const ctx = new ExecContext();
    assertEquals(ctx.getAlias('unknown'), undefined);
  });

  await t.step('unsetAlias removes an alias', () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -la');
    ctx.unsetAlias('ll');
    assertEquals(ctx.getAlias('ll'), undefined);
  });

  await t.step('unsetAlias on nonexistent alias is safe', () => {
    const ctx = new ExecContext();
    ctx.unsetAlias('nonexistent');
    assertEquals(ctx.getAlias('nonexistent'), undefined);
  });

  await t.step('child context alias set affects parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.setAlias('ll', 'ls -la');
    assertEquals(parent.getAlias('ll'), 'ls -la');
  });

  await t.step('child context inherits parent aliases', () => {
    const parent = new ExecContext();
    parent.setAlias('ll', 'ls -la');

    const child = parent.spawnContext();
    assertEquals(child.getAlias('ll'), 'ls -la');
  });

  await t.step('child context unsetAlias affects parent', () => {
    const parent = new ExecContext();
    parent.setAlias('ll', 'ls -la');

    const child = parent.spawnContext();
    child.unsetAlias('ll');

    assertEquals(parent.getAlias('ll'), undefined);
  });
});

Deno.test('ExecContext - IO Redirections', async (t) => {
  await t.step('redirectStdin changes stdin', () => {
    const ctx = new ExecContext();
    ctx.redirectStdin('input.txt');
    assertEquals(ctx.getStdin(), 'input.txt');
  });

  await t.step('redirectStdin returns new value', () => {
    const ctx = new ExecContext();
    const result = ctx.redirectStdin('file.txt');
    assertEquals(result, 'file.txt');
  });

  await t.step('redirectStdout changes stdout', () => {
    const ctx = new ExecContext();
    ctx.redirectStdout('output.txt');
    assertEquals(ctx.getStdout(), 'output.txt');
  });

  await t.step('redirectStdout returns new value', () => {
    const ctx = new ExecContext();
    const result = ctx.redirectStdout('file.txt');
    assertEquals(result, 'file.txt');
  });

  await t.step('redirectStderr changes stderr', () => {
    const ctx = new ExecContext();
    ctx.redirectStderr('error.txt');
    assertEquals(ctx.getStderr(), 'error.txt');
  });

  await t.step('redirectStderr returns new value', () => {
    const ctx = new ExecContext();
    const result = ctx.redirectStderr('file.txt');
    assertEquals(result, 'file.txt');
  });

  await t.step('redirectStdout with append flag', () => {
    const ctx = new ExecContext();
    assertEquals(ctx.getStdoutAppend(), false);

    ctx.redirectStdout('file.txt', true);
    assertEquals(ctx.getStdoutAppend(), true);
    assertEquals(ctx.getStdout(), 'file.txt');
  });

  await t.step('redirectStdout without append flag resets append', () => {
    const ctx = new ExecContext();
    ctx.redirectStdout('file.txt', true);
    assertEquals(ctx.getStdoutAppend(), true);

    ctx.redirectStdout('other.txt', false);
    assertEquals(ctx.getStdoutAppend(), false);
  });

  await t.step('redirectStderr with append flag', () => {
    const ctx = new ExecContext();
    assertEquals(ctx.getStderrAppend(), false);

    ctx.redirectStderr('file.txt', true);
    assertEquals(ctx.getStderrAppend(), true);
    assertEquals(ctx.getStderr(), 'file.txt');
  });

  await t.step('redirectStderr without append flag resets append', () => {
    const ctx = new ExecContext();
    ctx.redirectStderr('file.txt', true);
    assertEquals(ctx.getStderrAppend(), true);

    ctx.redirectStderr('other.txt', false);
    assertEquals(ctx.getStderrAppend(), false);
  });

  await t.step('IO changes in child do not affect parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.redirectStdin('child_input.txt');
    child.redirectStdout('child_output.txt');
    child.redirectStderr('child_error.txt');

    assertEquals(parent.getStdin(), '0');
    assertEquals(parent.getStdout(), '1');
    assertEquals(parent.getStderr(), '2');
  });
});

Deno.test('ExecContext - Multi-level Parent Chain', async (t) => {
  await t.step('grandchild inherits from grandparent', () => {
    const grandparent = new ExecContext();
    grandparent.setEnv({ LEVEL: 'grandparent' });

    const parent = grandparent.spawnContext();
    const child = parent.spawnContext();

    assertEquals(child.getEnv()['LEVEL'], 'grandparent');
  });

  await t.step('grandchild env changes propagate to grandparent', () => {
    const grandparent = new ExecContext();
    const parent = grandparent.spawnContext();
    const child = parent.spawnContext();

    child.setEnv({ NEW_VAR: 'from_grandchild' });
    assertEquals(grandparent.getEnv()['NEW_VAR'], 'from_grandchild');
  });

  await t.step('grandchild cwd changes propagate to grandparent', () => {
    const grandparent = new ExecContext();
    grandparent.setCwd('/grandparent');

    const parent = grandparent.spawnContext();
    const child = parent.spawnContext();

    child.setCwd('/grandchild');
    assertEquals(grandparent.getCwd(), '/grandchild');
  });

  await t.step('local env at different levels', () => {
    const grandparent = new ExecContext();
    grandparent.setLocalEnv({ LEVEL: 'gp' });

    const parent = grandparent.spawnContext();
    parent.setLocalEnv({ LEVEL: 'p' });

    const child = parent.spawnContext();
    child.setLocalEnv({ LEVEL: 'c' });

    // Child sees its own local value merged with parent chain
    assertEquals(child.getEnv()['LEVEL'], 'c');
    assertEquals(parent.getEnv()['LEVEL'], 'p');
    assertEquals(grandparent.getEnv()['LEVEL'], 'gp');
  });
});
