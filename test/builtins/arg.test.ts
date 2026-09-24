import { assertEquals, assertStringIncludes } from '@std/assert';
import { argBuiltin } from '../../src/builtins/arg.ts';
import { getExitCode, isExitSignal } from '../../src/builtins/exit.ts';
import { ExecContext } from '../../src/context.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof argBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('arg builtin', async (t) => {
  await t.step('declaration parsing', async (t) => {
    await t.step('--desc sets command description', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['--desc', 'Test command'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('required positional arg', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('optional positional arg with default', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['[<title>]', 'string', '=', 'Mr', 'Title prefix'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('long option', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('short and long option', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['-p', '--port', 'number', 'Port number'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('option with default', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['--port', 'number', '=', '8080', 'Port number'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('flag (boolean)', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['-v', '--verbose', 'Enable verbose mode'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('error on missing arguments', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr!, 'missing arguments');
    });

    await t.step('error on invalid type', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['<name>', 'invalid', 'Description'], mockShell, noopExecute);
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr!, 'invalid type');
    });
  });

  await t.step('--export parsing', async (t) => {
    await t.step('exports positional argument', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'alice',
        '#': '1',
      });

      await argBuiltin(ctx, ['<username>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['USERNAME'], 'alice');
    });

    await t.step('exports optional positional with default', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'alice',
        '#': '1',
      });

      await argBuiltin(ctx, ['<username>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['[<title>]', 'string', '=', 'User', 'Title'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['USERNAME'], 'alice');
      assertEquals(ctx.getEnv()['TITLE'], 'User');
    });

    await t.step('exports flag as 1 when set', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--verbose',
        '#': '1',
      });

      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['VERBOSE'], '1');
    });

    await t.step('exports flag as empty when not set', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
      });

      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['VERBOSE'], '');
    });

    await t.step('exports option with value', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--port',
        '2': '3000',
        '#': '2',
      });

      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['PORT'], '3000');
    });

    await t.step('exports option with = syntax', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--port=3000',
        '#': '1',
      });

      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['PORT'], '3000');
    });

    await t.step('handles mixed positionals and options', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'alice',
        '2': '--verbose',
        '3': '--port',
        '4': '8080',
        '#': '4',
      });

      await argBuiltin(ctx, ['<username>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['USERNAME'], 'alice');
      assertEquals(ctx.getEnv()['VERBOSE'], '1');
      assertEquals(ctx.getEnv()['PORT'], '8080');
    });

    await t.step('applies option default when not provided', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
      });

      await argBuiltin(ctx, ['--port', 'number', '=', '8080', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['PORT'], '8080');
    });
  });

  await t.step('--help handling', async (t) => {
    await t.step('exits with signal 0 on --help', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--help',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 0);
    });

    await t.step('exits with signal 0 on -h', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '-h',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 0);
    });

    await t.step('generates help text with usage', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--help',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['--desc', 'Test command'], mockShell, noopExecute);
      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertStringIncludes(result.stdout!, 'Usage: myscript');
      assertStringIncludes(result.stdout!, '<name>');
      assertStringIncludes(result.stdout!, 'Test command');
      assertStringIncludes(result.stdout!, '--verbose');
      assertStringIncludes(result.stdout!, '-h, --help');
    });

    await t.step('answers with the spec itself when JSON_OUTPUT is set', async () => {
      // A script that declares its arguments knows them as precisely as a compiled command
      // knows its spec. A caller that asked for JSON — a tool-schema generator, or an agent
      // reading a command's help — wants that structure rather than a usage block to parse,
      // and above all wants to know which flags take a value: `--out FILE` and `-v` look the
      // same in rendered help.
      const ctx = new ExecContext();
      ctx.setEnv({ JSON_OUTPUT: '1' });
      ctx.setParams({ '1': '--help', '#': '1', '0': 'myscript' });

      await argBuiltin(ctx, ['--desc', 'Test command'], mockShell, noopExecute);
      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['[<count>]', 'number', '=', '3', 'How many'], mockShell, noopExecute);
      await argBuiltin(ctx, ['-o', '--out', 'string', 'Where to write'], mockShell, noopExecute);
      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      const spec = JSON.parse(result.stdout!) as {
        name: string;
        description: string;
        args: { name: string; type: string; optional?: boolean }[];
        flags: { name: string; type: string; short?: string }[];
      };
      assertEquals(spec.name, 'myscript');
      assertEquals(spec.description, 'Test command');
      assertEquals(spec.args.map((a) => [a.name, a.type, a.optional ?? false]), [['name', 'string', false], ['count', 'number', true]]);
      assertEquals(spec.flags.find((f) => f.name === 'out')?.type, 'string');
      assertEquals(spec.flags.find((f) => f.name === 'out')?.short, 'o');
      // The distinction the whole thing is for: a switch is typed, not just undescribed.
      assertEquals(spec.flags.find((f) => f.name === 'verbose')?.type, 'bool');
    });

    await t.step('--example and --returns reach both shapes of help', async () => {
      const json = new ExecContext();
      json.setEnv({ JSON_OUTPUT: '1' });
      json.setParams({ '1': '--help', '#': '1', '0': 'myscript' });
      await argBuiltin(json, ['--desc', 'Test command'], mockShell, noopExecute);
      await argBuiltin(json, ['--example', 'myscript --out /tmp/x'], mockShell, noopExecute);
      await argBuiltin(json, ['--returns', 'the rows it wrote'], mockShell, noopExecute);
      const spec = JSON.parse((await argBuiltin(json, ['--export'], mockShell, noopExecute)).stdout!) as {
        examples: string[];
        returns: string;
      };
      assertEquals(spec.examples, ['myscript --out /tmp/x']);
      assertEquals(spec.returns, 'the rows it wrote');

      const text = new ExecContext();
      text.setParams({ '1': '--help', '#': '1', '0': 'myscript' });
      await argBuiltin(text, ['--desc', 'Test command'], mockShell, noopExecute);
      await argBuiltin(text, ['--example', 'myscript --out /tmp/x'], mockShell, noopExecute);
      await argBuiltin(text, ['--returns', 'the rows it wrote'], mockShell, noopExecute);
      const rendered = (await argBuiltin(text, ['--export'], mockShell, noopExecute)).stdout!;
      assertStringIncludes(rendered, 'Returns:');
      assertStringIncludes(rendered, 'Examples:');
      assertStringIncludes(rendered, 'myscript --out /tmp/x');
    });

    await t.step('--effect, --writes and --group reach the spec', async () => {
      const json = new ExecContext();
      json.setEnv({ JSON_OUTPUT: '1' });
      json.setParams({ '1': '--help', '#': '1', '0': 'myscript' });
      await argBuiltin(json, ['<command>', 'string', 'list, active or set'], mockShell, noopExecute);
      await argBuiltin(json, ['--out', 'string', 'where to write'], mockShell, noopExecute);
      await argBuiltin(json, ['--effect', 'read'], mockShell, noopExecute);
      await argBuiltin(json, ['--writes', 'command', 'set'], mockShell, noopExecute);
      await argBuiltin(json, ['--writes', '--out'], mockShell, noopExecute);
      await argBuiltin(json, ['--group'], mockShell, noopExecute);
      const spec = JSON.parse((await argBuiltin(json, ['--export'], mockShell, noopExecute)).stdout!) as {
        effect: string;
        group: boolean;
        args: { name: string; writes?: unknown }[];
        flags: { name: string; writes?: unknown }[];
      };
      assertEquals(spec.effect, 'read');
      assertEquals(spec.group, true);
      assertEquals(spec.args[0].writes, ['set']);
      assertEquals(spec.flags.find((f) => f.name === 'out')?.writes, true);
      assertEquals((await argBuiltin(new ExecContext(), ['--effect', 'maybe'], mockShell, noopExecute)).code, 1);
    });

    await t.step('renders text help when JSON_OUTPUT is not set', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ '1': '--help', '#': '1', '0': 'myscript' });
      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);
      assertStringIncludes(result.stdout!, 'Usage: myscript');
    });
  });

  await t.step('error handling', async (t) => {
    await t.step('exits with error on missing required arg', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'Missing required argument');
    });

    await t.step('exits with error on unknown option', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--unknown',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'Unknown option');
    });

    await t.step('validates number type', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--port',
        '2': 'abc',
        '#': '2',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'numeric value');
    });

    await t.step('suggests --help on error', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertStringIncludes(result.stderr!, '--help');
    });
  });

  await t.step('-- separator', async () => {
    const ctx = new ExecContext();
    ctx.setParams({
      '1': '--',
      '2': '--name',
      '#': '2',
    });

    await argBuiltin(ctx, ['<arg>', 'string', 'Argument'], mockShell, noopExecute);
    await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

    // --name should be treated as a positional after --
    assertEquals(ctx.getEnv()['ARG'], '--name');
  });

  await t.step('short option -x with value', async () => {
    const ctx = new ExecContext();
    ctx.setParams({
      '1': '-p',
      '2': '3000',
      '#': '2',
    });

    await argBuiltin(ctx, ['-p', '--port', 'number', 'Port number'], mockShell, noopExecute);
    await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

    assertEquals(ctx.getEnv()['PORT'], '3000');
  });

  await t.step('context isolation', async () => {
    // Registry should be per-context (different root contexts)
    const ctx1 = new ExecContext();
    const ctx2 = new ExecContext();

    await argBuiltin(ctx1, ['<name>', 'string', 'Name'], mockShell, noopExecute);

    // ctx2 should have no registry
    ctx2.setParams({ '#': '0' });
    const result = await argBuiltin(ctx2, ['--export'], mockShell, noopExecute);

    // Should succeed with no error (no args defined means nothing to do)
    assertEquals(result.code, 0);
  });

  await t.step('spawned context shares registry with root', async () => {
    // This tests the real-world scenario where each arg command
    // runs in a different spawned context (via executeCommand)
    const root = new ExecContext();
    root.setParams({
      '1': 'alice',
      '2': '--verbose',
      '#': '2',
    });

    // Simulate how the executor spawns a new context for each command
    const ctx1 = root.spawnContext();
    await argBuiltin(ctx1, ['<username>', 'string', 'User name'], mockShell, noopExecute);

    const ctx2 = root.spawnContext();
    await argBuiltin(ctx2, ['-v', '--verbose', 'Enable verbose mode'], mockShell, noopExecute);

    const ctx3 = root.spawnContext();
    await argBuiltin(ctx3, ['--export'], mockShell, noopExecute);

    // Values should be exported to the environment (visible via root due to propagation)
    assertEquals(root.getEnv()['USERNAME'], 'alice');
    assertEquals(root.getEnv()['VERBOSE'], '1');
  });

  await t.step('subContext creates isolated registry', async () => {
    // subContext creates a completely independent context (no parent link)
    // This simulates script A calling script B
    const scriptA = new ExecContext();
    scriptA.setParams({ '1': 'from-A', '#': '1' });

    await argBuiltin(scriptA.spawnContext(), ['<name>', 'string', 'Name'], mockShell, noopExecute);

    // Script B gets its own isolated context via subContext
    const scriptB = scriptA.subContext();
    scriptB.setParams({ '1': 'from-B', '#': '1' });

    await argBuiltin(scriptB.spawnContext(), ['<value>', 'string', 'Value'], mockShell, noopExecute);
    await argBuiltin(scriptB.spawnContext(), ['--export'], mockShell, noopExecute);

    // Script B should have its own exported value
    assertEquals(scriptB.getEnv()['VALUE'], 'from-B');
    // Script B should NOT have Script A's registry
    assertEquals(scriptB.getEnv()['NAME'], undefined);
  });

  await t.step('--rest', async (t) => {
    // Read $1..$# back out of a context the way a subsequent command would.
    const positionals = (ctx: ExecContext): string[] => {
      const params = ctx.getParams();
      const count = parseInt(params['#'] || '0', 10);
      const out: string[] = [];
      for (let i = 1; i <= count; i++) out.push(params[String(i)]);
      return out;
    };

    await t.step('leaves unconsumed args in $@ after --export', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'create',
        '2': '/people/anna',
        '3': '--name',
        '4': 'Anna',
        '5': '--gender',
        '6': 'female',
        '#': '6',
      });

      await argBuiltin(ctx, ['<subcommand>', 'string', 'Subcommand'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--rest'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      // Declared positional consumed and exported
      assertEquals(ctx.getEnv()['SUBCOMMAND'], 'create');
      // Everything after it is forwarded verbatim via the positionals
      assertEquals(positionals(ctx), ['/people/anna', '--name', 'Anna', '--gender', 'female']);
      assertEquals(ctx.getParams()['#'], '5');
    });

    await t.step('does not error on undeclared options', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ '1': 'info', '2': '--verbose', '#': '2' });

      await argBuiltin(ctx, ['<subcommand>', 'string', 'Subcommand'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--rest'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(result.code, 0);
      assertEquals(ctx.getEnv()['SUBCOMMAND'], 'info');
      assertEquals(positionals(ctx), ['--verbose']);
    });

    await t.step('empty rest leaves no positionals', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ '1': 'list', '#': '1' });

      await argBuiltin(ctx, ['<subcommand>', 'string', 'Subcommand'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--rest'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['SUBCOMMAND'], 'list');
      assertEquals(positionals(ctx), []);
      assertEquals(ctx.getParams()['#'], '0');
    });

    await t.step('rewrite propagates to root across spawned contexts', async () => {
      // Mirrors the executor: each `arg` command runs in its own spawned child
      // of the script context, so the rewrite must land on root to be visible
      // to the forwarding command that follows.
      const root = new ExecContext();
      root.setParams({ '1': 'set-parent', '2': '/people/anna', '3': 'mother', '#': '3' });

      await argBuiltin(root.spawnContext(), ['<subcommand>', 'string', 'Subcommand'], mockShell, noopExecute);
      await argBuiltin(root.spawnContext(), ['--rest'], mockShell, noopExecute);
      await argBuiltin(root.spawnContext(), ['--export'], mockShell, noopExecute);

      assertEquals(root.getEnv()['SUBCOMMAND'], 'set-parent');
      assertEquals(positionals(root), ['/people/anna', 'mother']);
    });

    await t.step('without --rest, surplus args still error', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ '1': 'create', '2': 'extra', '#': '2' });

      await argBuiltin(ctx, ['<subcommand>', 'string', 'Subcommand'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'Unexpected argument');
    });
  });
});
