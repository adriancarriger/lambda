import { matchCheckpointPhrase } from '../checkpoint';
import { orderInbox } from '../inbox';
import { applySectionEdit, commitProblems } from '../questions';
import { buildResolution } from '../resolution';
import { type ColdRead, type Pod, type Question } from '../schemas';
import { formatWire, parseMsgId } from '../wire';

const ready = (overrides: Partial<Question> = {}): Question => ({
  id: 'q1',
  podId: 'pawnee-a1b2',
  kind: 'question',
  phase: 2,
  status: 'draft',
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: '2026-10-03T00:00:00.000Z',
  summary:
    'Show closed trails on Ron Swanson’s trail map as their own layer? Rec A.',
  context:
    'The trail map lists open trails and markers; closed trails are invisible today.',
  problem: 'Hikers cannot tell a closed trail from a missing one.',
  options: [
    {
      id: 'A',
      label: 'Own layer',
      detail: 'Closed-trail layer',
      tradeoffs: 'Busier map',
    },
    {
      id: 'B',
      label: 'Hide them',
      detail: 'Drop closed trails',
      tradeoffs: 'Hides the closure',
    },
  ],
  recommendation: {
    optionId: 'A',
    why: 'Hikers should never be surprised.',
  },
  ...overrides,
});

const cleanRead: ColdRead = {
  restatement: 'Whether closed trails get their own map layer.',
  choice: 'A',
  missing: [],
};

describe('commitProblems', () => {
  it('accepts a complete draft with a clean cold read', () => {
    expect(
      commitProblems(ready(), cleanRead, 'All context inline.', [])
    ).toEqual([]);
  });

  it('names a missing section', () => {
    expect(
      commitProblems(ready({ problem: '' }), cleanRead, 'ok', [])
    ).toContain('Missing section: problem.');
  });

  it('rejects an option count outside 2–4', () => {
    const [first] = ready().options;

    expect(
      commitProblems(
        ready({ options: first === undefined ? [] : [first] }),
        cleanRead,
        'ok',
        []
      )
    ).toContain('Needs 2–4 options; has 1.');
  });

  it('rejects a recommendation that names no real option', () => {
    expect(
      commitProblems(
        ready({ recommendation: { optionId: 'C', why: 'x' } }),
        cleanRead,
        'ok',
        []
      ).join(' ')
    ).toContain('option "C", which does not exist');
  });

  it('rejects a cold read that still had questions', () => {
    expect(
      commitProblems(
        ready(),
        { ...cleanRead, missing: ['Which map — summer or winter?'] },
        'ok',
        []
      ).join(' ')
    ).toContain('Which map — summer or winter?');
  });

  it('rejects a missing justification and a missing cold read', () => {
    const problems = commitProblems(ready(), undefined, '  ', []);

    expect(problems).toContain('A cold-read result is required.');
    expect(problems).toContain(
      'A justification for why this question is ready is required.'
    );
  });

  it('refuses to queue behind an open hinging question', () => {
    const hinge = ready({ id: 'q1', status: 'open' });

    expect(
      commitProblems(ready({ id: 'q2', dependsOn: ['q1'] }), cleanRead, 'ok', [
        hinge,
      ]).join(' ')
    ).toContain('Depends on q1, which is still open');
    expect(
      commitProblems(ready({ id: 'q2', dependsOn: ['q1'] }), cleanRead, 'ok', [
        { ...hinge, status: 'answered' },
      ])
    ).toEqual([]);
  });

  it('only commits drafts', () => {
    expect(
      commitProblems(ready({ status: 'open' }), cleanRead, 'ok', [])[0]
    ).toContain('only drafts can be committed');
  });
});

describe('applySectionEdit', () => {
  it('parses structured sections and refuses non-drafts', () => {
    const edited = applySectionEdit(
      ready(),
      'recommendation',
      '{"optionId":"B","why":"Shorter"}'
    );

    expect(edited.recommendation).toEqual({ optionId: 'B', why: 'Shorter' });
    expect(() =>
      applySectionEdit(ready({ status: 'open' }), 'summary', 'x')
    ).toThrow('only drafts can be edited');
  });
});

