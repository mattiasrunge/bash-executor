// import { TestShell } from './lib/test-shell.ts';

// Deno.test('executor', async (t) => {
//   await t.step('execute a simple bash script', async () => {
//     const shell = new TestShell();

//     const bashScript = `echo "Hello, World!"`;
//     await shell.run(bashScript);
//   });

//   await t.step('execute an advanced bash script', async () => {
//     const shell = new TestShell();

//     const bashScript = `VAR=123 echo "Hello, World!" | grep "Hello" > file.txt`;
//     await shell.run(bashScript);
//   });

//   await t.step('execute a bash function', async () => {
//     const shell = new TestShell();

//     const bashScript = `
//     hello() {
//       echo "Hello, World!"
//     }

//     hello
//   `;
//     await shell.run(bashScript);
//   });

//   await t.step('execute a bash artithmic operation', async () => {
//     const shell = new TestShell();

//     const bashScript = `echo $((1+2))`;
//     await shell.run(bashScript);
//   });

//   await t.step('execute a piped command', async () => {
//     const shell = new TestShell();

//     const bashScript = `echo "Hello, World!" | grep "Hello" | wc -l`;
//     await shell.run(bashScript);
//   });

//   await t.step('execute a bash script with if', async () => {
//     const shell = new TestShell();

//     const bashScript = `#!/bin/bash

// # Define a variable
// value=5.1

// # Check the value using if, elif, and else
// if [ $value -lt 5 ]; then
//   echo "The value is less than 5."
// elif [ $value -eq 10 ]; then
//   echo "The value is equal to 10."
// else
//   echo "The value is greater than 5 but not equal to 10."
// fi
//   `;
//     await shell.run(bashScript);
//   });
// });
