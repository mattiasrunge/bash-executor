/*
 * exec-as NAME PATH [ARG ...]: run PATH with NAME as its argv[0].
 *
 * Deno starts a program by its resolved path, which the program then calls
 * itself — `/usr/bin/grep: x: No such file` where bash's child says `grep:`.
 * bash-ts starts its commands through this instead, as bash would name them.
 */
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fputs("usage: exec-as name path [arg ...]\n", stderr);
    return 2;
  }

  char *path = argv[2];

  argv[2] = argv[1];
  execv(path, argv + 2);
  perror(path);

  return 126;
}
