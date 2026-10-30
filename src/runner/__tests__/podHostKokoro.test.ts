import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { audioHash } from '../../app/server/tts/timing';
import { eventually, tempHome } from '../../mothership/__tests__/harness';
import { type PodHost, createPodHost } from '../podHost';

/** Kokoro's model process, faked: answers each piece, or fails the warm-up. */
class FakeWorker extends EventEmitter {
  pid = undefined;
  killed = false;
  connected = true;
  sent: Record<string, unknown>[] = [];

  constructor(
    private readonly warmError?: string,
    /** Takes pieces and never answers them: a worker about to die. */
    private readonly silent = false
  ) {
    super();
  }

  send = (message: Record<string, unknown>): boolean => {
    this.sent = [...this.sent, message];

    if (this.silent && message.warm !== true) {
      return true;
    }

    const reply =
      message.warm === true && this.warmError !== undefined
        ? { id: message.id, error: this.warmError }
        : { id: message.id, samples: new Float32Array(240) };
    setImmediate(() => this.emit('message', reply));

    return true;
  };

  kill = (): boolean => {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');

    return true;
  };
}

const TTS_ENV = [
  'POD_TTS_PROVIDER',
  'LAMBDA_APP_BUNDLE',
  'LAMBDA_HOME',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_TTS_API_KEY',
] as const;

