import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Stdout Redirection', async (t) => {
  await t.step('> redirects stdout to file', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo hello > output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '');
    assertEquals(shell.getFile('output.txt'), 'hello\n');
  });

  await t.step('>> redirects stdout with append', async () => {
    const shell = new TestShell();
    shell.setFile('output.txt', 'existing\n');
    const result = await shell.runAndCapture('echo appended >> output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '');
    assertEquals(shell.getFile('output.txt'), 'existing\nappended\n');
  });
});

Deno.test('Stderr Redirection', async (t) => {
  await t.step('2> redirects stderr to file', async () => {
    const shell = new TestShell();
    shell.mockCommand('errcmd', async () => ({ code: 0, stderr: 'error output\n' }));
    const result = await shell.runAndCapture('errcmd 2> error.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stderr, '');
    assertEquals(shell.getFile('error.txt'), 'error output\n');
  });

  await t.step('2>> redirects stderr with append', async () => {
    const shell = new TestShell();
    shell.setFile('error.txt', 'existing error\n');
    shell.mockCommand('errcmd', async () => ({ code: 0, stderr: 'new error\n' }));
    const result = await shell.runAndCapture('errcmd 2>> error.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stderr, '');
    assertEquals(shell.getFile('error.txt'), 'existing error\nnew error\n');
  });
});

Deno.test('Stdin Redirection', async (t) => {
  await t.step('< redirects stdin from file', async () => {
    const shell = new TestShell();
    shell.setFile('input.txt', 'file content\n');
    const result = await shell.runAndCapture('cat < input.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'file content\n');
  });
});

Deno.test('File Descriptor Duplication', async (t) => {
  await t.step('>& redirects stdout', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo hello >& output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('output.txt'), 'hello\n');
  });

  await t.step('2>& redirects stderr', async () => {
    const shell = new TestShell();
    shell.mockCommand('errcmd', async () => ({ code: 0, stderr: 'error\n' }));
    const result = await shell.runAndCapture('errcmd 2>& error.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('error.txt'), 'error\n');
  });
});

Deno.test('Multiple Redirections', async (t) => {
  await t.step('stdout and stderr to different files', async () => {
    const shell = new TestShell();
    shell.mockCommand('bothout', async () => ({ code: 0, stdout: 'out\n', stderr: 'err\n' }));
    const result = await shell.runAndCapture('bothout > out.txt 2> err.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('out.txt'), 'out\n');
    assertEquals(shell.getFile('err.txt'), 'err\n');
  });

  await t.step('stdin and stdout redirections', async () => {
    const shell = new TestShell();
    shell.setFile('in.txt', 'input data\n');
    const result = await shell.runAndCapture('cat < in.txt > out.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('out.txt'), 'input data\n');
  });
});

Deno.test('Redirection in Compound Lists', async (t) => {
  await t.step('braced group with redirections', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('{ echo hello; } > output.txt');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('output.txt'), 'hello\n');
  });

  await t.step('command-level redirection in if body', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('if true; then echo hello > output.txt; fi');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('output.txt'), 'hello\n');
  });

  await t.step('command-level redirection in for body', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('for i in 1; do echo hello > output.txt; done');
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('output.txt'), 'hello\n');
  });
});

Deno.test('Function Definition and Invocation', async (t) => {
  await t.step('function with command-level redirections', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      myfunc() {
        echo hello > output.txt
      }
      myfunc
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(shell.getFile('output.txt'), 'hello\n');
  });
});

Deno.test('Bidirectional File Descriptors', async (t) => {
  await t.step('exec 3<> opens file for read/write', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/data', 'line1\nline2\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/data
      read -u 3 first
      echo "$first"
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'line1\n');
  });

  await t.step('read -u 3 reads line-by-line from FD', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/data', 'aaa\nbbb\nccc\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/data
      read -u 3 a
      read -u 3 b
      read -u 3 c
      echo "$a $b $c"
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'aaa bbb ccc\n');
  });

  await t.step('echo >&3 writes to FD', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/out', '');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/out
      echo "hello" >&3
    `);
    assertEquals(result.exitCode, 0);
  });

  await t.step('exec 3>&- closes FD', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/data', 'test\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/data
      exec 3>&-
      read -u 3 line
    `);
    // read should fail since FD 3 is closed
    assertEquals(result.exitCode, 1);
  });

  await t.step('read -u returns 1 on EOF', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/empty', '');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/empty
      read -u 3 line
    `);
    assertEquals(result.exitCode, 1);
  });
});

Deno.test('Input FD Duplication', async (t) => {
  await t.step('<& redirects stdin from another FD', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/data', 'hello world\n');
    const result = await shell.runAndCapture(`
      exec 3<>/tmp/data
      read line <&3
      echo "$line"
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello world\n');
  });
});

