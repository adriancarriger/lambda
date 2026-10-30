import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildingPodStore } from '../../building/__tests__/fakes';
import type { PodStore } from '../../pod-store';
import { ASK_IDLE_MS, closeIdleAsks, runAsk } from '../ask';
import './podProject';

/**
 * The Product manager asks a read-only fork of the Engineering manager or
 * the dev. The real agent never sees the question: every message goes to the
 * fork's own window, and the fork's answer is read from its transcript.
 */

const windows = new Set<string>();
const recorded: {
  launches: { agent: string; mode: { kind: string }; command: string }[];
  pasted: string[];
  killed: string[];
  answers: string[];
  texts: string[];
} = { launches: [], pasted: [], killed: [], answers: [], texts: [] };
const state: {
  store: PodStore | null;
  answer: string;
  // What happens while the fork is answering (the runner's minute watch).
  onSend: () => void;
  // Whether the fork's window comes up ready.
  launchOk: boolean | 'throws';
  // How the fork's turn goes: it answers, it says nothing new (the last
  // text in its transcript is history copied by --fork-session), or it is
  // still thinking.
  reply: 'answers' | 'nothing-new' | 'still-thinking';
  // The injected clock, moved on by each sleep; and how many sleeps, so a
  // wait that never ends fails the test instead of hanging it.
  clock: number;
  sleeps: number;
  // What had been printed when the ask first started waiting.
  printedBeforeWait: string[] | null;
} = {
  store: null,
  answer: 'The pin loaded after the check ran.',
  onSend: () => undefined,
  launchOk: true,
  reply: 'answers',
  clock: 0,
  sleeps: 0,
  printedBeforeWait: null,
};

jest.mock('../launch', () => {
  const actual = jest.requireActual('../launch');

  return {
    ...actual,
    launchAgent: async (args: {
      pod: unknown;
      store: unknown;
      agent: string;
      mode: { kind: string };
    }) => {
      windows.add(args.agent);
      recorded.launches = [
        ...recorded.launches,
        {
          agent: args.agent,
          mode: args.mode,
          // The command line it would have started the fork with.
          command: actual.agentCommandLine(
            args.pod,
            args.store,
            args.agent,
            args.mode
          ),
        },
      ];

      if (state.launchOk === 'throws') {
        throw new Error('tmux new-window failed');
      }

      return state.launchOk;
    },
  };
});

jest.mock('../tmux', () => ({
  ...jest.requireActual('../tmux'),
  hasWindow: (_session: string, window: string) => windows.has(window),
  killWindow: (target: string) => {
    recorded.killed = [...recorded.killed, target];
    windows.delete(target.split(':').at(-1)?.replace(/^=/, '') ?? '');
  },
  sendKey: (target: string) => {
    recorded.pasted = [...recorded.pasted, target];
  },
  sleep: async (ms: number) => {
    state.printedBeforeWait = state.printedBeforeWait ?? [...recorded.answers];
    state.clock += ms;
    state.sleeps += 1;

    if (state.sleeps > 400) {
      throw new Error('Still waiting after 400 sleeps.');
    }
  },
  // The fork answers at once: a transcript line, then its Stop hook.
  sendToPane: async (target: string, text: string) => {
    recorded.pasted = [...recorded.pasted, target];
    recorded.texts = [...recorded.texts, text];
    const { store } = state;
    const window = target.split(':').at(-1) ?? '';

    if (store === null) {
      return;
    }

    state.onSend();

    if (state.reply === 'still-thinking') {
      return;
    }

    answerOn(
      window,
      state.answer,
      state.reply === 'answers'
        ? new Date(Date.now() + 1).toISOString()
        : '2020-01-01T00:00:00.000Z'
    );
  },
}));