describe('matchCheckpointPhrase', () => {
  it.each([
    'checkpoint complete',
    'Check point complete.',
    'ok CHECKPOINT  complete!',
    'looks good — checkpoint-complete',
  ])('matches %p', (text) => {
    expect(matchCheckpointPhrase(text)).toBe(true);
  });

  it.each([
    'is the checkpoint complete?',
    'checkpoint not complete',
    'the checkpoint is almost done',
  ])('does not match %p', (text) => {
    expect(matchCheckpointPhrase(text)).toBe(false);
  });
});

const podFixture = (id: string, createdAt: string): Pod => ({
  id,
  slug: id,
  createdAt,
  status: 'active',
  phase: 2,
  completedCheckpoints: [],
  worktreePath: '/tmp',
  ownsWorktree: true,
  managerCwd: '/tmp',
  devCwd: '/tmp',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
});

describe('orderInbox', () => {
  const pawnee = podFixture('pawnee-a1b2', '2026-10-01T00:00:00.000Z');
  const eagleton = podFixture('eagleton-c3d4', '2026-10-02T00:00:00.000Z');
  const open = (
    podId: string,
    id: string,
    committedAt: string,
    extra: Partial<Question> = {}
  ) => ready({ podId, id, status: 'open', committedAt, ...extra });

  it('orders by pod priority, then checkpoint urgency, then age', () => {
    const items = orderInbox(
      [pawnee, eagleton],
      [
        open('pawnee-a1b2', 'q1', '2026-10-03T01:00:00.000Z'),
        open('eagleton-c3d4', 'q1', '2026-10-03T03:00:00.000Z'),
        open('eagleton-c3d4', 'q2', '2026-10-03T04:00:00.000Z', {
          blocksCheckpoint: true,
        }),
        open('pawnee-a1b2', 'q2', '2026-10-03T00:30:00.000Z'),
        ready({ podId: 'pawnee-a1b2', id: 'q3' }),
      ],
      ['eagleton-c3d4']
    );

    expect(items.map((item) => `${item.pod.id}/${item.question.id}`)).toEqual([
      'eagleton-c3d4/q2',
      'eagleton-c3d4/q1',
      'pawnee-a1b2/q2',
      'pawnee-a1b2/q1',
    ]);
  });

  it('hides paused pods', () => {
    expect(
      orderInbox(
        [{ ...pawnee, status: 'paused' }],
        [open('pawnee-a1b2', 'q1', '2026-10-03T01:00:00.000Z')],
        []
      )
    ).toEqual([]);
  });
});

describe('wire markers', () => {
  it('formats and parses message ids', () => {
    const wire = formatWire(
      '/human-async',
      { qid: 'q12', msgId: 'mabc1' },
      'go with B'
    );

    expect(wire).toBe('/human-async q12 [m:mabc1]: go with B');
    expect(parseMsgId(wire)).toBe('mabc1');
    expect(parseMsgId('no marker here')).toBeNull();
  });
});

describe('buildResolution', () => {
  it('includes verbatim quotes, deferred items and the full transcript', () => {
    const text = buildResolution({
      ownerName: 'Leslie Knope',
      qid: 'q12',
      msgId: 'mres1',
      unconfirmed: false,
      decisions: [
        {
          id: 'd1',
          podId: 'pawnee-a1b2',
          qid: 'q12',
          decision: 'Remove the closed badge',
          quote: "kill the badge, it's noise",
          createdAt: 'x',
        },
        {
          id: 'd2',
          podId: 'pawnee-a1b2',
          qid: 'q12',
          decision: 'Empty state for months with no closures',
          quote: 'later',
          deferred: true,
          createdAt: 'x',
        },
      ],
      conversation: [
        {
          id: 'm1',
          podId: 'pawnee-a1b2',
          qid: 'q12',
          from: 'human',
          mode: 'sync',
          text: "kill the badge, it's noise",
          createdAt: 'x',
          delivery: 'received',
        },
      ],
    });

    expect(text).toContain('/human-resolved q12 [m:mres1]');
    expect(text).toContain('Leslie Knope: "kill the badge, it\'s noise"');
    expect(text).toContain(
      '- Empty state for months with no closures (Leslie Knope: "later")'
    );
    expect(text).toContain("[human] kill the badge, it's noise");
    expect(text).not.toContain('UNCONFIRMED');
  });

  it('marks the recovery path UNCONFIRMED', () => {
    expect(
      buildResolution({
        qid: 'q1',
        msgId: 'm1',
        unconfirmed: true,
        decisions: [],
        conversation: [],
      })
    ).toContain('UNCONFIRMED');
  });
});
