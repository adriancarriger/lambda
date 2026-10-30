import * as fs from 'fs';

import { type PodStore, newId } from '../../pod-store';
import '../../pod/__tests__/podProject';
import {
  askGuardDecision,
  productManagerGuardDecision,
} from '../../pod/askGuard';
import {
  ASK_FORK_ALLOW,
  FORK_DENY,
  PRODUCT_MANAGER_SETTINGS,
  agentCommandLine,
  oneShotLaunch,
  writePodSettings,
} from '../../pod/launch';
import { runHook } from '../../pod/messaging';
import { runPeek } from '../../pod/peek';
import {
  PM_IDLE_MS,
  runPmChat,
  sleepIdleProductManager,
  withStartLock,
} from '../productManager';
import { buildingPodStore } from './fakes';

/**
 * The Product manager reads everything and changes nothing, by settings
 * rather than by asking it nicely; it starts on the owner's first message and
 * sleeps after 30 quiet minutes, keeping its session for the next one.
 */

const windows = new Set<string>();
/** Holds a launch open (as waitForAgentReady does) until it resolves. */
const launchGate: { wait: Promise<void> } = { wait: Promise.resolve() };
const recorded: {
  launches: { agent: string; mode: { kind: string; sessionId?: string } }[];
  sent: { target: string; wire: string }[];
  touched: string[];
} = { launches: [], sent: [], touched: [] };

jest.mock('../../pod/launch', () => ({
  ...jest.requireActual('../../pod/launch'),
  launchAgent: async (args: {
    agent: string;
    mode: { kind: string; sessionId?: string };
  }) => {
    await launchGate.wait;
    windows.add(args.agent);
    recorded.launches = [
      ...recorded.launches,
      { agent: args.agent, mode: args.mode },
    ];

    return true;
  },
}));

jest.mock('../../pod/messaging', () => ({
  ...jest.requireActual('../../pod/messaging'),
  sendMessage: async (
    store: PodStore,
    args: { podId: string; target: string; text: string; wireText?: string }
  ) => {
    recorded.sent = [
      ...recorded.sent,
      { target: args.target, wire: args.wireText ?? args.text },
    ];

    return store.appendThread({
      id: newId('m'),
      podId: args.podId,
      from: 'human',
      mode: 'sync',
      text: args.text,
      target: args.target,
      createdAt: new Date().toISOString(),
    });
  },
}));

jest.mock('../../pod/tmux', () => ({
  ...jest.requireActual('../../pod/tmux'),
  hasWindow: (_session: string, window: string) => windows.has(window),
  killWindow: (target: string) => {
    windows.delete(target.split(':').at(-1)?.replace(/^=/, '') ?? '');
  },
  capturePane: (target: string) => {
    recorded.touched = [...recorded.touched, `capture ${target}`];

    return 'dev: running the map pin check\n';
  },
  sendToPane: async (target: string) => {
    recorded.touched = [...recorded.touched, `send ${target}`];
  },
  sendKey: (target: string) => {
    recorded.touched = [...recorded.touched, `key ${target}`];
  },
}));

const setUp = () => {
  const made = buildingPodStore();
  process.env.LAMBDA_PODS_ROOT = made.store.root;
  windows.clear();
  ['engineering-manager', 'dev', 'qa'].forEach((name) => windows.add(name));
  recorded.launches = [];
  recorded.sent = [];
  recorded.touched = [];
  launchGate.wait = Promise.resolve();
  made.store.writeBuilding(made.podId, {
    runs: [
      {
        id: '3',
        title: 'Trail markers',
        step: 'test',
        attempt: 2,
        startedAt: '2026-10-23T10:00:00.000Z',
        claim: 'claimed',
      },
    ],
    upNext: [{ id: '5', title: 'Lot 48 photos' }],
  });
  Array.from({ length: 12 }, (_, n) => n + 1).forEach((n) =>
    made.store.appendThread({
      id: newId('m'),
      podId: made.podId,
      from: 'engineering-manager',
      mode: 'note',
      text: `Engineering manager note ${n}`,
      expectsReply: false,
      createdAt: new Date(Date.UTC(2026, 9, 23, 10, n)).toISOString(),
    })
  );

  return made;
};

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
});

