import { ownerLabel } from './resolution';
import type { Change, ProposalFile } from './schemas';

/**
 * Quality rules for autonomous decisions — the checkpoint list the owner skims
 * and LISTENS to. A headline must say what happened in plain words; anything
 * technical goes in `details`, which is shown on click and never spoken.
 */

const MAX_HEADLINE = 140;

const TICKET = /\b[A-Z]{2,}-\d+\b/;
const CODE_SPAN = /`/;
// A real path has two slashes or a file extension; "trail/marker" is just
// English.
const FILE_PATH =
  /\b[\w.-]+\/[\w.-]+\/[\w./-]*|\b[\w-]+\.(ts|tsx|js|json|md|yml|yaml|sql)\b/;
// camelCase / PascalCase identifiers with an inner capital (plotTrailRoute, MarkerList).
const IDENTIFIER = /\b[a-z]+[A-Z][A-Za-z]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z]*\b/;
const SNAKE = /\b[a-z]+_[a-z_]+\b/;

// Irregular past tenses a headline plausibly opens with; regular ones end in -ed.
const IRREGULAR_PAST = new Set([
  'bound',
  'broke',
  'brought',
  'built',
  'chose',
  'cut',
  'drew',
  'fed',
  'found',
  'gave',
  'held',
  'kept',
  'laid',
  'led',
  'left',
  'let',
  'made',
  'meant',
  'put',
  'ran',
  'read',
  'rewrote',
  'sent',
  'set',
  'shut',
  'split',
  'spent',
  'stood',
  'struck',
  'took',
  'told',
  'undid',
  'won',
  'wrote',
]);
// End in -ed but are not past tenses.
const NOT_PAST = new Set([
  'bed',
  'feed',
  'need',
  'red',
  'seed',
  'shed',
  'speed',
]);

/** "Added …", "Moved …", "Kept …" — the headline opens by saying what was done. */
const opensWithPastTense = (text: string): boolean => {
  const first = (text.split(/\s+/)[0] ?? '').toLowerCase().replace(/\W/g, '');

  return (
    IRREGULAR_PAST.has(first) || (first.endsWith('ed') && !NOT_PAST.has(first))
  );
};

/** Anything the owner listens to: no ticket numbers, code, paths or code names. */
export const spokenTextProblems = (text: string, what: string): string[] => [
  // Semicolons are the tell of crammed, telegraphic writing — nobody says one.
  ...(text.includes(';')
    ? [
        `No semicolons in ${what} — it is read aloud. Write separate full sentences, and say what happens today and what happens after.`,
      ]
    : []),
  ...(TICKET.test(text)
    ? [
        `No ticket numbers in ${what} — say what the ticket is about ("the trail map ticket").`,
      ]
    : []),
  ...(CODE_SPAN.test(text) || FILE_PATH.test(text)
    ? [`No code or file paths in ${what} — put them in --details.`]
    : []),
  ...(IDENTIFIER.test(text) || SNAKE.test(text)
    ? [
        `No code names (camelCase/snake_case) in ${what} — describe what it does in plain words; names go in --details.`,
      ]
    : []),
];

export const headlineProblems = (headline: string): string[] => {
  const text = headline.trim();

  return [
    ...(text === '' ? ['The headline is empty.'] : []),
    ...(text !== '' && !opensWithPastTense(text)
      ? [
          'Start the headline with a past-tense verb saying what you did ("Added …", "Moved …", "Kept …", "Split …") — a plain description, not a pitch.',
        ]
      : []),
    ...(text.length > MAX_HEADLINE
      ? [
          `Keep the headline under ${MAX_HEADLINE} characters (it is ${text.length}); move the rest to --details.`,
        ]
      : []),
    ...spokenTextProblems(text, 'the headline'),
  ];
};

const MAX_DECISION_PART = 400;

/** Who a decision's "means" is about, when lambda.json names no `audience`. */
export const DEFAULT_AUDIENCE = 'someone using the product';

/**
 * A decision's "means" (what its `audience` will see or experience) and
 * "why": both read aloud, so both plain, unhurried and jargon-free.
 */
export const decisionTextProblems = (args: {
  before?: string | undefined;
  means: string | undefined;
  why: string | undefined;
  /** lambda.json `audience`. */
  audience?: string | undefined;
}): string[] => {
  const before = (args.before ?? '').trim();
  const means = (args.means ?? '').trim();
  const why = (args.why ?? '').trim();

  return [
    ...(before === ''
      ? [
          'Say the situation BEFORE with --before: what was true, or wrong, that called for this decision — plain words, assuming the reader knows nothing ("The trail map drew every marker from last year\'s survey. Markers moved since then didn\'t show where they stand now, so…").',
        ]
      : []),
    ...(before.length > MAX_DECISION_PART
      ? [`Keep --before under ${MAX_DECISION_PART} characters.`]
      : []),
    ...spokenTextProblems(before, '--before'),
    ...(means === ''
      ? [
          `Say what it MEANS with --means: what ${
            args.audience ?? DEFAULT_AUDIENCE
          } will see or experience because of this decision, in plain sentences (its "after").`,
        ]
      : []),
    ...(means.length > MAX_DECISION_PART
      ? [`Keep --means under ${MAX_DECISION_PART} characters.`]
      : []),
    ...spokenTextProblems(means, '--means'),
    ...(why.length > MAX_DECISION_PART
      ? [`Keep --why under ${MAX_DECISION_PART} characters.`]
      : []),
    ...spokenTextProblems(why, '--why'),
  ];
};

/** A fresh subagent's read of one decision (before + headline + means + why + instead). */
export interface DecisionColdRead {
  id: string;
  situation: string;
  restatement: string;
  unclear: string[];
  unexplained: string[];
}

/**
 * Every decision on a checkpoint is cold-read before posting, like the
 * tickets: covered, restated, and nothing it couldn't follow.
 */
export const decisionsColdReadProblems = (
  decisions: {
    id: string;
    decision: string;
    means?: string;
    before?: string;
  }[],
  reads: DecisionColdRead[],
  /** lambda.json `audience`. */
  audience: string = DEFAULT_AUDIENCE
): string[] => {
  if (decisions.length === 0) {
    return [];
  }

  return decisions.flatMap((decision, index) => {
    const label = `decision ${index + 1} ("${decision.decision.slice(0, 60)}")`;
    const read = reads.find((candidate) => candidate.id === decision.id);

    return [
      ...(decision.means === undefined || decision.means.trim() === ''
        ? [
            `${label} (${decision.id}) has no "means" — amend it: lambda pod decide --autonomous --amend ${decision.id} "<headline>" --means "<what ${audience} will see>".`,
          ]
        : []),
      ...(decision.before === undefined || decision.before.trim() === ''
        ? [
            `${label} (${decision.id}) has no "before" — amend it with --before "<the situation that called for it>".`,
          ]
        : []),
      ...(read === undefined || read.restatement.trim() === ''
        ? [`${label} (${decision.id}) has no cold read.`]
        : []),
      ...(read !== undefined && read.situation.trim() === ''
        ? [
            `The cold read of ${label} couldn't say what the situation was before it — the "before" doesn't land. Amend it and read again.`,
          ]
        : []),
      ...(read !== undefined && read.unclear.length > 0
        ? [
            `The cold read of ${label} couldn't follow: ${read.unclear.join(
              ' / '
            )}. Amend it and cold-read again.`,
          ]
        : []),
      ...(read !== undefined && read.unexplained.length > 0
        ? [
            `${label} points at things it never explains: ${read.unexplained.join(
              ' / '
            )}. Say what each is in plain words (usually in --before) and read again.`,
          ]
        : []),
    ];
  });
};

const MIN_INSTEAD = 8;

/**
 * Every autonomous decision names the option it did NOT take. Protocol
 * ("planned the epic I was given") has no real alternative — having to write
 * one is the moment the dev notices it isn't a decision.
 */
export const insteadProblems = (
  instead: string | undefined,
  /** The owner's name from the machine settings; `Owner` when there is none. */
  ownerName?: string
): string[] => {
  const text = (instead ?? '').trim();

  if (text.length < MIN_INSTEAD) {
    return [
      `Name the option you did NOT take with --instead "<the alternative>". If there was no real alternative ${ownerLabel(
        ownerName
      )} might have preferred, this is protocol, not a decision — don't log it.`,
    ];
  }

  return /^(nothing|none|n\/a|no alternative)/i.test(text)
    ? [
        "--instead says there was no alternative — then it is protocol, not a decision. Don't log it.",
      ]
    : [];
};

