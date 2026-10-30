import * as fs from 'fs';
import * as path from 'path';

import { loadProjectConfig } from '../config/projectConfig';
import {
  ChangesFileSchema,
  DecisionsColdReadSchema,
  JudgementsFileSchema,
  type PlanFile,
  PlanFileSchema,
  type Pod,
  type ProposalFile,
  ProposalFileSchema,
  QUESTION_SECTIONS,
  type Question,
  type QuestionOrigin,
  type QuestionSection,
  type ScreensFile,
  ScreensFileSchema,
  type ThreadEntry,
  applySectionEdit,
  changesProblems,
  classifyNew,
  commitProblems,
  decisionTextProblems,
  decisionsColdReadProblems,
  flowsProblems,
  headlineProblems,
  insteadProblems,
  makeKnowledgeEntry,
  matchCheckpointPhrase,
  newId,
  nextCardVersion,
  nowIso,
  parseColdRead,
  planProblems,
  proposalProblems,
  reversionForDecision,
  screensProblems,
  spokenTextProblems,
  trackOf,
  understoodProblems,
  uxDetailsProblems,
  withDecisionSnapshot,
  writeKnowledgeFile,
} from '../pod-store';
import { listEpicChildren } from '../tickets/epic';
import { callerAgent, openStore, openTickets, resolvePodId } from './context';
import { runChatHandoff } from './fork';
import { currentKnowledge, knowledgeDirs } from './knowledge';
import { chatTopic, sendMessage } from './messaging';
import {
  ownerForAgent,
  ownerStartForAgent,
  ownersForAgent,
  ownersForPerson,
} from './owner';

const readStdin = (): string => fs.readFileSync(0, 'utf8');

/** lambda.json `audience`: who a decision's "means" is about. */
const projectAudience = (): string | undefined =>
  loadProjectConfig()?.config.audience;

const isSection = (value: string): value is QuestionSection =>
  QUESTION_SECTIONS.some((section) => section === value);

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A refusal listing what to fix, one bullet each, on stderr; exits 1. */
const refuse = (heading: string, problems: string[]): never => {
  console.error(heading);
  problems.forEach((problem) => console.error(`  • ${problem}`));

  return process.exit(1);
};

/**
 * Which part of the owner's message a question is about (`--quote`, verbatim
 * — whitespace aside) and the dev's answer to just that part (`--reply`).
 * Without them a long multi-part message is shown whole on every question it
 * spawned.
 */
const quotedPart = (
  messageText: string,
  options: { quote?: string; reply?: string }
): { quote: string; reply: string } => {
  const quote = squash(options.quote ?? '');
  const reply = (options.reply ?? '').trim();
  const owner = ownerStartForAgent();
  const owners = ownersForAgent();

  if (quote === '' || reply === '') {
    throw new Error(
      `With --from-message also give --quote "<the exact part of ${owners} message this question is about>" and --reply "<your answer to just that part, plain sentences>". ${owner} sees only those two, not the whole message.`
    );
  }

  if (!squash(messageText).includes(quote)) {
    throw new Error(
      `--quote must be ${owners} words exactly as written — copy the relevant part of the message (line breaks and spacing aside).`
    );
  }

  const problems = spokenTextProblems(reply, '--reply');

  if (problems.length > 0) {
    throw new Error(problems.join(' '));
  }

  return { quote, reply };
};

/** Trim the origin of a question that came from a message to the part it's about. */
export const runQuestionOrigin = (
  qid: string,
  options: { pod?: string; quote?: string; reply?: string }
): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const question = store.readQuestion(podId, qid);

  if (question === null || question.origin?.kind !== 'message') {
    throw new Error(
      `${qid} did not come from one of ${ownersForAgent()} messages.`
    );
  }

  const { messageId } = question.origin;
  const message = store
    .readThread(podId)
    .find((entry) => entry.id === messageId);

  if (message === undefined) {
    throw new Error(`Message ${messageId} is not in this pod's thread.`);
  }

  store.writeQuestion({
    ...question,
    origin: { ...question.origin, ...quotedPart(message.text, options) },
  });
  console.log(`${qid} now quotes just the part of the message it is about.`);
};

/**
 * Every question says how it got into the queue — the owner sees (and hears)
 * "How we got here", with links. Exactly one origin flag is required.
 */
const originOf = (
  store: ReturnType<typeof openStore>,
  podId: string,
  phase: number,
  options: {
    fromMessage?: string;
    fromAnswer?: string;
    fromWork?: string;
    quote?: string;
    reply?: string;
  }
): QuestionOrigin => {
  const given = [
    options.fromMessage,
    options.fromAnswer,
    options.fromWork,
  ].filter((value) => value !== undefined);

  const owner = ownerForAgent();
  const owners = ownersForAgent();

  if (given.length !== 1) {
    throw new Error(
      `Say how this question got here — exactly one of: --from-message <m-id> (something ${owner} said: the [m:…] id of the message), --from-answer <qid> (a follow-up to ${owners} answer on that question), --from-work "<what you were doing, in plain words>" (the phase work turned it up).`
    );
  }

  if (options.fromMessage !== undefined) {
    const message = store
      .readThread(podId)
      .find((entry) => entry.id === options.fromMessage);

    if (message === undefined || message.from !== 'human') {
      throw new Error(
        `${options.fromMessage} is not one of ${owners} messages in this pod — use the [m:…] id from the message.`
      );
    }

    return {
      kind: 'message',
      messageId: message.id,
      qid: message.qid,
      ...quotedPart(message.text, options),
    };
  }

  if (options.fromAnswer !== undefined) {
    if (store.readQuestion(podId, options.fromAnswer) === null) {
      throw new Error(`No question ${options.fromAnswer} in this pod.`);
    }

    return { kind: 'answer', qid: options.fromAnswer };
  }

  const doing = (options.fromWork ?? '').trim();
  const problems = spokenTextProblems(doing, '--from-work');

  if (doing.length < 10 || problems.length > 0) {
    throw new Error(
      [
        '--from-work must say what you were doing in plain words (it is read aloud): "checking the trail map ticket against the code".',
        ...problems,
      ].join(' ')
    );
  }

  return { kind: 'work', phase, doing };
};