describe("the Product manager's settings", () => {
  const settings = (store: PodStore, podId: string, file: string) => {
    writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });

    return JSON.parse(fs.readFileSync(store.file(podId, file), 'utf8'));
  };

  it('denies everything a fork may not do, and the building pod’s own writes', () => {
    const { store, podId } = setUp();
    const { permissions } = settings(store, podId, 'pm-settings.json');

    expect(permissions.deny).toEqual(expect.arrayContaining(FORK_DENY));
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Edit',
        'Write',
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(lambda ship:*)',
        'Bash(lambda tickets update:*)',
        'Bash(lambda tickets create:*)',
        'Bash(lambda tmux:*)',
        'Bash(lambda pod blocked:*)',
        'Bash(lambda pod skip-ticket:*)',
        'Bash(lambda pod step:*)',
        'Bash(lambda pod screenshot:*)',
        'Bash(lambda pod build:*)',
        'Bash(lambda verdict record:*)',
      ])
    );
    expect(permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(lambda pod peek:*)',
        'Bash(lambda pod ask:*)',
        'Bash(lambda pod relay:*)',
        'Bash(lambda pod reply:*)',
      ])
    );
    expect(
      permissions.allow.filter((rule: string) =>
        permissions.deny.includes(rule)
      )
    ).toEqual([]);
  });

  it('gives an ask fork read-only tools only, and no auto mode', () => {
    const { store, podId } = setUp();
    const { permissions } = settings(store, podId, 'ask-settings.json');

    expect(permissions.allow).toEqual(ASK_FORK_ALLOW);
    expect(
      permissions.allow.filter(
        (rule: string) =>
          /^(Edit|Write|NotebookEdit)$/.test(rule) ||
          /commit|push|lambda/.test(rule)
      )
    ).toEqual([]);
    const pod = store.requirePod(podId);
    expect(
      agentCommandLine(pod, store, 'ask-a1b2c3', {
        kind: 'fork',
        fromSessionId: 'dev-session',
      })
    ).not.toContain('--permission-mode auto');
    expect(
      agentCommandLine(pod, store, 'ask-a1b2c3', {
        kind: 'fork',
        fromSessionId: 'dev-session',
      })
    ).toContain('ask-settings.json');
    expect(
      agentCommandLine(pod, store, 'product-manager', {
        kind: 'fresh',
        sessionId: 'pm-session',
      })
    ).toContain('pm-settings.json');
  });

  it('peeks at a pane without sending it anything', () => {
    const { podId } = setUp();
    const out: { texts: string[] } = { texts: [] };

    runPeek('dev', { pod: podId }, (text) => {
      out.texts = [...out.texts, text];
    });

    expect(out.texts.join('')).toContain('running the map pin check');
    expect(recorded.touched).toEqual([`capture =lambda-pod-${podId}:=dev`]);
  });
});

