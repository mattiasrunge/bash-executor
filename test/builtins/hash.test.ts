import { assertEquals } from '@std/assert';
import type { ExecContextIf } from '../../src/types.ts';
import { TestShell } from '../lib/test-shell.ts';

/** A shell whose PATH holds /usr/bin/tool, and that says what it ran. */
class PathShell extends TestShell {
  ran: string[] = [];

  async lookupCommand(_ctx: ExecContextIf, name: string): Promise<string[]> {
    return await Promise.resolve(name === 'tool' ? ['/usr/bin/tool'] : name.includes('/') ? [name] : []);
  }

  override async execute(ctx: ExecContextIf, name: string, args: string[], opts: { async?: boolean }): Promise<number> {
    this.ran.push(name);
    return await super.execute(ctx, name, args, opts);
  }
}

Deno.test('hash builtin', async (t) => {
  await t.step('an empty table says so', async () => {
    const shell = new PathShell();

    assertEquals((await shell.runAndCapture('hash')).stdout, 'hash: hash table empty\n');
  });

  await t.step('hashes from PATH, lists with hits, and runs the hashed file', async () => {
    const shell = new PathShell();
    const result = await shell.runAndCapture('hash tool; hash -p /opt/x x; x; x; hash; hash -t x; hash -l; echo "${BASH_CMDS[tool]}"');

    assertEquals(shell.ran, ['/opt/x', '/opt/x']);
    assertEquals(
      result.stdout,
      // In bash's order, which is that of its hash table's buckets
      'hits\tcommand\n   2\t/opt/x\n   0\t/usr/bin/tool\n/opt/x\nbuiltin hash -p /opt/x x\nbuiltin hash -p /usr/bin/tool tool\n/usr/bin/tool\n',
    );
  });

  await t.step('a name PATH does not have is an error', async () => {
    const shell = new PathShell();
    const result = await shell.runAndCapture('hash nothere');

    assertEquals(result.exitCode, 1);
    assertEquals(result.stderr, 'hash: nothere: not found\n');
  });

  await t.step('-d forgets one, -r and a new PATH forget them all', async () => {
    const shell = new PathShell();
    const result = await shell.runAndCapture('hash -p /a a; hash -p /b b; hash -d a; hash -t b; PATH=/bin; hash; hash -p /c c; hash -r; hash');

    assertEquals(result.stdout, '/b\nhash: hash table empty\nhash: hash table empty\n');
  });

  await t.step('type reports a hashed command', async () => {
    const shell = new PathShell();
    const result = await shell.runAndCapture('hash -p /opt/x x; type x; type -t x; type -p x');

    assertEquals(result.stdout, 'x is hashed (/opt/x)\nfile\n/opt/x\n');
  });
});
