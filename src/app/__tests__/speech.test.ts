import type { Question } from '../../pod-store';
import { toHexBytes } from '../client/keys';
import {
  clampRate,
  loadUxView,
  missingPictureText,
  saveUxView,
  screenView,
  speakable,
  spokenSections,
} from '../client/speech';
import { approveLabel, checkpointGoal, offersKeepOne } from '../shared/phases';
import { podNumber } from '../shared/podOrder';
import {
  CHECKPOINT_INSTRUCTIONS,
  buildScript,
  itemSections,
  sectionParts,
} from '../shared/speech';
import type { PodSummary } from '../shared/types';

describe('speakable: no ticket numbers read aloud', () => {
  it('drops parenthesised tickets and names bare ones', () => {
    expect(
      speakable('Rangers mark a trail (PAWNEE-70), then close it (PAWNEE-71).')
    ).toBe('Rangers mark a trail, then close it.');
    expect(speakable('Split PAWNEE-69 into two children.')).toBe(
      'Split the ticket into two children.'
    );
    expect(speakable('q3 is still waiting for you')).toBe(
      'question 3 is still waiting for you'
    );
  });
});

describe('checkpoint audio', () => {
  const checkpoint = {
    id: 'q4',
    podId: 'pawnee-a1b2',
    kind: 'checkpoint' as const,
    phase: 3,
    status: 'open' as const,
    blocksCheckpoint: true,
    dependsOn: [],
    createdAt: '2026-10-03T00:00:00.000Z',
    summary: 'I split the epic into a marking ticket and a closing ticket.',
    options: [],
    checkpoint: { cp: 3, decisionIds: ['d2', 'd1'] },
  };
  const decision = (id: string, headline: string, why: string) => ({
    id,
    podId: 'pawnee-a1b2',
    phase: 3,
    decision: headline,
    why,
    details: 'plotTrailRoute internals — never read aloud',
    createdAt: '2026-10-03T00:00:00.000Z',
  });

  it('tells a decision a screen already shows with that screen, keeping its number, and lists only the rest', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: {
        ...checkpoint,
        checkpoint: {
          cp: 4,
          decisionIds: ['d1', 'd2'],
          screens: [
            {
              name: 'Trail map',
              change: 'changed' as const,
              changes: 'A closed trail has a Reopen trail button.',
              tickets: ['3'],
              decisions: ['d2'],
            },
          ],
        },
      },
      thread: [],
      podLabel: 'Test',
      decisions: [
        decision('d1', 'Refused a marker that is not on the trail', 'No guessing.'),
        {
          ...decision(
            'd2',
            'Gave side trails the main Reopen button',
            'Same words.'
          ),
          instead: 'A new dialog for side trails.',
        },
      ],
    });
    const keys = sections?.map((section) => section.key) ?? [];

    expect(keys).toContain('screen-1');
    expect(keys).toContain('decision-1');
    expect(keys).not.toContain('decision-2');
    expect(
      sections?.find((section) => section.key === 'screen-1')?.text
    ).toContain(
      'Decision 2, why this way: Same words. Instead of: A new dialog for side trails.'
    );
    expect(
      sections?.find((section) => section.key === 'screen-1')?.text
    ).toContain(
      'Here is the one decision I made for you that no screen shows.'
    );
  });

  it('reads what happened, then each decision in card order (headline + why, never details), then how to respond', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: checkpoint,
      thread: [],
      podLabel: 'Test',
      decisions: [
        decision(
          'd1',
          'Rangers can only close one trail at a time',
          'Closing a whole park is an owner job.'
        ),
        decision(
          'd2',
          'Rangers get their own marker actions',
          'So they can never delete a trail.'
        ),
      ],
    });

    expect(sections?.map((section) => section.key)).toEqual([
      'goal',
      'summary',
      'decision-1',
      'decision-2',
      'instructions',
    ]);
    expect(sections?.[1]?.text).toContain(
      'Here are the 2 decisions I made for you.'
    );
    expect(sections?.[2]?.text).toBe(
      'Number 1. Rangers get their own marker actions. So they can never delete a trail.'
    );
    expect(sections?.map((section) => section.text).join(' ')).not.toContain(
      'plotTrailRoute'
    );
    expect(sections?.at(-1)?.text).toBe(
      `${CHECKPOINT_INSTRUCTIONS} That approves the split.`
    );

    // The dot label "1" numbers the scrubber; it must not be spoken as well
    // ("1. Number 1. …").
    const script = buildScript(sections ?? []);

    expect(script.text).toContain(
      'Here are the 2 decisions I made for you.\n\nNumber 1. Rangers'
    );
    expect(script.text).not.toMatch(/\d\. Number/);
    expect(script.text).toContain('How to respond. To change');
  });

  it('reads "The plan" between what happened and the decisions', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: {
        ...checkpoint,
        checkpoint: {
          cp: 3,
          decisionIds: [],
          plan: 'Rangers get a Mark a trail button on the map screen.',
        },
      },
      thread: [],
      podLabel: 'Test',
      decisions: [],
    });

    expect(sections?.map((section) => section.key)).toEqual([
      'goal',
      'summary',
      'plan',
      'instructions',
    ]);
    expect(sections?.[1]?.text).toBe(
      'I split the epic into a marking ticket and a closing ticket.'
    );
    expect(sections?.[2]?.text).toBe(
      'Rangers get a Mark a trail button on the map screen. I made no decisions on my own this phase.'
    );
  });

  it('reads a decision like a ticket: what it means, why, and what was not chosen', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: { ...checkpoint, checkpoint: { cp: 3, decisionIds: ['d9'] } },
      thread: [],
      podLabel: 'Test',
      decisions: [
        {
          id: 'd9',
          podId: 'pawnee-a1b2',
          phase: 3,
          decision: 'Named the parts of the Add a marker window',
          means:
            'Rangers see the trail name first, then a tickbox for closed trails.',
          why: 'The ticket gave no order, so I followed its sketch.',
          instead: 'Leaving the wording to whoever builds it.',
          createdAt: '2026-10-04T00:00:00.000Z',
        },
      ],
    });

    expect(
      sections?.find((section) => section.key === 'decision-1')?.text
    ).toBe(
      'Number 1. Named the parts of the Add a marker window. What it means: Rangers see the trail name first, then a tickbox for closed trails. Why: The ticket gave no order, so I followed its sketch. Instead of: Leaving the wording to whoever builds it.'
    );
  });

  it('reads a product decision Before → After, and leaves engineering calls on the card', () => {
    const base = {
      podId: 'pawnee-a1b2',
      phase: 3,
      why: 'It had been missed.',
      createdAt: '2026-10-04T00:00:00.000Z',
    };
    const sections = itemSections({
      kind: 'checkpoint',
      question: {
        ...checkpoint,
        checkpoint: { cp: 3, decisionIds: ['d1', 'd2'] },
      },
      thread: [],
      podLabel: 'Test',
      decisions: [
        {
          ...base,
          id: 'd1',
          decision: 'Sorted the trail list by length',
          before: 'Trails were listed in the order they were added.',
          means: 'The shortest walk is always first.',
        },
        {
          ...base,
          id: 'd2',
          kind: 'engineering' as const,
          decision: 'Cached the map tiles by default',
          before: 'Every visit fetched the tiles again.',
          means: 'The map opens from the cache.',
        },
      ],
    });
    const spoken = sections?.map((section) => section.text).join(' ') ?? '';

    expect(spoken).toContain(
      'Number 1. Sorted the trail list by length. Before: Trails were listed'
    );
    expect(spoken).toContain(
      // "red": the past-tense respelling (see PRONOUNCE in speech.ts).
      'One engineering decision is on the card, not red here.'
    );
    expect(spoken).not.toContain('Cached the map tiles');
  });

  it('reads the UX review screen by screen: what changes, then edge cases — never the ASCII', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: {
        ...checkpoint,
        summary: 'I sketched every screen the tickets change.',
        checkpoint: {
          cp: 4,
          decisionIds: [],
          screens: [
            {
              name: 'Festival schedule',
              change: 'changed',
              before: '┌ 3 stalls ┐',
              after: '┌ 12 stalls ┐',
              changes: 'Visitors see every stall on one page.',
              states: [
                'If two stalls share a slot, Publish stays disabled until the clash is fixed.',
              ],
              tickets: ['2'],
            },
          ],
        },
      },
      thread: [],
      podLabel: 'Test',
      decisions: [],
    });

    expect(sections?.map((section) => section.key)).toEqual([
      'goal',
      'summary',
      'screen-1',
      'instructions',
    ]);
    expect(sections?.[2]?.text).toBe(
      'One screen changes. Screen 1: Festival schedule, changed. Visitors see every stall on one page. I made no decisions on my own this phase.'
    );
    // Edge cases are on demand only — never in the item's audio.
    expect(sections?.map((section) => section.text).join(' ')).not.toContain(
      'Publish stays'
    );
    expect(sections?.map((section) => section.text).join(' ')).not.toContain(
      '┌'
    );
  });

  it('reads one line per ticket after the plan, by build number, never the id', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: {
        ...checkpoint,
        checkpoint: {
          cp: 3,
          decisionIds: [],
          plan: 'Rangers mark and close trails themselves.',
          planTickets: [
            {
              id: 'PAWNEE-70',
              title: '1 - Rangers mark a trail',
              summary: 'A button on the map screen marks the nearest trail.',
            },
            {
              id: 'PAWNEE-71',
              title: '2 - Rangers close a trail',
              summary: 'Any single trail outside the festival weekend.',
            },
          ],
        },
      },
      thread: [],
      podLabel: 'Test',
      decisions: [],
    });

    // One section per ticket, so each can be jumped to.
    expect(sections?.map((section) => section.key)).toEqual([
      'goal',
      'summary',
      'plan',
      'ticket-1',
      'ticket-2',
      'instructions',
    ]);
    expect(sections?.[2]?.text).toBe(
      'Rangers mark and close trails themselves.'
    );
    expect(sections?.[3]?.text).toBe(
      '2 tickets, in build order. Ticket 1: Rangers mark a trail. A button on the map screen marks the nearest trail.'
    );
    expect(sections?.[4]?.text).toBe(
      'Ticket 2: Rangers close a trail. Any single trail outside the festival weekend. I made no decisions on my own this phase.'
    );
    expect(sections?.[4]?.label).toBe('Ticket 2');
    expect(sections?.map((section) => section.text).join(' ')).not.toContain(
      'PAWNEE'
    );

    // Today / After, under the plain name (the Linear title is the fallback).
    const plain = itemSections({
      kind: 'checkpoint',
      question: {
        ...checkpoint,
        checkpoint: {
          cp: 3,
          decisionIds: [],
          plan: 'Rangers mark trails themselves.',
          planTickets: [
            {
              id: 'PAWNEE-70',
              title: '1 - Staff can close a trail with no inspection',
              name: '1 - Trails are inspected before they close',
              today: 'A ranger can close a trail alone.',
              after: 'Closing it asks for a photo of the trail first.',
            },
          ],
        },
      },
      thread: [],
      podLabel: 'Test',
      decisions: [],
    });

    expect(plain?.[3]?.text).toBe(
      'One ticket, in build order. Ticket 1: Trails are inspected before they close. Today: A ranger can close a trail alone. After this ticket: Closing it asks for a photo of the trail first. I made no decisions on my own this phase.'
    );

    // The label numbers the scrubber; the text already says "Ticket 2".
    expect(buildScript(sections ?? []).text).not.toContain(
      'Ticket 2. Ticket 2'
    );
  });
});

