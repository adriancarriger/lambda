import {
  type PlanTicket,
  type ScreenForReview,
  decisionTextProblems,
  decisionsColdReadProblems,
  flowsProblems,
  headlineProblems,
  insteadProblems,
  planProblems,
  screensProblems,
  uxDetailsProblems,
} from '../decisions';

describe('insteadProblems: protocol is not a decision', () => {
  it('accepts a real alternative', () => {
    expect(
      insteadProblems('Reusing the staff marker tools for volunteers')
    ).toEqual([]);
  });

  it.each([undefined, '', 'none', 'Nothing — I was told to', 'N/A'])(
    'rejects %p',
    (instead) => {
      expect(insteadProblems(instead).join(' ')).toContain('protocol');
    }
  );
});

describe('planProblems', () => {
  it('requires a plan', () => {
    expect(planProblems(undefined).join(' ')).toContain('--plan');
  });

  it('accepts a plain high-level plan', () => {
    expect(
      planProblems(
        'Volunteers get an Add a stall button on the festival board.\nStalls go through the existing review-and-publish step.'
      )
    ).toEqual([]);
  });

  describe('once the epic has children', () => {
    const children = [
      { id: 'PAWNEE-70', title: '1 - Volunteers add a stall' },
      { id: 'PAWNEE-71', title: '2 - Volunteers move a stall' },
    ];
    const line = (id: string, title: string): PlanTicket => ({
      id,
      title,
      name: title,
      today: 'There is no way for a volunteer to do this today.',
      after: 'Volunteers can do it from the festival board.',
      coldRead: {
        restatement: 'Volunteers get a new self-service action.',
        unclear: [],
      },
    });

    it('requires a ticket list', () => {
      expect(planProblems('The plan.', [], children).join(' ')).toContain(
        'a line per ticket'
      );
    });

    it('accepts one line per child, any id case', () => {
      expect(
        planProblems(
          'The plan.',
          [
            line('pawnee-70', '1 - Volunteers add a stall'),
            line('PAWNEE-71', '2 - Volunteers move a stall'),
          ],
          children
        )
      ).toEqual([]);
    });

    it('names a skipped child and a stranger', () => {
      const problems = planProblems(
        'The plan.',
        [
          line('PAWNEE-70', '1 - Volunteers add a stall'),
          line('PAWNEE-9999', '3 - Something else'),
        ],
        children
      ).join(' ');

      expect(problems).toContain('skips PAWNEE-71');
      expect(problems).toContain('PAWNEE-9999 is not a child');
    });

    it('keeps code out of a ticket line', () => {
      expect(
        planProblems(
          'The plan.',
          [
            {
              ...line('PAWNEE-70', '1 - Add'),
              after: 'Adds plotTrailRoute.',
            },
            line('PAWNEE-71', '2 - Move'),
          ],
          children
        ).join(' ')
      ).toContain('"after" of ticket "1 - Add"');
    });

    it('requires a plain name with the same build number', () => {
      expect(
        planProblems(
          'The plan.',
          [
            {
              ...line('PAWNEE-70', '1 - Add'),
              name: 'Volunteers add stalls',
            },
            line('PAWNEE-71', '2 - Move'),
          ],
          children
        ).join(' ')
      ).toContain('must start with "1 - …", like the title');
    });

    it('accepts a lettered build number like 4a', () => {
      expect(
        planProblems(
          'The plan.',
          [
            {
              ...line('PAWNEE-70', '4a - Add'),
              name: '4a - Volunteers add stalls',
            },
            line('PAWNEE-71', '2 - Move'),
          ],
          children
        ).join(' ')
      ).not.toContain('must start with');
    });

    it("a batch's rows are numbered by their place on the card, not their ticket titles", () => {
      const rows = [
        {
          ...line('PAWNEE-11', 'Ice Town trail markers'),
          name: '1 - Plan it: Ice Town trail markers',
        },
        {
          ...line('PAWNEE-19', '3 - Bench list'),
          name: '2 - Close it: bench list',
        },
      ];

      expect(
        planProblems('The batch.', rows, [], { rows: true }).join(' ')
      ).not.toContain('must start with');
      expect(
        planProblems(
          'The batch.',
          [rows[1] ?? rows[0], rows[0] ?? rows[1]].filter(
            (row): row is PlanTicket => row !== undefined
          ),
          [],
          { rows: true }
        ).join(' ')
      ).toContain('must start with "1 - …" — its row on the card');
    });

    it('refuses a ticket the cold read could not follow', () => {
      const problems = planProblems(
        'The plan.',
        [
          {
            ...line('PAWNEE-70', '1 - Add'),
            coldRead: {
              restatement: 'Something about publishing?',
              unclear: ['what "a refused publish" leaves behind'],
            },
          },
          line('PAWNEE-71', '2 - Move'),
        ],
        children
      ).join(' ');

      expect(problems).toContain("couldn't follow");
      expect(problems).toContain('a refused publish');
    });
  });

  it('keeps tickets and code out of what the owner hears', () => {
    expect(
      planProblems('Ships in PAWNEE-70 via plotTrailRoute').join(' ')
    ).toContain('No ticket numbers');
  });
});