describe("the Product manager's window", () => {
  it('has none before the first chat message', () => {
    setUp();

    expect(windows.has('product-manager')).toBe(false);
    expect(recorded.launches).toEqual([]);
  });

  it('starts on the first message, briefed with the ticket, the workflow and the last 10 notes', async () => {
    const { podId } = setUp();

    await runPmChat(podId, 'why did the test fail?');

    expect(recorded.launches).toEqual([
      {
        agent: 'product-manager',
        mode: { kind: 'fresh', sessionId: 'pm-session' },
      },
    ]);
    const brief = recorded.sent[0]?.wire ?? '';
    expect(recorded.sent[0]?.target).toBe('product-manager');
    expect(brief).toContain('Current ticket: 3 Trail markers');
    expect(brief).toContain('Test, attempt 2');
    expect(brief).toMatch(
      /✓ Pick up.*✓ Check ticket.*● Test · attempt 2.*○ Ship/s
    );
    expect(brief).toContain('why did the test fail?');
    const notes = brief.match(/Engineering manager note \d+/g) ?? [];
    expect(notes).toEqual(
      Array.from({ length: 10 }, (_, n) => `Engineering manager note ${n + 3}`)
    );
  });

  it('opens one window for two messages sent while it is still starting', async () => {
    const { store, podId } = setUp();
    const opened: { open: () => void } = { open: () => undefined };
    launchGate.wait = new Promise((resolve) => {
      opened.open = resolve;
    });

    const first = runPmChat(podId, 'why did the test fail?', { store });
    const second = runPmChat(podId, 'and the map pin?', { store });
    await new Promise((resolve) => setImmediate(resolve));
    opened.open();
    await Promise.all([first, second]);

    expect(recorded.launches).toHaveLength(1);
    expect(recorded.sent.map((one) => one.wire)).toEqual([
      expect.stringContaining('why did the test fail?'),
      'and the map pin?',
    ]);
    expect(fs.existsSync(store.file(podId, 'pm-start.lock'))).toBe(false);
  });

  it('sleeps after 30 quiet minutes, and resumes the same session', async () => {
    const { store, podId } = setUp();
    await runPmChat(podId, 'why did the test fail?');
    const at = Date.parse(
      store.readBuilding(podId).productManager?.lastActivityAt ?? ''
    );

    expect(sleepIdleProductManager(store, podId, at + PM_IDLE_MS - 1)).toBe(
      false
    );
    expect(sleepIdleProductManager(store, podId, at + PM_IDLE_MS)).toBe(true);
    expect(windows.has('product-manager')).toBe(false);
    expect(store.requirePod(podId).sessions['product-manager']).toBe(
      'pm-session'
    );

    await runPmChat(podId, 'skip the next ticket');

    expect(recorded.launches.at(-1)).toEqual({
      agent: 'product-manager',
      mode: { kind: 'resume', sessionId: 'pm-session' },
    });
    expect(recorded.sent.at(-1)?.wire).toBe('skip the next ticket');
  });
});

