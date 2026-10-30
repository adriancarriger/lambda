import {
  type DesignIssue,
  type DesignSeverity,
  parseJudgeVerdict,
  parseWalkPath,
  shouldStopDesignLoop,
} from '../loop';

const issue = (severity: DesignSeverity): DesignIssue => ({
  severity,
  where: 'Trail legend',
  what: "Ann Perkins's trail name is cut off",
});

const MIXES: Record<string, DesignIssue[]> = {
  none: [],
  'low only': [issue('low'), issue('low')],
  'worst medium-low': [issue('low'), issue('medium-low')],
  'worst medium': [issue('medium-low'), issue('medium')],
  'worst high': [issue('low'), issue('high')],
};

const S = (reason: string): { stop: true; reason: string } => ({
  stop: true,
  reason,
});
const C = { stop: false, reason: null };

// The rule table, written out literally: round × mix.
const TABLE: [number, string, { stop: boolean; reason: string | null }][] = [
  [1, 'none', S('only-low')],
  [1, 'low only', S('only-low')],
  [1, 'worst medium-low', C],
  [1, 'worst medium', C],
  [1, 'worst high', C],
  [2, 'none', S('only-low')],
  [2, 'low only', S('only-low')],
  [2, 'worst medium-low', C],
  [2, 'worst medium', C],
  [2, 'worst high', C],
  [3, 'none', S('only-low')],
  [3, 'low only', S('only-low')],
  [3, 'worst medium-low', C],
  [3, 'worst medium', C],
  [3, 'worst high', C],
  [4, 'none', S('only-low')],
  [4, 'low only', S('only-low')],
  [4, 'worst medium-low', S('round-4-medium-low')],
  [4, 'worst medium', C],
  [4, 'worst high', C],
  [5, 'none', S('only-low')],
  [5, 'low only', S('only-low')],
  [5, 'worst medium-low', S('round-4-medium-low')],
  [5, 'worst medium', C],
  [5, 'worst high', C],
  [6, 'none', S('only-low')],
  [6, 'low only', S('only-low')],
  [6, 'worst medium-low', S('round-4-medium-low')],
  [6, 'worst medium', C],
  [6, 'worst high', C],
  [7, 'none', S('only-low')],
  [7, 'low only', S('only-low')],
  [7, 'worst medium-low', S('round-4-medium-low')],
  [7, 'worst medium', S('round-7')],
  [7, 'worst high', S('round-7')],
];

describe('shouldStopDesignLoop', () => {
  it('covers exactly 35 rows (rounds 1–7 × five mixes)', () => {
    expect(TABLE).toHaveLength(35);
  });

  it.each(TABLE)('round %i, %s → %o', (round, mix, expected) => {
    const issues = MIXES[mix];

    if (issues === undefined) {
      throw new Error(`No mix named ${mix}`);
    }

    expect(shouldStopDesignLoop(round, issues)).toEqual(expected);
  });

  it('goes by the worst issue, not the count', () => {
    expect(
      shouldStopDesignLoop(4, [issue('medium-low'), issue('low'), issue('low')])
    ).toEqual(S('round-4-medium-low'));
    expect(
      shouldStopDesignLoop(4, [issue('medium-low'), issue('medium')])
    ).toEqual(C);
  });

  it.each([0, 8, 2.5, -1, Number.NaN])('throws on round %p', (round) => {
    expect(() => shouldStopDesignLoop(round, [])).toThrow(/round/i);
  });

  it.each(['critical', 'High', 'Med', ''])(
    'throws on unknown severity %p',
    (severity) => {
      // Outside the type on purpose (as a judge could send it): the helper
      // must check at runtime.
      const bad: DesignIssue[] = JSON.parse(
        JSON.stringify([{ severity, where: 'x', what: 'y' }])
      );

      expect(() => shouldStopDesignLoop(1, bad)).toThrow(/severity/i);
    }
  );
});

describe('parseJudgeVerdict', () => {
  const ISSUES: DesignIssue[] = [
    {
      severity: 'medium',
      where: 'Step 2: Show the detour',
      what: 'The Detour button sits above the map, not below it',
    },
    { severity: 'low', where: 'trail-open', what: 'Legend divider is 2px' },
  ];
  const json = JSON.stringify({ issues: ISSUES });

  it('reads a ```json fence and prose-wrapped JSON to the same issues', () => {
    expect(
      parseJudgeVerdict(`Here is my grade.\n\`\`\`json\n${json}\n\`\`\`\n`)
    ).toEqual(ISSUES);
    expect(
      parseJudgeVerdict(`I looked at every step. ${json} That is all {sic}.`)
    ).toEqual(ISSUES);
  });

  it('reads an empty issues list', () => {
    expect(parseJudgeVerdict('{"issues": []}')).toEqual([]);
  });

  it('keeps braces inside strings from ending the object early', () => {
    const tricky = {
      issues: [{ severity: 'low', where: 'trail-closed', what: 'a } b {' }],
    };
    expect(parseJudgeVerdict(`ok ${JSON.stringify(tricky)}`)).toEqual(
      tricky.issues
    );
  });

  it.each([
    ['missing where', '{"issues":[{"severity":"low","what":"x"}]}'],
    ['empty what', '{"issues":[{"severity":"low","where":"x","what":""}]}'],
    ['severity Med', '{"issues":[{"severity":"Med","where":"x","what":"y"}]}'],
    ['issues not a list', '{"issues": "none"}'],
    ['no JSON at all', 'Looks great to me.'],
    ['broken JSON', '{"issues": [ '],
  ])('throws on %s', (_label, text) => {
    expect(() => parseJudgeVerdict(text)).toThrow();
  });
});

describe('parseWalkPath', () => {
  const brief = (path: unknown): unknown => ({
    name: 'Close a trail',
    change: 'changed',
    changes: 'A closed trail can show its detour.',
    situations: [
      { slug: 'trail-closed', title: 'Trail closed' },
      { slug: 'trail-open', title: 'Trail open' },
    ],
    path,
  });

  it('reads click and state steps, and lists every situation in order', () => {
    expect(
      parseWalkPath(
        brief([
          { step: 'Show the detour', action: 'click show-detour' },
          { step: 'Trail reopens', action: 'state trail-open' },
        ])
      )
    ).toEqual({
      steps: [
        {
          n: 1,
          step: 'Show the detour',
          action: { kind: 'click', target: 'show-detour' },
        },
        {
          n: 2,
          step: 'Trail reopens',
          action: { kind: 'state', slug: 'trail-open' },
        },
      ],
      states: ['trail-closed', 'trail-open'],
    });
  });

  it.each([
    ['hover x', { step: 'Hover', action: 'hover x' }],
    ['state unknown-slug', { step: 'Elsewhere', action: 'state unknown-slug' }],
    ['click ../x', { step: 'Escape', action: 'click ../x' }],
    ['an empty step', { step: '', action: 'click map' }],
    ['two spaces', { step: 'Map', action: 'click  map' }],
  ])('throws on %s, naming the step number', (_label, bad) => {
    expect(() =>
      parseWalkPath(
        brief([{ step: 'Show the detour', action: 'click show' }, bad])
      )
    ).toThrow(/step 2/i);
  });

  it.each([
    ['no situations', { situations: [], path: [] }],
    [
      'a bad situation slug',
      { situations: [{ slug: 'Trail Closed', title: 'x' }], path: [] },
    ],
    ['no path list', { situations: [{ slug: 'a', title: 'A' }] }],
    ['not an object', 'brief'],
  ])('throws on %s', (_label, bad) => {
    expect(() => parseWalkPath(bad)).toThrow();
  });
});
