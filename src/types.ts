import type { AstNode, AstNodeCompoundList } from '@ein/bash-parser';

export type FunctionDef = {
  name: string;
  body: AstNodeCompoundList;
  ctx: ExecContextIf;
};

export type IO = {
  stdin: string;
  stdout: string;
  stderr: string;
};

export type ExecCommandOptions = {
  async?: boolean;
};

export interface ShellIf {
  execSyncCommand: (
    ctx: ExecContextIf,
    name: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;

  execCommand: (
    ctx: ExecContextIf,
    name: string,
    args: string[],
    opts: ExecCommandOptions,
  ) => Promise<number>;

  execSubshell: (
    ctx: ExecContextIf,
    cmd: AstNode,
    opts: ExecCommandOptions,
  ) => Promise<number>;

  pipeOpen: () => Promise<string>;
  pipeClose: (name: string) => Promise<void>;
  pipeRemove: (name: string) => Promise<void>;
  pipeRead: (name: string) => Promise<string>;

  run: (script: string) => Promise<number>;
}

export interface ExecContextIf {
  spawnContext: () => ExecContextIf;

  getCwd: () => string;

  setCwd: (cwd: string) => string;

  getEnv: () => Record<string, string>;

  setEnv: (values: Record<string, string | null>) => Record<string, string>;

  setLocalEnv: (
    values: Record<string, string | null>,
  ) => Record<string, string>;

  getParams: () => Record<string, string>;

  setParams: (values: Record<string, string | null>) => Record<string, string>;

  setLocalParams: (
    values: Record<string, string | null>,
  ) => Record<string, string>;

  setFunction: (
    name: string,
    body: AstNodeCompoundList,
    ctx: ExecContextIf,
  ) => void;

  unsetFunction: (name: string) => void;

  getFunction: (name: string) => FunctionDef | null;

  redirectStdin: (name: string) => string;

  redirectStdout: (name: string) => string;

  redirectStderr: (name: string) => string;

  getStdin: () => string;

  getStdout: () => string;

  getStderr: () => string;
}