// Generous on purpose: tight caps made the dev cut words instead of ideas.
const MAX_PLAN = 2400;
const MAX_PLAN_WITH_TICKETS = 2000;
const MAX_TICKET_NAME = 100;
const MAX_TICKET_PART = 400;

export interface PlanTicket {
  id: string;
  /** The ticket title. */
  title: string;
  /** Plain name, same build number: "1 - Closed trails show on the map". */
  name: string;
  today: string;
  after: string;
  coldRead: { restatement: string; unclear: string[] };
}

const buildNumber = (title: string): string | undefined =>
  /^(\d+[a-z]?)\s*[-–—]/i.exec(title.trim())?.[1]?.toLowerCase();

/**
 * `expected`: the number the name must start with — an epic's child keeps its
 * build number (from its ticket title); a batch row its position on the card,
 * which is how the owner refers to it ("row 3: plan it anyway").
 */
const ticketProblems = (
  ticket: PlanTicket,
  expected: string | undefined
): string[] => {
  const label = `ticket "${ticket.title}"`;
  const name = ticket.name.trim();
  const parts = [
    ['today', ticket.today.trim()],
    ['after', ticket.after.trim()],
  ] as const;

  return [
    ...(buildNumber(name) === undefined || buildNumber(name) !== expected
      ? [
          `The name of ${label} must start with ${
            expected === undefined ? 'its build number' : `"${expected} - …"`
          }${
            expected === buildNumber(ticket.title)
              ? ', like the title'
              : ' — its row on the card'
          }.`,
        ]
      : []),
    ...(name.length > MAX_TICKET_NAME
      ? [`Keep the name of ${label} under ${MAX_TICKET_NAME} characters.`]
      : []),
    ...spokenTextProblems(name, `the name of ${label}`),
    ...parts.flatMap(([part, text]) => [
      ...(text === ''
        ? [
            `"${part}" of ${label} is empty${
              part === 'today'
                ? ' — for brand-new work say so ("There is no way to … today.")'
                : ''
            }.`,
          ]
        : []),
      ...(text.length > MAX_TICKET_PART
        ? [
            `Keep "${part}" of ${label} under ${MAX_TICKET_PART} characters (it is ${text.length}).`,
          ]
        : []),
      ...spokenTextProblems(text, `"${part}" of ${label}`),
    ]),
    ...(ticket.coldRead.restatement.trim() === ''
      ? [`${label} has no cold read — a fresh subagent must restate it.`]
      : []),
    ...(ticket.coldRead.unclear.length > 0
      ? [
          `The cold read of ${label} couldn't follow: ${ticket.coldRead.unclear.join(
            ' / '
          )}. Rewrite it so someone with no context can, and cold-read it again.`,
        ]
      : []),
  ];
};