describe("the Product manager's sleep and a message waking it", () => {
  it('does not sleep while a message holds the start lock, and keeps the window', async () => {
    const { store, podId } = setUp();
    await runPmChat(podId, 'why did the test fail?', { store });
    const at = Date.parse(
      store.readBuilding(podId).productManager?.lastActivityAt ?? ''
    );
    // Another process's message is waking or briefing it right now.
    const lock = store.file(podId, 'pm-start.lock');
    fs.writeFileSync(lock, '4242 2026-10-23T10:00:00.000Z\n');

    try {
      expect(sleepIdleProductManager(store, podId, at + PM_IDLE_MS)).toBe(
        false
      );
      expect(windows.has('product-manager')).toBe(true);
      expect(store.readBuilding(podId).productManager?.awake).toBe(true);
    } finally {
      fs.rmSync(lock, { force: true });
    }

    expect(sleepIdleProductManager(store, podId, at + PM_IDLE_MS)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("the Product manager's start lock", () => {
  it('lets go of its own lock only, never one another message took over', async () => {
    const { store, podId } = setUp();
    const lock = store.file(podId, 'pm-start.lock');

    await withStartLock(store, podId, async () => {
      // This message ran so long its lock went stale, and another took it.
      fs.writeFileSync(lock, '4242 another message\n');
    });

    try {
      expect(fs.readFileSync(lock, 'utf8')).toBe('4242 another message\n');
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
});

describe('an ask fork runs read-only whatever the user’s own settings say', () => {
  it('starts in the default permission mode, from the project’s settings only', () => {
    const { store, podId } = setUp();
    writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });
    const line = agentCommandLine(
      store.requirePod(podId),
      store,
      'ask-a1b2c3',
      {
        kind: 'fork',
        fromSessionId: 'dev-session',
      }
    );

    expect(line).toContain('--permission-mode default');
    expect(line).toContain('--setting-sources project');
    expect(line).not.toContain('auto');
    const settings = JSON.parse(
      fs.readFileSync(store.file(podId, 'ask-settings.json'), 'utf8')
    );
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings.hooks.PreToolUse).toEqual([
      {
        hooks: [{ type: 'command', command: 'lambda pod hook ask-guard' }],
      },
    ]);
  });

  it("denies the building pod's own writes even when its guard doesn't run", () => {
    const { store, podId } = setUp();
    writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });
    const { permissions } = JSON.parse(
      fs.readFileSync(store.file(podId, 'ask-settings.json'), 'utf8')
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(lambda pod blocked:*)',
        'Bash(lambda verdict record:*)',
        'Bash(lambda pod reply:*)',
        'Bash(lambda pod ask:*)',
        'Bash(lambda pod relay:*)',
        'Bash(lambda event:*)',
      ])
    );
  });

  it.each([
    [
      'Bash',
      {
        command: 'tmux send-keys -t lambda-pod-build-a1b2:dev "ship it" Enter',
      },
    ],
    ['Bash', { command: 'git log --oneline; tmux send-keys -t x:dev y' }],
    ['Bash', { command: 'lambda ship 3' }],
    ['Bash', { command: 'cat a.txt > b.txt' }],
    ['Edit', { file_path: '/tmp/a.ts' }],
    ['Write', { file_path: '/tmp/a.ts' }],
  ])('its guard denies %s %j', (tool, input) => {
    expect(askGuardDecision(tool, input)).toBe('deny');
  });

  it.each([
    ['Read', { file_path: '/tmp/a.ts' }],
    ['Grep', { pattern: 'pin' }],
    ['Bash', { command: 'git log --oneline -5' }],
  ])('its guard allows %s %j', (tool, input) => {
    expect(askGuardDecision(tool, input)).toBe('allow');
  });
});

describe("an ask fork's commands can't write into the dev's folder", () => {
  it.each([
    'find . -name "*.orig" -delete',
    'find . -exec rm {} +',
    "sed -n -i '' 's/pin/marker/' src/map.ts",
    'sed -n 1,5p src/map.ts',
    'git diff --output=notes.txt',
    'git log --output notes.txt',
    'rg --pre ./run.sh pin src',
    'rg --pre=./run.sh pin src',
    'git diff "--output=q.txt"',
    "git diff '--output=a'",
    'git diff \\--output=x',
    'rg "--pre=sh" x .',
  ])('its guard denies %s', (command) => {
    expect(askGuardDecision('Bash', { command })).toBe('deny');
  });

  it.each([
    'git diff "--output=q.txt"',
    "git diff '--output=a'",
    'git diff \\--output=x',
  ])("the Product manager's guard denies %s too", (command) => {
    expect(productManagerGuardDecision('Bash', { command })).toBe('deny');
  });

  it.each([
    'git diff HEAD~1',
    'git log --oneline -5',
    'rg pin src',
    'grep -n pin src/map.ts',
  ])('its guard still allows %s', (command) => {
    expect(askGuardDecision('Bash', { command })).toBe('allow');
  });

  it.each(['cat =(touch /tmp/pwn)', "ls *(e:'touch /tmp/pwn':)"])(
    "its guard denies zsh's %s",
    (command) => {
      expect(askGuardDecision('Bash', { command })).toBe('deny');
    }
  );

  it.each([
    'lambda pod peek dev =(touch /tmp/p)',
    'lambda pod reply "x" *(e:\'touch /tmp/p\':)',
    'lambda pod reply --fyi "$(cat <<\'EOF\'\nhi\nEOF)"; touch /tmp/p; echo "$(cat <<\'EOF\'\nx\nEOF\n)"',
  ])("the Product manager's guard denies %s", (command) => {
    expect(productManagerGuardDecision('Bash', { command })).toBe('deny');
  });

  it('allows no command that can write, by prefix', () => {
    expect(ASK_FORK_ALLOW).not.toEqual(
      expect.arrayContaining(['Bash(find:*)'])
    );
    expect(ASK_FORK_ALLOW).not.toEqual(
      expect.arrayContaining(['Bash(sed -n:*)'])
    );
  });
});

describe("the Product manager can't reach an agent around ask and relay", () => {
  it('denies lambda pod send, deliver and interrupt, and lambda event', () => {
    const { store, podId } = setUp();
    writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });
    const { permissions } = JSON.parse(
      fs.readFileSync(store.file(podId, 'pm-settings.json'), 'utf8')
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(lambda pod send:*)',
        'Bash(lambda pod deliver:*)',
        'Bash(lambda pod interrupt:*)',
        'Bash(lambda event:*)',
      ])
    );
    expect(permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(lambda pod ask:*)',
        'Bash(lambda pod relay:*)',
      ])
    );
  });
});