export const runQuestionAdd = (options: {
  pod?: string;
  ticket?: string;
  phase?: string;
  dependsOn?: string;
  blocksCheckpoint?: boolean;
  fromMessage?: string;
  fromAnswer?: string;
  fromWork?: string;
  quote?: string;
  reply?: string;
}): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const pod = store.requirePod(podId);
  const phase = options.phase === undefined ? pod.phase : Number(options.phase);
  const origin = originOf(store, podId, phase, options);
  const id = store.nextQuestionId(podId);

  store.writeQuestion({
    id,
    origin,
    podId,
    kind: 'question',
    ticketId: options.ticket,
    phase,
    status: 'draft',
    blocksCheckpoint: options.blocksCheckpoint === true,
    dependsOn:
      options.dependsOn === undefined
        ? []
        : options.dependsOn.split(',').map((dependency) => dependency.trim()),
    createdAt: nowIso(),
    options: [],
  });
  console.log(id);
};

export const runQuestionEdit = (
  qid: string,
  options: { pod?: string; section: string; text?: string; stdin?: boolean }
): void => {
  if (!isSection(options.section)) {
    throw new Error(
      `Unknown section "${options.section}". One of: ${QUESTION_SECTIONS.join(
        ', '
      )}.`
    );
  }

  const value = options.stdin === true ? readStdin() : options.text;

  if (value === undefined) {
    throw new Error('Pass --text <value> or --stdin.');
  }

  const podId = resolvePodId(options.pod);
  const store = openStore();
  store.writeQuestion(
    applySectionEdit(
      store.requireQuestion(podId, qid),
      options.section,
      value.trim()
    )
  );
  console.log(`Updated ${qid}.${options.section}.`);
};

/**
 * The quality gate in front of the owner's inbox. The cold read must come from
 * a fresh-context subagent that saw ONLY the question file: the dev has the
 * whole conversation in its head, which is exactly why its own questions come
 * out needing follow-ups. A project can't turn it off.
 */
export const runQuestionCommit = (
  qid: string,
  options: { pod?: string; justification: string; coldRead: string }
): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const question = store.requireQuestion(podId, qid);
  const raw =
    options.coldRead === '-'
      ? readStdin()
      : fs.readFileSync(options.coldRead, 'utf8');
  const coldRead = parseColdRead(JSON.parse(raw));
  const problems = commitProblems(
    question,
    coldRead,
    options.justification,
    store.listQuestions(podId).filter((sibling) => sibling.id !== qid)
  );

  if (problems.length > 0) {
    refuse('Not committed — fix these and run commit again:', problems);
  }

  store.writeQuestion({
    ...question,
    status: 'open',
    committedAt: nowIso(),
    commit: { justification: options.justification, coldRead },
  });
  console.log(COMMITTED(qid));
};

/** Printed to the person: `Committed q3 — it is now in your inbox.` */
export const COMMITTED = (qid: string): string =>
  `Committed ${qid} — it is now in ${ownersForPerson()} inbox.`;

export const runQuestionWithdraw = (
  qid: string,
  options: { pod?: string; reason: string }
): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  store.writeQuestion({
    ...store.requireQuestion(podId, qid),
    status: 'withdrawn',
    withdrawnAt: nowIso(),
    withdrawReason: options.reason,
  });
  console.log(`Withdrew ${qid}.`);
};

export const runQuestionList = (options: {
  pod?: string;
  status?: string;
  json?: boolean;
}): void => {
  const podId = resolvePodId(options.pod);
  const questions = openStore()
    .listQuestions(podId)
    .filter(
      (question) =>
        options.status === undefined || question.status === options.status
    );

  if (options.json === true) {
    console.log(JSON.stringify(questions, null, 2));

    return;
  }

  questions.forEach((question) =>
    console.log(
      `${question.id.padEnd(5)} ${question.status.padEnd(
        9
      )} ${question.kind.padEnd(10)} ${
        question.dependsOn.length > 0
          ? `after ${question.dependsOn.join(',')} `
          : ''
      }${(question.summary ?? '(no summary yet)').slice(0, 90)}`
    )
  );
};

export const runQuestionShow = (
  qid: string,
  options: { pod?: string }
): void => {
  console.log(
    JSON.stringify(
      openStore().requireQuestion(resolvePodId(options.pod), qid),
      null,
      2
    )
  );
};

export const runResolve = (qid: string, options: { pod?: string }): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  store.writeQuestion({
    ...store.requireQuestion(podId, qid),
    status: 'answered',
    answeredAt: nowIso(),
  });
  console.log(`Resolved ${qid}.`);
};

