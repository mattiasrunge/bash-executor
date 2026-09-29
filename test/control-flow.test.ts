import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('If Statements', async (t) => {
  await t.step('if with true condition executes then block', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if true; then
        echo "yes"
      fi
    `);
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('if with false condition skips then block', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if false; then
        echo "yes"
      fi
    `);
    assertEquals(result.stdout, '');
  });

  await t.step('if-else executes else block on false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if false; then
        echo "yes"
      else
        echo "no"
      fi
    `);
    assertEquals(result.stdout, 'no\n');
  });

  await t.step('if-elif-else chain', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '2' });
    const result = await shell.runAndCapture(`
      if [ $x -eq 1 ]; then
        echo "one"
      elif [ $x -eq 2 ]; then
        echo "two"
      else
        echo "other"
      fi
    `);
    assertEquals(result.stdout, 'two\n');
  });

  await t.step('nested if statements', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if true; then
        if true; then
          echo "nested"
        fi
      fi
    `);
    assertEquals(result.stdout, 'nested\n');
  });

  await t.step('if with test command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x=5
      if test $x -gt 3; then
        echo "greater"
      fi
    `);
    assertEquals(result.stdout, 'greater\n');
  });

  await t.step('if with [ ] brackets', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x="hello"
      if [ "$x" = "hello" ]; then
        echo "match"
      fi
    `);
    assertEquals(result.stdout, 'match\n');
  });

  await t.step('if with arithmetic condition', async () => {
    const shell = new TestShell();
    // Use [ ] for comparison to avoid parser issue with > in (( ))
    const result = await shell.runAndCapture(`
      x=10
      if [ $x -gt 5 ]; then
        echo "big"
      fi
    `);
    assertEquals(result.stdout, 'big\n');
  });
});

Deno.test('While Loops', async (t) => {
  await t.step('while loop executes while condition is true', async () => {
    const shell = new TestShell();
    // Note: Using i=$((i+1)) instead of (( i++ )) because postfix increment
    // returns 0 when i=0, causing exit code 1 which stops the compound list
    const result = await shell.runAndCapture(`
      i=0
      while [ $i -lt 3 ]; do
        echo $i
        i=$((i + 1))
      done
    `);
    assertEquals(result.stdout, '0\n1\n2\n');
  });

  await t.step('while loop with false condition never executes', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      while false; do
        echo "never"
      done
    `);
    assertEquals(result.stdout, '');
  });

  await t.step('while loop with arithmetic condition', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=3
      while [ $i -gt 0 ]; do
        echo $i
        i=$((i - 1))
      done
    `);
    assertEquals(result.stdout, '3\n2\n1\n');
  });
});

Deno.test('Loop Control - Break', async (t) => {
  await t.step('break exits while loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=0
      while true; do
        echo $i
        i=$((i + 1))
        if [ $i -eq 3 ]; then
          break
        fi
      done
      echo "done"
    `);
    assertEquals(result.stdout, '0\n1\n2\ndone\n');
  });

  await t.step('break exits for loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2 3 4 5; do
        if [ $i -eq 3 ]; then
          break
        fi
        echo $i
      done
    `);
    assertEquals(result.stdout, '1\n2\n');
  });
});

