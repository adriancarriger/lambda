import type {
  AutonomousDecision,
  Change,
  ProposedTicket,
  Question,
  ThreadMessage,
} from '../../pod-store';
import { pendingReply } from './conversation';
import { originView } from './items';
import { type PodTrack, checkpointGoal } from './phases';
import { type StructureProposal, structureSpoken } from './structurePitch';

/**
 * What gets spoken, shared by the server (which pre-renders it with
 * ElevenLabs) and the client (which plays it, or falls back to the browser's
 * voice). Both MUST build the identical script: the audio file's section
 * times are computed from character offsets in it.
 */

/**
 * A question's fixed sections, or a checkpoint's `decision-<n>` and
 * `instructions` — every one gets its own dot on the player.
 */
export type SectionKey = string;

export const SECTION_ORDER: SectionKey[] = [
  'summary',
  'context',
  'problem',
  'options',
  'recommendation',
  'visual',
];

const BOX_DRAWING = /[─-╿▀-▟]/g;

/**
 * Words the voice says wrong, respelled so it says them right. Checked against
 * the phonemizer Kokoro uses (espeak, en-us).
 *
 * "read" and "record" depend on use, and espeak gets most of them right from
 * context ("have read" → red, "will record" → verb). These are the cases it
 * misses:
 * - past "read" after not / already / as ("Not read for you", "Marked as
 *   read") came out "reed" — respelled "red" (ɹˈɛd), but not in an order
 *   ("Do not read it");
 * - the verb "record" opening a sentence ("Record the decision.") or after
 *   "re-" came out as the noun ˈɹɛkɚd — respelled "rekord" (ɹᵻkˈoːɹd).
 */
const PRONOUNCE: Array<[RegExp, string]> = [
  [
    /(?<!\b(?:do|does|did|will|would|can|could|should|must|may|might)\s+not\s+)(?<=\b(?:not|already|as)\s+(?:re-)?)read\b/gi,
    'red',
  ],
  [
    /(?<=(?:^|[.!?:;]\s+|\n[ \t]*|\b(?:and|then|please)\s+)(?:re-)?)record(?=s?\s+(?:the|a|an|this|that|these|those|it|its|each|every|his|her|their|your|my|our|what|how|who|why|which)\b)/gim,
    'rekord',
  ],
  [/(?<=\bre-)record\b/gi, 'rekord'],
];

const respell = (text: string): string =>
  PRONOUNCE.reduce((spoken, [word, said]) => spoken.replace(word, said), text);

/**
 * Make text fit to be heard: no file:line references, code spans, URLs or
 * box-drawing characters; arrows read as words.
 */