const forkQid = (): string | undefined => {
  const agent = callerAgent();

  // The chat fork isn't about one question: it passes --qid itself.
  return agent?.startsWith('fork-') === true && agent !== 'fork-chat'
    ? agent.slice('fork-'.length)
    : undefined;
};

/** "2, 14b" → ["2", "14b"]; undefined when not given. */
const ticketList = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((ticket) => ticket.trim())
        .filter((ticket) => ticket !== '');

export const runDecide = (
  decisionArg: string | undefined,
  options: {
    pod?: string;
    qid?: string;
    quote?: string;
    deferred?: boolean;
    autonomous?: boolean;
    why?: string;
    details?: string;
    detailsStdin?: boolean;
    ux?: boolean;
    instead?: string;
    means?: string;
    before?: string;
    engineering?: boolean;
    product?: boolean;
    tickets?: string;
    amend?: string;
    withdraw?: string;
    reason?: string;
    intentRef?: string;
    whyNoIntent?: string;
  }
): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();

  if (options.withdraw !== undefined) {
    // Protocol logged as a decision: take it off every future checkpoint.
    if (options.reason === undefined || options.reason.trim() === '') {
      throw new Error(
        '--withdraw needs --reason "<why this is not a decision>".'
      );
    }

    const withdrawn = store.updateAutonomousDecision(
      podId,
      options.withdraw,
      (existing) => ({
        ...existing,
        withdrawnAt: nowIso(),
        withdrawReason: options.reason?.trim(),
      })
    );
    console.log(
      `Withdrew ${withdrawn.id}. If its checkpoint is already posted, re-post it (checkpoint post) so the card drops it.`
    );

    return;
  }

  const decision = decisionArg ?? '';

  if (options.autonomous === true && options.amend !== undefined) {
    // Rewrite an existing decision in place (same id ⇒ same number on the
    // checkpoint card). Omitted parts keep their current value.
    const details =
      options.detailsStdin === true ? readStdin() : options.details;
    const current = store
      .readAutonomousDecisions(podId)
      .find((candidate) => candidate.id === options.amend);
    const ux = options.ux ?? current?.ux;
    const instead = options.instead ?? current?.instead;
    const means = options.means ?? current?.means;
    const why = options.why ?? current?.why;
    const before = options.before ?? current?.before;
    const problems = [
      ...headlineProblems(decision),
      ...decisionTextProblems({
        before,
        means,
        why,
        audience: projectAudience(),
      }),
      ...insteadProblems(instead, ownerForAgent()),
      ...(ux === true ? uxDetailsProblems(details ?? current?.details) : []),
    ];

    if (problems.length > 0) {
      refuse('Not amended — fix these and run it again:', problems);
    }

    const amended = store.updateAutonomousDecision(
      podId,
      options.amend,
      (existing) => ({
        ...existing,
        decision: decision.trim(),
        why: options.why ?? existing.why,
        before: before?.trim(),
        means: means?.trim(),
        kind:
          options.engineering === true
            ? 'engineering'
            : options.product === true
            ? 'product'
            : existing.kind ?? 'product',
        tickets: ticketList(options.tickets) ?? existing.tickets,
        details:
          details === undefined || details.trim() === ''
            ? existing.details
            : details.trim(),
        ux: ux === true ? true : undefined,
        instead: instead?.trim(),
        intentRef: options.intentRef ?? existing.intentRef,
        whyNoIntent: options.whyNoIntent ?? existing.whyNoIntent,
      })
    );
    // Open checkpoints that list it get a version with the new wording.
    reversionForDecision(store, podId, amended.id);
    console.log(`Amended ${amended.id}.`);

    return;
  }

  if (options.autonomous === true) {
    if (options.why === undefined) {
      throw new Error('--autonomous needs --why.');
    }

    if (options.intentRef === undefined && options.whyNoIntent === undefined) {
      throw new Error(
        '--autonomous needs --intent-ref "<intent.md line>" or --why-no-intent "<why intent.md does not cover this>".'
      );
    }

    // The headline is what the owner skims and hears at the checkpoint: plain
    // words, no ticket numbers or code names — those belong in --details.
    const details =
      options.detailsStdin === true ? readStdin() : options.details;
    const problems = [
      ...headlineProblems(decision),
      ...decisionTextProblems({
        before: options.before,
        means: options.means,
        why: options.why,
        audience: projectAudience(),
      }),
      ...insteadProblems(options.instead, ownerForAgent()),
      ...(options.ux === true ? uxDetailsProblems(details) : []),
    ];

    if (problems.length > 0) {
      refuse('Not logged — fix these and run it again:', problems);
    }

    const saved = store.appendAutonomousDecision({
      id: newId('d'),
      podId,
      phase: store.requirePod(podId).phase,
      decision: decision.trim(),
      why: options.why,
      before: options.before?.trim(),
      means: options.means?.trim(),
      kind: options.engineering === true ? 'engineering' : 'product',
      tickets: ticketList(options.tickets),
      details:
        details === undefined || details.trim() === ''
          ? undefined
          : details.trim(),
      ux: options.ux === true ? true : undefined,
      instead: options.instead?.trim(),
      intentRef: options.intentRef,
      whyNoIntent: options.whyNoIntent,
      createdAt: nowIso(),
    });
    console.log(`Logged autonomous decision ${saved.id}.`);

    return;
  }

  if (decision.trim() === '') {
    throw new Error('Give the decision text.');
  }

  if (options.quote === undefined || options.quote.trim() === '') {
    throw new Error(
      `${ownerStartForAgent()}'s decisions need --quote "<${ownersForAgent()} exact words>". Use --autonomous for your own calls.`
    );
  }

  const saved = store.appendHumanDecision({
    id: newId('d'),
    podId,
    qid:
      options.qid ??
      (callerAgent() === 'fork-chat' ? chatTopic(store, podId) : forkQid()),
    decision,
    quote: options.quote,
    deferred: options.deferred === true ? true : undefined,
    createdAt: nowIso(),
  });
  console.log(`Recorded ${saved.id}.`);
};