const question = (overrides: Partial<Question> = {}): Question => ({
  id: 'q12',
  podId: 'pawnee-a1b2',
  kind: 'question',
  phase: 3,
  status: 'open',
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: '2026-10-03T00:00:00.000Z',
  summary:
    'Show closed trails as their own line on the Ramsett Park map? I recommend A.',
  context: 'The map lists trails → markers.',
  problem: 'Visitors cannot spot a closed trail.',
  options: [
    {
      id: 'A',
      label: 'Own line',
      detail: 'A closed-trail row',
      tradeoffs: 'Longer legend',
    },
    {
      id: 'B',
      label: 'Grey it',
      detail: 'Dim the trail',
      tradeoffs: 'Hides the closure',
    },
  ],
  recommendation: { optionId: 'A', why: 'visitors should never be surprised.' },
  visual: {
    ascii: '┌ Legend   ┐\n│ Closed ✕ │ ← new\n└──────────┘',
    notes: 'Closed trails get their own line.',
    spoken: 'Closed trails now get their own line on the map.',
  },
  ...overrides,
});

describe('pipeline 2 checkpoints', () => {
  const base = {
    podId: 'pawnee-a1b2',
    kind: 'checkpoint' as const,
    phase: 3,
    status: 'open' as const,
    blocksCheckpoint: true,
    dependsOn: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    options: [],
  };
  const sectionsOf = (question: Question) =>
    itemSections({
      kind: 'checkpoint',
      question,
      thread: [],
      podLabel: 'Test',
      decisions: [],
    }) ?? [];

  it('reads the split proposal: the counts first, then each ticket with its E2E impact', () => {
    const sections = sectionsOf({
      ...base,
      id: 'q3',
      summary: 'Two tickets.',
      checkpoint: {
        cp: 3,
        decisionIds: [],
        proposal: [
          {
            number: '1',
            title: 'Visitors see the trail map',
            what: 'A visitor with no signal gets the cached map.',
            files: ['server/src/trails/map.ts:40'],
            dependsOn: [],
            e2e: { kind: 'new-tests', spec: 'trail-map.spec.ts' },
            docs: [],
            overlaps: [],
          },
          {
            number: '2',
            title: 'Visitors see a closure note',
            what: 'A trail closed for three days shows a note.',
            files: ['server/src/trails/closures.ts:12'],
            dependsOn: ['1'],
            e2e: {
              kind: 'new-file',
              spec: 'closure.spec.ts',
              why: 'no spec covers closure notes today',
            },
            docs: ['trails.md'],
            overlaps: [],
          },
        ],
      },
    });

    expect(sections.map((section) => section.key)).toEqual([
      'goal',
      'summary',
      'proposal-1',
      'proposal-2',
      'instructions',
    ]);
    expect(sections[2]?.text).toBe(
      'The proposed split: 2 tickets, built one at a time in this order; one new E2E spec file; one ticket adds tests to an existing spec. Ticket 1: Visitors see the trail map. A visitor with no signal gets the cached map. It adds tests to an existing E2E spec.'
    );
    // Files are on the card, never read.
    expect(sections[3]?.text).not.toMatch(/closures\.ts/);
    expect(sections[3]?.text).toMatch(
      /adds a new E2E spec file, because no spec covers closure notes today/
    );
  });

  it('opens the UX review with what was understood and what changed since the split', () => {
    const sections = sectionsOf({
      ...base,
      id: 'q4',
      summary: 'One screen changes.',
      checkpoint: {
        cp: 4,
        decisionIds: [],
        understood: 'You want the map to work even without a signal.',
        changes: [
          {
            kind: 'ticket',
            text: 'Tickets 3 and 4 became one.',
            before: 'Marking and closing a trail were separate tickets.',
            why: 'The rebase on Epic 1 made them share one screen.',
          },
          { kind: 'engineering', text: 'Renamed the tile helper.' },
          {
            kind: 'screen',
            text: 'The trail map shows the legend first.',
            before: 'It showed the search box first.',
            why: 'You chose the legend over search.',
          },
        ],
      },
    });

    // Each change is its own section (its own dot and skip).
    expect(sections.map((section) => section.key).slice(0, 5)).toEqual([
      'goal',
      'summary',
      'understood',
      'change-1',
      'change-2',
    ]);
    expect(sections[3]?.text).toBe(
      'Since you approved the split, 2 things changed. Change 1, a ticket: Tickets 3 and 4 became one. Before: Marking and closing a trail were separate tickets. Why: The rebase on Epic 1 made them share one screen.'
    );
    expect(sections[4]?.text).toBe(
      'Change 2, a screen: The trail map shows the legend first. Before: It showed the search box first. Why: You chose the legend over search. Plus one engineering fix, on the card.'
    );
  });

  it('reads each flow intro as its own section, before its first screen', () => {
    const screen = (name: string, flow: number) => ({
      name,
      change: 'changed' as const,
      before: 'old',
      after: 'new',
      changes: `${name} changes.`,
      tickets: ['1'],
      flow,
    });
    const sections = sectionsOf({
      ...base,
      id: 'q8',
      summary: 'Three screens.',
      checkpoint: {
        cp: 4,
        decisionIds: [],
        flows: [
          { name: 'Finding a trail', summary: 'Ann searches for the ridge loop.' },
          { name: 'Walking', summary: 'Ann follows the markers.' },
        ],
        screens: [
          screen('Search page', 0),
          screen('Park menu', 0),
          screen('Trail map', 1),
        ],
      },
    });

    expect(sections.map((section) => section.key)).toEqual([
      'goal',
      'summary',
      'flow-1',
      'screen-1',
      'screen-2',
      'flow-2',
      'screen-3',
      'instructions',
    ]);
    expect(sections[2]?.text).toBe(
      '3 screens change. Flow 1: Finding a trail. Ann searches for the ridge loop.'
    );
    // The screen no longer carries its flow's intro.
    expect(sections[3]?.text).toMatch(/^Screen 1: Search page, changed\./);
  });

  it('never reads a picture legend aloud', () => {
    const screen = {
      name: 'Trail map',
      change: 'changed' as const,
      before: 'old',
      after: 'new',
      changes: 'Ann sees why the trail is closed.',
      tickets: ['2'],
    };
    const question = (withPictures: boolean) => ({
      ...base,
      id: 'q9',
      summary: 'One screen.',
      checkpoint: {
        cp: 4,
        decisionIds: [],
        screens: [
          withPictures
            ? {
                ...screen,
                pictures: [
                  {
                    situation: 'Trail closed',
                    after: 'designs/trail-map/trail-closed.annotated.png',
                    legend: [{ n: 1, label: 'Why the trail is closed' }],
                  },
                ],
                prototypeUrl: 'https://claude.ai/design/p/x',
              }
            : screen,
        ],
      },
    });
    const sections = sectionsOf(question(true));

    expect(
      sections.some((section) => section.text.includes('Why the trail is closed'))
    ).toBe(false);
    expect(sections).toEqual(sectionsOf(question(false)));
  });

  it('reads each suggested judgement as its own section, with why it lasts', () => {
    const sections = sectionsOf({
      ...base,
      id: 'q20',
      phase: 5,
      summary: 'Reconciled.',
      checkpoint: {
        cp: 5,
        decisionIds: [],
        suggestedJudgements: [
          {
            kind: 'judgement',
            statement: 'Closed trails stay on the map, greyed out.',
            why: 'Visitors learn the trail is there and will reopen.',
            quote: 'Just grey them out, never hide them.',
          },
          {
            kind: 'copy',
            statement: 'Say trail, never path.',
            why: 'One name everywhere.',
            quote: 'always trail',
            copy: {
              use: 'trail',
              never: ['path'],
              meaning: 'a marked walking route',
            },
          },
        ],
      },
    });
    const judgements = sections.filter((section) =>
      section.key.startsWith('judgement-')
    );

    expect(judgements.map((section) => section.key)).toEqual([
      'judgement-1',
      'judgement-2',
    ]);
    expect(judgements[0]?.text).toBe(
      "I suggest 2 lasting judgements to keep for future tickets. Tick the ones you want before you close the checkpoint. Judgement 1 of 2: Closed trails stay on the map, greyed out. Why it's good long term: Visitors learn the trail is there and will reopen."
    );
    expect(judgements[1]?.text).toMatch(
      /Judgement 2 of 2: .* That means always saying trail, never path\.$/
    );
  });

  it('says so when nothing changed since the UX review', () => {
    const sections = sectionsOf({
      ...base,
      id: 'q9',
      phase: 5,
      summary: 'Reconciled.',
      checkpoint: { cp: 5, decisionIds: [], changes: [] },
    });

    expect(sections.find((section) => section.key === 'changes')?.text).toBe(
      'Nothing you would see changed since the UX review.'
    );
  });
});

