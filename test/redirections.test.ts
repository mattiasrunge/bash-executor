import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Stdout Redirection', async (t) => {
  await t.step('> redirects stdout to file', async () => {
    const shell = new TestShell();
    let capturedCtxStdout = '';
    let capturedCtxAppend = false;
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStdout = ctx.getStdout();
      capturedCtxAppend = ctx.getStdoutAppend();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx > output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStdout, 'output.txt');
    assertEquals(capturedCtxAppend, false);
  });

  await t.step('>> redirects stdout with append', async () => {
    const shell = new TestShell();
    let capturedCtxStdout = '';
    let capturedCtxAppend = false;
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStdout = ctx.getStdout();
      capturedCtxAppend = ctx.getStdoutAppend();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx >> output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStdout, 'output.txt');
    assertEquals(capturedCtxAppend, true);
  });
});

Deno.test('Stderr Redirection', async (t) => {
  await t.step('2> redirects stderr to file', async () => {
    const shell = new TestShell();
    let capturedCtxStderr = '';
    let capturedCtxAppend = false;
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStderr = ctx.getStderr();
      capturedCtxAppend = ctx.getStderrAppend();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx 2> error.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStderr, 'error.txt');
    assertEquals(capturedCtxAppend, false);
  });

  await t.step('2>> redirects stderr with append', async () => {
    const shell = new TestShell();
    let capturedCtxStderr = '';
    let capturedCtxAppend = false;
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStderr = ctx.getStderr();
      capturedCtxAppend = ctx.getStderrAppend();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx 2>> error.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStderr, 'error.txt');
    assertEquals(capturedCtxAppend, true);
  });
});

Deno.test('Stdin Redirection', async (t) => {
  await t.step('< redirects stdin from file', async () => {
    const shell = new TestShell();
    let capturedCtxStdin = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStdin = ctx.getStdin();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx < input.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStdin, 'input.txt');
  });
});

Deno.test('File Descriptor Duplication', async (t) => {
  await t.step('>& redirects stdout', async () => {
    const shell = new TestShell();
    let capturedCtxStdout = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStdout = ctx.getStdout();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx >& output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStdout, 'output.txt');
  });

  await t.step('2>& redirects stderr', async () => {
    const shell = new TestShell();
    let capturedCtxStderr = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedCtxStderr = ctx.getStderr();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx 2>& error.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedCtxStderr, 'error.txt');
  });
});

Deno.test('Multiple Redirections', async (t) => {
  await t.step('stdout and stderr to different files', async () => {
    const shell = new TestShell();
    let capturedStdout = '';
    let capturedStderr = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedStdout = ctx.getStdout();
      capturedStderr = ctx.getStderr();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx > out.txt 2> err.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedStdout, 'out.txt');
    assertEquals(capturedStderr, 'err.txt');
  });

  await t.step('stdin and stdout redirections', async () => {
    const shell = new TestShell();
    let capturedStdin = '';
    let capturedStdout = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedStdin = ctx.getStdin();
      capturedStdout = ctx.getStdout();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('getctx < in.txt > out.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedStdin, 'in.txt');
    assertEquals(capturedStdout, 'out.txt');
  });
});

Deno.test('Redirection in Compound Lists', async (t) => {
  await t.step('braced group with redirections', async () => {
    const shell = new TestShell();
    let capturedStdout = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedStdout = ctx.getStdout();
      return { code: 0 };
    });
    const result = await shell.runAndCapture('{ getctx; } > output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedStdout, 'output.txt');
  });

  // Note: Redirections on if/for/while/function are not propagated to inner commands
  // in the current implementation. These tests document the current behavior.
  await t.step('command-level redirection in if body', async () => {
    const shell = new TestShell();
    let capturedStdout = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedStdout = ctx.getStdout();
      return { code: 0 };
    });
    // Redirection on the command itself works
    const result = await shell.runAndCapture('if true; then getctx > output.txt; fi');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedStdout, 'output.txt');
  });

  await t.step('command-level redirection in for body', async () => {
    const shell = new TestShell();
    let capturedStdout = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedStdout = ctx.getStdout();
      return { code: 0 };
    });
    // Redirection on the command itself works
    const result = await shell.runAndCapture('for i in 1; do getctx > output.txt; done');
    assertEquals(result.exitCode, 0);
    assertEquals(capturedStdout, 'output.txt');
  });
});

Deno.test('Function Definition and Invocation', async (t) => {
  await t.step('function with command-level redirections', async () => {
    const shell = new TestShell();
    let capturedStdout = '';
    shell.mockCommand('getctx', async (ctx) => {
      capturedStdout = ctx.getStdout();
      return { code: 0 };
    });
    // Redirection on command inside function works
    const result = await shell.runAndCapture(`
      myfunc() {
        getctx > output.txt
      }
      myfunc
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(capturedStdout, 'output.txt');
  });
});
