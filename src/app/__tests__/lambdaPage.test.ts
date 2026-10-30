import {
  ago,
  blockerChoices,
  epicProgress,
  focusTicket,
  foldedLine,
  mainAction,
  ordinal,
  phaseDivider,
  phaseStrip,
  queuePlace,
  stripStepOf,
} from '../shared/lambdaPage';
import type { Lambda, LambdaTicket } from '../shared/lambdas';

/** A Lambda's page past planning: the same page in every phase. */

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

const ticket = (id: string, where: LambdaTicket['where']): LambdaTicket => ({
  id,
  title: `Ticket ${id}`,
  where,
});

const lambda = (extra: Partial<Lambda> = {}): Lambda => ({
  key: 'pod:plan-parks',
  title: 'Parks site launch',
  projectId: 'parks',
  planningPodId: 'plan-parks',
  ticketId: 'PAWNEE-2',
  tickets: [],
  phase: 'queued',
  needsYou: [],
  working: false,
  shippedAt: null,
  paused: false,
  ...extra,
});

const queued = (place: number): LambdaTicket['where'] => ({
  kind: 'queued',
  place,
  computer: "Leslie's Mac",
  podId: 'build-leslie',
  ahead: [],
});

describe("a Lambda's page", () => {
  it('shows QA in the phase strip only when the review step is on', () => {
    expect(phaseStrip('ready', false).map((one) => one.label)).toEqual([
      'Planning',
      'Ready',
      'Building',
      'Merged',
    ]);
    expect(
      phaseStrip('building', true).map((one) => [one.id, one.state])
    ).toEqual([
      ['planning', 'done'],
      ['ready', 'done'],
      ['building', 'current'],
      ['qa', 'todo'],
      ['merged', 'todo'],
    ]);
    expect(phaseStrip('qa', false).map((one) => one.id)).toContain('qa');
    expect(stripStepOf('shipped')).toBe('merged');
  });

  it('is about the ticket waiting on the owner first, a blocker before a review', () => {
    const page = lambda({
      tickets: [
        ticket('PAWNEE-2a', {
          kind: 'building',
          step: 'build',
          startedAt: '2026-10-26T11:00:00.000Z',
          computer: "Leslie's Mac",
          podId: 'build-leslie',
        }),
        ticket('PAWNEE-2b', queued(2)),
        ticket('PAWNEE-2c', {
          kind: 'blocked',
          computer: "Ann's Mac",
          podId: 'build-ann',
          messageId: 'm1',
        }),
      ],
      needsYou: [
        {
          podId: 'build-leslie',
          kind: 'reply',
          key: 'k-review',
          ticketId: 'PAWNEE-2a',
          tag: 'review',
        },
        {
          podId: 'build-ann',
          kind: 'reply',
          key: 'k-blocked',
          ticketId: 'PAWNEE-2c',
          tag: 'blocked',
        },
      ],
    });

    expect(focusTicket(page)?.id).toBe('PAWNEE-2c');
    expect(mainAction(page)).toBe('Answer, and carry on');
    expect(
      focusTicket({ ...page, needsYou: page.needsYou.slice(0, 1) })?.id
    ).toBe('PAWNEE-2a');
  });

  it("says a queued ticket's place in line and roughly when it starts", () => {
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(22)).toBe('22nd');
    expect(queuePlace(ticket('PAWNEE-4', queued(3)), 20 * 60_000)).toEqual({
      headline: '3rd in line',
      detail: "on Leslie's Mac · starts in about 40 min",
    });
    expect(queuePlace(ticket('PAWNEE-4', queued(1)), 20 * 60_000)).toEqual({
      headline: 'Next in line',
      detail: "on Leslie's Mac",
    });
  });

  it('folds every phase before this one into one line', () => {
    expect(foldedLine('ready', 23, 5)).toBe(
      'Planning · 5 checkpoints, 23 messages'
    );
    expect(foldedLine('building', 31, 5)).toBe(
      'Planning and Ready · 31 messages'
    );
    expect(foldedLine('qa', 44, 5)).toBe(
      'Planning, Ready and Building · 44 messages'
    );
    expect(foldedLine('merged', 18, 0)).toBe(
      'Planning, Ready and Building · 18 messages'
    );
  });

  it('marks where each phase starts', () => {
    expect(
      phaseDivider(
        lambda({ phase: 'building' }),
        ticket('PAWNEE-6', {
          kind: 'building',
          step: 'build',
          startedAt: '2026-10-26T11:42:00.000Z',
          computer: "Leslie's Mac",
          podId: 'build-leslie',
        }),
        NOW,
        {}
      )
    ).toBe("Leslie's Mac picked it up · 18m ago");
    expect(
      phaseDivider(
        lambda({ phase: 'shipped', shippedAt: '2026-10-26T10:00:00.000Z' }),
        null,
        NOW,
        { commit: '4bde137aa' }
      )
    ).toBe('Merged · 4bde137 · 2h ago');
    expect(
      phaseDivider(lambda({ phase: 'qa' }), null, NOW, {
        builtMs: 31 * 60_000,
      })
    ).toBe('Built in 31m · waiting for your review');
    expect(ago('2026-10-23T12:00:00.000Z', NOW)).toBe('3d ago');
  });

  it("gives each phase its main action, and an epic's progress once a part ships", () => {
    expect(mainAction(lambda({ phase: 'queued' }))).toBe('Plan more');
    expect(mainAction(lambda({ phase: 'qa' }))).toBe('Approve and merge');
    expect(mainAction(lambda({ phase: 'shipped' }))).toBe("Plan what's next");
    expect(mainAction(lambda({ phase: 'building' }))).toBeNull();

    const shipped = ticket('PAWNEE-1', {
      kind: 'shipped',
      at: '2026-10-26T10:00:00.000Z',
      computer: "Leslie's Mac",
      podId: 'build-leslie',
    });

    expect(
      epicProgress(
        lambda({
          tickets: [
            shipped,
            { ...shipped, id: 'PAWNEE-3' },
            ticket('PAWNEE-4', queued(2)),
            ticket('PAWNEE-5', queued(3)),
            ticket('PAWNEE-7', queued(4)),
          ],
        })
      )?.line
    ).toBe('Parks site launch is 2 of 5 shipped');
    expect(epicProgress(lambda({ tickets: [shipped] }))).toBeNull();
  });
});

describe("a Blocked item's choices", () => {
  it('splits its numbered options, picking the one its recommendation names', () => {
    expect(
      blockerChoices(
        '1) Parks only, for now 2) Both Parks and Animal Control',
        'Parks only, for now.'
      )
    ).toEqual({
      choices: ['Parks only, for now', 'Both Parks and Animal Control'],
      recommended: 0,
    });
    expect(blockerChoices('Look at the Agents tab', 'Check it.')).toEqual({
      choices: [],
      recommended: -1,
    });
  });
});