const squashSpace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** CP3 on pipeline 2: `--proposal-file`, every proposed ticket cold-read. */
const readProposal = (file: string | undefined): ProposalFile | null =>
  file === undefined
    ? null
    : ProposalFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

/** CP4: `--screens-file`, each screen cold-read. */
const readScreens = (file: string | undefined): ScreensFile | null =>
  file === undefined
    ? null
    : ScreensFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

/** --plan-file (epic + tickets), or the epic paragraph alone via --plan / --plan-stdin. */
const readPlan = (options: {
  plan?: string;
  planStdin?: boolean;
  planFile?: string;
}): PlanFile => {
  if (options.planFile !== undefined) {
    const raw: unknown = JSON.parse(fs.readFileSync(options.planFile, 'utf8'));

    return PlanFileSchema.parse(raw);
  }

  return {
    epic: options.planStdin === true ? readStdin() : options.plan ?? '',
    tickets: [],
  };
};

export const runCheckpointPost = async (given: {
  pod?: string;
  cp: string;
  summary: string;
  plan?: string;
  planStdin?: boolean;
  planFile?: string;
  screensFile?: string;
  decisionsColdRead?: string;
  proposalFile?: string;
  understood?: string;
  changesFile?: string;
  judgementsFile?: string;
  /**
   * Re-read the open checkpoint's recorded files (`lambda pod checkpoint
   * refresh`): same checks, same card, updated in place. A failed check keeps
   * the card as it was and records why (`refreshError`).
   */
  refresh?: boolean;
}): Promise<void> => {
  const podId = resolvePodId(given.pod);
  const store = openStore();
  const cp = Number(given.cp);
  const refreshing = given.refresh === true;
  const owner = ownerStartForAgent();
  const owners = ownersForAgent();
  const openNow = store
    .listQuestions(podId)
    .find(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === cp &&
        question.status === 'open'
    );
  const recorded = openNow?.checkpoint?.sources;

  if (refreshing && (openNow === undefined || recorded === undefined)) {
    throw new Error(
      openNow === undefined
        ? `No open checkpoint ${cp} to refresh.`
        : `Checkpoint ${cp} was posted before cards could be edited live: post it once more (lambda pod checkpoint post), then edits to its files update it.`
    );
  }

  const absolute = (file: string | undefined): string | undefined =>
    file === undefined ? undefined : path.resolve(file);
  // Refresh: everything comes from what was recorded when it was posted.
  const options =
    refreshing && recorded !== undefined
      ? { ...recorded, planStdin: false, decisionsColdRead: undefined }
      : {
          ...given,
          ...(given.planStdin === true ? { plan: readStdin() } : {}),
          planStdin: false,
          planFile: absolute(given.planFile),
          screensFile: absolute(given.screensFile),
          proposalFile: absolute(given.proposalFile),
          changesFile: absolute(given.changesFile),
          judgementsFile: absolute(given.judgementsFile),
        };
  /** Refresh: the card stays as it was, with why the edit didn't take. */
  const refreshFailed = (problems: string[]): never => {
    if (openNow?.checkpoint !== undefined) {
      store.writeQuestion({
        ...openNow,
        checkpoint: {
          ...openNow.checkpoint,
          refreshError: problems.join('\n'),
        },
      });
    }

    return refuse(
      'Not refreshed — the card keeps its last good version:',
      problems
    );
  };

  if (!Number.isInteger(cp) || cp < 1 || cp > 5) {
    throw new Error('--cp must be 1–5.');
  }

  const podNow = store.requirePod(podId);
  const track = trackOf(podNow);

  if (track === 'existing' && (cp === 1 || cp === 2)) {
    throw new Error(
      'This pod plans an existing epic or ticket: it has no CP1 or CP2. What you understood opens the UX review (CP4) instead.'
    );
  }

  if (track === 'batch' && (cp === 1 || cp === 3)) {
    throw new Error(
      'A batch has no CP1 and no split proposal (CP3): its checkpoints are the triage (CP2), the UX review (CP4) and the final check (CP5).'
    );
  }

  if ((podNow.skipped ?? []).includes(`cp${cp}`)) {
    throw new Error(
      `${owner} skipped CP${cp} — don't post it; carry on with the next stage.`
    );
  }

  // When CP3 (the split) was closed — the line between its decisions and CP4's.
  const cp3ClosedAt = store
    .listQuestions(podId)
    .find(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === 3 &&
        question.status === 'answered'
    )?.answeredAt;

  const cp3Open = store
    .listQuestions(podId)
    .some(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === 3 &&
        question.status === 'open'
    );

  if (cp === 4 && cp3Open) {
    throw new Error(
      `The UX review (CP4) comes after ${ownerForAgent()} closes the split proposal (CP3).`
    );
  }

  const screens = readScreens(options.screensFile);
  const isUxReview = cp === 4;
  // CP3 is the split proposal — no tickets exist yet, so no plan.
  const isProposal = cp === 3;
  const proposal = isProposal ? readProposal(options.proposalFile) : null;
  // "Changed since the split was approved" (CP4) / "since the UX review" (CP5).
  // A lone ticket with nothing visible has no UX review: then CP5 has
  // nothing to compare against.
  const cp4Posted = store
    .listQuestions(podId)
    .some(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === 4 &&
        question.status !== 'withdrawn'
    );
  const needsChanges =
    (cp === 5 && cp4Posted) || (cp === 4 && cp3ClosedAt !== undefined);
  const changes =
    options.changesFile === undefined
      ? null
      : ChangesFileSchema.parse(
          JSON.parse(fs.readFileSync(options.changesFile, 'utf8'))
        ).changes;
  // Suggested judgements (CP5): the owner's own words, each standing alone. Any
  // already known (exact or near) are dropped, not repeated.
  const suggested =
    options.judgementsFile === undefined
      ? []
      : JudgementsFileSchema.parse(
          JSON.parse(fs.readFileSync(options.judgementsFile, 'utf8'))
        ).judgements;
  const said = [
    ...store
      .readThread(podId)
      .filter((message) => message.from === 'human')
      .map((message) => message.text),
    ...store.readHumanDecisions(podId).map((decision) => decision.quote),
  ].map(squashSpace);
  const judgementsIssues = suggested.flatMap((judgement, index) => {
    const label = `judgement ${index + 1}`;

    return [
      ...(judgement.statement.length > 220
        ? [`${label}: keep the statement under 220 characters.`]
        : []),
      ...spokenTextProblems(judgement.statement, `${label}'s statement`),
      ...spokenTextProblems(judgement.why, `${label}'s why`),
      ...(said.some((text) => text.includes(squashSpace(judgement.quote)))
        ? []
        : [
            `${label}: the quote must be ${owners} exact words from this pod (a message or a decision's --quote).`,
          ]),
      ...(judgement.kind === 'copy' && judgement.copy === undefined
        ? [
            `${label}: a copy rule needs "copy": {"use", "never": [], "meaning"}.`,
          ]
        : []),
    ];
  });
  const known = currentKnowledge();
  const freshSuggestions = suggested.filter((judgement) => {
    const verdict = classifyNew(
      makeKnowledgeEntry({
        kind: judgement.kind,
        statement: judgement.statement,
        why: judgement.why,
      }),
      known
    );

    if (verdict.status !== 'added') {
      console.log(
        `Dropped "${judgement.statement.slice(0, 60)}" — already known (${
          verdict.status
        }).`
      );
    }

    return verdict.status === 'added';
  });
  const v2Issues = [
    ...(isProposal && proposal === null
      ? [
          'The split proposal (CP3) needs --proposal-file: every proposed ticket with its files and E2E impact (see /pod-phase research).',
        ]
      : []),
    ...(proposal === null ? [] : proposalProblems(proposal)),
    ...(isUxReview
      ? understoodProblems(options.understood, ownerForAgent())
      : []),
    ...(needsChanges && changes === null
      ? [
          cp === 4
            ? `Pass --changes-file: what changed since ${ownerForAgent()} approved the split ({"changes": []} if nothing).`
            : 'Pass --changes-file: what changed since the UX review ({"changes": []} if nothing).',
        ]
      : []),
    ...(changes === null ? [] : changesProblems(changes, ownerForAgent())),
    ...judgementsIssues,
  ];
  const { epic: planText, tickets } =
    isUxReview || isProposal ? { epic: '', tickets: [] } : readPlan(options);
  const plan = planText.trim();
  const { epicId } = store.requirePod(podId);
  // Every live child gets a line, so no ticket silently drops off the summary.
  const children =
    epicId === undefined || isUxReview || isProposal
      ? []
      : await listEpicChildren(openTickets(), epicId);
  const planIssues = [
    ...v2Issues,
    ...(isProposal
      ? []
      : isUxReview
      ? screens === null
        ? [
            'The UX review (CP4) needs --screens-file: one entry per screen that changes (see Checkpoints in your dev instructions).',
          ]
        : flowsProblems(screens.flows, {
            pictureExists: (podRelative) =>
              fs.existsSync(path.join(store.podDir(podId), podRelative)),
          })
      : planProblems(plan, tickets, children, {
          rows: store.requirePod(podId).source === 'batch',
        })),
    ...spokenTextProblems(options.summary, 'the summary'),
  ];

  if (planIssues.length > 0 && refreshing) {
    refreshFailed(planIssues);
  }

  if (planIssues.length > 0) {
    refuse('Not posted — fix these and run it again:', planIssues);
  }

  // A checkpoint is the end of a phase: posting one while a question is still
  // open (or drafted) bakes "still waiting for you" into a summary that goes
  // stale the moment the owner answers.
  const unfinished = store
    .listQuestions(podId)
    .filter(
      (question) =>
        question.kind === 'question' &&
        (question.status === 'open' || question.status === 'draft')
    );

  // An edit to a card that's already up is fine whatever else is open.
  if (unfinished.length > 0 && !refreshing) {
    console.error(
      `Not posted — these questions are still ${unfinished
        .map((question) => `${question.id} (${question.status})`)
        .join(
          ', '
        )}. Post the checkpoint after the last one is answered and applied.`
    );
    process.exit(1);
  }

  // A checkpoint shows every decision not already shown at an earlier one —
  // so stages with no checkpoint of their own (an existing epic's Shape and
  // Review, the tickets) surface at the next one.
  const shownEarlier = new Set(
    store
      .listQuestions(podId)
      .filter(
        (question) =>
          question.kind === 'checkpoint' &&
          question.status !== 'withdrawn' &&
          (question.checkpoint?.cp ?? cp) < cp
      )
      .flatMap((question) => question.checkpoint?.decisionIds ?? [])
  );
  const decisions = store
    .readAutonomousDecisions(podId)
    .filter(
      (decision) =>
        decision.withdrawnAt === undefined && !shownEarlier.has(decision.id)
    )
    // Product decisions first (numbered 1…), engineering calls after — the
    // card groups them the same way.
    .map((decision, index) => ({ decision, index }))
    .sort(
      (a, b) =>
        Number(a.decision.kind === 'engineering') -
          Number(b.decision.kind === 'engineering') || a.index - b.index
    )
    .map(({ decision }) => decision);
  // Decisions read like the tickets: each has a "means", and a fresh read of
  // it followed everything.
  const reads =
    options.decisionsColdRead === undefined
      ? []
      : DecisionsColdReadSchema.parse(
          JSON.parse(fs.readFileSync(options.decisionsColdRead, 'utf8'))
        );
  const decisionIssues = refreshing
    ? []
    : decisionsColdReadProblems(decisions, reads, projectAudience());

  if (decisionIssues.length > 0) {
    refuse('Not posted — fix these and run it again:', [
      ...decisionIssues,
      ...(options.decisionsColdRead === undefined
        ? [
            'Pass --decisions-cold-read <file>: one {"id", "restatement", "unclear": []} per decision (see Checkpoints in your dev instructions).',
          ]
        : []),
    ]);
  }

  // A screen tells the decisions it shows (CP4): only this checkpoint's.
  const shownIds = new Set(
    refreshing && openNow?.checkpoint !== undefined
      ? openNow.checkpoint.decisionIds
      : decisions.map((decision) => decision.id)
  );
  const linkIssues = (screens?.flows ?? []).flatMap((flow) =>
    flow.screens.flatMap((screen) =>
      (screen.decisions ?? [])
        .filter((id) => !shownIds.has(id))
        .map(
          (id) =>
            `Screen "${screen.name}" lists decision ${id}, which isn't on this checkpoint — use the ids of this checkpoint's decisions (autonomous-decisions.jsonl), or drop it.`
        )
    )
  );

  if (linkIssues.length > 0 && refreshing) {
    refreshFailed(linkIssues);
  }

  if (linkIssues.length > 0) {
    refuse('Not posted — fix these and run it again:', linkIssues);
  }

  const existing = store
    .listQuestions(podId)
    .find(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === cp &&
        question.status === 'open'
    );
  const base: Question = existing ?? {
    id: store.nextQuestionId(podId),
    podId,
    kind: 'checkpoint',
    phase: store.requirePod(podId).phase,
    status: 'open',
    blocksCheckpoint: true,
    dependsOn: [],
    createdAt: nowIso(),
    committedAt: nowIso(),
    options: [],
  };

  // The summary is what actually happened this phase, in the dev's words. How
  // to respond is the app's job (shown and read at the END of the checkpoint),
  // not boilerplate at the top.
  const card: Question = {
    ...base,
    summary: options.summary,
    context: undefined,
    problem: undefined,
    checkpoint: {
      cp,
      // A refresh re-reads the files; the decisions shown were settled when
      // it was posted (amended in place with `lambda pod decide --amend`).
      decisionIds:
        refreshing && openNow?.checkpoint !== undefined
          ? openNow.checkpoint.decisionIds
          : decisions.map((decision) => decision.id),
      plan,
      planTickets:
        tickets.length === 0
          ? undefined
          : tickets.map((ticket) => ({
              id: ticket.id.trim(),
              title: ticket.title.trim(),
              name: ticket.name.trim(),
              today: ticket.today.trim(),
              after: ticket.after.trim(),
              proposal: ticket.proposal,
              lane: ticket.lane,
              laneWas: ticket.laneWas,
            })),
      // Flattened in flow order (numbered 1…N straight through), each pointing
      // at its flow — the card groups them back under flow headers.
      screens:
        screens === null
          ? undefined
          : screens.flows.flatMap((flow, flowIndex) =>
              flow.screens.map(({ coldRead: _coldRead, ...screen }) => ({
                ...screen,
                flow: flowIndex,
              }))
            ),
      flows:
        screens === null
          ? undefined
          : screens.flows.map(({ name, summary }) => ({ name, summary })),
      proposal:
        proposal === null
          ? undefined
          : proposal.tickets.map(
              ({ coldRead: _coldRead, ...ticket }) => ticket
            ),
      understood: isUxReview ? options.understood?.trim() : undefined,
      changes: changes ?? undefined,
      suggestedJudgements:
        freshSuggestions.length === 0 ? undefined : freshSuggestions,
      // The owner's ticks survive an edit; a fresh post starts clean.
      keptJudgements: refreshing
        ? openNow?.checkpoint?.keptJudgements
        : undefined,
      sources: {
        summary: options.summary,
        plan: options.plan,
        planFile: options.planFile,
        screensFile: options.screensFile,
        proposalFile: options.proposalFile,
        understood: options.understood,
        changesFile: options.changesFile,
        judgementsFile: options.judgementsFile,
      },
      refreshedAt: nowIso(),
      refreshError: undefined,
    },
  };
  // The card it replaces is kept as an earlier version (see versions.ts).
  store.writeQuestion(
    nextCardVersion({
      store,
      previous: existing,
      next: withDecisionSnapshot(store, card),
      kind: refreshing ? 'edited' : 'reposted',
    })
  );
  console.log(
    refreshing
      ? `Refreshed checkpoint ${cp} (${base.id}) from its files.`
      : `Posted checkpoint ${cp} as ${base.id} (${decisions.length} decisions).`
  );
};