/** A child as Linear has it — what the plan's ticket list must cover. */
export interface PlanChild {
  id: string;
  title: string;
}

/**
 * A checkpoint's "The plan": the epic paragraph (what people will see and do,
 * plus only the heavy architecture), then — once the epic has children — one
 * plain summary per ticket covering every child. All of it is read aloud.
 */
export const planProblems = (
  plan: string | undefined,
  tickets: PlanTicket[] = [],
  children: PlanChild[] = [],
  /** A batch's triage: rows are numbered by position, not by ticket title. */
  options: { rows?: boolean } = {}
): string[] => {
  const text = (plan ?? '').trim();

  if (text === '') {
    return [
      'A checkpoint needs a plan (--plan-file, or --plan / --plan-stdin before the epic has children): the whole plan as it now stands — what people will see and do, plus only the heavy architecture.',
    ];
  }

  const cap = children.length > 0 ? MAX_PLAN_WITH_TICKETS : MAX_PLAN;
  const listed = new Set(tickets.map((ticket) => ticket.id.toUpperCase()));
  const known = new Set(children.map((child) => child.id.toUpperCase()));
  const missing = children.filter(
    (child) => !listed.has(child.id.toUpperCase())
  );
  const unknown = tickets.filter(
    (ticket) => !known.has(ticket.id.toUpperCase())
  );

  return [
    ...(text.length > cap
      ? [
          `Keep the epic paragraph under ${cap} characters (it is ${
            text.length
          }) — high level only${
            children.length > 0 ? '; each ticket gets its own line' : ''
          }.`,
        ]
      : []),
    ...spokenTextProblems(text, 'the plan'),
    ...(children.length > 0 && tickets.length === 0
      ? [
          'This epic has child tickets, so the plan needs a line per ticket — pass --plan-file with {"epic": "…", "tickets": [{"id", "title", "name", "today", "after", "coldRead"}]}.',
        ]
      : []),
    ...(tickets.length > 0 && missing.length > 0
      ? [
          `The ticket list skips ${missing
            .map((child) => `${child.id} (${child.title})`)
            .join(', ')} — every child gets a line.`,
        ]
      : []),
    ...(children.length > 0 && unknown.length > 0
      ? [
          `${unknown.map((ticket) => ticket.id).join(', ')} ${
            unknown.length === 1 ? 'is' : 'are'
          } not a child of this epic.`,
        ]
      : []),
    ...tickets.flatMap((ticket, index) =>
      ticketProblems(
        ticket,
        options.rows === true ? String(index + 1) : buildNumber(ticket.title)
      )
    ),
  ];
};