describe('a pod host with Kokoro', () => {
  const fixture: {
    dirs: string[];
    hosts: PodHost[];
    saved: Record<string, string | undefined>;
  } = { dirs: [], hosts: [], saved: {} };

  beforeEach(() => {
    const home = tempHome();
    fixture.dirs = [home];
    fixture.hosts = [];
    fixture.saved = Object.fromEntries(
      TTS_ENV.map((name) => [name, process.env[name]])
    );
    TTS_ENV.forEach((name) => delete process.env[name]);
    process.env.POD_TTS_PROVIDER = 'kokoro';
    process.env.LAMBDA_APP_BUNDLE = '/Applications/Lambda.app';
    process.env.LAMBDA_HOME = home;
  });

  afterEach(() => {
    fixture.hosts.forEach((host) => host.dispose());
    TTS_ENV.forEach((name) => {
      const value = fixture.saved[name];

      if (value === undefined) {
        delete process.env[name];

        return;
      }

      process.env[name] = value;
    });
    fixture.dirs.forEach((dir) =>
      fs.rmSync(dir, { recursive: true, force: true })
    );
  });

  const make = (warmError?: string, silentFirst = false) => {
    const folder = tempHome();
    fs.writeFileSync(
      path.join(folder, 'lambda.json'),
      JSON.stringify({ name: 'Pawnee Parks site' })
    );
    fixture.dirs = [...fixture.dirs, folder];
    const forked: { workers: FakeWorker[]; lines: string[] } = {
      workers: [],
      lines: [],
    };
    const host = createPodHost({
      folder,
      lambda: async () => '',
      spawnLambda: () => spawn('true'),
      tmux: () => '',
      onChange: () => undefined,
      log: (line) => {
        forked.lines = [...forked.lines, line];
      },
      isCurrent: () => true,
      env: { LAMBDA_HOME: process.env.LAMBDA_HOME },
      forkKokoro: () => {
        const worker = new FakeWorker(
          warmError,
          silentFirst && forked.workers.length === 0
        );
        forked.workers = [...forked.workers, worker];

        return worker;
      },
    });
    fixture.hosts = [...fixture.hosts, host];
    host.store.writePod({
      id: 'lot-48',
      slug: 'lot-48',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: '2026-01-01T00:00:00Z',
      worktreePath: folder,
      ownsWorktree: false,
      managerCwd: folder,
      devCwd: folder,
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });

    return { host, forked };
  };

  const TEXT = 'Leslie wants the pit filled in by Friday.';

  it('starts no model process until audio is first asked for', async () => {
    const { host, forked } = make();

    expect(forked.workers).toHaveLength(0);

    await host.handle('tts/clip', 'lot-48', { text: TEXT });

    expect(forked.workers).toHaveLength(1);
  });

  it('stops its model process when it is disposed', async () => {
    const listeners = process.listenerCount('exit');
    const { host, forked } = make();
    await host.handle('tts/clip', 'lot-48', { text: TEXT });

    host.dispose();

    expect(forked.workers.map((worker) => worker.killed)).toEqual([true]);
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('says so in its log when the model fails to load', async () => {
    const { host, forked } = make('the model download failed');

    await host.handle('tts/clip', 'lot-48', { text: TEXT });

    await eventually(() =>
      forked.lines.some(
        (line) =>
          line.startsWith('tts ') && line.includes('the model download failed')
      )
    );
  });

  it('speaks a reply through Kokoro, never ElevenLabs, with no key', async () => {
    const { host, forked } = make();
    host.store.appendThread({
      id: 'mreply1',
      podId: 'lot-48',
      from: 'manager',
      mode: 'async',
      text: TEXT,
      createdAt: '2026-10-03T01:00:00Z',
    });
    const fetched = jest.spyOn(global, 'fetch');

    try {
      const reply = await host.handle('tts-stream', 'lot-48', {
        msgId: 'mreply1',
      });

      expect(reply).toMatchObject({ base64: expect.any(String) });
      expect(forked.workers).toHaveLength(1);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });

  const pieceSent = (worker: FakeWorker | undefined) =>
    worker?.sent.some((message) => message.warm !== true) === true;

  it.each([
    ['exits', (worker: FakeWorker) => worker.emit('exit', 1, null)],
    [
      'errors (its channel closed)',
      (worker: FakeWorker) =>
        worker.emit('error', new Error('ERR_IPC_CHANNEL_CLOSED')),
    ],
  ])(
    'fails the clip when its model process %s mid-render, and starts a new one',
    async (_, die) => {
      const { host, forked } = make(undefined, true);
      const first = host.handle('tts/clip', 'lot-48', { text: TEXT });
      await eventually(() => pieceSent(forked.workers[0]));
      const [dead] = forked.workers;

      if (dead === undefined) {
        throw new Error('No worker was started');
      }

      die(dead);
      await expect(first).resolves.not.toMatchObject({ status: 'ready' });

      const second = await host.handle('tts/clip', 'lot-48', {
        text: 'Ron wants the pit left as it is.',
      });

      expect(second).toMatchObject({ status: 'ready' });
      expect(forked.workers).toHaveLength(2);
    }
  );

  it('starts a new model process when the old one has disconnected but not yet exited', async () => {
    const { host, forked } = make();
    await host.handle('tts/clip', 'lot-48', { text: TEXT });
    const [old] = forked.workers;

    if (old === undefined) {
      throw new Error('No worker was started');
    }

    old.connected = false;
    const clip = await host.handle('tts/clip', 'lot-48', {
      text: 'Ron wants the pit left as it is.',
    });

    expect(clip).toMatchObject({ status: 'ready' });
    expect(forked.workers).toHaveLength(2);
    expect(old.sent.filter((message) => message.warm !== true)).toHaveLength(1);
  });

  it("is on with no key, and keys each clip by provider so switching never serves the other's audio", async () => {
    const { host } = make();

    expect(host.snapshots().tts.enabled).toBe(true);

    const clip = await host.handle('tts/clip', 'lot-48', { text: TEXT });

    expect(clip).toMatchObject({ status: 'ready' });
    const stored = fs.readdirSync(host.store.file('lot-48', 'audio'));
    const kokoro = audioHash('af_heart', 'kokoro-82m-fp32-chunked', TEXT);
    const elevenLabs = audioHash(
      '21m00Tcm4TlvDq8ikWAM',
      'eleven_flash_v2_5',
      TEXT
    );
    expect(stored).toContain(`${kokoro}.json`);
    expect(stored.some((name) => name.startsWith(elevenLabs))).toBe(false);
  });
});
