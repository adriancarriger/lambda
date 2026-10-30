import { type Command } from 'commander';

import { registerBuildingCommands } from './buildingCommands';
import { ownerName } from './owner';

/**
 * `lambda pod` — planning pods (a planning manager and a planning dev in
 * Claude Code, each pod with its own working copy, tmux session and state)
 * and building pods (an Engineering manager, a dev and qa building Ready
 * tickets, with a Product manager to talk to).
 *
 * Every action imports its implementation lazily, so `lambda --help` and the
 * other commands never load the pod code.
 */

const run =
  <A extends unknown[]>(action: (...args: A) => Promise<void> | void) =>
  async (...args: A): Promise<void> => {
    try {
      await action(...args);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  };

/**
 * Help text an agent reads names the owner by `owner.name`, else "the
 * owner". A machine file that can't be read leaves the help as written:
 * `lambda --help` must work while the settings are being fixed.
 */
const o = (text: string): string => {
  const name = (() => {
    try {
      return ownerName();
    } catch {
      return undefined;
    }
  })();

  return name === undefined ? text : text.replace(/\b[Tt]he owner\b/g, name);
};

const lifecycle = () => import('./lifecycle');
const messaging = () => import('./messaging');
const questions = () => import('./questions');
const fork = () => import('./fork');
const intake = () => import('./intake');
const resume = () => import('./resume');
const attention = () => import('./attention');
const steps = () => import('./steps');
const requests = () => import('./requests');
const knowledge = () => import('./knowledge');

/** `lambda pod --help`: the subcommands, grouped. */
export const POD_HELP = `Usage: lambda pod <command>

Lifecycle   new  list  status  phase  rename  structure
            propose-structure  tickets  skip  epic  sync
            pause  resume  done  delete  resume-all
            render-mode
Messages    send  await  capture  deliver  reply  interrupt
            hook
Questions   question add|origin|edit|commit|withdraw|list|
            show|resolve   answer  chat  carry-on  nudge
Decisions   decide
Checkpoints checkpoint post|refresh|complete|match
Steps       step <step-id> start|done|skip|note
Requests    request add|start|done|list
Forks       fork chat|chat-warm|handoff|start|send|close|
            park|discard|recover|watchdog
            resolve-conversation
Building    build  blocked  skip-ticket  screenshot
            pm-chat  talk-ticket  watch-building
Product     peek  ask  relay
manager

Pod agents get POD_ID / POD_AGENT in their environment, so pod-scoped commands
(question, reply, decide, resolve, checkpoint post) need no --pod from inside a pod.
`;

export const registerPodCommand = (program: Command): void => {
  const pod = program
    .command('pod')
    .description('Run planning pods: a planning manager and a dev');

  // ── lifecycle ────────────────────────────────────────────────────────────
  pod
    .command('new <slug>')
    .description(
      "Create a pod: state, a worktree on the codebase's default branch, a tmux session with manager + dev"
    )
    .option(
      '--workdir <path>',
      'Use an existing folder instead of creating a worktree (not removed by `done`)'
    )
    .option('--agent <command>', 'Agent CLI (default: claude)')
    .option(
      '--text <text>',
      'The one text box: an idea, a ticket, an epic, or several tickets (a batch) — the pod works out which'
    )
    .option(
      '--single',
      'With --text: several ticket ids, but ONE pod about the first (not a batch)'
    )
    .option(
      '--freeform',
      'A conversation with the dev, no pipeline, until you switch it (lambda pod structure)'
    )
    .option('--idea <text>', 'Your opening idea, sent to the dev')
    .option(
      '--epic <ticket>',
      'Plan an EXISTING epic (adopting its children) instead of writing a new one'
    )
    .option(
      '--ticket <id>',
      'Plan a lone EXISTING ticket (no epic): reviewed, researched and brought up to the template'
    )
    .option(
      '--from-checkpoint <qid>',
      o(
        '(pod agents) Start a pod for a ticket the owner agreed to pull out, at this closed checkpoint'
      )
    )
    .option(
      '--spinoff <message-id>',
      o(
        "(pod agents) Start a freeform Lambda the owner agreed to in this chat — the id of the owner's message ([m:…]) agreeing"
      )
    )
    .option('--from-pod <id>', '(internal) The pod this one was pulled out of')
    .option('--from-qid <qid>', '(internal) The checkpoint that approved it')
    .option(
      '--from-message <id>',
      o("(internal) The owner's message that agreed to it")
    )
    .option('--no-launch', 'Create state only; do not start agents')
    .action(
      run(
        async (
          slug: string,
          options: {
            fromCheckpoint?: string;
            spinoff?: string;
            fromPod?: string;
            fromQid?: string;
            fromMessage?: string;
            workdir?: string;
            agent?: string;
            idea?: string;
            epic?: string;
            ticket?: string;
            text?: string;
            single?: boolean;
            freeform?: boolean;
            launch: boolean;
          }
        ) => (await lifecycle()).runNew(slug, options)
      )
    );

  pod
    .command('list')
    .description('List pods')
    .action(run(async () => (await lifecycle()).runList()));

  pod
    .command('status <id>')
    .description("A pod's phase, checkpoints, questions and turn state")
    .action(run(async (id: string) => (await lifecycle()).runStatus(id)));

  pod
    .command('phase <id> <n>')
    .description(
      'Set the pipeline phase (1 Shape · 2 Epic review · 3 Split · 4 Fill · 5 Reconcile)'
    )
    .action(
      run(async (id: string, n: string) =>
        (await lifecycle()).runSetPhase(id, Number(n))
      )
    );

  pod
    .command('rename <id> <title...>')
    .description("Set a pod's display name (its id never changes)")
    .action(
      run(async (id: string, title: string[]) =>
        (await lifecycle()).runRename(id, title.join(' '))
      )
    );

  pod
    .command('render-mode <id> [mode]')
    .description(
      "Print a pod's UX review render mode, or set it: full (screenshots and designs) or ascii (faster)"
    )
    .action(
      run(async (id: string, mode?: string) =>
        (await lifecycle()).runRenderMode(id, mode)
      )
    );

  pod
    .command('structure <id>')
    .description(
      'Switch a freeform pod to the structured flow (your call); keeps the whole conversation'
    )
    .option('--epic <id>', 'Plan this existing epic')
    .option('--ticket <id>', 'Plan this lone existing ticket')
    .option('--batch <ids>', 'Plan these tickets as a batch (comma-separated)')
    .action(
      run(
        async (
          id: string,
          options: { epic?: string; ticket?: string; batch?: string }
        ) => (await intake()).runStructure(id, options)
      )
    );

  pod
    .command('propose-structure <id>')
    .description(
      o(
        "A freeform pod's dev: propose the structured flow — it comes up in the owner's inbox to start (or keep talking)"
      )
    )
    .option('--epic <id>', 'Plan this existing epic')
    .option('--ticket <id>', 'Plan this lone existing ticket')
    .option('--batch <ids>', 'Plan these tickets as a batch (comma-separated)')
    .requiredOption('--why <text>', 'One or two sentences: why it is ready now')
    .action(
      run(
        async (
          id: string,
          options: {
            epic?: string;
            ticket?: string;
            batch?: string;
            why: string;
          }
        ) => (await intake()).runProposeStructure(id, options)
      )
    );

  pod
    .command('tickets <id> <ids...>')
    .description(
      "Set a batch pod's tickets, in order (after the triage: drop merged and pulled-out ones)"
    )
    .action(
      run(async (id: string, ids: string[]) =>
        (await intake()).runSetTickets(id, ids)
      )
    );

  pod
    .command('skip <id> <stage>')
    .description(
      o(
        "Skip a stage of the pod's flow — the owner's call (agents relaying it pass --quote)"
      )
    )
    .option(
      '--quote <words>',
      o("The owner's exact words, when an agent relays them")
    )
    .action(
      run(async (id: string, stage: string, options: { quote?: string }) =>
        (await intake()).runSkip(id, stage, options)
      )
    );

  pod
    .command('epic <id> <ticket>')
    .description("Record the pod's epic ticket")
    .action(
      run(async (id: string, ticket: string) =>
        (await lifecycle()).runSetEpic(id, ticket)
      )
    );

  pod
    .command('sync <id>')
    .description(
      "Check the pod's worktree out at the latest default branch and rewrite its instructions"
    )
    .action(run(async (id: string) => (await lifecycle()).runSync(id)));

  pod
    .command('pause <id>')
    .action(run(async (id: string) => (await lifecycle()).runPause(id)));
  pod
    .command('resume <id>')
    .action(run(async (id: string) => (await lifecycle()).runResume(id)));
  pod
    .command('done <id>')
    .description(
      'Finish a pod: stop agents, remove its worktree, keep its state'
    )
    .action(run(async (id: string) => (await lifecycle()).runDone(id)));

  pod
    .command('delete <id>')
    .description(
      'Remove a pod: stop agents, remove its worktree, move its state to <pods root>/.trash (people only; tickets untouched)'
    )
    .action(run(async (id: string) => (await lifecycle()).runDelete(id)));

  // ── talking to agents ────────────────────────────────────────────────────
  pod
    .command('send <id> <agent> <text...>')
    .description(
      'Paste a message into a pod agent (manager | dev | fork-<qid>) and submit it'
    )
    .action(
      run(async (id: string, agent: string, text: string[]) =>
        (await messaging()).runSend(id, agent, text.join(' '))
      )
    );

  pod
    .command('await <id> <agent>')
    .description(
      "Block until the agent's current turn ends (exit 2 on timeout — call again)"
    )
    .option('--timeout <seconds>', 'Give up after this long', '540')
    .action(
      run(async (id: string, agent: string, options: { timeout: string }) =>
        (await messaging()).runAwait(id, agent, Number(options.timeout))
      )
    );

  pod
    .command('capture <id> <agent>')
    .option('--lines <n>', 'Scrollback lines', '60')
    .action(
      run(async (id: string, agent: string, options: { lines: string }) =>
        (await messaging()).runCapture(id, agent, Number(options.lines))
      )
    );

  pod
    .command('deliver <id> <msgId>')
    .description('Re-deliver a pending message (same id)')
    .action(
      run(async (id: string, msgId: string) =>
        (await messaging()).runDeliver(id, msgId)
      )
    );

  pod
    .command('reply [text...]')
    .description(
      o(
        '(agents) Post a message to the owner — dev/manager must pass --ask or --fyi. Markdown renders in the inbox; for several lines pass ONE quoted argument ("$(cat <<\'EOF\' … EOF)")'
      )
    )
    .option('--qid <qid>', 'The question this is about')
    .option(
      '--ask',
      o("The owner needs to answer this: it goes to the owner's inbox")
    )
    .option('--fyi', 'No answer needed: it stays in the thread')
    .option(
      '--review <ticketId>',
      o(
        "With --ask: a ticket ready for the owner's review (QA on); they approve it or send it back"
      )
    )
    .option(
      '--progress',
      o(
        "A progress note on an item (--qid), not your reply: shows in its chat but never brings it back to the owner's inbox"
      )
    )
    .option(
      '--reply-to <msgId>',
      o(
        "With --parts-file: the [m:…] id of the owner's message you are answering"
      )
    )
    .option(
      '--parts-file <path>',
      o(
        'A reply to a message with several parts: JSON [{"quote": "<the owner\'s exact words for that part>", "answer": "…"}], one per part (replaces the text)'
      )
    )
    .action(
      run(
        async (
          text: string[] | undefined,
          options: {
            qid?: string;
            ask?: boolean;
            fyi?: boolean;
            progress?: boolean;
            replyTo?: string;
            partsFile?: string;
            review?: string;
          }
        ) => (await messaging()).runReply((text ?? []).join(' '), options)
      )
    );

  pod
    .command('hook <event>')
    .description(
      '(internal) Agent hook: prompt-submit | stop | ask-guard | pm-guard'
    )
    .action(run(async (event: string) => (await messaging()).runHook(event)));

  // ── questions & decisions ───────────────────────────────────────────────
  const question = pod.command('question').description('The question queue');

  question
    .command('add')
    .description('Create a draft question; prints its id')
    .option('--pod <id>')
    .option('--ticket <id>', 'Ticket the question is about')
    .option('--phase <n>')
    .option(
      '--depends-on <qids>',
      'Comma-separated questions this one waits on'
    )
    .option(
      '--blocks-checkpoint',
      'The current checkpoint cannot close without this answer'
    )
    .option(
      '--from-message <msgId>',
      o(
        "HOW IT GOT HERE (one of three required): something the owner said — the [m:…] id of the owner's message"
      )
    )
    .option(
      '--from-answer <qid>',
      o("HOW IT GOT HERE: a follow-up to the owner's answer on that question")
    )
    .option(
      '--from-work <doing>',
      'HOW IT GOT HERE: the phase work turned it up — what you were doing, in plain words (read aloud)'
    )
    .option(
      '--quote <text>',
      o(
        "With --from-message (REQUIRED): the exact part of the owner's message this question is about — the owner sees only this, not the whole message"
      )
    )
    .option(
      '--reply <text>',
      'With --from-message (REQUIRED): your answer to just that part, in plain sentences'
    )
    .action(
      run(
        async (options: {
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
        }) => (await questions()).runQuestionAdd(options)
      )
    );

  question
    .command('origin <qid>')
    .description(
      o(
        'Trim "How we got here" to the part of the owner\'s message this question is about (for questions made from a message)'
      )
    )
    .option('--pod <id>')
    .requiredOption(
      '--quote <text>',
      o("The exact part of the owner's message it is about")
    )
    .requiredOption('--reply <text>', 'Your answer to just that part')
    .action(
      run(
        async (
          qid: string,
          options: { pod?: string; quote?: string; reply?: string }
        ) => (await questions()).runQuestionOrigin(qid, options)
      )
    );

  question
    .command('edit <qid>')
    .description(
      'Set one section: summary | context | problem | options (JSON) | recommendation (JSON) | visual (JSON)'
    )
    .option('--pod <id>')
    .requiredOption('--section <name>')
    .option('--text <value>')
    .option('--stdin', 'Read the value from stdin')
    .action(
      run(
        async (
          qid: string,
          options: {
            pod?: string;
            section: string;
            text?: string;
            stdin?: boolean;
          }
        ) => (await questions()).runQuestionEdit(qid, options)
      )
    );

  question
    .command('commit <qid>')
    .description(o("Publish a draft to the owner's inbox (gated)"))
    .option('--pod <id>')
    .requiredOption('--justification <text>', 'Why this question is ready')
    .requiredOption(
      '--cold-read <file>',
      'Cold-read JSON {restatement, choice, missing[]} ("-" = stdin)'
    )
    .action(
      run(
        async (
          qid: string,
          options: { pod?: string; justification: string; coldRead: string }
        ) => (await questions()).runQuestionCommit(qid, options)
      )
    );

  question
    .command('withdraw <qid>')
    .option('--pod <id>')
    .requiredOption('--reason <text>')
    .action(
      run(async (qid: string, options: { pod?: string; reason: string }) =>
        (await questions()).runQuestionWithdraw(qid, options)
      )
    );

  question
    .command('list')
    .option('--pod <id>')
    .option('--status <status>', 'draft | open | answered | withdrawn')
    .option('--json')
    .action(
      run(async (options: { pod?: string; status?: string; json?: boolean }) =>
        (await questions()).runQuestionList(options)
      )
    );

  question
    .command('show <qid>')
    .option('--pod <id>')
    .action(
      run(async (qid: string, options: { pod?: string }) =>
        (await questions()).runQuestionShow(qid, options)
      )
    );

  pod
    .command('resolve <qid>')
    .description('(dev) Mark a question answered')
    .option('--pod <id>')
    .action(
      run(async (qid: string, options: { pod?: string }) =>
        (await questions()).runResolve(qid, options)
      )
    );

  const requestCmd = pod
    .command('request')
    .description(
      o(
        'Work requests — anything the owner asks a pod to DO; the manager runs it at once'
      )
    );
  requestCmd
    .command('add <summary...>')
    .description('Queue a work request (the Chat fork, the app or by hand)')
    .option('--pod <id>')
    .requiredOption('--quote <words>', o("The owner's exact words"))
    .option('--qid <qid>', o('The item on screen when the owner asked'))
    .action(
      run(
        async (
          summary: string[],
          options: { pod?: string; quote?: string; qid?: string }
        ) => (await requests()).runRequestAdd(summary.join(' '), options)
      )
    );
  requestCmd
    .command('start <rid>')
    .description('(manager) Mark it working and hand it to the dev')
    .option('--pod <id>')
    .action(
      run(async (rid: string, options: { pod?: string }) =>
        (await requests()).runRequestStart(rid, options)
      )
    );
  requestCmd
    .command('done <rid>')
    .description(
      '(dev) Finished: what it did, and which stages it made stale (they are redone)'
    )
    .option('--pod <id>')
    .requiredOption(
      '--result <text>',
      'One plain line: what changed, decisions logged, questions asked'
    )
    .option(
      '--invalidates <stages>',
      'Comma-separated workflow stage ids it made stale (e.g. tickets,ux-review), or none'
    )
    .action(
      run(
        async (
          rid: string,
          options: { pod?: string; result?: string; invalidates?: string }
        ) => (await requests()).runRequestDone(rid, options)
      )
    );
  requestCmd
    .command('list')
    .option('--pod <id>')
    .action(
      run(async (options: { pod?: string }) =>
        (await requests()).runRequestList(options)
      )
    );

  pod
    .command('interrupt <id> <agent>')
    .description(
      "(manager) Stop an agent's turn now (Escape) — before running a work request"
    )
    .action(
      run(async (id: string, agent: string) =>
        (await requests()).runInterrupt(id, agent)
      )
    );

  pod
    .command('step <id> <event>')
    .description(
      "Report a workflow step (shown in the workflow panel): <id> is one of the codebase's planning steps, <event> is start | done | skip | note"
    )
    .option('--pod <id>')
    .option(
      '--pass <n>',
      'Which pass of a repeated step (red flags, reconcile)'
    )
    .option(
      '--progress <done/total>',
      'Progress through a per-ticket step, e.g. 7/11'
    )
    .option(
      '--found <n>',
      'What it produced: fixes made plus questions asked (required when a repeated step finishes a pass; 0 if none)'
    )
    .option('--note <text>', 'One short line shown on hover')
    .option(
      '--ticket <id>',
      'Batch pods: the ticket this is about (fills the ticket grid)'
    )
    .option(
      '--reason <text>',
      'With skip: why (a building pod skipping visual-check must give one)'
    )
    .action(
      run(
        async (
          id: string,
          event: string,
          options: {
            pod?: string;
            pass?: string;
            progress?: string;
            found?: string;
            note?: string;
            ticket?: string;
            reason?: string;
          }
        ) => (await steps()).runStep(id, event, options)
      )
    );

  pod
    .command('decide [decision]')
    .description(
      o("Record a decision: the owner's (--quote) or your own (--autonomous)")
    )
    .option('--pod <id>')
    .option('--qid <qid>')
    .option('--quote <words>', o("The owner's exact words"))
    .option('--deferred', o('The owner put this off rather than deciding it'))
    .option(
      '--autonomous',
      'A call you made yourself; <decision> is its plain-language HEADLINE'
    )
    .option(
      '--before <text>',
      'REQUIRED for --autonomous: the situation that called for it — what was true or wrong before, assuming the reader knows nothing'
    )
    .option(
      '--engineering',
      "Only the build notices this (not the product's users): shown in its own collapsed group, not read aloud by default"
    )
    .option('--product', 'With --amend: mark it a product decision again')
    .option(
      '--why <text>',
      'The justification, in a sentence or two (read aloud)'
    )
    .option(
      '--details <text>',
      'Shown on click, never read aloud: the technical detail. --ux requires an ASCII sketch here'
    )
    .option('--details-stdin', 'Read --details from stdin')
    .option('--ux', 'A decision about what users see')
    .option(
      '--means <text>',
      "REQUIRED for --autonomous: what the product's users will see or experience because of it — plain sentences (read aloud)"
    )
    .option(
      '--tickets <numbers>',
      'Build numbers of the tickets it affects, comma-separated ("2, 14b")'
    )
    .option(
      '--instead <text>',
      'The option you did NOT take (required for --autonomous). No real alternative ⇒ protocol, not a decision: don’t log it'
    )
    .option(
      '--amend <decisionId>',
      'Rewrite an existing autonomous decision in place (keeps its id and checkpoint number)'
    )
    .option(
      '--withdraw <decisionId>',
      'Take a logged decision off future checkpoints (it was protocol, not a choice); needs --reason'
    )
    .option('--reason <text>', 'Why it is being withdrawn')
    .option('--intent-ref <ref>', 'The intent.md line this follows from')
    .option('--why-no-intent <text>', 'Why intent.md does not cover this')
    .action(
      run(
        async (
          decision: string | undefined,
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
        ) => (await questions()).runDecide(decision, options)
      )
    );

  const checkpoint = pod
    .command('checkpoint')
    .description('Pipeline checkpoints (1–5; CP4 is the UX review)');

  checkpoint
    .command('post')
    .description(
      "(dev) Post the checkpoint inbox item with this phase's autonomous decisions"
    )
    .option('--pod <id>')
    .requiredOption('--cp <n>')
    .requiredOption(
      '--summary <text>',
      'What this phase did, in 1–2 plain sentences (shown and read first; no ticket numbers)'
    )
    .option(
      '--plan <text>',
      'Before the epic has children: the epic paragraph alone — the whole plan as it stands, what people will see and do plus only the heavy architecture. Read aloud. (Once it has children use --plan-file.)'
    )
    .option('--plan-stdin', 'Read --plan from stdin')
    .option(
      '--plan-file <path>',
      'Once the epic has children (then REQUIRED): JSON {"epic": "<paragraph>", "tickets": [{"id": "<ticket id>", "title": "<ticket title>", "name": "1 - <plain name>", "today": "…", "after": "…", "coldRead": {"restatement": "…", "unclear": []}}]} covering every child in build order'
    )
    .option(
      '--decisions-cold-read <path>',
      'REQUIRED when the checkpoint has decisions: JSON [{"id": "d…", "situation": "<what was true before>", "restatement": "…", "unclear": [], "unexplained": []}] — one fresh read per decision'
    )
    .option(
      '--proposal-file <path>',
      'CP3 on pipeline 2 (then REQUIRED): the split proposal, JSON {"tickets": [{"number": "1", "title", "what", "files": ["path:line"], "dependsOn": [], "e2e": {"kind": "new-file|new-tests|assertions|none", "spec", "why"}, "docs": [], "overlaps": [{"id", "how": "folds-in|overlaps|related", "note"}], "coldRead": {"restatement", "unclear": []}}]}'
    )
    .option(
      '--understood <text>',
      o(
        'CP4 on pipeline 2 (then REQUIRED): what you understood the owner wants, 2–3 plain sentences from intent.md (read first)'
      )
    )
    .option(
      '--changes-file <path>',
      'Pipeline 2 — CP4 after a split proposal, and CP5 (then REQUIRED): JSON {"changes": [{"kind": "screen|ticket|e2e|human|engineering", "text": "<now>", "before": "<when approved>", "why": "<what changed it>"}]} (before + why required except for engineering) — what changed since the split was approved (CP4) / since the UX review (CP5); [] if nothing'
    )
    .option(
      '--judgements-file <path>',
      o(
        'CP5: suggested lasting judgements from what the owner decided in this pod — JSON {"judgements": [{"kind": "judgement|copy", "statement": "<one plain sentence>", "why": "<why it is good long term>", "quote": "<the owner\'s exact words>", "copy": {"use", "never": [], "meaning"}}]}; the owner ticks the ones to keep'
      )
    )
    .option(
      '--screens-file <path>',
      'CP4, the UX review (then REQUIRED): JSON [{"name", "change": "changed|new|removed", "before": "<ASCII>", "after": "<ASCII>", "changes": "…", "states": ["…"], "tickets": ["2"], "coldRead": {"restatement": "…", "unclear": []}}]'
    )
    .action(
      run(
        async (options: {
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
        }) => (await questions()).runCheckpointPost(options)
      )
    );

  checkpoint
    .command('refresh <id>')
    .description(
      "Re-read an open checkpoint's files (proposal, changes, plan, screens…) and update its card in place — same checks as posting. Run it when one of those files changes."
    )
    .requiredOption('--cp <n>')
    .action(
      run(async (id: string, options: { cp: string }) =>
        (await questions()).runCheckpointPost({
          pod: id,
          cp: options.cp,
          summary: '',
          refresh: true,
        })
      )
    );

  checkpoint
    .command('complete <id>')
    .requiredOption('--cp <n>')
    .option(
      '--keep-one',
      "A lone ticket's split proposal (CP3): keep it one ticket instead"
    )
    .action(
      run(async (id: string, options: { cp: string; keepOne?: boolean }) =>
        (await questions()).runCheckpointComplete(id, options.cp, {
          keepOne: options.keepOne,
        })
      )
    );

  checkpoint
    .command('match <text...>')
    .description('Does this text close a checkpoint? (exit 0 = yes)')
    .action(
      run(async (text: string[]) =>
        (await questions()).runCheckpointMatch(text.join(' '))
      )
    );

  // ── the person's side ───────────────────────────────────────────────────
  pod
    .command('answer <id> <qid>')
    .description('Answer an inbox item asynchronously (what Enter does)')
    .option('--text <text>')
    .option('--accept-rec', 'Go with the recommendation')
    .action(
      run(
        async (
          id: string,
          qid: string,
          options: { text?: string; acceptRec?: boolean }
        ) => (await questions()).runAnswer(id, qid, options)
      )
    );

  pod
    .command('chat <id> <text...>')
    .description("Talk to a pod's dev directly (phase 1, or dropping in)")
    .option(
      '--about <qid>',
      'The item that was up when you said it (context, not an answer on it)'
    )
    .action(
      run(async (id: string, text: string[], options: { about?: string }) =>
        (await questions()).runChat(id, text.join(' '), options.about)
      )
    );

  pod
    .command('carry-on <id>')
    .description(
      '"Done — carry on": end a back-and-forth so the dev stops waiting on you'
    )
    .action(run(async (id: string) => (await attention()).runCarryOn(id)));

  pod
    .command('nudge <id>')
    .description('Wake a stalled pod (resumes it if its session is gone)')
    .action(run(async (id: string) => (await attention()).runNudge(id)));

  const forkCmd = pod
    .command('fork')
    .description(
      'Conversation forks: read-only side conversations with the dev'
    );

  forkCmd
    .command('chat <id> <text...>')
    .description(
      "The Chat panel: talk to the pod's chat fork (fork-chat) about an item (--about) or the whole pod"
    )
    .option('--about <qid>', 'The item on screen this message is about')
    .option(
      '--hold',
      "⌘⏎: keep the pod's items out of the inbox until the chat replies"
    )
    .action(
      run(
        async (
          id: string,
          text: string[],
          options: { about?: string; hold?: boolean }
        ) =>
          (await fork()).runChatSend(
            id,
            options.about,
            text.join(' '),
            options.hold === true
          )
      )
    );
  forkCmd
    .command('chat-warm <id>')
    .description('Start the pod chat fork now (the Chat panel was opened)')
    .action(run(async (id: string) => (await fork()).runChatWarm(id)));
  forkCmd
    .command('handoff <id>')
    .description(
      'Send the dev what was said in the Chat panel since the last hand-off (also automatic on every center answer)'
    )
    .action(run(async (id: string) => (await fork()).runChatHandoff(id)));

  forkCmd
    .command('start <id> <qid>')
    .action(
      run(async (id: string, qid: string) =>
        (await fork()).runForkStart(id, qid)
      )
    );
  forkCmd
    .command('send <id> <qid> <text...>')
    .action(
      run(async (id: string, qid: string, text: string[]) =>
        (await fork()).runForkSend(id, qid, text.join(' '))
      )
    );
  forkCmd
    .command('close <id> <qid>')
    .option('--text <text>', 'A final message')
    .action(
      run(async (id: string, qid: string, options: { text?: string }) =>
        (await fork()).runForkClose(id, qid, options.text)
      )
    );
  forkCmd
    .command('park <id> <qid>')
    .action(
      run(async (id: string, qid: string) =>
        (await fork()).runForkPark(id, qid)
      )
    );
  forkCmd
    .command('discard <id> <qid>')
    .action(
      run(async (id: string, qid: string) =>
        (await fork()).runForkDiscard(id, qid)
      )
    );
  forkCmd
    .command('recover <id> <qid>')
    .action(
      run(async (id: string, qid: string) =>
        (await fork()).runForkRecover(id, qid)
      )
    );
  forkCmd
    .command('watchdog')
    .action(run(async () => (await fork()).runForkWatchdog()));

  pod
    .command('resolve-conversation [qid]')
    .description(
      '(fork) End the conversation: the dev gets decisions + transcript'
    )
    .option('--pod <id>')
    .action(
      run(async (qid: string | undefined, options: { pod?: string }) =>
        (await fork()).runResolveConversation(qid, options.pod)
      )
    );

  // ── building pods ───────────────────────────────────────────────────────
  registerBuildingCommands(pod, { run, o });

  // ── restart survival ────────────────────────────────────────────────────
  pod
    .command('resume-all')
    .description(
      'Bring back every active pod in this codebase after a restart, here in this terminal'
    )
    .option('--stagger <seconds>', 'Pause between planning pods', '30')
    .option('--only <kind>', 'Only building or only planning pods')
    .action(
      run(async (options: { stagger?: string; only?: string }) =>
        (await resume()).runResumeAll(options)
      )
    );

  // Set after the subcommands are added, so their own help keeps the default.
  pod.configureHelp({ formatHelp: () => POD_HELP });
};

/** `lambda knowledge`: the owner's lasting judgements and copy rules. */
export const registerKnowledgeCommand = (program: Command): void => {
  const knowledgeCmd = program
    .command('knowledge')
    .description(
      o(
        "The owner's lasting product judgements and copy (wording) rules — checked by planning"
      )
    );
  knowledgeCmd
    .command('add')
    .description(
      'Add a judgement or copy rule to this machine (shared by lambda knowledge sync)'
    )
    .requiredOption('--kind <kind>', 'judgement | copy')
    .requiredOption(
      '--statement <text>',
      'One plain sentence that stands alone'
    )
    .requiredOption('--why <text>', "Why it's good long term")
    .option('--quote <words>', o("The owner's exact words it came from"))
    .option('--use <term>', 'Copy rule: the term to use')
    .option('--never <terms>', 'Copy rule: comma-separated terms never to use')
    .option('--meaning <text>', 'Copy rule: what the term means')
    .option('--source <where>', 'Where it was decided (pod, ticket)')
    .option('--supersedes <ids>', 'Comma-separated ids this replaces')
    .action(
      run(
        async (options: {
          kind: string;
          statement: string;
          why: string;
          quote?: string;
          use?: string;
          never?: string;
          meaning?: string;
          source?: string;
          supersedes?: string;
        }) => (await knowledge()).runKnowledgeAdd(options)
      )
    );
  knowledgeCmd
    .command('list')
    .description('What counts now: checked-in + this machine, minus superseded')
    .option('--kind <kind>', 'judgement | copy')
    .option('--json')
    .action(
      run(async (options: { kind?: string; json?: boolean }) =>
        (await knowledge()).runKnowledgeList(options)
      )
    );
  knowledgeCmd
    .command('sync')
    .description(
      "Copy this machine's new entries into the checked-in store (add-only)"
    )
    .action(run(async () => (await knowledge()).runKnowledgeSync()));
};