const SKETCH = /[─-╿]|\+-{2,}|\|.*\|/;
const MAX_SCREEN_CHANGES = 600;
const MAX_SCREEN_STATE = 300;

export interface ScreenForReview {
  name: string;
  change: 'changed' | 'new' | 'removed';
  before?: string;
  after?: string;
  changes: string;
  journey?: { who: string; before: string; here: string; after: string };
  states?: string[];
  tickets: string[];
  coldRead: { restatement: string; unclear: string[] };
  pictures?: {
    situation: string;
    scenarioId?: string;
    before?: string;
    after?: string;
    legend: { n: number; label: string }[];
  }[];
  prototypeUrl?: string;
}

export interface ScreenFileChecks {
  /** Whether a pod-relative path exists in the pod's folder (keeps this module pure). */
  pictureExists?: (podRelative: string) => boolean;
}

const MAX_JOURNEY_PART = 300;
const JOURNEY_PARTS = ['who', 'before', 'here', 'after'] as const;
const MAX_LEGEND_LABEL = 80;
/** Pod-relative, under `designs/`, PNG only; no segment may start with a dot. */
const PICTURE_PATH = /^designs(\/[a-z0-9][a-z0-9._-]*)+\.png$/;
const PROTOTYPE_URL = /^https:\/\/claude\.ai\//;

/** Each value that appears more than once, once, in first-seen order. */
const repeated = <T>(values: T[]): T[] =>
  values.filter(
    (value, index) =>
      values.indexOf(value) === index && values.lastIndexOf(value) !== index
  );

/**
 * A screen's pictures (full render mode): real `designs/…png` files, one per
 * situation, each with the sides its change has, and a short numbered
 * legend. The legend is shown, never spoken, so it skips the speech checks.
 */