export const speakable = (text: string): string =>
  respell(text)
    // Markdown is for the eye: attached images, code blocks, table rules,
    // heading and list markers and emphasis say nothing aloud.
    .replace(/^\[Image: \S+\][ \t]*$/gm, '')
    // A prototype card (shared/prototypes.ts) is seen, not heard.
    .replace(/^\[Prototype: [^\]\n]*\][ \t]*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_row, cells: string) =>
      cells
        .split('|')
        .map((cell) => cell.trim())
        .join(', ')
    )
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[ x]\][ \t]+)?/gim, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/\n(?:[ \t]*\n)+/g, '\n')
    .trim()
    // Ticket numbers read aloud ("P-A-W-N-E-E twelve") help no one:
    // parenthesised ones go, bare ones become "the ticket".
    .replace(/\s*\(\s*[A-Z]{2,}-\d+\s*\)/g, '')
    .replace(/\b[A-Z]{2,}-\d+\b/g, 'the ticket')
    .replace(/\bq(\d+)\b/g, 'question $1')
    .replace(/\[d[a-z0-9]+\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\b[\w./-]+\.[a-z]{1,5}:\d+(?:[-–]\d+)?\b/gi, '')
    .replace(BOX_DRAWING, ' ')
    .replace(/\s*(?:→|->)\s*/g, ' to ')
    .replace(/\s*←\s*/g, ' — ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

export interface SpokenSection {
  key: SectionKey;
  label: string;
  text: string;
  /** Said before the text. Defaults to the label; '' says nothing (the text introduces itself). */
  heading?: string;
}

const LABELS: Record<string, string> = {
  summary: 'Summary',
  context: 'Context',
  problem: 'Problem',
  options: 'Options',
  recommendation: 'Recommendation',
  visual: 'What changes',
};

const rawSectionText = (question: Question, key: SectionKey): string => {
  if (key === 'options') {
    return question.options
      .map(
        (option) =>
          `Option ${option.id}: ${option.label}. ${option.detail}. Trade-offs: ${option.tradeoffs}.`
      )
      .join(' ');
  }

  if (key === 'recommendation') {
    return question.recommendation === undefined
      ? ''
      : `I recommend option ${question.recommendation.optionId}, because ${question.recommendation.why}`;
  }

  if (key === 'visual') {
    // Never the ASCII — only the notes written to be heard.
    return question.visual?.spoken ?? '';
  }

  if (key === 'summary' || key === 'context' || key === 'problem') {
    return question[key] ?? '';
  }

  return '';
};

/** The sections to read, in order, skipping empty ones. */
export const spokenSections = (question: Question): SpokenSection[] =>
  SECTION_ORDER.map((key) => ({
    key,
    label: LABELS[key] ?? key,
    text: speakable(rawSectionText(question, key)),
  })).filter((section) => section.text !== '');

/** How to respond to a checkpoint — read at the END, never as its summary. */
export const CHECKPOINT_INSTRUCTIONS =
  'To change a decision, say its number and what you want instead. Say "explain" and a number to hear more, or ask for options on any of them. Say "checkpoint complete" when you are happy.';

/** A checkpoint's decisions in its own order — the numbers the owner sees and says. */
export const numberedDecisionsOf = (
  question: Question,
  decisions: AutonomousDecision[]
): AutonomousDecision[] =>
  (question.checkpoint?.decisionIds ?? []).flatMap((id) =>
    decisions.filter((decision) => decision.id === id)
  );

const numberDecisions = (
  question: Question,
  decisions: AutonomousDecision[]
): NumberedDecision[] =>
  numberedDecisionsOf(question, decisions).map((decision, index) => ({
    id: decision.id,
    number: index + 1,
    headline: decision.decision,
    why: decision.why,
    before: decision.before,
    means: decision.means,
    instead: decision.instead,
    engineering: decision.kind === 'engineering',
  }));

/** A checkpoint's decision, as the card numbers it (1-based, in checkpoint order). */
export interface NumberedDecision {
  /** Absent only in older callers' hand-built lists. */
  id?: string;
  number: number;
  headline: string;
  why: string;
  /** The situation that called for it (newer decisions). */
  before?: string;
  /** What it means for the people who use it (newer decisions). */
  means?: string;
  /** The option not taken. */
  instead?: string;
  /** Only the build notices it — not in the main audio. */
  engineering?: boolean;
}

/** "Before … After … Why … Instead of …" — older decisions just their why. */
export const decisionBody = (decision: NumberedDecision): string =>
  decision.means === undefined
    ? decision.why
    : `${
        decision.before === undefined
          ? 'What it means:'
          : `Before: ${decision.before} After:`
      } ${decision.means} Why: ${decision.why}${
        decision.instead === undefined ? '' : ` Instead of: ${decision.instead}`
      }`;

/** "Today: … After this ticket: …" — or an older checkpoint's one paragraph. */
const ticketBody = (ticket: {
  today?: string;
  after?: string;
  summary?: string;
}): string =>
  ticket.today !== undefined && ticket.after !== undefined
    ? `Today: ${ticket.today} After this ticket: ${ticket.after}`
    : ticket.summary ?? '';

/**
 * A screen's states & edge cases — NOT part of the item's audio (they're long
 * and optional). Played only from their own 🔊, so they're only rendered
 * (and paid for) when the owner asks.
 */
export const screenStatesSpeech = (
  index: number,
  screen: { name: string; states?: string[] }
): string =>
  speakable(
    `Screen ${index + 1}, ${screen.name}: states and edge cases. ${(
      screen.states ?? []
    ).join(' ')}`
  );

/** The decisions a CP4 screen already shows — told with it, not listed again. */
export const screenDecisionIds = (question: Question): Set<string> =>
  new Set(
    (question.checkpoint?.screens ?? []).flatMap(
      (screen) => screen.decisions ?? []
    )
  );

/** A decision told with its screen: why this way, and what was turned down. */
export const screenDecisionSpeech = (decision: NumberedDecision): string =>
  `Decision ${decision.number}, why this way: ${decision.why}${
    decision.instead === undefined ? '' : ` Instead of: ${decision.instead}`
  }`;

/** A UX-review screen's audio section, by its position on the card (from 0). */
export const screenSectionKey = (index: number): string =>
  `screen-${index + 1}`;

export const flowSectionKey = (flow: number): string => `flow-${flow + 1}`;

/** A ticket's audio section, by its position on the card (from 0). */
export const proposalSectionKey = (index: number): string =>
  `proposal-${index + 1}`;

/** How many proposed tickets touch E2E, and how — the split proposal's headline. */
export const proposalCounts = (
  proposal: ProposedTicket[]
): Record<ProposedTicket['e2e']['kind'], number> => ({
  'new-file': proposal.filter((ticket) => ticket.e2e.kind === 'new-file')
    .length,
  'new-tests': proposal.filter((ticket) => ticket.e2e.kind === 'new-tests')
    .length,
  assertions: proposal.filter((ticket) => ticket.e2e.kind === 'assertions')
    .length,
  none: proposal.filter((ticket) => ticket.e2e.kind === 'none').length,
});

const plural = (count: number, one: string, many: string): string =>
  `${count === 1 ? 'one' : count} ${count === 1 ? one : many}`;

const proposalCountsSpeech = (proposal: ProposedTicket[]): string => {
  const counts = proposalCounts(proposal);
  const parts = [
    counts['new-file'] === 0
      ? 'no new E2E spec files'
      : plural(counts['new-file'], 'new E2E spec file', 'new E2E spec files'),
    ...(counts['new-tests'] === 0
      ? []
      : [
          `${plural(
            counts['new-tests'],
            'ticket adds',
            'tickets add'
          )} tests to an existing spec`,
        ]),
    ...(counts.assertions === 0
      ? []
      : [
          `${plural(
            counts.assertions,
            'ticket changes',
            'tickets change'
          )} assertions only`,
        ]),
  ];

  return `The proposed split: ${plural(
    proposal.length,
    'ticket',
    'tickets'
  )}, built one at a time in this order; ${parts.join('; ')}.`;
};

const e2eSpeech = (ticket: ProposedTicket): string => {
  switch (ticket.e2e.kind) {
    case 'new-file':
      return `It adds a new E2E spec file${
        ticket.e2e.why === undefined ? '' : `, because ${ticket.e2e.why}`
      }.`;
    case 'new-tests':
      return 'It adds tests to an existing E2E spec.';
    case 'assertions':
      return 'It only changes assertions in an existing E2E spec.';
    default:
      return `It needs no E2E test${
        ticket.e2e.why === undefined ? '' : `: ${ticket.e2e.why}`
      }.`;
  }
};

export const changeSectionKey = (index: number): string =>
  `change-${index + 1}`;

const CHANGE_WORD: Record<Change['kind'], string> = {
  screen: 'a screen',
  ticket: 'a ticket',
  e2e: 'the E2E tests',
  human: 'something you need to do',
  engineering: 'engineering',
};

/**
 * "Changed since …": one section per change the owner would see — its own dot,
 * 🔊 and skip — each standing alone (what it is now, what it was, why).
 * Engineering-only changes are counted on the last one, not read.
 */
const changeSections = (changes: Change[], since: string): SpokenSection[] => {
  const heard = changes.filter((change) => change.kind !== 'engineering');
  const engineering = changes.length - heard.length;
  const fixes =
    engineering === 0
      ? ''
      : ` Plus ${plural(
          engineering,
          'engineering fix',
          'engineering fixes'
        )}, on the card.`;

  if (heard.length === 0) {
    return [
      {
        key: 'changes',
        label: 'What changed',
        text: speakable(
          `Nothing you would see changed since ${since}.${fixes}`
        ),
      },
    ];
  }

  return heard.map((change, index) => ({
    key: changeSectionKey(index),
    label: `Change ${index + 1}`,
    heading: '',
    text: speakable(
      `${
        index === 0
          ? `Since ${since}, ${plural(
              heard.length,
              'thing',
              'things'
            )} changed. `
          : ''
      }Change ${index + 1}, ${CHANGE_WORD[change.kind]}: ${change.text}${
        change.before === undefined ? '' : ` Before: ${change.before}`
      }${change.why === undefined ? '' : ` Why: ${change.why}`}${
        index === heard.length - 1 ? fixes : ''
      }`
    ),
  }));
};

export const ticketSectionKey = (index: number): string =>
  `ticket-${index + 1}`;

/** The build number in "3 - …", or the card position when the title has none. */
const ticketNumber = (title: string, index: number): string =>
  /^(\d+[a-z]?)\s*[-–—]/i.exec(title.trim())?.[1] ?? String(index + 1);

/** An engineering decision, played on demand from its own 🔊. */
export const engineeringDecisionSpeech = (decision: NumberedDecision): string =>
  speakable(
    `Engineering decision ${decision.number}. ${
      decision.headline
    }. ${decisionBody(decision)}`
  );

/** "1 - Rangers mark a trail" → "Ticket 1: Rangers mark a trail." */
export const spokenTicketTitle = (title: string): string => {
  // Build numbers can be lettered ("14b") when a ticket is inserted later.
  const match = /^(\d+[a-z]?)\s*[-–—]\s*(.+)$/i.exec(title.trim());
  const text =
    match === null ? title.trim() : `Ticket ${match[1]}: ${match[2]}`;

  return /[.!?]$/.test(text) ? text : `${text}.`;
};

/**
 * A checkpoint, conversationally: what happened, then each decision on its
 * own (headline + why — never the details), then how to respond.
 */
export const checkpointSections = (
  question: Question,
  decisions: NumberedDecision[],
  pod?: PodTrack
): SpokenSection[] => {
  const cp = question.checkpoint?.cp ?? 0;
  const { goal, approves } = checkpointGoal(cp, pod);
  // Decisions a screen already shows are told with it, not listed again.
  const shown = screenDecisionIds(question);
  const isShown = (decision: NumberedDecision): boolean =>
    decision.id !== undefined && shown.has(decision.id);
  const listed = decisions.filter((decision) => !isShown(decision));
  const told = decisions.filter(
    (decision) => isShown(decision) && decision.engineering !== true
  ).length;
  const product = listed.filter((decision) => decision.engineering !== true);
  const engineering = listed.length - product.length;
  const engineeringNote =
    engineering === 0
      ? ''
      : ` ${
          engineering === 1
            ? 'One engineering decision is'
            : `${engineering} engineering decisions are`
        } on the card, not read here.`;
  const intro =
    product.length === 0
      ? told > 0
        ? `Every decision I made for you was told with its screen.${engineeringNote}`
        : `I made no ${
            engineering === 0 ? '' : 'product '
          }decisions on my own this phase.${engineeringNote}`
      : `Here ${
          product.length === 1
            ? 'is the one decision'
            : `are the ${product.length} decisions`
        } I made for you${
          told > 0 ? ' that no screen shows' : ''
        }.${engineeringNote}`;

  const plan = question.checkpoint?.plan?.trim() ?? '';
  const tickets = question.checkpoint?.planTickets ?? [];
  const proposal = question.checkpoint?.proposal ?? [];
  const understood = question.checkpoint?.understood?.trim() ?? '';
  const changes = question.checkpoint?.changes;
  const screens = question.checkpoint?.screens ?? [];
  const flows = question.checkpoint?.flows ?? [];
  /** "Flow 2: Walking. Ann follows the markers. " before a flow's first screen. */
  const flowIntro = (index: number): string => {
    const flow = screens[index]?.flow;
    const entry = flow === undefined ? undefined : flows[flow];

    return entry === undefined ||
      flow === undefined ||
      (index > 0 && screens[index - 1]?.flow === flow)
      ? ''
      : `Flow ${flow + 1}: ${entry.name}. ${entry.summary} `;
  };

  // "What happened" (this phase) → "The plan" (the epic) → "Tickets" (one
  // line each) → the decisions. The intro to the decisions closes whichever
  // of those comes last.
  const last =
    screens.length > 0
      ? 'screens'
      : proposal.length > 0
      ? 'proposal'
      : tickets.length > 0
      ? 'tickets'
      : plan === ''
      ? 'summary'
      : 'plan';

  return [
    { key: 'goal', label: 'Goal', text: speakable(goal) },
    {
      key: 'summary',
      label: 'What happened',
      text: speakable(
        `${question.summary ?? ''}${last === 'summary' ? ` ${intro}` : ''}`
      ),
    },
    ...(understood === ''
      ? []
      : [
          {
            key: 'understood',
            label: 'What I understood',
            text: speakable(`What I understood you want: ${understood}`),
          },
        ]),
    ...(changes === undefined
      ? []
      : changeSections(
          changes,
          question.checkpoint?.cp === 4
            ? 'you approved the split'
            : 'the UX review'
        )),
    // The split proposal: one section per proposed ticket, the first opening
    // with the counts (tickets, new spec files).
    ...proposal.map((ticket, index) => ({
      key: proposalSectionKey(index),
      label: `Ticket ${ticket.number}`,
      heading: '',
      text: speakable(
        `${index === 0 ? `${proposalCountsSpeech(proposal)} ` : ''}Ticket ${
          ticket.number
        }: ${ticket.title}. ${ticket.what} ${e2eSpeech(ticket)}${
          index === proposal.length - 1 && last === 'proposal'
            ? ` ${intro}`
            : ''
        }`
      ),
    })),
    ...(plan === ''
      ? []
      : [
          {
            key: 'plan',
            label: 'The plan',
            text: speakable(`${plan}${last === 'plan' ? ` ${intro}` : ''}`),
          },
        ]),
    // One section per ticket, so the card's 🔊 and the scrubber can jump
    // straight to any of them. The text introduces itself ("Ticket 3: …").
    ...tickets.map((ticket, index) => ({
      key: ticketSectionKey(index),
      label: `Ticket ${ticketNumber(ticket.name ?? ticket.title, index)}`,
      heading: '',
      text: speakable(
        `${
          index === 0
            ? `${
                tickets.length === 1
                  ? 'One ticket'
                  : `${tickets.length} tickets`
              }, in build order. `
            : ''
        }${spokenTicketTitle(ticket.name ?? ticket.title)} ${ticketBody(
          ticket
        )}${
          index === tickets.length - 1 && last === 'tickets' ? ` ${intro}` : ''
        }`
      ),
    })),
    // The UX review: one section per screen — what changes, then its edge
    // cases. The ASCII is on screen only.
    // A flow's intro is its own section (its own dot, 🔊 and skip), before
    // its first screen; the first one opens with how many screens change.
    ...screens.flatMap((screen, index) => {
      const opening =
        index === 0
          ? `${
              screens.length === 1
                ? 'One screen changes'
                : `${screens.length} screens change`
            }. `
          : '';
      const flowText = flowIntro(index);
      const flowSections: SpokenSection[] =
        flowText === '' || screen.flow === undefined
          ? []
          : [
              {
                key: flowSectionKey(screen.flow),
                label: `Flow ${screen.flow + 1}`,
                heading: '',
                text: speakable(`${opening}${flowText}`),
              },
            ];

      return [
        ...flowSections,
        {
          key: screenSectionKey(index),
          label: `Screen ${index + 1}`,
          heading: '',
          text: speakable(
            `${flowSections.length === 0 ? opening : ''}Screen ${index + 1}: ${
              screen.name
            }, ${screen.change === 'new' ? 'a new screen' : screen.change}. ${
              screen.changes
            }${(screen.decisions ?? [])
              .flatMap((id) =>
                decisions.filter(
                  (decision) =>
                    decision.id === id && decision.engineering !== true
                )
              )
              .map((decision) => ` ${screenDecisionSpeech(decision)}`)
              .join('')}${index === screens.length - 1 ? ` ${intro}` : ''}`
          ),
        },
      ];
    }),
    // Engineering calls aren't read in the run — they're on the card, with
    // their own 🔊 (rendered only when asked for).
    ...listed
      .filter((decision) => decision.engineering !== true)
      .map((decision) => ({
        key: `decision-${decision.number}`,
        // Hovering the bar names it; the bar itself groups them as "Decisions".
        label: `Decision ${decision.number}`,
        heading: '',
        text: speakable(
          `Number ${decision.number}. ${decision.headline}. ${decisionBody(
            decision
          )}`
        ),
      })),
    // Suggested judgements (CP5): one section each, so next / previous moves
    // between them.
    ...(question.checkpoint?.suggestedJudgements ?? []).map(
      (judgement, index, all) => ({
        key: judgementSectionKey(index),
        label: `Judgement ${index + 1}`,
        heading: '',
        text: speakable(
          `${
            index === 0
              ? `I suggest ${plural(
                  all.length,
                  'lasting judgement',
                  'lasting judgements'
                )} to keep for future tickets. Tick the ones you want before you close the checkpoint. `
              : ''
          }Judgement ${index + 1} of ${all.length}: ${
            judgement.statement
          } Why it's good long term: ${judgement.why}${
            judgement.copy === undefined
              ? ''
              : ` That means always saying ${judgement.copy.use}${
                  judgement.copy.never.length === 0
                    ? ''
                    : `, never ${judgement.copy.never.join(' or ')}`
                }.`
          }`
        ),
      })
    ),
    {
      key: 'instructions',
      label: 'How to respond',
      text: `${CHECKPOINT_INSTRUCTIONS} That approves ${approves}.`,
    },
  ].filter((section) => section.text !== '');
};

export const judgementSectionKey = (index: number): string =>
  `judgement-${index + 1}`;

/** A single spoken line (a "Your turn" reply, a Stalled notice). */
export const singleSection = (label: string, text: string): SpokenSection[] => {
  const spoken = speakable(text);

  return spoken === '' ? [] : [{ key: 'summary', label, text: spoken }];
};

/** What an inbox item reads aloud, or null when there is nothing to say. */
export const itemSections = (args: {
  kind: 'reply' | 'question' | 'checkpoint' | 'stalled' | 'structure';
  question: Question | null;
  thread: ThreadMessage[];
  podLabel: string;
  /** The pod's autonomous decisions (only used for checkpoints). */
  decisions?: AutonomousDecision[];
  /** The pod's questions — for "How we got here". */
  questions?: Question[];
  /** The owner's recorded decisions — what they chose on parts already resolved. */
  humanDecisions?: { qid?: string; decision: string }[];
  /** An earlier exchange picked with ‹ › (default: the one the item opens with). */
  exchangeIndex?: number | null;
  /** Stalled items: what the watchdog tried, or what a human must do. */
  stalledReason?: string;
  /** Structure items: what the dev proposes. */
  structureProposal?: StructureProposal;
  /** The pod's track — a checkpoint's goal depends on it. */
  pod?: PodTrack;
  /** Its place in the sidebar: the audio opens "Pod 2, Trail map bugs". */
  podNumber?: number;
}): SpokenSection[] | null => {
  const body = itemBody(args);

  // The owner jumps between pods: every item first says which one it is.
  return body === null || args.podNumber === undefined
    ? body
    : [
        {
          key: 'pod',
          label: 'Lambda',
          heading: '',
          text: speakable(
            `Lambda ${args.podNumber}, ${args.podLabel}. ${itemKindLabel(
              args
            )}.`
          ),
        },
        ...body,
      ];
};

const itemKindLabel = (args: {
  kind: 'reply' | 'question' | 'checkpoint' | 'stalled' | 'structure';
  question: Question | null;
}): string => {
  if (args.kind === 'checkpoint') {
    return `Checkpoint ${args.question?.checkpoint?.cp ?? ''}`.trim();
  }

  if (args.kind === 'reply') {
    return 'Your turn';
  }

  if (args.kind === 'structure') {
    return 'Structured planning';
  }

  return args.kind === 'stalled' ? 'Stalled' : 'A decision';
};

const itemBody = (
  args: Parameters<typeof itemSections>[0]
): SpokenSection[] | null => {
  if (
    (args.kind === 'checkpoint' || args.kind === 'question') &&
    args.question !== null
  ) {
    // What's new first: how this got here, then the latest exchange on it,
    // then the item itself.
    const body =
      args.kind === 'checkpoint'
        ? checkpointSections(
            args.question,
            numberDecisions(args.question, args.decisions ?? []),
            args.pod
          )
        : spokenSections(args.question);

    return [
      ...contextSections(
        args.question,
        args.questions ?? [],
        args.thread,
        args.humanDecisions ?? [],
        args.exchangeIndex
      ),
      ...body,
    ];
  }

  if (args.kind === 'reply') {
    const reply = pendingReply(args.thread, args.pod?.mode === 'freeform');

    return reply === null ? null : singleSection('Your turn', reply.text);
  }

  if (args.kind === 'structure') {
    return args.structureProposal === undefined
      ? null
      : singleSection(
          'Structured planning',
          structureSpoken(args.structureProposal, args.podLabel)
        );
  }

  if (args.kind === 'stalled') {
    return singleSection(
      'Stalled',
      args.stalledReason === undefined
        ? `${args.podLabel} is stalled: nobody is working on it and nothing is waiting on you.`
        : `${args.podLabel} needs a hand. ${args.stalledReason}.`
    );
  }

  return null;
};

/**
 * "How we got here" — read before the item, so what's new comes first. The
 * item's own back-and-forth isn't read: it's in the chat beside the card (the
 * card is the document; the chat is the conversation). The extra parameters
 * stay so callers needn't change.
 */
export const contextSections = (
  question: Question,
  questions: Question[],
  thread: ThreadMessage[],
  _humanDecisions: { qid?: string; decision: string }[] = [],
  _exchangeIndex?: number | null
): SpokenSection[] => {
  const origin = originView(question, questions, thread);

  return origin === null
    ? []
    : [
        {
          key: 'origin',
          label: 'How we got here',
          heading: '',
          text: speakable(origin.spoken),
        },
      ];
};

export interface ScriptSection {
  key: SectionKey;
  label: string;
  /** Character offsets of this section in the script. */
  start: number;
  end: number;
}

export interface Script {
  text: string;
  sections: ScriptSection[];
}

const SEPARATOR = '\n\n';

/**
 * Exactly what one section says ("Summary. …"), before it is cut into clips
 * (sectionParts) — server and browser MUST agree on it.
 */
export const sectionSpeech = (section: SpokenSection): string => {
  const heading = section.heading ?? section.label;

  return heading === '' ? section.text : `${heading}. ${section.text}`;
};

/**
 * Speech cut into clips at sentence ends: a short first one, so the first
 * words come quickly, then longer ones, each rendered while the one before
 * it plays. A long section rendered whole keeps them waiting for all of it.
 * A line break is kept where the text had one (a list item, a heading).
 */
const FIRST_PART_CHARS = 250;
const PART_CHARS = 600;

export const chunkSpeech = (text: string): string[] =>
  text
    .split(/(?<=\n)|(?<=[.!?])[ \t]+/)
    .map((sentence) => sentence.replace(/^[ \t]+/, ''))
    .filter((sentence) => sentence.trim() !== '')
    .reduce<string[]>((chunks, sentence) => {
      const last = chunks.at(-1);
      const limit = chunks.length === 1 ? FIRST_PART_CHARS : PART_CHARS;
      const joined =
        last === undefined
          ? undefined
          : `${last}${last.endsWith('\n') ? '' : ' '}${sentence}`;

      if (joined === undefined || joined.trim().length > limit) {
        return [...chunks, sentence];
      }

      return [...chunks.slice(0, -1), joined];
    }, [])
    .map((chunk) => chunk.trim());

/**
 * A section's clips, in order, each cached by its exact text — server and
 * browser MUST cut them the same way.
 */
export const sectionParts = (
  section: SpokenSection
): { key: string; text: string }[] =>
  chunkSpeech(sectionSpeech(section)).map((text, index) => ({
    key: `${section.key}#${index}`,
    text,
  }));

/** Join sections into one script ("Summary. … \n\n Context. …") with offsets. */
export const buildScript = (sections: SpokenSection[]): Script =>
  sections.reduce<Script>(
    (script, section) => {
      const prefix = script.text === '' ? '' : SEPARATOR;
      const body = sectionSpeech(section);
      const start = script.text.length + prefix.length;

      return {
        text: `${script.text}${prefix}${body}`,
        sections: [
          ...script.sections,
          {
            key: section.key,
            label: section.label,
            start,
            end: start + body.length,
          },
        ],
      };
    },
    { text: '', sections: [] }
  );

/** A section's place on the audio timeline, in seconds at 1×. */
export interface TimedSection {
  key: SectionKey;
  label: string;
  start: number;
  end: number;
}
