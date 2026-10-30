import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeBuildingInstructions } from '../../building/lifecycle';
import { type Project, loadProjectConfig } from '../../config/projectConfig';
import { createPodStore } from '../../pod-store';
import { agentPath, ourCommandFiles } from '../base';
import { agentCommandLine, writePodSettings } from '../launch';
import { runDone, runNew, runRenderMode } from '../lifecycle';
import { isIdle, runHook, sendMessage } from '../messaging';
import { inputReady, sendToPane, waitForAgentReady } from '../tmux';
import { usePodProject } from './podProject';

// No real agents: windows open nowhere, and messages are recorded, not pasted.
jest.mock('../messaging', () => ({
  ...jest.requireActual('../messaging'),
  sendMessage: jest.fn(async () => ({ id: 'm1' })),
}));
jest.mock('../tmux', () => ({
  ...jest.requireActual('../tmux'),
  newWindow: jest.fn(),
  hasSession: jest.fn(() => false),
  sendToPane: jest.fn(async () => undefined),
  waitForAgentReady: jest.fn(async () => true),
}));

const POD = 'pawnee-a1b2';

const withPodEnv = (root: string, agent: string, body: () => void): void => {
  const saved = { ...process.env };
  process.env.LAMBDA_PODS_ROOT = root;
  process.env.POD_ID = POD;
  process.env.POD_AGENT = agent;

  try {
    body();
  } finally {
    process.env = saved;
  }
};

const seed = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pod-'));
  createPodStore(root).writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-03T00:00:00.000Z',
    status: 'active',
    phase: 2,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  });

  return root;
};

describe('runRenderMode', () => {
  const printed = (body: () => void): string[] => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      body();

      return log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }
  };

  it("prints ascii for a new pod on a computer that hasn't checked Claude Design, and the mode it was set to after that", () => {
    const root = seed();

    withPodEnv(root, '', () => {
      delete process.env.POD_AGENT;
      expect(printed(() => runRenderMode(POD))).toEqual(['ascii']);
      printed(() => runRenderMode(POD, 'full'));
      expect(printed(() => runRenderMode(POD))).toEqual(['full']);
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, POD, 'pod.json'), 'utf8'))
        .renderMode
    ).toBe('full');
  });

  it('refuses an unknown mode or pod and writes nothing', () => {
    const root = seed();
    const podJson = path.join(root, POD, 'pod.json');
    const before = fs.readFileSync(podJson);

    withPodEnv(root, '', () => {
      delete process.env.POD_AGENT;
      expect(() => runRenderMode(POD, 'fast')).toThrow('full or ascii');
      expect(() => runRenderMode('eagleton-c3d4', 'ascii')).toThrow(
        'eagleton-c3d4'
      );
    });
    expect(fs.readFileSync(podJson).equals(before)).toBe(true);
  });
});

describe('isIdle', () => {
  it('waits for a turn that started after the last message', () => {
    expect(isIdle({})).toBe(true);
    expect(isIdle({ sentAt: '2026-10-03T01:00:00Z' })).toBe(false);
    expect(
      isIdle({
        sentAt: '2026-10-03T01:00:00Z',
        startedAt: '2026-10-03T01:00:01Z',
      })
    ).toBe(false);
    expect(
      isIdle({
        sentAt: '2026-10-03T01:00:00Z',
        startedAt: '2026-10-03T01:00:01Z',
        endedAt: '2026-10-03T01:02:00Z',
      })
    ).toBe(true);
  });

  it('does not count an older finished turn as the answer to a newer message', () => {
    expect(
      isIdle({
        startedAt: '2026-10-03T00:59:00Z',
        endedAt: '2026-10-03T00:59:30Z',
        sentAt: '2026-10-03T01:00:00Z',
      })
    ).toBe(false);
  });
});

