import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Question } from '../schemas';
import { createPodStore } from '../store';
import {
  QUICK_EDIT_MS,
  nextCardVersion,
  reversionForDecision,
} from '../versions';

/**
 * A checkpoint card is edited in place; the card it replaces is kept as a
 * version — unless nothing changed, or it was a quick edit nobody saw.
 */

const POD = 'pawnee-a1b2';
const POSTED = new Date('2026-10-17T09:00:00.000Z');
const later = (ms: number): Date => new Date(POSTED.getTime() + ms);

const card = (summary: string, extra: Partial<Question> = {}): Question => ({
  id: 'q4',
  podId: POD,
  kind: 'checkpoint',
  phase: 3,
  status: 'open',
  blocksCheckpoint: true,
  dependsOn: [],
  createdAt: POSTED.toISOString(),
  options: [],
  summary,
  checkpoint: { cp: 4, decisionIds: [] },
  ...extra,
});

const store = () =>
  createPodStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pods-versions-')));

const posted = (s: ReturnType<typeof store>): Question =>
  nextCardVersion({
    store: s,
    previous: undefined,
    next: card('Leslie reviews the parks budget.'),
    kind: 'posted',
    now: POSTED,
  });

it('a new card is v1', () => {
  expect(posted(store()).checkpoint).toMatchObject({
    version: 1,
    versionKind: 'posted',
  });
});

it('an edit he saw keeps the old card and becomes the next version', () => {
  const s = store();
  const v1 = posted(s);
  const v2 = nextCardVersion({
    store: s,
    previous: v1,
    next: card('Ron cuts the parks budget.'),
    kind: 'edited',
    now: later(30_000),
    activeMs: () => 12_000,
  });

  expect(v2.checkpoint).toMatchObject({ version: 2, versionKind: 'edited' });
  expect(s.listQuestionVersions(POD, 'q4')).toEqual([v1]);
});

it('an edit to a card that has been up a while is kept, seen or not', () => {
  const s = store();
  const v2 = nextCardVersion({
    store: s,
    previous: posted(s),
    next: card('Ron cuts the parks budget.'),
    kind: 'reposted',
    now: later(QUICK_EDIT_MS + 1),
    activeMs: () => 0,
  });

  expect(v2.checkpoint?.version).toBe(2);
  expect(s.listQuestionVersions(POD, 'q4')).toHaveLength(1);
});

it('a quick edit nobody saw replaces the version instead', () => {
  const s = store();
  const v1 = nextCardVersion({
    store: s,
    previous: posted(s),
    next: card('Ron cuts the parks budget.'),
    kind: 'edited',
    now: later(20_000),
    activeMs: () => 0,
  });

  expect(v1.checkpoint).toMatchObject({ version: 1, versionKind: 'posted' });
  expect(v1.summary).toBe('Ron cuts the parks budget.');
  expect(s.listQuestionVersions(POD, 'q4')).toEqual([]);
});

it('a refresh that changes nothing he would see is not a version', () => {
  const s = store();
  const v1 = posted(s);
  const same = nextCardVersion({
    store: s,
    previous: v1,
    next: {
      ...card('Leslie reviews the parks budget.'),
      checkpoint: {
        cp: 4,
        decisionIds: [],
        refreshedAt: later(1).toISOString(),
      },
    },
    kind: 'edited',
    now: later(QUICK_EDIT_MS * 5),
    activeMs: () => 60_000,
  });

  expect(same.checkpoint?.version).toBe(1);
  expect(s.listQuestionVersions(POD, 'q4')).toEqual([]);
});

it('a card posted before versions existed counts as v1', () => {
  const s = store();
  const legacy = card('Leslie reviews the parks budget.');
  const next = nextCardVersion({
    store: s,
    previous: legacy,
    next: card('Ron cuts the parks budget.'),
    kind: 'reposted',
    now: later(QUICK_EDIT_MS * 3),
    activeMs: () => 0,
  });

  expect(next.checkpoint?.version).toBe(2);
  expect(s.listQuestionVersions(POD, 'q4')[0]?.checkpoint?.version).toBe(1);
});

it('a re-post is always a version, even with nothing changed', () => {
  const s = store();
  const v1 = posted(s);
  const v2 = nextCardVersion({
    store: s,
    previous: v1,
    next: card('Leslie reviews the parks budget.'),
    kind: 'reposted',
    now: later(QUICK_EDIT_MS * 2),
    activeMs: () => 5_000,
  });

  expect(v2.checkpoint).toMatchObject({ version: 2, versionKind: 'reposted' });
});

it('amending a decision makes a new version that keeps the old wording', () => {
  const s = store();
  s.writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: POSTED.toISOString(),
    status: 'active',
    phase: 4,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
    pipeline: 2,
  });
  s.appendAutonomousDecision({
    id: 'd1',
    podId: POD,
    phase: 4,
    decision: 'Ron gets a closure notice',
    why: 'He forgets.',
    createdAt: POSTED.toISOString(),
  });
  // Posted a while ago, with the decision's wording copied in.
  s.writeQuestion({
    ...card('Leslie reviews the parks budget.'),
    checkpoint: {
      cp: 4,
      decisionIds: ['d1'],
      version: 1,
      versionAt: new Date(Date.now() - QUICK_EDIT_MS * 3).toISOString(),
      versionKind: 'posted',
      decisionSnapshot: s.readAutonomousDecisions(POD),
    },
  });
  s.updateAutonomousDecision(POD, 'd1', (decision) => ({
    ...decision,
    decision: 'Ron gets a closure notice a day early',
  }));

  reversionForDecision(s, POD, 'd1');

  const now = s.readQuestion(POD, 'q4');
  expect(now?.checkpoint?.version).toBe(2);
  expect(now?.checkpoint?.decisionSnapshot?.[0]?.decision).toBe(
    'Ron gets a closure notice a day early'
  );
  expect(
    s.listQuestionVersions(POD, 'q4')[0]?.checkpoint?.decisionSnapshot?.[0]
      ?.decision
  ).toBe('Ron gets a closure notice');
});
