import type { Pty, SpawnPty } from '../connectClaude';

export interface FakePty extends Pty {
  file: string;
  args: string[];
  cols: number;
  env: Record<string, string | undefined>;
  written: string[];
  emit: (data: string) => void;
  exit: (exitCode: number) => void;
}

/** A pty that prints what the test says, and records every spawn. */
export const createFakeSpawn = (): {
  spawn: SpawnPty;
  spawned: FakePty[];
} => {
  const spawned: FakePty[] = [];

  const spawn: SpawnPty = (file, args, options) => {
    const listeners: {
      data: ((data: string) => void)[];
      exit: ((event: { exitCode: number }) => void)[];
    } = { data: [], exit: [] };
    const pty: FakePty = {
      file,
      args,
      cols: options.cols,
      env: options.env,
      written: [],
      onData: (listener) => {
        listeners.data = [...listeners.data, listener];
      },
      onExit: (listener) => {
        listeners.exit = [...listeners.exit, listener];
      },
      write: (data) => {
        pty.written = [...pty.written, data];
      },
      kill: () => undefined,
      emit: (data) => listeners.data.forEach((listener) => listener(data)),
      exit: (exitCode) =>
        listeners.exit.forEach((listener) => listener({ exitCode })),
    };
    spawned.splice(spawned.length, 0, pty);

    return pty;
  };

  return { spawn, spawned };
};

/** A token-shaped string built at run time, never a literal in the source. */
export const FAKE_TOKEN = [
  'sk',
  'ant',
  'oat01',
  'FAKE_pawnee-PARKS_0123456789abcdefghijklmnopqrstuvwxyz',
].join('-');