describe('speakable', () => {
  it('drops file:line references, code spans and URLs', () => {
    expect(
      speakable(
        'See `buildState` in server/src/state.ts:42 and https://linear.app/x for details.'
      )
    ).toBe('See in and for details.');
  });

  it('reads arrows as words and strips box drawing', () => {
    expect(speakable('trails → markers')).toBe('trails to markers');
    expect(speakable('┌──┐ box ──')).toBe('box');
  });
});

describe('spokenSections', () => {
  it('reads every section in order, summary first', () => {
    expect(spokenSections(question()).map((section) => section.key)).toEqual([
      'summary',
      'context',
      'problem',
      'options',
      'recommendation',
      'visual',
    ]);
  });

  it('speaks the visual notes, never the ASCII', () => {
    const visual = spokenSections(question()).find(
      (section) => section.key === 'visual'
    );

    expect(visual?.text).toBe(
      'Closed trails now get their own line on the map.'
    );
    expect(
      spokenSections(question())
        .map((section) => section.text)
        .join(' ')
    ).not.toMatch(/[┌│└─]/);
  });

  it('formats options and the recommendation as sentences', () => {
    const sections = spokenSections(question());

    expect(
      sections.find((section) => section.key === 'options')?.text
    ).toContain(
      'Option A: Own line. A closed-trail row. Trade-offs: Longer legend.'
    );
    expect(
      sections.find((section) => section.key === 'recommendation')?.text
    ).toBe('I recommend option A, because visitors should never be surprised.');
  });

  it('skips empty sections', () => {
    const keys = spokenSections(
      question({ context: undefined, visual: undefined })
    ).map((section) => section.key);

    expect(keys).not.toContain('context');
    expect(keys).not.toContain('visual');
  });
});