/** Close a checkpoint and wake the manager. Called by the app, or by hand. */
export const runCheckpointComplete = async (
  podId: string,
  cpRaw: string,
  options: { keepOne?: boolean } = {}
): Promise<void> => {
  const store = openStore();
  const cp = Number(cpRaw);
  const split = splitChoice(
    store.requirePod(podId),
    cp,
    options.keepOne === true
  );
  await runChatHandoff(podId);
  saveKeptJudgements(store, podId, cp);
  store.updatePod(podId, (pod) => ({
    ...pod,
    completedCheckpoints: Array.from(
      new Set([...pod.completedCheckpoints, cp])
    ).sort((a, b) => a - b),
    ...(split === undefined
      ? {}
      : {
          split,
          ...(split === 'accepted' ? { source: 'epic' as const } : {}),
        }),
  }));
  store
    .listQuestions(podId)
    .filter(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === cp &&
        question.status === 'open'
    )
    .forEach((question) =>
      store.writeQuestion({
        ...question,
        status: 'answered',
        answeredAt: nowIso(),
      })
    );
  await sendMessage(store, {
    podId,
    target: 'manager',
    command: '/checkpoint-complete',
    text: `Checkpoint ${cp} is complete (closed by ${ownerForAgent()}).${
      split === 'one-ticket'
        ? ` ${ownerStartForAgent()} kept it ONE ticket: drop the split proposal and bring the ticket up to the template.`
        : split === 'accepted'
        ? ` ${ownerStartForAgent()} accepted the split: the ticket is now the epic, and the proposed tickets become its children.`
        : ''
    } Continue the pipeline.`,
    mode: 'note',
    from: 'system',
  });
  console.log(`Checkpoint ${cp} complete for ${podId}; manager notified.`);
};