/** The fork's transcript gets one assistant line, then its Stop hook runs. */
const answerOn = (window: string, text: string, at: string): void => {
  const { store } = state;

  if (store === null) {
    throw new Error('No store');
  }

  const transcript = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ask-')),
    'session.jsonl'
  );
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: { content: [{ type: 'text', text }] },
    })}\n`
  );
  store.patchTurn('build-a1b2', window, {
    transcriptPath: transcript,
    startedAt: new Date(Date.now() + 1).toISOString(),
    endedAt: new Date(Date.now() + 2).toISOString(),
  });
};

const setUp = () => {
  const made = buildingPodStore();
  state.store = made.store;
  process.env.LAMBDA_PODS_ROOT = made.store.root;
  windows.clear();
  ['engineering-manager', 'dev', 'qa', 'product-manager'].forEach((name) =>
    windows.add(name)
  );
  // Both real agents have started (their prompt hook ran).
  made.store.patchTurn(made.podId, 'dev', {
    startedAt: '2026-10-23T10:00:00Z',
  });
  made.store.patchTurn(made.podId, 'engineering-manager', {
    startedAt: '2026-10-23T10:00:00Z',
  });
  recorded.launches = [];
  recorded.pasted = [];
  recorded.killed = [];
  recorded.texts = [];

  return made;
};

const ask = (
  target: string,
  question: string,
  options: {
    thread?: string;
    close?: string;
    wait?: boolean;
    pod?: string;
  } = {}
) =>
  runAsk(
    target,
    question,
    { pod: 'build-a1b2', ...options },
    (line) => {
      recorded.answers = [...recorded.answers, line];
    },
    { now: () => state.clock, capMs: 100_000 }
  );

beforeEach(() => {
  state.clock = Date.now();
});

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  recorded.answers = [];
  state.onSend = () => undefined;
  state.launchOk = true;
  state.reply = 'answers';
  state.sleeps = 0;
  state.printedBeforeWait = null;
  process.exitCode = undefined;
});

describe('lambda pod ask', () => {
  it.each(['/clear', '!touch /tmp/p', '# remember this'])(
    'never types %s at the start of the fork’s input, where Claude Code would run it',
    async (question) => {
      setUp();

      await ask('dev', question);

      expect(recorded.texts).toEqual([`The Product manager asks: ${question}`]);
    }
  );

  it('reuses one fork for one thread, and forks again for a new one', async () => {
    const { store, podId } = setUp();

    const first = await ask('dev', 'why did the test fail?');
    await ask('dev', 'and now?', { thread: first });

    expect(recorded.launches).toEqual([
      {
        agent: `ask-${first}`,
        mode: expect.objectContaining({ kind: 'fork' }),
        command: expect.any(String),
      },
    ]);
    // One fork for the thread: one `claude --resume … --fork-session`.
    expect(
      recorded.launches.filter((launch) =>
        launch.command.includes('claude --resume dev-session --fork-session')
      )
    ).toHaveLength(1);
    expect(recorded.answers.at(-1)).toContain(
      'The pin loaded after the check ran.'
    );

    const second = await ask('dev', 'is attempt 2 running?');

    expect(second).not.toBe(first);
    expect(recorded.launches).toHaveLength(2);
    expect(
      store
        .listAsks(podId)
        .map((thread) => thread.id)
        .sort()
    ).toEqual([first, second].sort());
  });

  it('spins a fork down with --close, and after 15 idle minutes', async () => {
    const { store, podId } = setUp();
    const first = await ask('dev', 'why did the test fail?');
    const second = await ask('engineering-manager', 'what is next?');

    await ask('dev', '', { close: first });
    expect(recorded.killed).toEqual([`=lambda-pod-${podId}:=ask-${first}`]);

    const lastUsed = Date.parse(store.readAsk(podId, second)?.lastUsedAt ?? '');
    closeIdleAsks(store, podId, lastUsed + ASK_IDLE_MS - 1);
    expect(recorded.killed).toHaveLength(1);
    closeIdleAsks(store, podId, lastUsed + ASK_IDLE_MS);
    expect(recorded.killed).toEqual([
      `=lambda-pod-${podId}:=ask-${first}`,
      `=lambda-pod-${podId}:=ask-${second}`,
    ]);
    expect(ASK_IDLE_MS).toBe(15 * 60_000);
  });

  it('still spins the others down when one conversation file is unreadable, and warns about it', async () => {
    const { store, podId } = setUp();
    const id = await ask('dev', 'why did the test fail?');
    fs.writeFileSync(store.file(podId, 'asks', 'a0bad0.json'), '{ not json');
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const lastUsed = Date.parse(store.readAsk(podId, id)?.lastUsedAt ?? '');

    try {
      expect(closeIdleAsks(store, podId, lastUsed + ASK_IDLE_MS)).toEqual([id]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('a0bad0.json'));
    } finally {
      warn.mockRestore();
    }
  });

  it('never spins a fork down while it is answering, and keeps a close made meanwhile', async () => {
    const { store, podId } = setUp();
    const first = await ask('dev', 'why did the test fail?');
    const thread = store.readAsk(podId, first);

    if (thread === null) {
      throw new Error('No thread');
    }
    // Last used 14½ minutes ago: the watch runs while the next answer comes.
    store.writeAsk({
      ...thread,
      lastUsedAt: new Date(Date.now() - ASK_IDLE_MS + 30_000).toISOString(),
    });
    state.onSend = () => {
      closeIdleAsks(store, podId, Date.now() + 60_000);
    };

    await ask('dev', 'and now?', { thread: first });

    expect(recorded.killed).toEqual([]);
    expect(store.readAsk(podId, first)?.closedAt).toBeUndefined();

    state.onSend = () => {
      const now = store.readAsk(podId, first);

      if (now !== null) {
        store.writeAsk({ ...now, closedAt: '2026-10-23T10:30:00.000Z' });
      }
    };
    await ask('dev', 'one more?', { thread: first });

    expect(store.readAsk(podId, first)?.closedAt).toBe(
      '2026-10-23T10:30:00.000Z'
    );
  });

  it('refuses qa, an unknown conversation, and a target not started yet', async () => {
    const { store, podId } = setUp();

    await expect(ask('qa', 'did it pass?')).rejects.toThrow(
      'You can ask the engineering-manager or the dev.'
    );
    await expect(ask('dev', 'hello?', { thread: 'a0000' })).rejects.toThrow(
      'No conversation a0000.'
    );
    await expect(ask('dev', '', { close: 'a0000' })).rejects.toThrow(
      'No conversation a0000.'
    );
    store.patchTurn(podId, 'dev', { startedAt: undefined });
    fs.rmSync(store.file(podId, 'turns', 'dev.json'));
    await expect(ask('dev', 'hello?')).rejects.toThrow(
      "The dev hasn't started yet, so there's nothing to ask."
    );
    expect(recorded.launches).toEqual([]);
  });

  it('closes a conversation whose fork window has gone, and says so', async () => {
    const { store, podId } = setUp();
    const first = await ask('dev', 'why did the test fail?');
    windows.delete(`ask-${first}`);

    await expect(ask('dev', 'and now?', { thread: first })).rejects.toThrow(
      `Conversation ${first} has ended: its fork's window is gone. Ask without --thread to start a new one.`
    );
    expect(store.readAsk(podId, first)?.closedAt).toEqual(expect.any(String));
  });

  it('says a conversation is with the other agent, keeping it open', async () => {
    const { store, podId } = setUp();
    const first = await ask('engineering-manager', 'what is next?');

    await expect(ask('dev', 'and you?', { thread: first })).rejects.toThrow(
      `Conversation ${first} is with the engineering-manager, not the dev.`
    );
    expect(store.readAsk(podId, first)?.closedAt).toBeUndefined();
  });

  it('never sends anything to the real dev or Engineering manager', async () => {
    setUp();

    await ask('dev', 'why did the test fail?');
    await ask('engineering-manager', 'what is next?');

    expect(
      recorded.pasted.filter(
        (target) =>
          target.endsWith(':dev') || target.endsWith(':engineering-manager')
      )
    ).toEqual([]);
  });
});