describe('clampRate', () => {
  it('keeps the rate in 1–3.5 on quarter steps', () => {
    expect(clampRate(9)).toBe(3.5);
    expect(clampRate(0.2)).toBe(1);
    expect(clampRate(2.4)).toBe(2.5);
  });
});

describe('toHexBytes', () => {
  it('encodes keys, including escape sequences and multi-byte characters', () => {
    expect(toHexBytes('a\r')).toEqual(['61', '0d']);
    expect(toHexBytes('\x1b[A')).toEqual(['1b', '5b', '41']);
    expect(toHexBytes('é')).toEqual(['c3', 'a9']);
  });
});

describe('speakable: markdown is for the eye', () => {
  it('drops markers, code blocks and attached images; keeps the words', () => {
    expect(
      speakable(
        [
          '## Why it needs a person',
          '- **Ridge loop** is *closed* in winter',
          '- See [the runbook](https://example.com/runbook)',
          '```',
          'ls trails/',
          '```',
          '| Step | Who |',
          '| --- | --- |',
          '| Repaint markers | Ann |',
          '[Image: /home/ann/.pods/_uploads/img_a_b.png]',
        ].join('\n')
      )
    ).toBe(
      'Why it needs a person\nRidge loop is closed in winter\nSee the runbook\nStep, Who\nRepaint markers, Ann'
    );
  });
});