describe('runHook', () => {
  it('marks the [m:…] message received and records the turn start', () => {
    const root = seed();
    const store = createPodStore(root);
    store.appendThread({
      id: 'mhello1',
      podId: POD,
      from: 'human',
      mode: 'async',
      text: 'go with B',
      wire: '/human-async q1 [m:mhello1]: go with B',
      target: 'dev',
      createdAt: '2026-10-03T01:00:00Z',
    });

    withPodEnv(root, 'dev', () => {
      runHook(
        'prompt-submit',
        JSON.stringify({ prompt: '/human-async q1 [m:mhello1]: go with B' })
      );
    });

    expect(store.readThread(POD)[0]?.delivery).toBe('received');
    expect(store.readTurn(POD, 'dev').startedAt).toBeDefined();
  });

  it('marks a warming fork active when its warm-up turn ends', () => {
    const root = seed();
    const store = createPodStore(root);
    store.writeFork({
      qid: 'q3',
      podId: POD,
      window: 'fork-q3',
      state: 'warming',
      startedAt: '2026-10-03T01:00:00Z',
      lastActivityAt: '2026-10-03T01:00:00Z',
    });

    withPodEnv(root, 'fork-q3', () => runHook('stop', '{}'));

    expect(store.readFork(POD, 'q3')?.state).toBe('active');
    expect(store.readTurn(POD, 'fork-q3').endedAt).toBeDefined();
  });

  it('records the transcript the agent is really writing (resumes write a new file)', () => {
    const root = seed();

    withPodEnv(root, 'dev', () =>
      runHook(
        'stop',
        JSON.stringify({
          transcript_path: '/tmp/claude/projects/x/new-session.jsonl',
        })
      )
    );

    expect(createPodStore(root).readTurn(POD, 'dev').transcriptPath).toBe(
      '/tmp/claude/projects/x/new-session.jsonl'
    );
  });

  it('never throws, even on garbage input', () => {
    const root = seed();

    expect(() =>
      withPodEnv(root, 'dev', () => runHook('prompt-submit', '{not json'))
    ).not.toThrow();
  });
});

describe('writePodSettings', () => {
  it('gives forks a read-only allowlist and both agents the pod hooks', () => {
    const root = seed();
    const store = createPodStore(root);
    writePodSettings(store, POD);

    const read = (name: string): unknown =>
      JSON.parse(fs.readFileSync(store.file(POD, name), 'utf8'));
    const main = JSON.stringify(read('settings.json'));
    const fork = read('fork-settings.json');

    expect(main).toContain('lambda pod hook prompt-submit');
    expect(main).toContain('lambda pod hook stop');
    expect(main).toContain('Bash(git push:*)');
    expect(fork).toMatchObject({
      permissions: {
        deny: expect.arrayContaining([
          'Edit',
          'Write',
          'Bash(lambda tickets push:*)',
          'Bash(lambda tickets update:*)',
        ]),
      },
    });
    expect(JSON.stringify(fork)).not.toMatch(/"allow":\[[^\]]*"Edit"/);
  });

  // Not covered here: designs and screenshots. Pods don't publish designs or
  // take app screenshots; the fork's Artifact checks live in settings.test.ts.

  it('denies the Workflow tool, whose consent prompt nobody answers', () => {
    const root = seed();
    const store = createPodStore(root);
    writePodSettings(store, POD);

    ['settings.json', 'fork-settings.json'].forEach((name) => {
      expect(
        JSON.parse(fs.readFileSync(store.file(POD, name), 'utf8'))
      ).toMatchObject({
        permissions: { deny: expect.arrayContaining(['Workflow']) },
      });
    });
  });
});

describe('inputReady', () => {
  const rule = '─'.repeat(40);

  it('is ready only with an empty input box at the bottom', () => {
    expect(
      inputReady(
        [
          '⏺ Done.',
          rule,
          '❯ ',
          rule,
          '  ⏵⏵ auto mode on (shift+tab to cycle)',
        ].join('\n')
      )
    ).toBe(true);
  });

  it('is NOT ready while a resumed session replays old prompts', () => {
    // History full of `❯` lines, no input box yet: a warm-up pasted here is
    // lost.
    expect(
      inputReady(
        [
          '❯ /pod-phase ux',
          '⏺ Writing the screens…',
          '❯ /human q7 [m:abc]: why?',
          '⏺ Because…',
          '✻ Resuming conversation…',
        ].join('\n')
      )
    ).toBe(false);
  });
});

