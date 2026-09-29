import { assertEquals } from '@std/assert';
import { printfBuiltin } from '../../src/builtins/printf.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

// Mock shell
const mockShell: ShellIf = {
  execute: async () => 0,
  pipeOpen: async () => 'pipe',
  pipeClose: async () => {},
  pipeRemove: async () => {},
  pipeRead: async () => '',
  pipeWrite: async () => {},
  isPipe: () => true,
  pipeFromFile: async () => {},
  pipeToFile: async () => {},
};

Deno.test('printf builtin', async (t) => {
  await t.step('no arguments returns error', async () => {
    const ctx = new ExecContext();
    const result = await printfBuiltin(ctx, [], mockShell, noopExecute);
    // bash's usage status, and its usage line
    assertEquals(result.code, 2);
    assertEquals(result.stderr, 'printf: usage: printf [-v var] format [arguments]\n');
  });

  await t.step('prints literal string', async () => {
    const ctx = new ExecContext();
    const result = await printfBuiltin(ctx, ['hello world'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, 'hello world');
  });

  await t.step('string format specifiers', async (t) => {
    await t.step('%s substitutes string', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['Hello %s!', 'World'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'Hello World!');
    });

    await t.step('multiple %s substitutions', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%s + %s = %s', 'a', 'b', 'ab'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'a + b = ab');
    });

    await t.step('%s with width', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['[%10s]', 'test'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '[      test]');
    });

    await t.step('%-s left aligns', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['[%-10s]', 'test'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '[test      ]');
    });

    await t.step('%.precision truncates string', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%.3s', 'hello'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hel');
    });
  });

  await t.step('integer format specifiers', async (t) => {
    await t.step('%d formats decimal', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%d', '42'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '42');
    });

    await t.step('%i formats decimal', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%i', '42'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '42');
    });

    await t.step('%d with width', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['[%5d]', '42'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '[   42]');
    });

    await t.step('%o formats octal', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%o', '8'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '10');
    });

    await t.step('%x formats lowercase hex', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%x', '255'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'ff');
    });

    await t.step('%X formats uppercase hex', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%X', '255'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'FF');
    });
  });

  await t.step('floating point format specifiers', async (t) => {
    await t.step('%f formats float', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%f', '3.14159'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '3.141590');
    });

    await t.step('%.2f with precision', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%.2f', '3.14159'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '3.14');
    });

    await t.step('%e formats scientific', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%.2e', '1234'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      // @std/fmt uses two-digit exponent (e+03) instead of bash's (e+3)
      assertEquals(result.stdout, '1.23e+03');
    });
  });

  await t.step('character format specifier', async (t) => {
    await t.step('%c prints first character', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['%c', 'abc'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'a');
    });
  });

  await t.step('escape sequences', async (t) => {
    await t.step('\\n produces newline', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['hello\\nworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\nworld');
    });

    await t.step('\\t produces tab', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['col1\\tcol2'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'col1\tcol2');
    });

    await t.step('\\\\ produces backslash', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['path\\\\file'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'path\\file');
    });
  });

  await t.step('percent escape', async (t) => {
    await t.step('%% produces literal percent', async () => {
      const ctx = new ExecContext();
      const result = await printfBuiltin(ctx, ['100%%'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '100%');
    });
  });

  await t.step('missing arguments use empty string', async () => {
    const ctx = new ExecContext();
    const result = await printfBuiltin(ctx, ['%s and %s', 'first'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, 'first and ');
  });
});

Deno.test('printf reuses the format for extra arguments', async (t) => {
  await t.step('one specifier, three arguments', async () => {
    const result = await printfBuiltin(new ExecContext(), ['%s-', 'a', 'b', 'c'], mockShell, noopExecute);
    assertEquals(result.stdout, 'a-b-c-');
  });

  await t.step('a last round short of arguments fills in empty', async () => {
    const result = await printfBuiltin(new ExecContext(), ['[%s %s]', 'a', 'b', 'c'], mockShell, noopExecute);
    assertEquals(result.stdout, '[a b][c ]');
  });

  await t.step('a format without specifiers runs once', async () => {
    const result = await printfBuiltin(new ExecContext(), ['x\\n', 'a', 'b'], mockShell, noopExecute);
    assertEquals(result.stdout, 'x\n');
  });

  await t.step('%% does not consume an argument', async () => {
    const result = await printfBuiltin(new ExecContext(), ['%d%%\\n', '1', '2'], mockShell, noopExecute);
    assertEquals(result.stdout, '1%\n2%\n');
  });
});