Deno.test('Loop Control - Continue', async (t) => {
  await t.step('continue skips to next iteration in while', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=0
      while [ $i -lt 5 ]; do
        i=$((i + 1))
        if [ $i -eq 3 ]; then
          continue
        fi
        echo $i
      done
    `);
    assertEquals(result.stdout, '1\n2\n4\n5\n');
  });

  await t.step('continue skips to next iteration in for', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2 3 4 5; do
        if [ $i -eq 3 ]; then
          continue
        fi
        echo $i
      done
    `);
    assertEquals(result.stdout, '1\n2\n4\n5\n');
  });

  await t.step('&& continue skips only matching iteration', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for mod in core media extra; do
        [ "$mod" = "core" ] && continue
        echo $mod
      done
    `);
    assertEquals(result.stdout, 'media\nextra\n');
  });
});

Deno.test('Until Loops', async (t) => {
  await t.step('until loop executes until condition is true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=0
      until [ $i -ge 3 ]; do
        echo $i
        i=$((i + 1))
      done
    `);
    assertEquals(result.stdout, '0\n1\n2\n');
  });

  await t.step('until loop with initially true condition never executes', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      until true; do
        echo "never"
      done
    `);
    assertEquals(result.stdout, '');
  });
});

Deno.test('For Loops', async (t) => {
  await t.step('for loop iterates over word list', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for item in a b c; do
        echo $item
      done
    `);
    assertEquals(result.stdout, 'a\nb\nc\n');
  });

  await t.step('for loop with numbers', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for n in 1 2 3; do
        echo "num: $n"
      done
    `);
    assertEquals(result.stdout, 'num: 1\nnum: 2\nnum: 3\n');
  });

  await t.step('for loop with quoted strings', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for word in "hello world" "foo bar"; do
        echo "$word"
      done
    `);
    assertEquals(result.stdout, 'hello world\nfoo bar\n');
  });

  await t.step('for loop with command expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for item in $(echo x y z); do
        echo $item
      done
    `);
    assertEquals(result.stdout, 'x\ny\nz\n');
  });

  await t.step('empty for loop word list', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for item in; do
        echo "never"
      done
      echo "done"
    `);
    assertEquals(result.stdout, 'done\n');
  });

  await t.step('word list is expanded once, before the first iteration', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      list="a b"
      for item in $list $list; do
        list="changed"
        echo $item
      done
    `);
    assertEquals(result.stdout, 'a\nb\na\nb\n');
  });
});

// A body that fails is ordinary — `for f in *; do grep x $f; done` runs to the
// end. Aborting the loop instead turned a scan into a silent "nothing found".
Deno.test('Arithmetic For Loops', async (t) => {
  await t.step('init, test and update', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for ((i=0; i<3; i++)); do
        echo "i=$i"
      done
    `);
    assertEquals(result.stdout, 'i=0\ni=1\ni=2\n');
  });

  await t.step('spaced, no separator before do, two variables', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`for (( i = 0, j = 3 ; i < j ; i++, j-- )) do echo "$i $j"; done`);
    assertEquals(result.stdout, '0 3\n1 2\n');
  });

  await t.step('continue still runs the update', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`for ((i=0; i<4; i++)); do (( i == 1 )) && continue; echo $i; done`);
    assertEquals(result.stdout, '0\n2\n3\n');
  });

  await t.step('no test runs until break', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`n=0; for ((;;)); do n=$((n+1)); (( n >= 3 )) && break; done; echo $n`);
    assertEquals(result.stdout, '3\n');
  });

  await t.step('a false test never runs the body, and the variable stays set', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`for ((i=5; i<3; i++)); do echo no; done; echo $i`);
    assertEquals(result.stdout, '5\n');
  });

  await t.step('while with a comparison in (( ))', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`i=0; while (( i < 3 )); do echo $i; i=$((i+1)); done`);
    assertEquals(result.stdout, '0\n1\n2\n');
  });
});