describe('speakable: names the voice gets wrong', () => {
  it('says past "read" as "red" where the voice says "reed"', () => {
    expect(
      speakable('Not read for you. Marked as read. Already re-read it.')
    ).toBe('Not red for you. Marked as red. Already re-red it.');
    expect(speakable('Do not read it. Read the log. I have read it.')).toBe(
      'Do not read it. Read the log. I have read it.'
    );
  });

  it('says the verb "record" as the verb where the voice says the noun', () => {
    expect(
      speakable('Record the decision. Then record it. Re-record that clip.')
    ).toBe('rekord the decision. Then rekord it. Re-rekord that clip.');
    expect(
      speakable('Keep a record. The record shows it. A medical record.')
    ).toBe('Keep a record. The record shows it. A medical record.');
  });
});

describe('checkpoint goal', () => {
  it("a batch's CP2 says it is triage only, and its button says what closing approves", () => {
    expect(checkpointGoal(2, { pipeline: 2, source: 'batch' }).goal).toMatch(
      /^Triage only/
    );
    expect(approveLabel(2, { pipeline: 2, source: 'batch' })).toBe(
      'Approve the ticket structure — close checkpoint 2'
    );
    expect(approveLabel(5, { pipeline: 2, source: 'idea' })).toBe(
      'Approve the final plan — close checkpoint 5'
    );
  });

  it("a lone ticket's split proposal closes as the split or as one ticket", () => {
    const lone = { pipeline: 2, source: 'ticket' } as const;

    expect(offersKeepOne(3, lone)).toBe(true);
    expect(approveLabel(3, lone)).toBe('Accept the split — close checkpoint 3');
    expect(checkpointGoal(3, lone).goal).toMatch(/keep it one ticket/);
    expect(offersKeepOne(3, { pipeline: 2, source: 'epic' })).toBe(false);
    expect(offersKeepOne(5, lone)).toBe(false);
  });
});