/**
 * A lone ticket's CP3 is the split proposal, closed one of two ways: keep it
 * one ticket, or accept the split.
 */
const splitChoice = (pod: Pod, cp: number, keepOne: boolean): Pod['split'] => {
  const lone = pod.source === 'ticket' && cp === 3;

  if (keepOne && !lone) {
    throw new Error(
      "--keep-one closes a lone ticket's split proposal (checkpoint 3) only."
    );
  }

  if (!lone) {
    return undefined;
  }

  return keepOne ? 'one-ticket' : 'accepted';
};

/**
 * The suggested judgements the owner ticked on this checkpoint (each tick is
 * saved as it is made) go into the knowledge store as the checkpoint closes.
 */
const saveKeptJudgements = (
  store: ReturnType<typeof openStore>,
  podId: string,
  cp: number
): void => {
  const question = store
    .listQuestions(podId)
    .find(
      (candidate) =>
        candidate.kind === 'checkpoint' &&
        candidate.checkpoint?.cp === cp &&
        candidate.status === 'open'
    );
  const suggested = question?.checkpoint?.suggestedJudgements ?? [];
  const kept = question?.checkpoint?.keptJudgements ?? [];
  const pod = store.requirePod(podId);
  const known = currentKnowledge();

  kept
    .map((index) => suggested[index])
    .filter((judgement) => judgement !== undefined)
    .forEach((judgement) => {
      if (judgement === undefined) {
        return;
      }

      const entry = makeKnowledgeEntry({
        kind: judgement.kind,
        statement: judgement.statement,
        why: judgement.why,
        quote: judgement.quote,
        copy: judgement.copy,
        source: `${pod.title ?? pod.slug}${
          pod.epicId === undefined ? '' : ` (${pod.epicId})`
        }, checkpoint ${cp}`,
      });

      if (classifyNew(entry, known).status === 'added') {
        writeKnowledgeFile(knowledgeDirs().local, entry);
        known.splice(known.length, 0, entry);
        console.log(`Kept judgement ${entry.id}: ${entry.statement}`);
      }
    });
};