describe('two asks at once', () => {
  it('run side by side, each on its own fork, and both answer', async () => {
    setUp();

    const [first, second] = await Promise.all([
      ask('dev', 'why did the test fail?'),
      ask('engineering-manager', 'what is next?'),
    ]);

    expect(first).not.toBe(second);
    expect(recorded.launches.map((launch) => launch.agent).sort()).toEqual(
      [`ask-${first}`, `ask-${second}`].sort()
    );
    expect(
      recorded.launches.filter((launch) =>
        launch.command.includes('--fork-session')
      )
    ).toHaveLength(2);
    expect(
      recorded.answers.filter((line) =>
        line.includes('The pin loaded after the check ran.')
      )
    ).toHaveLength(2);
  });
});

describe('only in a building pod', () => {
  it('refuses a planning pod, whose forks are not read-only', async () => {
    const made = buildingPodStore('plan-c3d4', 'r-leslie-mac', {
      kind: 'planning',
    });
    state.store = made.store;
    process.env.LAMBDA_PODS_ROOT = made.store.root;
    made.store.patchTurn(made.podId, 'dev', {
      startedAt: '2026-10-23T10:00:00Z',
    });
    recorded.launches = [];

    await expect(
      ask('dev', 'why did the test fail?', { pod: made.podId })
    ).rejects.toThrow(
      'lambda pod ask works in a building pod only; plan-c3d4 is a planning pod.'
    );
    expect(recorded.launches).toEqual([]);
  });
});