describe('lambda pod new', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.LAMBDA_PODS_ROOT;
    delete process.env.POD_ID;
    delete process.env.POD_AGENT;
    jest.mocked(sendMessage).mockClear();
    jest.mocked(sendToPane).mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  const project = (config: Record<string, unknown> = {}): Project => {
    const loaded = loadProjectConfig(usePodProject(config));

    if (loaded === null) {
      throw new Error('No project.');
    }

    return loaded;
  };

  const deps = (loaded: Project) => ({
    project: loaded,
    tickets: () => {
      throw new Error('No tickets in this test.');
    },
    print: () => undefined,
  });

  const onlyPod = (loaded: Project) => {
    const store = createPodStore(path.join(loaded.root, '.lambda', 'pods'));
    const [id] = store.listPodIds();

    if (id === undefined) {
      throw new Error('No pod was created.');
    }

    return store.requirePod(id);
  };

  it('lists pods/ in the project .lambda/.gitignore exactly once, however many pods', async () => {
    const loaded = project();

    await runNew('ice-town', { launch: false }, deps(loaded));
    await runNew('ice-town', { launch: false }, deps(loaded));

    const lines = fs
      .readFileSync(path.join(loaded.root, '.lambda', '.gitignore'), 'utf8')
      .split('\n');
    expect(lines.filter((line) => line === 'pods/')).toHaveLength(1);
  });

  it('a --workdir pod owns nothing: done leaves the folder and removes only its manager folder', async () => {
    const loaded = project();
    const workdir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-dog-park-'))
    );
    fs.writeFileSync(path.join(workdir, 'planted.txt'), 'keep me');

    await runNew('dog-park', { launch: false, workdir }, deps(loaded));
    const pod = onlyPod(loaded);

    expect(pod.ownsWorktree).toBe(false);
    expect(pod.managerCwd).toBe(
      path.join(workdir, '.lambda', 'managers', pod.id)
    );
    expect(fs.existsSync(path.join(pod.managerCwd, 'CLAUDE.md'))).toBe(true);

    runDone(pod.id);

    expect(fs.readFileSync(path.join(workdir, 'planted.txt'), 'utf8')).toBe(
      'keep me'
    );
    expect(fs.existsSync(pod.managerCwd)).toBe(false);
  });

  it("a --workdir pod ending takes only its own commands, never a building pod's beside it", async () => {
    const loaded = project();
    const workdir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-dog-park-'))
    );
    await runNew('dog-park', { launch: false, workdir }, deps(loaded));
    const pod = onlyPod(loaded);
    const building = {
      id: 'build-a1b2',
      devCwd: workdir,
      managerCwd: path.join(workdir, '.lambda', 'managers', 'build-a1b2'),
    };
    fs.mkdirSync(building.managerCwd, { recursive: true });
    writeBuildingInstructions(building, 'Leslie Knope');
    const commands = path.join(workdir, '.claude', 'commands');

    runDone(pod.id);

    ['start.md', 'code-review.md', 'qa.md'].forEach((file) =>
      expect(fs.existsSync(path.join(commands, file))).toBe(true)
    );
    expect(fs.existsSync(path.join(commands, 'pod-phase.md'))).toBe(false);
    expect(ourCommandFiles(workdir)).toEqual(
      expect.arrayContaining(['start.md', 'code-review.md', 'qa.md'])
    );
    expect(ourCommandFiles(workdir)).not.toContain('pod-phase.md');
  });

  it("denies lambda.json's pods.deny to every agent, and pods.forkDeny to forks as well", async () => {
    const loaded = project({
      pods: {
        deny: ['Bash(make release:*)'],
        forkDeny: ['Bash(./scripts/publish.sh:*)'],
      },
    });

    await runNew('ice-town', { launch: false }, deps(loaded));
    const pod = onlyPod(loaded);
    const store = createPodStore(path.join(loaded.root, '.lambda', 'pods'));
    const read = (file: string): { permissions: { deny: string[] } } =>
      JSON.parse(fs.readFileSync(store.file(pod.id, file), 'utf8'));

    const main = read('settings.json').permissions.deny;
    const fork = read('fork-settings.json').permissions.deny;

    expect(main).toContain('Bash(make release:*)');
    expect(main).not.toContain('Bash(./scripts/publish.sh:*)');
    expect(fork).toEqual(
      expect.arrayContaining([
        'Bash(make release:*)',
        'Bash(./scripts/publish.sh:*)',
      ])
    );
  });

  it('refuses a --workdir that does not exist, creating nothing', async () => {
    const loaded = project();

    await expect(
      runNew(
        'dog-park',
        { launch: false, workdir: '/no/such/folder' },
        deps(loaded)
      )
    ).rejects.toThrow(
      '--workdir /no/such/folder does not exist. Nothing was created.'
    );
    expect(fs.existsSync(path.join(loaded.root, '.lambda'))).toBe(false);
  });

  it("in a git project, puts the manager's folder in the pod's worktree, never the main checkout", async () => {
    const loaded = project();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', loaded.root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git(
      '-c',
      'user.email=leslie@pawnee.gov',
      '-c',
      'user.name=Leslie Knope',
      'commit',
      '-q',
      '-m',
      'start'
    );
    process.env.LAMBDA_POD_WORKTREES = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-worktrees-'))
    );

    await runNew('ice-town', { launch: false }, deps(loaded));
    const pod = onlyPod(loaded);

    expect(pod.ownsWorktree).toBe(true);
    expect(pod.worktreePath.startsWith(process.env.LAMBDA_POD_WORKTREES)).toBe(
      true
    );
    expect(pod.managerCwd).toBe(
      path.join(pod.worktreePath, '.lambda', 'managers', pod.id)
    );
    expect(fs.existsSync(path.join(pod.managerCwd, 'CLAUDE.md'))).toBe(true);
    expect(pod.managerCwd.startsWith(`${loaded.root}${path.sep}`)).toBe(false);
  });

  it("puts <pods root>/_bin first on the agents' PATH when it holds lambda, else the running lambda's folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-pods-'));

    expect(agentPath(root, '/opt/lambda/bin/lambda')).toMatch(
      /^\/opt\/lambda\/bin:/
    );

    fs.mkdirSync(path.join(root, '_bin'));
    fs.writeFileSync(path.join(root, '_bin', 'lambda'), '#!/bin/sh\n');

    expect(
      agentPath(root, '/opt/lambda/bin/lambda').startsWith(
        `${path.join(root, '_bin')}:`
      )
    ).toBe(true);
  });

  it("launches agents with Lambda's env, and no other tool's", () => {
    const root = seed();
    process.env.LAMBDA_PODS_ROOT = root;
    process.env.OTHER_TOOL_HOME = '/opt/other';
    const store = createPodStore(root);
    const line = agentCommandLine(store.requirePod(POD), store, 'dev', {
      kind: 'fresh',
      sessionId: 'd',
    });

    expect(line).toContain(`LAMBDA_PODS_ROOT='${root}'`);
    expect(line).toContain('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false');
    expect(line).toContain("PATH='");
    expect(line).toContain('--strict-mcp-config');
    expect(line).not.toContain('OTHER_TOOL_HOME');
  });

  it("types lambda.json's pods.firstMessage to the manager and dev first, and points the dev at its addendum", async () => {
    const loaded = project({ pods: { firstMessage: '/warm-up' } });
    const addendum = path.join(
      loaded.root,
      '.lambda',
      'planning',
      'dev.add.md'
    );
    fs.mkdirSync(path.dirname(addendum), { recursive: true });
    fs.writeFileSync(addendum, 'Mark closed trails on the map.\n');

    await runNew('ice-town', { launch: true }, deps(loaded));
    const pod = onlyPod(loaded);

    expect(jest.mocked(sendToPane).mock.calls).toEqual([
      [expect.stringMatching(/:manager$/), '/warm-up'],
      [expect.stringMatching(/:dev$/), '/warm-up'],
    ]);
    const sent = jest.mocked(sendMessage).mock.calls.map(([, args]) => args);
    expect(sent[0]?.text).toContain(
      `then the codebase's additions to it in ${addendum},`
    );
    expect(pod.status).toBe('active');
  });

  it('keeps going when an agent is slow to show its prompt: warns, sends both bootstraps, keeps the pod', async () => {
    const loaded = project();
    jest
      .mocked(waitForAgentReady)
      .mockImplementation(async (target) => !target.endsWith(':dev'));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await runNew('ice-town', { launch: true }, deps(loaded));
    const pod = onlyPod(loaded);

    expect(warn).toHaveBeenCalledWith(
      `⚠ Pod ${pod.id}: dev did not show an input prompt in time; sending anyway.`
    );
    const sent = jest.mocked(sendMessage).mock.calls.map(([, args]) => args);
    expect(sent.map((args) => args.target)).toEqual(['dev', 'manager']);
    expect(sent[0]?.text).toContain(
      `You are the DEV in planning pod ${pod.id}`
    );
    expect(sent[1]?.text).toContain(`PLANNING MANAGER for pod ${pod.id}`);
    // No pods.firstMessage: nothing is typed first.
    expect(jest.mocked(sendToPane)).not.toHaveBeenCalled();
    expect(pod.status).toBe('active');
  });
});