describe('headlineProblems', () => {
  it('accepts a plain-language headline that says what was done', () => {
    expect(
      headlineProblems(
        'Gave volunteers their own stall tools instead of reusing the staff ones'
      )
    ).toEqual([]);
    expect(
      headlineProblems(
        'Added an "Add a stall" button above the volunteer\'s upcoming shifts'
      )
    ).toEqual([]);
  });

  it('rejects the kind of headline that needed its justification to make sense', () => {
    const problems = headlineProblems(
      'New volunteer-only tools (plotTrailRoute, MarkerList) reuse festivalBoard internals'
    );

    expect(problems.join(' ')).toContain('No code names');
  });

  it.each([
    "An Add a stall button sits above the volunteer's upcoming shifts",
    'Volunteers get their own stall tools',
    'Need a second screen for moving',
  ])('requires a past-tense opening verb: %p', (headline) => {
    expect(headlineProblems(headline).join(' ')).toContain('past-tense verb');
  });

  it.each([
    ['Split PAWNEE-69 into two children', 'No ticket numbers'],
    ['Edited `pod.json` before publishing', 'No code or file paths'],
    ['Stored it in server/src/state.ts', 'No code or file paths'],
    ['Used the stall_id field', 'No code names'],
  ])('rejects %p', (headline, expected) => {
    expect(headlineProblems(headline).join(' ')).toContain(expected);
  });

  it('rejects semicolons — the tell of crammed writing', () => {
    expect(
      headlineProblems('Kept the map on; moved the legend step').join(' ')
    ).toContain('No semicolons');
  });

  it('lets a slash in plain English through', () => {
    expect(
      headlineProblems('Kept the trail/marker groundwork ticket first')
    ).toEqual([]);
  });

  it('caps the length', () => {
    expect(headlineProblems('Added '.repeat(40)).join(' ')).toContain(
      'under 140 characters'
    );
  });
});

describe('decisions read like the tickets', () => {
  it('requires a plain "means" and keeps jargon out of means and why', () => {
    expect(
      decisionTextProblems({ means: '', why: 'Because.' }).join(' ')
    ).toContain('MEANS');
    expect(
      decisionTextProblems({
        means: 'Volunteers see a window titled Add a stall.',
        why: 'The ticket gave no order; I followed its sketch.',
      }).join(' ')
    ).toContain('No semicolons');
    expect(
      decisionTextProblems({
        means: 'Volunteers see a window titled Add a stall.',
        why: 'The ticket gave no order, so I followed its sketch.',
      }).join(' ')
    ).toContain('BEFORE');
    expect(
      decisionTextProblems({
        before:
          'The ticket listed the parts of the window but not their names.',
        means: 'Volunteers see a window titled Add a stall.',
        why: 'The ticket gave no order, so I followed its sketch.',
      })
    ).toEqual([]);
  });

  it('needs every decision cold-read: the situation before, nothing unclear, nothing unexplained', () => {
    const read = {
      id: 'd1',
      situation: 'The window had no names for its parts.',
      restatement: 'Volunteers see a clear window.',
      unclear: [],
      unexplained: [],
    };
    const decisions = [
      {
        id: 'd1',
        decision: 'Named the parts',
        means: 'Volunteers see…',
        before: 'No names.',
      },
      { id: 'd2', decision: 'Locked one more feature' },
    ];
    const problems = decisionsColdReadProblems(decisions, [
      { ...read, unclear: ['"stall line"'], unexplained: ['"this rule"'] },
    ]).join(' ');

    expect(problems).toContain('couldn\'t follow: "stall line"');
    expect(problems).toContain('never explains: "this rule"');
    expect(problems).toContain('(d2) has no "means"');
    expect(problems).toContain('(d2) has no "before"');
    expect(problems).toContain('(d2) has no cold read');
    expect(
      decisionsColdReadProblems(decisions.slice(0, 1), [
        { ...read, situation: '' },
      ]).join(' ')
    ).toContain('situation was before');
    expect(decisionsColdReadProblems(decisions.slice(0, 1), [read])).toEqual(
      []
    );
  });

  it("asks for what lambda.json's audience will see, or someone using the product", () => {
    expect(
      decisionTextProblems({ means: '', why: 'Because.' }).join(' ')
    ).toContain('what someone using the product will see or experience');
    expect(
      decisionTextProblems({
        means: '',
        why: 'Because.',
        audience: 'a volunteer',
      }).join(' ')
    ).toContain('what a volunteer will see or experience');

    const noMeans = [{ id: 'd2', decision: 'Locked one more feature' }];

    expect(decisionsColdReadProblems(noMeans, []).join(' ')).toContain(
      '--means "<what someone using the product will see>"'
    );
    expect(
      decisionsColdReadProblems(noMeans, [], 'a volunteer').join(' ')
    ).toContain('--means "<what a volunteer will see>"');
  });
});