describe('a fork that does not start', () => {
  it('throws, closes the thread, and sends the question nowhere', async () => {
    const { store, podId } = setUp();
    state.launchOk = false;

    await expect(ask('dev', 'why did the test fail?')).rejects.toThrow(
      "The dev's fork didn't start, so the question wasn't sent. Ask again."
    );
    const [thread] = store.listAsks(podId);

    expect(thread?.closedAt).toEqual(expect.any(String));
    expect(recorded.killed).toEqual([
      `=lambda-pod-${podId}:=${thread?.window}`,
    ]);
    expect(recorded.pasted).toEqual([]);
  });
});

describe('a fork whose launch throws', () => {
  it('closes the thread, so it is not left open with no window', async () => {
    const { store, podId } = setUp();
    state.launchOk = 'throws';

    await expect(ask('dev', 'why did the test fail?')).rejects.toThrow(
      'tmux new-window failed'
    );

    expect(store.listAsks(podId).map((thread) => thread.closedAt)).toEqual([
      expect.any(String),
    ]);
    expect(recorded.pasted).toEqual([]);
  });
});

describe('a question that was never answered in time', () => {
  it('closes the conversation instead of asking the next question there', async () => {
    const { store, podId } = setUp();
    state.reply = 'still-thinking';
    const id = await ask('dev', 'why did the test fail?');
    const pasted = recorded.pasted.length;
    state.clock += 11 * 60_000;

    await expect(
      ask('dev', 'and the map pin?', { thread: id })
    ).rejects.toThrow(
      `Conversation ${id} never answered its last question, so it's closed. Ask without --thread to start a new one.`
    );
    expect(recorded.pasted).toHaveLength(pasted);
    expect(store.readAsk(podId, id)?.closedAt).toEqual(expect.any(String));
  });
});

describe('an answer that takes longer than a Bash call', () => {
  it('prints the conversation id before it waits, and exits 2 with how to keep waiting', async () => {
    setUp();
    state.reply = 'still-thinking';

    const id = await ask('dev', 'why did the test fail?');

    expect(state.printedBeforeWait).toEqual([
      `[conversation ${id} with a read-only fork of the dev]`,
    ]);
    expect(recorded.answers.at(-1)).toBe(
      `The dev's fork is still answering after 100s. Run \`lambda pod ask --thread ${id} --wait\` to keep waiting.`
    );
    expect(process.exitCode).toBe(2);
    // 100 one-second sleeps, then it gave up: well under Bash's 2 minutes.
    expect(state.sleeps).toBeLessThanOrEqual(101);
  });

  it('--wait picks the same answer up without asking again', async () => {
    setUp();
    state.reply = 'still-thinking';
    const id = await ask('dev', 'why did the test fail?');
    const pasted = recorded.pasted.length;
    process.exitCode = undefined;
    recorded.answers = [];
    answerOn(
      `ask-${id}`,
      'It was the pin.',
      new Date(Date.now() + 5).toISOString()
    );

    await ask('', '', { thread: id, wait: true });

    expect(recorded.answers).toEqual([
      `[conversation ${id} with a read-only fork of the dev]`,
      'It was the pin.',
    ]);
    expect(recorded.pasted).toHaveLength(pasted);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a new question while the last one is still being answered, sending nothing', async () => {
    setUp();
    state.reply = 'still-thinking';
    const id = await ask('dev', 'why did the test fail?');
    const pasted = recorded.pasted.length;

    await expect(
      ask('dev', 'and the map pin?', { thread: id })
    ).rejects.toThrow(
      `Conversation ${id} is still answering the last question. Run \`lambda pod ask --thread ${id} --wait\` for that answer, then ask again.`
    );
    expect(recorded.pasted).toHaveLength(pasted);
  });

  it('--wait needs a --thread and sends no question', async () => {
    setUp();

    await expect(ask('', '', { wait: true })).rejects.toThrow(
      '--wait needs --thread <id>.'
    );
    const id = await ask('dev', 'why did the test fail?');
    await expect(
      ask('dev', 'and now?', { thread: id, wait: true })
    ).rejects.toThrow('--wait sends no question: drop the question.');
  });
});

describe("the fork's answer", () => {
  it('is only what it said after the question, never history copied by --fork-session', async () => {
    setUp();
    state.reply = 'nothing-new';

    await ask('dev', 'why did the test fail?');

    expect(recorded.answers.at(-1)).toBe('(no answer)');
  });
});