Deno.test('Here-strings', async (t) => {
  await t.step('<<< feeds the word to stdin', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('read x <<< "a b"; echo "[$x]"');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '[a b]\n');
  });

  await t.step('the word is expanded first', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('V="p q"; read -a a <<< "$V"; echo "${#a[@]}"');
    assertEquals(result.stdout, '2\n');
  });

  await t.step('it works with read -a and with mapfile', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('mapfile -t L <<< "$(printf "a b\\nc d\\n")"; echo "${#L[@]} [${L[1]}]"');
    assertEquals(result.stdout, '2 [c d]\n');
  });

  await t.step('an IFS prefix applies to the read it precedes', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('IFS=: read a b <<< "x:y"; echo "$a-$b"');
    assertEquals(result.stdout, 'x-y\n');
  });
});

Deno.test('Here-documents', async (t) => {
  await t.step('a quoted delimiter writes the body as it is, markdown and all', async () => {
    const shell = new TestShell();
    const script = 'cat > /tmp/notes.md << \'EOF\'\n# Family\n- **Anna Exempel** (mother) $HOME `x` \\$y\n  "quoted"\nEOF\necho done';
    const result = await shell.runAndCapture(script);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'done\n');
    assertEquals(shell.getFile('/tmp/notes.md'), '# Family\n- **Anna Exempel** (mother) $HOME `x` \\$y\n  "quoted"\n');
  });

  await t.step('an unquoted delimiter expands parameters and commands; quotes stay ordinary text', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('NAME=Bo; cat <<EOF\nhi "$NAME" (${#NAME}) $(echo "sub") $((1 + 2)) \\$NAME \\"q\\"\nEOF');
    assertEquals(result.stdout, 'hi "Bo" (2) sub 3 $NAME \\"q\\"\n');
  });

  await t.step('<<- drops the leading tabs', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('cat <<-EOF\n\t\tone\n\ttwo\n\tEOF');
    assertEquals(result.stdout, 'one\ntwo\n');
  });

  await t.step('it feeds read and a pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('while read l; do echo "[$l]"; done <<EOF\na\nb\nEOF\ncat <<EOF | cat\npiped\nEOF');
    assertEquals(result.stdout, '[a]\n[b]\npiped\n');
  });
});

Deno.test('Redirections on compound commands', async (t) => {
  await t.step('a while loop reads its stdin from a file', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/lines', 'p\nq\n');
    const result = await shell.runAndCapture('while read l; do echo "[$l]"; done < /tmp/lines');
    assertEquals(result.stdout, '[p]\n[q]\n');
  });

  await t.step('a while loop reads a here-string', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('while read l; do echo "[$l]"; done <<< "$(printf "1\\n2\\n")"');
    assertEquals(result.stdout, '[1]\n[2]\n');
  });

  await t.step('an if command redirects too', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('if read l; then echo "got=$l"; fi <<< "hello"');
    assertEquals(result.stdout, 'got=hello\n');
  });

  await t.step('a group keeps the same stdin across its commands', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('{ read a; read b; echo "$a-$b"; } <<< "$(printf "x\\ny\\n")"');
    assertEquals(result.stdout, 'x-y\n');
  });

  await t.step('a subshell takes its own redirections, the complaint it ends with too', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(echo out; echo err >&2) > /tmp/o 2> /tmp/e\n(echo ${u?gone}) 2> /tmp/u\necho "st=$?"');
    assertEquals(result.stdout, 'st=1\n');
    assertEquals(result.stderr, '');
    assertEquals(shell.getFile('/tmp/o'), 'out\n');
    assertEquals(shell.getFile('/tmp/e'), 'err\n');
    assertEquals(shell.getFile('/tmp/u'), 'u: gone\n');
  });
});

