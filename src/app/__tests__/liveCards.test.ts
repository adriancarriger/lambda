import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, type Question, createPodStore } from '../../pod-store';
import { refreshStaleCards, staleCards } from '../server/liveCards';

/**
 * Which cards the inbox re-reads: an OPEN checkpoint whose recorded files
 * changed after the card was last read — once per edit, so an edit that fails
 * its checks isn't re-run until the file changes again.
 */

const POD = 'pawnee-a1b2';
const PROPOSAL = '/tmp/pawnee/proposal.json';
const READ_AT = '2026-10-16T10:00:00.000Z';

const pod: Pod = {
  id: POD,
  slug: 'pawnee',
  createdAt: '2026-10-07T00:00:00.000Z',
  status: 'active',
  phase: 3,
  completedCheckpoints: [],
  worktreePath: '/tmp/pawnee',
  ownsWorktree: false,
  managerCwd: '/tmp/pawnee',
  devCwd: '/tmp/pawnee',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  pipeline: 2,
};

const checkpoint = (overrides: Partial<Question> = {}): Question => ({
  id: 'q1',
  podId: POD,
  kind: 'checkpoint',
  phase: 3,
  status: 'open',
  blocksCheckpoint: true,
  dependsOn: [],
  createdAt: '2026-10-16T09:00:00.000Z',
  options: [],
  checkpoint: {
    cp: 3,
    decisionIds: [],
    sources: { summary: 'Two tickets.', proposalFile: PROPOSAL },
    refreshedAt: READ_AT,
  },
  ...overrides,
});

const storeWith = (question: Question) => {
  const store = createPodStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pods-live-'))
  );
  store.writePod(pod);
  store.writeQuestion(question);

  return store;
};

const later = Date.parse(READ_AT) + 5_000;
const edited = (file: string): number | null =>
  file === PROPOSAL ? later : null;

it('a file edited after the card was read makes the card stale', () => {
  expect(staleCards(storeWith(checkpoint()), edited, new Map())).toEqual([
    { podId: POD, cp: 3, mtime: later },
  ]);
});

it('an edit already refreshed for (even one that failed) is not re-run', () => {
  expect(
    staleCards(storeWith(checkpoint()), edited, new Map([[`${POD}/3`, later]]))
  ).toEqual([]);
});

it('files older than the last read, or a closed card, are left alone', () => {
  expect(
    staleCards(
      storeWith(checkpoint()),
      () => Date.parse(READ_AT) - 1,
      new Map()
    )
  ).toEqual([]);
  expect(
    staleCards(storeWith(checkpoint({ status: 'answered' })), edited, new Map())
  ).toEqual([]);
});

it('says why a refresh failed, and leaves that edit for the next one', async () => {
  const logs: { lines: string[] } = { lines: [] };
  const tried = new Map<string, number>();
  const refreshing = new Set<string>();

  await refreshStaleCards({
    store: storeWith(checkpoint()),
    mtimeOf: edited,
    tried,
    refreshing,
    refresh: () => Promise.reject(new Error('proposal.json is not JSON')),
    log: (line) => {
      logs.lines = [...logs.lines, line];
    },
  });

  expect(logs.lines).toEqual([
    `Couldn't refresh checkpoint 3 of ${POD}: proposal.json is not JSON. It's tried again when its files change.`,
  ]);
  expect(tried.get(`${POD}/3`)).toBe(later);
  expect(refreshing.size).toBe(0);
});