describe('every item opens by naming its pod', () => {
  it('"Lambda 2, Trail map bugs. Checkpoint 4." before anything else', () => {
    const sections = itemSections({
      kind: 'checkpoint',
      question: {
        id: 'q8',
        podId: 'p',
        kind: 'checkpoint',
        phase: 3,
        status: 'open',
        blocksCheckpoint: true,
        dependsOn: [],
        createdAt: '2026-10-10T00:00:00.000Z',
        options: [],
        summary: 'Screens changed.',
        checkpoint: { cp: 4, decisionIds: [] },
      },
      thread: [],
      podLabel: 'Trail map bugs',
      podNumber: 2,
    });

    expect(sections?.[0]).toMatchObject({
      key: 'pod',
      text: 'Lambda 2, Trail map bugs. Checkpoint 4.',
    });
  });

  it('says nothing extra without a number', () => {
    expect(
      itemSections({
        kind: 'stalled',
        question: null,
        thread: [],
        podLabel: 'Trail map bugs',
      })?.[0]?.key
    ).not.toBe('pod');
  });
});

describe('podNumber', () => {
  it("is the pod's place in the sidebar", () => {
    const summary = (id: string, createdAt: string): PodSummary => ({
      pod: {
        id,
        slug: id,
        createdAt,
        status: 'active',
        phase: 1,
        completedCheckpoints: [],
        worktreePath: '/tmp',
        ownsWorktree: false,
        managerCwd: '/tmp',
        devCwd: '/tmp',
        agentCommand: 'claude',
        sessions: { manager: 'm', dev: 'd' },
      },
      running: true,
      status: 'working',
      needsYou: 0,
      liveForks: [],
      chatHold: false,
    });
    const pods = [summary('a', '2026-10-01'), summary('b', '2026-10-02')];

    expect(podNumber(pods, [], 'b')).toBe(2);
    expect(podNumber(pods, ['b'], 'b')).toBe(1);
  });
});