Deno.test('Loops - failing body', async (t) => {
  await t.step('for loop runs every iteration when the body fails', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2 3; do
        echo "i=$i"
        false
      done
      echo "after=$?"
    `);
    assertEquals(result.stdout, 'i=1\ni=2\ni=3\nafter=1\n');
  });

  await t.step('while loop runs every iteration when the body fails', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      n=0
      while [ $n -lt 3 ]; do
        n=$((n + 1))
        false
      done
      echo "n=$n after=$?"
    `);
    assertEquals(result.stdout, 'n=3 after=1\n');
  });

  await t.step('until loop runs every iteration when the body fails', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      n=0
      until [ $n -ge 3 ]; do
        n=$((n + 1))
        false
      done
      echo "n=$n after=$?"
    `);
    assertEquals(result.stdout, 'n=3 after=1\n');
  });

  await t.step('loop status is the status of the last iteration', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2; do
        [ $i -eq 1 ]
      done
      echo "after=$?"
    `);
    assertEquals(result.stdout, 'after=1\n');
  });

  await t.step('exit in the body still ends the script', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2 3; do
        echo "i=$i"
        [ $i -eq 2 ] && exit 7
      done
      echo "not reached"
    `);
    assertEquals(result.stdout, 'i=1\ni=2\n');
    assertEquals(result.exitCode, 7);
  });

  await t.step('return in the body still leaves the function', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      f() {
        for i in 1 2 3; do
          echo "i=$i"
          [ $i -eq 2 ] && return 3
        done
        echo "not reached"
      }
      f
      echo "after=$?"
    `);
    assertEquals(result.stdout, 'i=1\ni=2\nafter=3\n');
  });

  await t.step('a failing command substitution iterates over nothing, not out of the loop', async () => {
    const shell = new TestShell();
    shell.mockCommand('events', async (_ctx, args) => {
      // Only "b" has no events — the other two must still be counted.
      return args[0] === 'b' ? { code: 1, stderr: 'no such directory\n' } : { code: 0, stdout: `${args[0]}1\n${args[0]}2\n` };
    });
    const result = await shell.runAndCapture(`
      total=0
      for p in a b c; do
        for e in $(events $p); do
          total=$((total + 1))
        done
      done
      echo "total=$total"
    `);
    assertEquals(result.stdout, 'total=4\n');
  });

  await t.step('a loop feeding a pipe writes every iteration', async () => {
    const shell = new TestShell();
    shell.mockCommand('events', async (_ctx, args) => {
      return args[0] === 'b' ? { code: 1 } : { code: 0, stdout: `${args[0]}1\n` };
    });
    const result = await shell.runAndCapture(`for p in a b c; do events $p; done | wc -l`);
    assertEquals(result.stdout, '2\n');
  });

  await t.step('break and continue are only loop control as a command name', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in break continue; do
        echo $i
      done
      echo "done"
    `);
    assertEquals(result.stdout, 'break\ncontinue\ndone\n');
  });

  await t.step('break N and continue N leave N loops', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in a b; do for j in x y; do echo $i$j; break 2; done; echo end-$i; done
      for i in a b; do for j in x y; do echo $i$j; continue 2; done; echo end-$i; done
      for i in a; do while :; do break 9; done; echo not-here; done
      echo "done $?"
    `);
    assertEquals(result.stdout, 'ax\nax\nbx\ndone 0\n');
  });

  await t.step('break outside a loop, a function called from one included, complains and does nothing', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      f() { break; }
      break; echo "status $?"
      for i in 1 2; do f; echo $i; done
    `);
    assertEquals(result.stdout, 'status 0\n1\n2\n');
    assertEquals(result.stderr.match(/only meaningful/g)?.length, 3);
  });
});

Deno.test('Case Statements', async (t) => {
  await t.step('case matches exact pattern', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'foo' });
    const result = await shell.runAndCapture(`
      case $x in
        foo) echo "matched foo" ;;
        bar) echo "matched bar" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched foo\n');
  });

  await t.step('case with no match', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'baz' });
    const result = await shell.runAndCapture(`
      case $x in
        foo) echo "foo" ;;
        bar) echo "bar" ;;
      esac
    `);
    assertEquals(result.stdout, '');
  });

  await t.step('case with default pattern *', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'unknown' });
    const result = await shell.runAndCapture(`
      case $x in
        foo) echo "foo" ;;
        *) echo "default" ;;
      esac
    `);
    assertEquals(result.stdout, 'default\n');
  });

  await t.step('case with multiple patterns using |', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'yes' });
    const result = await shell.runAndCapture(`
      case $x in
        yes|y|Y) echo "affirmative" ;;
        no|n|N) echo "negative" ;;
      esac
    `);
    assertEquals(result.stdout, 'affirmative\n');
  });

  await t.step('case with glob pattern', async () => {
    const shell = new TestShell();
    shell.setParams({ file: 'test.txt' });
    const result = await shell.runAndCapture(`
      case $file in
        *.txt) echo "text file" ;;
        *.jpg) echo "image" ;;
      esac
    `);
    assertEquals(result.stdout, 'text file\n');
  });

  // Test case with literal (no variable expansion needed)
  await t.step('case with literal clause', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      case foo in
        foo) echo "matched" ;;
        bar) echo "bar" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('quoted parts of a pattern match literally', async () => {
    const shell = new TestShell();
    shell.setParams({ PATH: '/bin:/x/bin' });
    const result = await shell.runAndCapture(`
      case ":$PATH:" in
        *":/x/bin:"*) echo "present" ;;
        *) echo "absent" ;;
      esac
    `);
    assertEquals(result.stdout, 'present\n');
  });

  await t.step('quoted pattern falls through when not contained', async () => {
    const shell = new TestShell();
    shell.setParams({ PATH: '/bin' });
    const result = await shell.runAndCapture(`
      case ":$PATH:" in
        *":/x/bin:"*) echo "present" ;;
        *) echo "absent" ;;
      esac
    `);
    assertEquals(result.stdout, 'absent\n');
  });

  await t.step('variables expand inside patterns', async () => {
    const shell = new TestShell();
    shell.setParams({ pat: 'foo', x: 'foo' });
    const result = await shell.runAndCapture(`
      case $x in
        $pat) echo "var matched" ;;
        *) echo "no" ;;
      esac
    `);
    assertEquals(result.stdout, 'var matched\n');
  });

  await t.step('unquoted variable pattern keeps globs active', async () => {
    const shell = new TestShell();
    shell.setParams({ pat: '*.txt', file: 'notes.txt' });
    const result = await shell.runAndCapture(`
      case $file in
        $pat) echo "glob from var" ;;
        *) echo "no" ;;
      esac
    `);
    assertEquals(result.stdout, 'glob from var\n');
  });

  await t.step('double-quoted variable pattern is literal', async () => {
    const shell = new TestShell();
    shell.setParams({ pat: '*.txt', file: 'notes.txt' });
    const result = await shell.runAndCapture(`
      case $file in
        "$pat") echo "literal star" ;;
        *) echo "fallthrough" ;;
      esac
    `);
    assertEquals(result.stdout, 'fallthrough\n');
  });

  await t.step('quoted glob characters are literal', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      case '*' in
        "*") echo "literal star matched" ;;
        x) echo "no" ;;
      esac
    `);
    assertEquals(result.stdout, 'literal star matched\n');
  });

  await t.step('backslash-escaped glob character is literal', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'a*b' });
    const result = await shell.runAndCapture(`
      case $x in
        a\\*b) echo "escaped" ;;
        *) echo "no" ;;
      esac
    `);
    assertEquals(result.stdout, 'escaped\n');
  });

  await t.step('single-quoted pattern is fully literal', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      case 'a?c' in
        'a?c') echo "single quoted" ;;
        *) echo "no" ;;
      esac
    `);
    assertEquals(result.stdout, 'single quoted\n');
  });
});