export const runCheckpointMatch = (text: string): void => {
  const matched = matchCheckpointPhrase(text);
  console.log(matched ? 'true' : 'false');
  process.exitCode = matched ? 0 : 1;
};

/**
 * The owner answered an inbox item (Enter, or the accept-rec hotkey).
 * Checkpoint items close on the phrase; everything else goes to the dev as
 * /human-async.
 */
export const runAnswer = async (
  podId: string,
  qid: string,
  options: { text?: string; acceptRec?: boolean }
): Promise<void> => {
  const store = openStore();
  const question = store.requireQuestion(podId, qid);
  const recommended = question.recommendation?.optionId;
  const text =
    options.acceptRec === true
      ? `Go with the recommendation (${recommended ?? 'as recommended'}).`
      : (options.text ?? '').trim();

  if (text === '') {
    throw new Error('Empty answer.');
  }

  // What the owner said in the sidebar chat reaches the dev first, then the answer.
  await runChatHandoff(podId);

  if (
    question.kind === 'checkpoint' &&
    question.checkpoint !== undefined &&
    matchCheckpointPhrase(text)
  ) {
    store.appendThread({
      id: newId('m'),
      podId,
      qid,
      from: 'human',
      mode: 'async',
      text,
      createdAt: nowIso(),
    });
    await runCheckpointComplete(podId, String(question.checkpoint.cp));

    return;
  }

  const entry = await sendMessage(store, {
    podId,
    target: 'dev',
    command: '/human-async',
    qid,
    text,
    // On a checkpoint the owner refers to decisions by their number on the card
    // ("2: use the opening date"), so the dev gets the same numbered list.
    wireText:
      question.kind === 'checkpoint' && question.checkpoint !== undefined
        ? `${text}\n\n${numberedDecisions(
            store,
            podId,
            question.checkpoint.decisionIds
          )}`
        : undefined,
    mode: 'async',
    from: 'human',
  });
  console.log(`Answer ${entry.id} sent to the dev.`);
};

