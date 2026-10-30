import type { AutonomousDecision, Question, Screen } from '../../pod-store';
import {
  buildTimeline,
  decisionCardKey,
  lastChange,
  screenCardKey,
} from '../shared/cardHistory';

/**
 * A checkpoint's versions as one timeline: each card (screen, ticket,
 * decision) knows which versions added, changed or removed it, and each
 * version how many cards it touched.
 */

const screen = (name: string, after: string): Screen => ({
  name,
  change: 'changed',
  before: 'Bench list — 40 benches',
  after,
  changes: 'Leslie sees which benches are adopted.',
  tickets: ['1'],
});

const decision = (id: string, text: string): AutonomousDecision => ({
  id,
  podId: 'pawnee-a1b2',
  phase: 4,
  decision: text,
  why: 'Ron forgets.',
  createdAt: '2026-10-17T09:00:00.000Z',
});

const version = (
  n: number,
  screens: Screen[],
  decisions: AutonomousDecision[] = [],
  versionKind: 'posted' | 'reposted' | 'edited' = 'edited'
): Question => ({
  id: 'q4',
  podId: 'pawnee-a1b2',
  kind: 'checkpoint',
  phase: 4,
  status: 'open',
  blocksCheckpoint: true,
  dependsOn: [],
  createdAt: '2026-10-17T09:00:00.000Z',
  options: [],
  checkpoint: {
    cp: 4,
    decisionIds: decisions.map(({ id }) => id),
    decisionSnapshot: decisions,
    screens,
    version: n,
    versionAt: `2026-10-17T1${n}:00:00.000Z`,
    versionKind,
  },
});

const benches = (after: string) => screen('Bench list', after);
const mural = screen('Mural: colours, sizes and the artist', 'Hi Donna');
const BENCHES = screenCardKey(benches(''));
const MURAL = screenCardKey(mural);
const SWINGS = decisionCardKey('d1');

const history = [
  version(
    1,
    [benches('31 adopted')],
    [decision('d1', 'Ron inspects the swings')],
    'posted'
  ),
  // Renumbered and a card added: only the new card is a change.
  version(
    2,
    [mural, benches('31 adopted')],
    [decision('d1', 'Ron inspects the swings')]
  ),
  // A re-post that changed nothing.
  version(
    3,
    [mural, benches('31 adopted')],
    [decision('d1', 'Ron inspects the swings')],
    'reposted'
  ),
  version(
    4,
    [mural, benches('31 adopted · 2 new')],
    [decision('d1', 'Ron inspects the swings a day early')]
  ),
];

it('counts the cards each version touched (v1 is the post)', () => {
  expect(
    buildTimeline(history).versions.map(({ version: v, kind, changes }) => ({
      v,
      kind,
      changes,
    }))
  ).toEqual([
    { v: 1, kind: 'posted', changes: 0 },
    { v: 2, kind: 'edited', changes: 1 },
    { v: 3, kind: 'reposted', changes: 0 },
    { v: 4, kind: 'edited', changes: 2 },
  ]);
});

it('marks the versions that added or changed each card', () => {
  const { cards } = buildTimeline(history);

  expect([...(cards.get(BENCHES) ?? [])]).toEqual([
    [1, 'added'],
    [4, 'changed'],
  ]);
  expect([...(cards.get(MURAL) ?? [])]).toEqual([[2, 'added']]);
  expect([...(cards.get(SWINGS) ?? [])]).toEqual([
    [1, 'added'],
    [4, 'changed'],
  ]);
});

it('says when a card last changed, as of the version on screen', () => {
  const timeline = buildTimeline(history);

  expect(lastChange(timeline, BENCHES, 4)).toEqual({
    version: 4,
    change: 'changed',
  });
  expect(lastChange(timeline, BENCHES, 3)).toEqual({
    version: 1,
    change: 'added',
  });
  // Not in v1 yet.
  expect(lastChange(timeline, MURAL, 1)).toBeUndefined();
});