describe('the Product manager runs read-only whatever the user’s own settings say', () => {
  const guard = (tool: string, input: Record<string, unknown>): string => {
    const spy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const answer = (() => {
      try {
        runHook(
          'pm-guard',
          JSON.stringify({ tool_name: tool, tool_input: input })
        );

        return spy.mock.calls.map(([chunk]) => String(chunk)).join('');
      } finally {
        spy.mockRestore();
      }
    })();

    return answer === ''
      ? 'no answer'
      : JSON.parse(answer).hookSpecificOutput.permissionDecision;
  };

  it.each(['product-manager', 'pm-a1b2c3'])(
    '%s starts in the default permission mode, from the project’s settings only',
    (agent) => {
      const { store, podId } = setUp();
      const line = agentCommandLine(store.requirePod(podId), store, agent, {
        kind: 'fresh',
        sessionId: 'pm-session',
      });

      expect(line).toContain('--permission-mode default');
      expect(line).toContain('--setting-sources project');
      expect(line).not.toContain('auto');
    }
  );

  it('has its allow list enforced by a guard, in the pod and outside it', () => {
    const { store, podId } = setUp();
    writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });
    const inPod = JSON.parse(
      fs.readFileSync(store.file(podId, 'pm-settings.json'), 'utf8')
    );
    const guardHook = [
      { hooks: [{ type: 'command', command: 'lambda pod hook pm-guard' }] },
    ];

    [inPod, PRODUCT_MANAGER_SETTINGS].forEach((one) => {
      expect(one.permissions.defaultMode).toBe('default');
      expect(one.hooks.PreToolUse).toEqual(guardHook);
    });
    expect(inPod.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(lambda pod done:*)',
        'Bash(lambda pod pause:*)',
        'Bash(lambda pod resume:*)',
        'Bash(lambda tickets delete:*)',
        'Bash(lambda tickets reorder:*)',
        'Bash(lambda tickets place:*)',
        'Bash(lambda tickets pull:*)',
        'Bash(lambda stop:*)',
      ])
    );
  });

  it('a one-shot run reads the project’s settings only', () => {
    const launch = oneShotLaunch({ prompt: 'x', settingsFile: '/tmp/s.json' });
    const at = launch.args.indexOf('--setting-sources');

    expect(launch.args[at + 1]).toBe('project');
  });

  it('a one-shot run gets no Bash or edits, whatever the project allows', () => {
    const launch = oneShotLaunch({ prompt: 'x', settingsFile: '/tmp/s.json' });
    const at = launch.args.indexOf('--disallowedTools');

    expect(at).toBeGreaterThan(-1);
    expect(launch.args[at + 1].split(',')).toEqual([
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
    ]);
  });

  it.each([
    ['Bash', { command: 'lambda pod done build-a1b2' }],
    ['Bash', { command: 'lambda pod pause build-a1b2' }],
    ['Bash', { command: 'lambda tickets delete 5' }],
    ['Bash', { command: 'lambda tickets reorder 1' }],
    ['Bash', { command: 'rm -rf src' }],
    ['Bash', { command: 'lambda tickets get 3 && lambda pod done x' }],
    ['Bash', { command: 'lambda tickets get 3 > notes.txt' }],
    ['Bash', { command: 'lambda pod reply --fyi "$(rm -rf src)"' }],
    [
      'Bash',
      {
        command:
          'lambda pod reply --fyi "$(cat <<\'EOF\'\nhi\nEOF\n)"; rm x; echo "$(cat <<\'EOF\'\nyo\nEOF\n)"',
      },
    ],
    ['Edit', { file_path: '/tmp/a.ts' }],
    ['Write', { file_path: '/tmp/a.ts' }],
  ])('its guard denies %s %j', (tool, input) => {
    expect(guard(tool, input)).toBe('deny');
  });

  it.each([
    ['Read', { file_path: '/tmp/a.ts' }],
    ['Bash', { command: 'lambda tickets get 3' }],
    ['Bash', { command: 'lambda pod peek dev' }],
    ['Bash', { command: 'git log --oneline -5' }],
    [
      'Bash',
      { command: 'lambda pod reply --fyi "**The pin failed.** Map | list"' },
    ],
    [
      'Bash',
      {
        command:
          'lambda pod reply --fyi "$(cat <<\'EOF\'\n**The pin failed.**\n- `map.ts` ran $first\nEOF\n)"',
      },
    ],
  ])('its guard allows %s %j', (tool, input) => {
    expect(guard(tool, input)).toBe('allow');
  });
});
