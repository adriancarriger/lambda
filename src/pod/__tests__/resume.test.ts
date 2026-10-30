/**
 * `lambda pod resume-all`: every active pod back, oldest first, forks that
 * were mid-conversation recovered, a report file written — and nothing run
 * outside the pods' own `lambda-pod-<id>` sessions. tmux, the agent launch
 * and delivery are faked.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, createPodStore } from '../../pod-store';
import * as fork from '../fork';
import { runResumeAll } from '../resume';
import './podProject';

const windows = new Map<string, string[]>();
/** Windows at a shell, by `session:window`. */
const atShell = new Set<string>();
const sessionsTouched: string[] = [];
const launched: string[] = [];
const slept: number[] = [];

const touch = (session: string): string => {
  sessionsTouched.splice(sessionsTouched.length, 0, session);

  return session;
};

jest.mock('../tmux', () => ({
  hasSession: (session: string) => windows.has(touch(session)),
  hasWindow: (session: string, window: string) =>
    (windows.get(touch(session)) ?? []).includes(window),
  listWindows: (session: string) => windows.get(touch(session)) ?? [],
  windowCount: (session: string, window: string) =>
    (windows.get(touch(session)) ?? []).filter((name) => name === window)
      .length,
  killSession: (session: string) => windows.delete(touch(session)),
  killWindow: (target: string) => touch(target.split(':')[0] ?? ''),
  windowAtShell: (session: string, window: string) =>
    atShell.has(`${touch(session)}:${window}`),
  sendToPane: async () => undefined,
  sleep: async (ms: number) => {
    slept.splice(slept.length, 0, ms);
  },
}));

jest.mock('../launch', () => ({
  DEV_BOOTSTRAP: () => '',
  MANAGER_BOOTSTRAP: () => '',
  writePodSettings: () => undefined,
  launchAgent: async (args: { pod: { id: string }; agent: string }) => {
    const session = `lambda-pod-${args.pod.id}`;
    launched.splice(launched.length, 0, `${args.pod.id}:${args.agent}`);
    windows.set(session, [...(windows.get(session) ?? []), args.agent]);

    return true;
  },
}));

// Every process started is recorded; resume-all should start none.
const mockSpawned: string[] = [];

jest.mock('child_process', () => {
  const actual: typeof childProcess = jest.requireActual('child_process');
  const record = (name: string) =>
    jest.fn((file: string) => {
      mockSpawned.splice(mockSpawned.length, 0, `${name} ${file}`);

      throw new Error(`${name} ${file} was not expected`);
    });

  return {
    ...actual,
    spawnSync: record('spawnSync'),
    execFileSync: record('execFileSync'),
    execSync: record('execSync'),
  };
});

jest.mock('../messaging', () => ({
  sendMessage: async () => undefined,
  deliverEntry: async () => undefined,
}));

const pod = (id: string, createdAt: string, status: Pod['status']): Pod => ({
  id,
  slug: id,
  createdAt,
  status,
  phase: 2,
  completedCheckpoints: [1],
  worktreePath: '/tmp/pawnee',
  ownsWorktree: false,
  managerCwd: '/tmp/pawnee',
  devCwd: '/tmp/pawnee',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
});

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  jest.restoreAllMocks();
});

it('resumes the active pods oldest first, skips a paused one, recovers live forks and writes a report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resume-'));
  process.env.LAMBDA_PODS_ROOT = root;
  const store = createPodStore(root);
  // Written newest first: the order must come from createdAt.
  store.writePod(
    pod('bench-donations-2210', '2026-10-05T00:00:00.000Z', 'active')
  );
  store.writePod(pod('ice-town-4821', '2026-10-04T00:00:00.000Z', 'active'));
  store.writePod(pod('lot-48-9999', '2026-10-03T00:00:00.000Z', 'paused'));
  store.writeFork({
    qid: 'chat',
    podId: 'ice-town-4821',
    window: 'fork-chat',
    state: 'active',
    startedAt: '2026-10-04T01:00:00.000Z',
    lastActivityAt: '2026-10-04T01:00:00.000Z',
  });
  store.writeFork({
    qid: 'q2',
    podId: 'ice-town-4821',
    window: 'fork-q2',
    state: 'resolved',
    startedAt: '2026-10-04T01:00:00.000Z',
    lastActivityAt: '2026-10-04T01:00:00.000Z',
  });
  const printed: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.splice(printed.length, 0, line);
  });

  await runResumeAll({ stagger: '0' });

  expect(launched).toEqual([
    'ice-town-4821:manager',
    'ice-town-4821:dev',
    'bench-donations-2210:manager',
    'bench-donations-2210:dev',
  ]);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, '_last-resume.json'), 'utf8')
  );
  expect(report.pods).toEqual([
    { id: 'lot-48-9999', result: 'skipped (paused)' },
    { id: 'ice-town-4821', result: 'resumed' },
    { id: 'bench-donations-2210', result: 'resumed' },
  ]);
  expect(report.recoveredForks).toEqual(['ice-town-4821/chat']);
  expect(printed[0]).toBe('Resuming 2 Lambdas (stagger 0s)…');
  expect(printed.at(-1)).toBe(
    `Report: ${path.join(root, '_last-resume.json')}`
  );
  expect(mockSpawned).toEqual([]);
  expect(
    sessionsTouched.filter((session) => !session.startsWith('lambda-pod-'))
  ).toEqual([]);
});