const picturesProblems = (
  screen: ScreenForReview,
  label: string,
  checks: ScreenFileChecks
): string[] => {
  const pictures = screen.pictures ?? [];
  const situations = pictures.map((picture) => picture.situation);

  return [
    ...repeated(situations).map(
      (situation) =>
        `${label} has two pictures for the situation "${situation}"; give each situation one.`
    ),
    ...pictures.flatMap((picture) => {
      const where = `the "${picture.situation}" picture of ${label}`;
      const sides = (['before', 'after'] as const).filter(
        (side) => picture[side] !== undefined
      );
      const numbers = picture.legend.map((entry) => entry.n);

      return [
        ...(sides.length === 0
          ? [`${where} has neither before nor after.`]
          : []),
        ...(picture.before !== undefined && screen.change === 'new'
          ? [`${where} has a "before", but a new screen has no today.`]
          : []),
        ...(picture.after !== undefined && screen.change === 'removed'
          ? [`${where} has an "after", but a removed screen has no design.`]
          : []),
        ...sides.flatMap((side) => {
          const picturePath = picture[side] ?? '';

          if (!PICTURE_PATH.test(picturePath)) {
            return [
              `The "${side}" of ${where} must be a pod-relative designs/…/*.png path, not "${picturePath}".`,
            ];
          }

          return checks.pictureExists !== undefined &&
            !checks.pictureExists(picturePath)
            ? [
                `The "${side}" of ${where} (${picturePath}) isn't in the pod folder.`,
              ]
            : [];
        }),
        ...picture.legend.flatMap((entry) => [
          ...(entry.label.trim() === ''
            ? [`Legend entry ${entry.n} of ${where} is empty.`]
            : []),
          ...(entry.label.length > MAX_LEGEND_LABEL
            ? [
                `Keep legend entry ${entry.n} of ${where} under ${MAX_LEGEND_LABEL} characters.`,
              ]
            : []),
        ]),
        ...repeated(numbers).map(
          (n) => `${where} numbers two legend entries ${n}.`
        ),
      ];
    }),
    ...(screen.prototypeUrl !== undefined &&
    !PROTOTYPE_URL.test(screen.prototypeUrl)
      ? [
          `The prototype link of ${label} must be under https://claude.ai/, not "${screen.prototypeUrl}".`,
        ]
      : []),
  ];
};

/**
 * The UX review (CP4): every screen shows before and after as ASCII, says
 * what changes in plain words, lists its states and edge cases, and names
 * the tickets that build it — and a cold read could follow it.
 */
export const screensProblems = (
  screens: ScreenForReview[],
  checks: ScreenFileChecks = {}
): string[] => {
  if (screens.length === 0) {
    return [
      'The UX review needs at least one screen. If nothing users see changes, say so in --summary and post it with an empty plan instead.',
    ];
  }

  return screens.flatMap((screen, index) => {
    const label = `screen ${index + 1} ("${screen.name}")`;
    const needsBefore = screen.change !== 'new';
    const needsAfter = screen.change !== 'removed';

    return [
      ...(screen.name.trim() === '' ? [`${label} has no name.`] : []),
      ...spokenTextProblems(screen.name, `the name of ${label}`),
      ...(needsBefore && !SKETCH.test(screen.before ?? '')
        ? [
            `${label} needs a "before" ASCII sketch of the screen as it is today (or change: "new").`,
          ]
        : []),
      ...(needsAfter && !SKETCH.test(screen.after ?? '')
        ? [`${label} needs an "after" ASCII sketch (or change: "removed").`]
        : []),
      ...(screen.changes.trim() === ''
        ? [`${label} must say what changes, in plain sentences.`]
        : []),
      ...(screen.changes.length > MAX_SCREEN_CHANGES
        ? [`Keep "changes" of ${label} under ${MAX_SCREEN_CHANGES} characters.`]
        : []),
      ...spokenTextProblems(screen.changes, `"changes" of ${label}`),
      // The journey: why this screen exists, from the person's side.
      ...(screen.journey === undefined
        ? [
            `${label} needs its journey — who uses it, how they get here, what they do here, and what happens after (journey: {who, before, here, after}).`,
          ]
        : JOURNEY_PARTS.flatMap((part) => {
            const text = (screen.journey?.[part] ?? '').trim();

            return [
              ...(text === ''
                ? [`The journey of ${label} is missing "${part}".`]
                : []),
              ...(text.length > MAX_JOURNEY_PART
                ? [
                    `Keep "${part}" in the journey of ${label} under ${MAX_JOURNEY_PART} characters.`,
                  ]
                : []),
              ...spokenTextProblems(
                text,
                `"${part}" in the journey of ${label}`
              ),
            ];
          })),
      ...(screen.states ?? []).flatMap((state, at) => [
        ...(state.length > MAX_SCREEN_STATE
          ? [
              `Keep state ${
                at + 1
              } of ${label} under ${MAX_SCREEN_STATE} characters.`,
            ]
          : []),
        ...spokenTextProblems(state, `state ${at + 1} of ${label}`),
      ]),
      ...(screen.tickets.length === 0
        ? [
            `${label} must name the tickets that build it (build numbers, "2", "14b").`,
          ]
        : []),
      ...(screen.coldRead.restatement.trim() === ''
        ? [`${label} has no cold read.`]
        : []),
      ...(screen.coldRead.unclear.length > 0
        ? [
            `The cold read of ${label} couldn't follow: ${screen.coldRead.unclear.join(
              ' / '
            )}. Rewrite it and cold-read it again.`,
          ]
        : []),
      ...picturesProblems(screen, label, checks),
    ];
  });
};