Deno.test('exec opens a file once for the commands after it', async (t) => {
  await t.step('exec >file: every later command appends', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      exec >/tmp/out
      echo one
      echo two
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '');
    assertEquals(shell.getFile('/tmp/out'), 'one\ntwo\n');
  });

  await t.step('exec 3>file: >&3 writes accumulate', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/log', 'old\n');
    const result = await shell.runAndCapture(`
      exec 3>/tmp/log
      echo a >&3
      echo b >&3
      echo out
    `);
    assertEquals(result.stdout, 'out\n');
    assertEquals(shell.getFile('/tmp/log'), 'a\nb\n');
  });

  await t.step('exec 3>>file keeps what was there', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/log', 'old\n');
    await shell.runAndCapture(`
      exec 3>>/tmp/log
      echo new >&3
    `);
    assertEquals(shell.getFile('/tmp/log'), 'old\nnew\n');
  });

  await t.step('exec 3<file: read -u 3 reads it', async () => {
    const shell = new TestShell();
    shell.setFile('/tmp/in', 'first\nsecond\n');
    const result = await shell.runAndCapture(`
      exec 3</tmp/in
      read -u 3 a
      read -u 3 b
      echo "$b $a"
    `);
    assertEquals(result.stdout, 'second first\n');
  });
});

Deno.test('N>file on a command redirects fd N, not stdout', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture(`
    { echo to-three >&3; echo to-stdout; } 3>/tmp/three
  `);
  assertEquals(result.stdout, 'to-stdout\n');
  assertEquals(shell.getFile('/tmp/three'), 'to-three\n');
});

Deno.test('exec {name}>file puts a free descriptor in name', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture(`
    exec {v}>/tmp/named
    echo "v=$v"
    echo hi >&$v
    exec {v}>&-
  `);
  assertEquals(result.stdout, 'v=10\n');
  assertEquals(shell.getFile('/tmp/named'), 'hi\n');
});

Deno.test('redirections before the command name', async (t) => {
  await t.step(">file cmd writes cmd's output to the file", async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('>/tmp/pre echo hi');
    assertEquals(result.stdout, '');
    assertEquals(shell.getFile('/tmp/pre'), 'hi\n');
  });

  await t.step('a redirection alone creates the file', async () => {
    const shell = new TestShell();
    await shell.runAndCapture('> /tmp/empty');
    assertEquals(shell.getFile('/tmp/empty'), '');
  });

  await t.step('beside an assignment, which still happens', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=1 >/tmp/made; echo "x=$x"');
    assertEquals(result.stdout, 'x=1\n');
    assertEquals(shell.getFile('/tmp/made'), '');
  });
});

Deno.test('a builtin whose output cannot be written fails, and the script goes on', async () => {
  const shell = new TestShell();
  shell.setFile('/tmp/in', 'x\n');

  // A descriptor the host cannot write to, as a file opened only for reading
  const write = shell.pipeWrite.bind(shell);
  shell.pipeWrite = async (name: string, data: string) => {
    if (name === '3') throw new Error('Bad file descriptor');
    await write(name, data);
  };

  const result = await shell.runAndCapture('exec 3<>/tmp/in; echo hi >&3; echo "st=$?"');
  assertEquals(result.stdout, 'st=1\n');
  assertEquals(result.stderr, 'echo: write error: Bad file descriptor\n');
});

Deno.test("exec in the background leaves the shell's descriptors alone", async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('exec >/tmp/bg &\necho still; exec true &\necho alive');
  assertEquals(result.stdout, 'still\nalive\n');
  assertEquals(shell.getFile('/tmp/bg'), '');
});

Deno.test('a redirection word expands to one word, or the redirection is ambiguous', async (t) => {
  // Each expected text is bash 5.2's, bar the `bash: line N: ` before each message
  await t.step('two words, or none, write nowhere', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('z="a b"; echo hi > $z; echo $?; e=; echo hi > $e; echo $?; echo x > ""; echo $?');

    assertEquals(result.stdout, '1\n1\n1\n');
    assertEquals(result.stderr, '$z: ambiguous redirect\n$e: ambiguous redirect\n: No such file or directory\n');
    assertEquals([shell.getFile('a'), shell.getFile('/a')], ['', '']);
  });

  await t.step("a here-string's word is one word, split and globbed never", async () => {
    const result = await new TestShell().runAndCapture('x="a  b"; cat <<< $x; cat <<< *; cat <<< $nope');

    assertEquals(result.stdout, 'a  b\n*\n\n');
  });
});