Deno.test('$? inside compound bodies', async (t) => {
  await t.step('if body sees the exit code of its own last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if true; then
        false
        echo $?
      fi
    `);
    assertEquals(result.stdout, '1\n');
  });

  await t.step('else body sees the exit code of its own last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if false; then
        echo no
      else
        false
        echo $?
      fi
    `);
    assertEquals(result.stdout, '1\n');
  });

  await t.step('the capture-and-retry idiom sees the failure', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      STATUS=1
      if true; then
        false
        STATUS=$?
      fi
      if [ $STATUS -ne 0 ]; then
        echo "retry"
      fi
    `);
    assertEquals(result.stdout, 'retry\n');
  });

  await t.step('while body sees the exit code of its own last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      n=0
      while [ $n -lt 1 ]; do
        false
        echo $?
        n=1
      done
    `);
    assertEquals(result.stdout, '1\n');
  });

  await t.step('for body sees the exit code of its own last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1; do
        false
        echo $?
      done
    `);
    assertEquals(result.stdout, '1\n');
  });

  await t.step('group sees the exit code of its own last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      { false; echo $?; }
    `);
    assertEquals(result.stdout, '1\n');
  });

  await t.step('function body sees the exit code of its own last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      f() {
        false
        echo $?
      }
      f
    `);
    assertEquals(result.stdout, '1\n');
  });

  await t.step('a body that runs nothing leaves $? alone', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      false
      if [ 1 -eq 1 ]; then
        :
      fi
      echo $?
    `);
    assertEquals(result.stdout, '0\n');
  });
});