const MAX_FLOW_SUMMARY = 400;

/**
 * The UX review groups its screens into flows — journeys someone goes
 * through, start to finish. Every flow is named, summarised in plain words,
 * and has at least one screen; then every screen is checked as usual.
 */
export const flowsProblems = (
  flows: { name: string; summary: string; screens: ScreenForReview[] }[],
  checks: ScreenFileChecks = {}
): string[] => {
  if (flows.length === 0) {
    return [
      'The UX review needs its screens grouped into flows: {"flows": [{"name", "summary", "screens": [...]}]}.',
    ];
  }

  return [
    ...flows.flatMap((flow, index) => {
      const label = `flow ${index + 1} ("${flow.name}")`;

      return [
        ...(flow.name.trim() === '' ? [`${label} has no name.`] : []),
        ...spokenTextProblems(flow.name, `the name of ${label}`),
        ...(flow.summary.trim() === ''
          ? [
              `${label} needs a summary — the whole journey in 1–2 plain sentences.`,
            ]
          : []),
        ...(flow.summary.length > MAX_FLOW_SUMMARY
          ? [
              `Keep the summary of ${label} under ${MAX_FLOW_SUMMARY} characters.`,
            ]
          : []),
        ...spokenTextProblems(flow.summary, `the summary of ${label}`),
        ...(flow.screens.length === 0 ? [`${label} has no screens.`] : []),
      ];
    }),
    ...screensProblems(
      flows.flatMap((flow) => flow.screens),
      checks
    ),
  ];
};

/** A UX decision's details must carry an ASCII sketch of the screen. */
export const uxDetailsProblems = (details: string | undefined): string[] => {
  if (details === undefined || details.trim() === '') {
    return [
      'A UX decision (--ux) needs --details with an ASCII sketch of the screen.',
    ];
  }

  return /[─-╿]|\+-{2,}|\|.*\|/.test(details)
    ? []
    : [
        'The --details of a UX decision must include an ASCII sketch (box-drawing ┌─┐ or +--+ / |…|).',
      ];
};

// ── pipeline 2: the split proposal, "what I understood", the change lists ──

const MAX_PROPOSAL_TITLE = 100;
const MAX_PROPOSAL_WHAT = 500;

const proposedTicketProblems = (ticket: ProposalFile['tickets'][number]) => {
  const label = `Ticket ${ticket.number} ("${ticket.title.slice(0, 40)}")`;

  return [
    ...(ticket.title.length > MAX_PROPOSAL_TITLE
      ? [`${label}: keep the title under ${MAX_PROPOSAL_TITLE} characters.`]
      : []),
    ...(ticket.what.length > MAX_PROPOSAL_WHAT
      ? [`${label}: keep "what" under ${MAX_PROPOSAL_WHAT} characters.`]
      : []),
    ...spokenTextProblems(ticket.title, `${label}'s title`),
    ...spokenTextProblems(ticket.what, `${label}'s "what"`),
    ...(ticket.e2e.kind !== 'none' && (ticket.e2e.spec ?? '').trim() === ''
      ? [`${label}: name the E2E spec file (e2e.spec).`]
      : []),
    ...((ticket.e2e.kind === 'new-file' || ticket.e2e.kind === 'none') &&
    (ticket.e2e.why ?? '').trim() === ''
      ? [
          ticket.e2e.kind === 'new-file'
            ? `${label}: a NEW spec file needs e2e.why — what an existing spec cannot hold.`
            : `${label}: no E2E needs e2e.why — why nothing user-facing needs a test.`,
        ]
      : []),
    ...(ticket.coldRead.unclear.length > 0
      ? [
          `${label}: the cold read found it unclear — ${ticket.coldRead.unclear.join(
            '; '
          )}. Rewrite and re-read.`,
        ]
      : []),
  ];
};