Deno.test('printf -v assigns instead of printing', async (t) => {
  await t.step('sets the variable, prints nothing', async () => {
    const ctx = new ExecContext();
    const result = await printfBuiltin(ctx, ['-v', 'out', '%05d', '42'], mockShell, noopExecute);
    assertEquals(result.stdout, undefined);
    assertEquals(ctx.getParams().out, '00042');
  });

  await t.step('an invalid name is an error', async () => {
    const result = await printfBuiltin(new ExecContext(), ['-v', '1x', '%s', 'a'], mockShell, noopExecute);
    assertEquals(result.code, 2);
  });
});

Deno.test('printf as bash has it', async (t) => {
  const printf = async (...args: string[]) => (await printfBuiltin(new ExecContext(), args, mockShell, noopExecute)).stdout;

  await t.step("numbers: hex, octal, and a quote for a character's code", async () => {
    assertEquals(await printf('%d %d %d %#x', "'A", '0x1f', '010', "'\x7f"), '65 31 8 0x7f');
  });

  await t.step('%b expands escapes, and \\c ends all output', async () => {
    assertEquals(await printf('%b|', 'a\\tb', 'x\\cy', 'z'), 'a\tb|x');
  });

  await t.step('%q quotes to read back', async () => {
    assertEquals(await printf('%q|%q|%q|%q', 'a b', "it's", '', 'x\ty'), "a\\ b|it\\'s|''|$'x\\ty'");
  });
});

Deno.test("printf: C conversions on 64-bit integers, * widths, and bash's own", async (t) => {
  const printf = async (...args: string[]) => await printfBuiltin(new ExecContext(), args, mockShell, noopExecute);
  const out = async (...args: string[]) => (await printf(...args)).stdout;

  await t.step('integers: flags, precision, 64 bits, unsigned', async () => {
    assertEquals(
      await out('%05d|%+d|%.3d|%#x|%#o|%u|%d', '42', '42', '7', '255', '8', '-1', '9223372036854775807'),
      '00042|+42|007|0xff|010|18446744073709551615|9223372036854775807',
    );
  });

  await t.step('floats: %f %e %g %a as C writes them', async () => {
    assertEquals(await out('%.2f|%e|%g|%g|%a', '3.14159', '31415.9', '0.0001', '1234567', '3'), '3.14|3.141590e+04|0.0001|1.23457e+06|0xcp-2');
  });

  await t.step('* takes the width and precision from the arguments, a negative width left-justifies', async () => {
    assertEquals(await out('%*s|%-*s|%.*f|%*s|', '6', 'x', '6', 'y', '2', '3.14159', '-3', 'z'), '     x|y     |3.14|z  |');
  });

  await t.step('a huge width is only padding', async () => {
    assertEquals((await out('%50000d', '1'))!.length, 50000);
  });

  await t.step('an invalid number is said before the output it belongs to, and fails', async () => {
    const result = await printf('%d\n', 'GNU', '12abc');
    assertEquals(result.code, 1);
    assertEquals(result.output, [{ stderr: 'printf: GNU: invalid number\n', stdout: '0\n' }, { stderr: 'printf: 12abc: invalid number\n', stdout: '12\n' }]);
  });

  await t.step('%n stores the count so far, %c of nothing is NUL', async () => {
    const ctx = new ExecContext();
    const result = await printfBuiltin(ctx, ['%s%n|%c', 'abc', 'v', ''], mockShell, noopExecute);
    assertEquals([result.stdout, ctx.getParams()['v']], ['abc|\0', '3']);
  });

  await t.step('%(…)T in the zone TZ names', async () => {
    const ctx = new ExecContext();
    ctx.setEnv({ TZ: 'EST5EDT' });
    const result = await printfBuiltin(ctx, ['%(%F %r %Z %z)T', '1275250155'], mockShell, noopExecute);
    assertEquals(result.stdout, '2010-05-30 04:09:15 PM EDT -0400');
  });
});
