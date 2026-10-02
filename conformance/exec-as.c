/*
 * exec-as NAME PATH [ARG ...]: run PATH with NAME as its argv[0].
 *
 * Deno starts a program by its resolved path, which the program then calls
 * itself — `/usr/bin/grep: x: No such file` where bash's child says `grep:`.
 * bash-ts starts its commands through this instead, as bash would name them.
 *
 * Deno can neither close a child's stdin, stdout or stderr nor hand it any
 * other descriptor, which bash's `cmd >&-` and `cmd 3<&0` do, nor start it
 * ignoring a signal, as `trap '' SIG` makes bash's children. BASH_TS_FDPLAN
 * says what to do first, in order: `-N` closes N, `N=M` makes N a copy of M,
 * `!S` ignores signal S.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void plan(void) {
  char *text = getenv("BASH_TS_FDPLAN");

  if (!text) return;

  text = strdup(text);
  unsetenv("BASH_TS_FDPLAN");

  for (char *step = strtok(text, " "); step; step = strtok(NULL, " ")) {
    if (step[0] == '-') {
      close(atoi(step + 1));
    } else if (step[0] == '!') {
      signal(atoi(step + 1), SIG_IGN);
    } else {
      char *eq = strchr(step, '=');

      if (eq) dup2(atoi(eq + 1), atoi(step));
    }
  }

  free(text);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fputs("usage: exec-as name path [arg ...]\n", stderr);
    return 2;
  }

  char *path = argv[2];

  plan();
  argv[2] = argv[1];
  execv(path, argv + 2);
  perror(path);

  return 126;
}