Deno.test('case patterns: extended, and quoted parts literal', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('for f in a.c b.o "x*"; do case $f in *.@(c|h)) echo "$f src";; "x*") echo "$f star";; *) echo "$f other";; esac; done');
  assertEquals(result.stdout, 'a.c src\nb.o other\nx* star\n');
});

Deno.test('ANSI-C and locale strings in patterns', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture(`z=$'\\t'; case "$z" in $'\\t') echo tab;; esac; case x in $"x") echo loc;; esac; [[ $'a\\tb' =~ ^a$'\\t'b$ ]] && echo re`);
  assertEquals(result.stdout, 'tab\nloc\nre\n');
});

Deno.test('a case subject is neither split nor globbed', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture(
    'set -- a b c; IFS=:; case $* in a:b:c) echo one;; esac; x=a:b; case $x in *\\:*) echo two;; esac; IFS=" "; case * in \\*) echo three;; esac',
  );
  assertEquals(result.stdout, 'one\ntwo\nthree\n');
});

Deno.test('case: ;& falls through, ;;& tests on', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('case foobar in bar) echo skip ;; foo*) echo retest ;;& *bar) echo fall ;& x) echo in ;; y) echo no ;; esac');
  assertEquals(result.stdout, 'retest\nfall\nin\n');
});

Deno.test('select', async (t) => {
  await t.step('menu and prompt on stderr, the choice and REPLY set, 1 at the end of input', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('printf "2\\nzz\\n" | { select x in a b; do echo "x=$x REPLY=$REPLY"; done; echo "st=$?"; }');
    assertEquals(result.stdout, 'x=b REPLY=2\nx= REPLY=zz\nst=1\n');
    assertEquals(result.stderr, '1) a\n2) b\n#? #? #? \n');
  });

  await t.step('break ends it', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('select x in a b; do echo "$x"; break; done <<< 1; echo "st=$?"');
    assertEquals(result.stdout, 'a\nst=0\n');
  });
});

Deno.test('for without in goes over the positional parameters', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('set -- p q; for i; do echo "$i"; done; for j do echo "$j"; done');
  assertEquals(result.stdout, 'p\nq\np\nq\n');
});

Deno.test('arithmetic commands bash allows', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('(( )); echo "e=$?"; if ((1)) then echo yes; fi; for ((i=0; i < 2; i++)) { echo $i; }; echo $((1 ? 20 : (x+=2)))');
  assertEquals(result.stdout, 'e=1\nyes\n0\n1\n20\n');
});

Deno.test('! alone and repeated', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('!; echo $?; ! !; echo $?; ! ! true; echo $?; ! ! ! true; echo $?');
  assertEquals(result.stdout, '1\n0\n0\n1\n');
});

Deno.test('for with a name that is not one fails when it runs', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('for 1 in a b; do echo x; done; echo "st=$?"');
  assertEquals(result.stdout, 'st=1\n');
  assertEquals(result.stderr, "`1': not a valid identifier\n");
});