describe('sectionParts: a long section plays while the rest renders', () => {
  it('cuts a section into a short first clip, then longer ones', () => {
    const sentence = `${'Leslie '.repeat(13)}wins.`; // 97 characters
    const parts = sectionParts({
      key: 'summary',
      label: 'Summary',
      text: Array(20).fill(sentence).join(' '),
    });

    expect(parts.map((part) => part.key).slice(0, 2)).toEqual([
      'summary#0',
      'summary#1',
    ]);
    expect(parts[0]?.text.startsWith('Summary. Leslie')).toBe(true);
    expect(parts[0]?.text.length).toBeLessThanOrEqual(250);
    expect(parts.every((part) => part.text.length <= 600)).toBe(true);
    expect(parts.map((part) => part.text).join(' ')).toBe(
      `Summary. ${Array(20).fill(sentence).join(' ')}`
    );
  });

  it('keeps a short section as one clip', () => {
    expect(
      sectionParts({ key: 'ask', label: 'Ask', text: 'Approve it?' })
    ).toEqual([{ key: 'ask#0', text: 'Ask. Approve it?' }]);
  });
});

describe('the UX review view (Pictures | ASCII)', () => {
  const withStorage = (storage: Partial<Storage>, body: () => void): void => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: storage },
      configurable: true,
    });

    try {
      body();
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', saved);
      }
    }
  };
  const memory = (initial: string | null) => {
    const items = new Map<string, string>();

    if (initial !== null) {
      items.set('pods.uxView', initial);
    }

    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
  };
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  it('loads pictures unless ascii was saved', () => {
    withStorage(memory(null), () => expect(loadUxView()).toBe('pictures'));
    withStorage(memory('ascii'), () => expect(loadUxView()).toBe('ascii'));
    withStorage(memory('banana'), () => expect(loadUxView()).toBe('pictures'));
    withStorage(throwing, () => expect(loadUxView()).toBe('pictures'));
  });

  it('saves the choice, and never throws when storage is blocked', () => {
    withStorage(memory(null), () => {
      saveUxView('ascii');
      expect(loadUxView()).toBe('ascii');
    });
    withStorage(throwing, () =>
      expect(() => saveUxView('ascii')).not.toThrow()
    );
  });

  it('shows pictures only when chosen and the screen has some', () => {
    const picture = {
      situation: 'Trail closed',
      after: 'designs/trail-map/trail-closed.annotated.png',
      legend: [],
    };

    expect(screenView('pictures', { pictures: [picture] })).toBe('pictures');
    expect(screenView('pictures', {})).toBe('ascii');
    expect(screenView('ascii', { pictures: [picture] })).toBe('ascii');
    expect(screenView('pictures', { pictures: [] })).toBe('ascii');
  });

  it('says a new screen has no today only when it is new', () => {
    expect(missingPictureText('before', { change: 'new' })).toBe(
      'New screen — nothing here today.'
    );
    expect(missingPictureText('before', { change: 'changed' })).toBe(
      'No screenshot of today.'
    );
    expect(missingPictureText('after', { change: 'removed' })).toBe('Removed.');
  });

  it("says why there's no before when the project has no photo hook", () => {
    expect(
      missingPictureText('before', { change: 'changed', noPhotoHook: true })
    ).toBe('No "before" picture: this codebase hasn\'t set up app photos.');
    // A new screen has nothing today either way.
    expect(
      missingPictureText('before', { change: 'new', noPhotoHook: true })
    ).toBe('New screen — nothing here today.');
  });
});