describe('screensProblems (the UX review)', () => {
  const screen = (
    overrides: Partial<ScreenForReview> = {}
  ): ScreenForReview => ({
    name: 'Trail map',
    change: 'changed',
    before: '┌ Trails ┐\n│ [Map] │\n└───────┘',
    after: '┌ Trails ┐\n│ ☐ Closed │\n└──────────┘',
    changes: 'Closed trails show on the map, greyed out.',
    journey: {
      who: 'Ann Perkins, a volunteer who checks the Lot 48 trail markers each spring.',
      before: 'She hears that a trail is closed and opens the map.',
      here: 'She finds the trail and taps Show detour.',
      after:
        'Once she marks it checked, the notice clears and Leslie sees the trail as inspected.',
    },
    tickets: ['2'],
    coldRead: { restatement: 'Closed trails show on the map.', unclear: [] },
    ...overrides,
  });

  it('accepts a complete screen', () => {
    expect(screensProblems([screen()])).toEqual([]);
  });

  it('needs a before sketch unless the screen is new, and an after unless removed', () => {
    expect(
      screensProblems([screen({ before: undefined })]).join(' ')
    ).toContain('"before" ASCII');
    expect(
      screensProblems([screen({ change: 'new', before: undefined })])
    ).toEqual([]);
    expect(
      screensProblems([screen({ change: 'removed', after: undefined })])
    ).toEqual([]);
  });

  it('groups screens into named, summarised flows', () => {
    expect(flowsProblems([]).join(' ')).toContain('grouped into flows');
    expect(
      flowsProblems([
        {
          name: 'Marking the trail',
          summary: 'Ann checks a closed trail.',
          screens: [screen()],
        },
      ])
    ).toEqual([]);

    const problems = flowsProblems([
      { name: 'Marking the trail', summary: '', screens: [] },
    ]).join(' ');

    expect(problems).toContain('needs a summary');
    expect(problems).toContain('has no screens');
  });

  it('needs the journey, tickets and a clean cold read', () => {
    const problems = screensProblems([
      screen({
        journey: undefined,
        tickets: [],
        coldRead: { restatement: 'x', unclear: ['"show detour"'] },
      }),
    ]).join(' ');

    expect(problems).toContain('needs its journey');
    expect(
      screensProblems([
        screen({
          journey: { who: 'Ann', before: '', here: 'Checks', after: 'Done' },
        }),
      ]).join(' ')
    ).toContain('missing "before"');
    expect(problems).toContain('name the tickets');
    expect(problems).toContain("couldn't follow");
  });

  describe('pictures and the prototype link', () => {
    const files = new Set([
      'designs/trail-map/trail-closed.before.png',
      'designs/trail-map/trail-closed.annotated.png',
      'designs/trail-map/trail-open.before.png',
      'designs/trail-map/trail-open.annotated.png',
    ]);
    const pictureExists = (podRelative: string) => files.has(podRelative);
    const picture = (
      overrides: Partial<NonNullable<ScreenForReview['pictures']>[number]> = {}
    ) => ({
      situation: 'Trail closed',
      scenarioId: 'trail-map-trail-closed',
      before: 'designs/trail-map/trail-closed.before.png',
      after: 'designs/trail-map/trail-closed.annotated.png',
      legend: [
        { n: 1, label: 'Why the trail is closed' },
        { n: 2, label: 'Show detour' },
      ],
      ...overrides,
    });
    const check = (overrides: Partial<ScreenForReview>) =>
      screensProblems([screen(overrides)], { pictureExists });

    it('accepts a screen with two valid pictures whose files exist', () => {
      expect(
        check({
          pictures: [
            picture(),
            picture({
              situation: 'Trail open',
              before: 'designs/trail-map/trail-open.before.png',
              after: 'designs/trail-map/trail-open.annotated.png',
            }),
          ],
          prototypeUrl: 'https://claude.ai/design/p/abc123',
        })
      ).toEqual([]);
    });

    it('refuses a path that is absolute, escapes the folder, is not a PNG, or is missing', () => {
      for (const after of [
        '/home/x/a.png',
        'designs/../pod.json',
        'designs/a.jpg',
        'designs/trail-map/missing.png',
      ]) {
        const problems = check({ pictures: [picture({ after })] });

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(after);
      }
    });

    it('refuses two pictures with the same situation, naming the screen', () => {
      const problems = check({ pictures: [picture(), picture()] }).join(' ');

      expect(problems).toContain('Trail map');
      expect(problems).toContain('"Trail closed"');
    });

    it('refuses a picture with neither side, or a side the change does not have', () => {
      expect(
        check({
          pictures: [picture({ before: undefined, after: undefined })],
        }).join(' ')
      ).toContain('neither');
      expect(
        check({
          change: 'new',
          before: undefined,
          pictures: [picture()],
        }).join(' ')
      ).toContain('new screen');
      expect(
        check({
          change: 'removed',
          after: undefined,
          pictures: [picture()],
        }).join(' ')
      ).toContain('removed screen');
    });

    it('never speaks the legend, so a path or identifier in it is fine; an empty, long or repeated entry is not', () => {
      expect(
        check({
          pictures: [
            picture({
              legend: [
                { n: 1, label: 'designs/trail-map/x.png' },
                { n: 2, label: 'showDetourButton' },
              ],
            }),
          ],
        })
      ).toEqual([]);
      expect(
        check({ pictures: [picture({ legend: [{ n: 1, label: ' ' }] })] })
      ).toHaveLength(1);
      expect(
        check({
          pictures: [picture({ legend: [{ n: 1, label: 'x'.repeat(81) }] })],
        })
      ).toHaveLength(1);
      expect(
        check({
          pictures: [
            picture({
              legend: [
                { n: 1, label: 'One' },
                { n: 1, label: 'Two' },
              ],
            }),
          ],
        })
      ).toHaveLength(1);
    });

    it('refuses a prototype link outside https://claude.ai/', () => {
      expect(check({ prototypeUrl: 'http://evil.example' })).toHaveLength(1);
      expect(
        check({ prototypeUrl: 'https://claude.ai.evil.example/x' })
      ).toHaveLength(1);
    });

    it('still needs the ASCII after when the screen has pictures', () => {
      expect(
        check({ after: undefined, pictures: [picture()] }).join(' ')
      ).toContain('"after" ASCII');
    });

    it('checks pictures through flowsProblems too', () => {
      expect(
        flowsProblems(
          [
            {
              name: 'Marking the trail',
              summary: 'Ann checks a closed trail.',
              screens: [
                screen({
                  pictures: [picture({ after: 'designs/trail-map/nope.png' })],
                }),
              ],
            },
          ],
          { pictureExists }
        ).join(' ')
      ).toContain('designs/trail-map/nope.png');
    });
  });
});

describe('uxDetailsProblems', () => {
  it('requires details with an ASCII sketch', () => {
    expect(uxDetailsProblems(undefined)).toHaveLength(1);
    expect(uxDetailsProblems('The button moves to the right.')).toHaveLength(1);
    expect(
      uxDetailsProblems('┌ Roster ┐\n│ Add │ ← new\n└───────────┘')
    ).toEqual([]);
    expect(uxDetailsProblems('+------+\n| Map |\n+------+')).toEqual([]);
  });
});