/** The checkpoint card's numbering — the order of its decisionIds, from 1. */
const numberedDecisions = (
  store: ReturnType<typeof openStore>,
  podId: string,
  decisionIds: string[]
): string => {
  const decisions = store.readAutonomousDecisions(podId);
  const lines = decisionIds.map((id, index) => {
    const decision = decisions.find((candidate) => candidate.id === id);

    return `${index + 1}. ${decision?.decision ?? '(unknown)'} [${id}]`;
  });

  return lines.length === 0
    ? '(This checkpoint lists no decisions.)'
    : [
        `Decisions on this checkpoint, as numbered on ${ownersForAgent()} card:`,
        ...lines,
      ].join('\n');
};

/**
 * Who the owner is answering: the agent behind the latest unanswered `--ask`
 * in the pod chat — the manager can ask too — else the dev.
 */
const chatTarget = (thread: ThreadEntry[]): 'dev' | 'manager' => {
  const chat = thread.filter((message) => message.qid === undefined);
  const lastHuman = chat.reduce(
    (index, message, at) => (message.from === 'human' ? at : index),
    -1
  );
  const ask = chat
    .slice(lastHuman + 1)
    .filter((message) => message.expectsReply === true)
    .at(-1);

  return ask?.from === 'manager' ? 'manager' : 'dev';
};

/**
 * The owner's answer on a building pod's Blocked item (the Engineering
 * manager's message `about` names), sent to the Engineering manager about it
 * — which settles the item. Whether `about` named one.
 */
const answerBlocked = async (
  podId: string,
  text: string,
  about: string
): Promise<boolean> => {
  const store = openStore();
  const item = store
    .readThread(podId)
    .find(
      (message) =>
        message.id === about && message.from === 'engineering-manager'
    );

  if (item === undefined) {
    return false;
  }

  const run = store
    .readBuilding(podId)
    .runs.find((candidate) => candidate.blocked?.messageId === about);
  const topic =
    run === undefined
      ? 'the Blocked item'
      : `the Blocked item on ${run.id} ${run.title}`;
  const entry = await sendMessage(store, {
    podId,
    target: 'engineering-manager',
    command: '',
    text,
    about,
    wireText: `(About ${topic}.)\n\n${text}`,
    mode: 'async',
    from: 'human',
  });
  console.log(`Sent ${entry.id} to the Engineering manager.`);

  return true;
};

export const runChat = async (
  podId: string,
  text: string,
  about?: string
): Promise<void> => {
  // A building pod's one conversation is its Product manager — except an
  // answer on a Blocked item, which goes to the Engineering manager.
  if (openStore().readPod(podId)?.kind === 'building') {
    if (about !== undefined && (await answerBlocked(podId, text, about))) {
      return;
    }

    const { runPmChat } = await import('../building/productManager');
    await runPmChat(podId, text);

    return;
  }

  // Answering "Your turn" in the center: the sidebar chat reaches the dev first.
  await runChatHandoff(podId);
  const store = openStore();
  // Said while an item was up: the dev is told which one (it isn't an answer
  // on it — the item stays in the owner's inbox until Done is pressed).
  const question =
    about === undefined
      ? undefined
      : store.listQuestions(podId).find((candidate) => candidate.id === about);
  const topic =
    question === undefined
      ? undefined
      : question.kind === 'checkpoint' && question.checkpoint !== undefined
      ? `${question.id} (Checkpoint ${question.checkpoint.cp})`
      : `${question.id}: ${question.summary ?? ''}`;
  const entry = await sendMessage(store, {
    podId,
    target: chatTarget(store.readThread(podId)),
    command: '/human-chat',
    text,
    ...(topic === undefined
      ? {}
      : { about, wireText: `(About ${topic}.)\n\n${text}` }),
    mode: 'sync',
    from: 'human',
  });
  console.log(`Sent ${entry.id}.`);
};