it("brings back a paused building pod's agents in its windows (always there), and still skips a paused planning pod", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resume-'));
  process.env.LAMBDA_PODS_ROOT = root;
  const store = createPodStore(root);
  store.writePod({
    ...pod('build-c0ff', '2026-10-08T00:00:00.000Z', 'paused'),
    kind: 'building',
    sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
  });
  store.writePod(pod('lot-48-7777', '2026-10-03T00:00:00.000Z', 'paused'));
  // A boot rebuilt the session: the three windows are back, at a shell.
  windows.set('lambda-pod-build-c0ff', ['manager', 'qa', 'dev']);
  ['manager', 'qa', 'dev'].forEach((name) =>
    atShell.add(`lambda-pod-build-c0ff:${name}`)
  );
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  await runResumeAll({ stagger: '0' });

  expect(launched.filter((one) => one.startsWith('build-c0ff:'))).toEqual([
    'build-c0ff:engineering-manager',
    'build-c0ff:dev',
    'build-c0ff:qa',
  ]);
  expect(launched.some((one) => one.startsWith('lot-48-7777:'))).toBe(false);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, '_last-resume.json'), 'utf8')
  );
  expect(report.pods).toEqual([
    { id: 'build-c0ff', result: 'agents back (paused)' },
    { id: 'lot-48-7777', result: 'skipped (paused)' },
  ]);
  // Paused it stays: its agents are up, but it takes no ticket.
  expect(store.requirePod('build-c0ff').status).toBe('paused');
});

it("keeps going when one fork can't be recovered: the others are, and the report says which failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resume-'));
  process.env.LAMBDA_PODS_ROOT = root;
  const store = createPodStore(root);
  store.writePod(pod('pit-cleanup-1111', '2026-10-06T00:00:00.000Z', 'active'));
  store.writePod(
    pod('harvest-fest-2222', '2026-10-07T00:00:00.000Z', 'active')
  );
  ['pit-cleanup-1111', 'harvest-fest-2222'].forEach((podId) =>
    store.writeFork({
      qid: 'chat',
      podId,
      window: 'fork-chat',
      state: 'active',
      startedAt: '2026-10-07T01:00:00.000Z',
      lastActivityAt: '2026-10-07T01:00:00.000Z',
    })
  );
  jest
    .spyOn(fork, 'runForkRecover')
    .mockImplementation(async (podId: string) => {
      if (podId === 'pit-cleanup-1111') {
        throw new Error('the fork window is gone');
      }
    });
  const printed: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.splice(printed.length, 0, line);
  });
  const warned: string[] = [];
  jest.spyOn(console, 'warn').mockImplementation((line: string) => {
    warned.splice(warned.length, 0, line);
  });

  await runResumeAll({ stagger: '0' });

  const report = JSON.parse(
    fs.readFileSync(path.join(root, '_last-resume.json'), 'utf8')
  );
  expect(report.recoveredForks).toEqual(['harvest-fest-2222/chat']);
  expect(report.errors).toEqual([
    'fork pit-cleanup-1111/chat not recovered: the fork window is gone',
  ]);
  expect(warned).toEqual([
    '⚠ fork pit-cleanup-1111/chat not recovered: the fork window is gone',
  ]);
  expect(printed.at(-1)).toBe(
    `Report: ${path.join(root, '_last-resume.json')}`
  );
});

it('brings a building pod back first and at once, then staggers only the planning pods', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resume-'));
  process.env.LAMBDA_PODS_ROOT = root;
  const store = createPodStore(root);
  store.writePod(pod('rec-center-3101', '2026-10-01T00:00:00.000Z', 'active'));
  store.writePod(pod('dog-park-3102', '2026-10-02T00:00:00.000Z', 'active'));
  // The newest pod, but the one whose windows are in front of you.
  store.writePod({
    ...pod('build-be11', '2026-10-09T00:00:00.000Z', 'active'),
    kind: 'building',
    sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
  });
  windows.set('lambda-pod-build-be11', ['manager', 'qa', 'dev']);
  ['manager', 'qa', 'dev'].forEach((name) =>
    atShell.add(`lambda-pod-build-be11:${name}`)
  );
  launched.splice(0, launched.length);
  slept.splice(0, slept.length);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  await runResumeAll({ stagger: '30' });

  expect(launched.map((one) => one.split(':')[0])).toEqual([
    'build-be11',
    'build-be11',
    'build-be11',
    'rec-center-3101',
    'rec-center-3101',
    'dog-park-3102',
    'dog-park-3102',
  ]);
  // One wait, between the two planning pods: none before or after the build.
  expect(slept).toEqual([30_000]);
});

it('--only building brings back just the building pod, so a boot can start it before anything else', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resume-'));
  process.env.LAMBDA_PODS_ROOT = root;
  const store = createPodStore(root);
  store.writePod(pod('ice-rink-3201', '2026-10-01T00:00:00.000Z', 'active'));
  store.writePod({
    ...pod('build-be22', '2026-10-09T00:00:00.000Z', 'paused'),
    kind: 'building',
    sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
  });
  windows.set('lambda-pod-build-be22', ['manager', 'qa', 'dev']);
  ['manager', 'qa', 'dev'].forEach((name) =>
    atShell.add(`lambda-pod-build-be22:${name}`)
  );
  launched.splice(0, launched.length);
  const printed: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.splice(printed.length, 0, line);
  });

  await runResumeAll({ only: 'building' });

  expect(launched.every((one) => one.startsWith('build-be22:'))).toBe(true);
  expect(launched).toHaveLength(3);
  expect(printed[0]).toBe('Resuming 0 Lambdas (stagger 30s)…');
  await expect(runResumeAll({ only: 'bakery' })).rejects.toThrow(
    '--only takes building or planning (got "bakery").'
  );
});