/** CP3 (pipeline 2): the split proposal, before any ticket is written. */
export const proposalProblems = (proposal: ProposalFile): string[] => {
  const numbers = proposal.tickets.map((ticket) => ticket.number);
  const built = numbers.filter((number) => number !== '0');
  const expected = built.map((_number, index) => String(index + 1));
  const known = new Set(numbers);

  return [
    ...(proposal.tickets.length === 0 ? ['The proposal has no tickets.'] : []),
    ...(built.join(',') !== expected.join(',')
      ? [
          `Number the tickets 1…${
            built.length
          } in build order (got ${built.join(
            ', '
          )}); 0 is only for a step-0 Needs-a-human ticket.`,
        ]
      : []),
    ...proposal.tickets.flatMap((ticket) =>
      ticket.dependsOn
        .filter((dependency) => !known.has(dependency))
        .map(
          (dependency) =>
            `Ticket ${ticket.number} depends on ${dependency}, which is not in the proposal.`
        )
    ),
    ...proposal.tickets.flatMap((ticket) =>
      ticket.dependsOn
        .filter((dependency) => Number(dependency) >= Number(ticket.number))
        .map(
          (dependency) =>
            `Ticket ${ticket.number} depends on ${dependency} — a dependency must have a lower build number.`
        )
    ),
    ...proposal.tickets.flatMap((ticket) =>
      ticket.dependsOn
        .filter(
          (dependency) => (ticket.dependsWhy?.[dependency] ?? '').trim() === ''
        )
        .map(
          (dependency) =>
            `Ticket ${ticket.number} depends on ${dependency} with no reason — add dependsWhy["${dependency}"].`
        )
    ),
    ...proposal.tickets.flatMap(proposedTicketProblems),
  ];
};

const MAX_UNDERSTOOD = 600;

/** CP4 (pipeline 2): "What I understood" — the intent, so a misread shows. */
export const understoodProblems = (
  text: string | undefined,
  /** The owner's name from the machine settings; `Owner` when there is none. */
  ownerName?: string
): string[] => {
  const trimmed = (text ?? '').trim();
  const owner = ownerLabel(ownerName);

  if (trimmed === '') {
    return [
      `The UX review needs --understood "<2–3 sentences>": what you understood ${owner} wants, from intent.md — this is where ${owner} catches a misread.`,
    ];
  }

  return [
    ...(trimmed.length > MAX_UNDERSTOOD
      ? [`Keep --understood under ${MAX_UNDERSTOOD} characters.`]
      : []),
    ...spokenTextProblems(trimmed, '--understood'),
  ];
};

/**
 * CP4/CP5 change lists. Each one the owner would see is its own audio section,
 * so it has to stand alone: what it is now, what it was when the owner approved it,
 * and why it changed. Engineering lines are listed, not read aloud.
 */
export const changesProblems = (
  changes: Change[],
  /** The owner's name from the machine settings; `Owner` when there is none. */
  ownerName?: string
): string[] =>
  changes.flatMap((change, index) => {
    if (change.kind === 'engineering') {
      return [];
    }

    const label = `change ${index + 1}`;

    return [
      ...spokenTextProblems(change.text, label),
      ...((change.before ?? '').trim() === ''
        ? [
            `${label}: add "before" — what it was when ${ownerLabel(
              ownerName
            )} approved it, so the change makes sense on its own.`,
          ]
        : spokenTextProblems(change.before ?? '', `${label}'s before`)),
      ...((change.why ?? '').trim() === ''
        ? [
            `${label}: add "why" — which decision, review or request changed it.`,
          ]
        : spokenTextProblems(change.why ?? '', `${label}'s why`)),
    ];
  });
