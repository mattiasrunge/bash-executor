import { assertEquals } from '@std/assert';
import { formatTimes, timeValue } from '../src/timing.ts';
import { TestShell } from './lib/test-shell.ts';

/** A shell whose CPU clock moves on by the same amount each time it is asked. */
const ticking = () => {
  const shell = new TestShell();
  let calls = 0;

  Object.assign(shell, {
    cpuTimes: async () => {
      calls++;
      return await { user: calls * 1.25, system: calls * 0.5, childrenUser: calls * 0.25, childrenSystem: 0 };
    },
  });

  return shell;
};

Deno.test('time', async (t) => {
  await t.step('reports what the command used in TIMEFORMAT, on stderr, and keeps its status', async () => {
    const result = await ticking().runAndCapture("TIMEFORMAT='u=%U s=%3S %%'; time false; echo $?");

    assertEquals(result.stdout, '1\n');
    assertEquals(result.stderr, 'u=1.500 s=0.500 %\n');
  });

  await t.step("-p writes POSIX's format whatever TIMEFORMAT says", async () => {
    const result = await ticking().runAndCapture('TIMEFORMAT=x; time -p true 2>&1 | cat');

    assertEquals(result.stderr.split('\n').slice(1), ['user 1.50', 'sys 0.50', '']);
  });

  await t.step('an empty TIMEFORMAT reports nothing, a bad one only complains', async () => {
    const result = await ticking().runAndCapture("TIMEFORMAT=; time true; TIMEFORMAT='%U %x'; time true; echo $?");

    assertEquals(result.stdout, '0\n');
    assertEquals(result.stderr, "TIMEFORMAT: `x': invalid format character\n");
  });

  await t.step('times ! negated, and on its own an empty command', async () => {
    const result = await ticking().runAndCapture('TIMEFORMAT=T; time ! true; echo $?; time; echo $?');

    assertEquals(result.stdout, '1\n0\n');
    assertEquals(result.stderr, 'T\nT\n');
  });

  await t.step("times writes the totals, the shell's and its commands'", async () => {
    const result = await ticking().runAndCapture('times');

    assertEquals(result.stdout, '0m1.250s 0m0.500s\n0m0.250s 0m0.000s\n');
  });
});

Deno.test('TIMEFORMAT escapes', () => {
  const times = { real: 75.4567, user: 0.5, system: 0.25 };

  assertEquals(formatTimes('%R|%0R|%1lR|%lU|%P', times).text, '75.456|75|1m15.4s|0m0.500s|0.99');
  assertEquals(timeValue(0.0999, 2, false), '0.09');
});

Deno.test('coproc', async (t) => {
  await t.step('the shell writes to NAME[1] and reads what the command answers from NAME[0]', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(
      'coproc ECHO { while read -r line; do echo "got $line"; done; }; echo ${ECHO[@]}; echo hi >&${ECHO[1]}; read -r reply <&${ECHO[0]}; echo "$reply"',
    );

    assertEquals(result.stdout, '63 60\ngot hi\n');
  });

  await t.step('unnamed it is COPROC, and closing NAME[1] ends its input', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(
      'coproc { n=0; while read -r l; do n=$((n+1)); done; echo "$n lines"; }; printf "a\\nb\\n" >&${COPROC[1]}; eval "exec ${COPROC[1]}>&-"; echo ${COPROC[@]}; read -r r <&${COPROC[0]}; echo "$r"',
    );

    assertEquals(result.stdout, '63 -1\n2 lines\n');
  });

  await t.step('a name that is no identifier is refused', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('coproc 1a { :; }; echo $?');

    assertEquals(result.stdout, '1\n');
    assertEquals(result.stderr, "`1a': not a valid identifier\n");
  });
});

Deno.test('moving a descriptor, N<&M-, closes M', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('coproc C { read -r x; echo "[$x]"; }; exec 4<&${C[0]}- 5>&${C[1]}-; echo ${C[@]}; echo in >&5; read -r y <&4; echo "$y"');

  assertEquals(result.stdout, '-1 -1\n[in]\n');
});
