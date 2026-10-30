---
description: (planning pods) Run one phase of the planning pipeline. Sent to the pod dev by the Planning manager.
argument-hint: 1 | 2 | triage | apply-triage | research | tickets | ux | 4 | 5 | finish
---

# /pod-phase $ARGUMENTS

You are the dev in planning pod `$POD_ID`. Follow the planning dev instructions (`dev.md`) throughout: the asking rules, the question format, cold reads, and the ripple and stale checks. Run only the section for **$ARGUMENTS** below. When it is done, end your turn — the Planning manager is waiting for that.

**Your track** is on the `track:` line of `lambda pod status $POD_ID`, and the epic (or lone ticket) id on the line below it:

- `idea` — a new idea: CP1 (the plan), CP2 (the reviewed epic), research and the **split proposal** (CP3), the tickets, the UX review (CP4), Fill, Reconcile, CP5.
- `existing` — an existing epic or a lone ticket (`ticket:` line): **no CP1 or CP2** — the epic is already {owner}'s, and what you understood opens the UX review instead. Research as usual; the split proposal when an epic has no children, and for every lone ticket ({owner} chooses: split, or keep one ticket). Questions still go to {owner} as they come up.
- `batch` — several existing tickets planned together (the `tickets:` line), usually unrelated bugs, no epic: Shape, then **triage** (CP2), then each ticket through the lone-ticket flow — one UX review (CP4) and one final check (CP5) for the whole batch. **Per-ticket work runs in a fresh subagent per ticket** (read, research, review), so your own context holds the summaries and the picture across the batch, not every ticket's detail. Report per-ticket steps with `--ticket <id>` as well as `--progress`. Questions about one ticket get `--ticket <id>` on `lambda pod question add`.

**Planning runs no tests, E2E, dev servers or builds. The only things it starts are `lambda shot` (the project's photo hook) and `lambda design render`, `lambda design walk` and `lambda design snapshot` (short headless renders of designs). `lambda shot search`, `lambda shot check` and the other file-only `lambda design` commands are not runs. `lambda design system build --from <base>` (a local bundle of the design system committed on main, built outside this worktree, for designs) is also allowed. So is `lambda design system prepare`, which does the same and installs it on a canvas. Planning never writes the design system's files and never creates the ticket that makes it.** Otherwise it reads code and tickets and writes plans. Proving things by running them is the ticket's job (see "Prove it first" in `tickets`).

**Report every step** before and after you do it: `lambda pod step <step> start`, then `lambda pod step <step> done`. {owner}'s workflow panel shows where you are from these, and each step's history (time, what it found) decides whether it stays in the process. Each step below names its id.

- Per-ticket steps: add `--progress <done>/<total>` as you go.
- Repeated steps (red flags, reconcile): `--pass <n>` on start and done, and **`--found <n>` on done** — the fixes plus questions that pass produced, `0` if none. A pass with `--found 0` is the short-circuit, and it is also the evidence that a pass may not earn its place, so never round it up.
- A step that doesn't apply (the epic already has children, so nothing to propose): `skip --note "<why>"` in place of `done`.
- Optional `--note "<one short line>"` on done: what it changed, for the hover.

**This project may change the process.** `lambda planning show` lists this project's planning steps in order, including steps the project added (each runs its own slash command), renamed or switched off. Run the steps it lists; a step it shows as `off` is skipped with `skip --note "switched off"`.

**A ticket that stops existing is deleted, never canceled.** When tickets are merged (by {owner}, or a merge you logged) or a ticket's content moves elsewhere, the ticket that is gone gets `lambda tickets delete <id> --reason "<merged into … | moved to …>"`. Canceled is only for a real ticket {owner} dropped and wants on record, and only when they say so. The epic or ticket you are planning is never deleted.

---

## 1 — Shape

Phase 1 is a live conversation with {owner} (`/human-chat` messages; you reply with `lambda pod reply --ask` when you need their answer, `--fyi` otherwise).

**Their questions come first.** If their opening message (or anything they have said since) asks you something, answer it before any phase work — `lambda pod reply --ask`, short, ending with an open door — and talk it through for as long as they want. Shape is not done while a reply of theirs is outstanding: `lambda pod status` shows the owner is waiting, and the Planning manager waits on it. Fold what they say into `intent.md` (their words, verbatim).

**Name the pod** as soon as you know what it is: `lambda pod rename $POD_ID "<3–6 plain words>"` ("Harvest Festival sign-ups", "Park map pins"). If {owner} has renamed it themselves the command keeps their name — that's fine, don't try again.

**Started as a freeform conversation?** (`mode:` line says so.) Then you and {owner} have already talked it through, and the thread is in your context. Shape starts from that talk: write `intent.md` from it (their words verbatim) and **confirm rather than re-ask** — anything they already settled is settled.

**Statuses.** Starting the pod moved its tickets to `planning`; anything you create while planning gets `--status planning`. Finish moves them to `ready`. Never move a ticket to `building` — the build pods do that.

**First check `lambda pod status $POD_ID`.** An `epic:` line means an **existing epic**; a `ticket:` line means a **lone ticket**; a `tickets:` line means a **batch** — follow the matching section below and **never create a new epic**. Otherwise follow "New idea".

### New idea

1. Understand the idea. Ask {owner} directly (via `lambda pod reply --ask`) only what you genuinely cannot settle from the code, the project's docs or their words. Keep replies short.
2. (`lambda pod step intent start` / `lambda pod step intent done`) Write `intent.md` (format in `dev.md`) — their words verbatim first.
3. (`lambda pod step epic start` / `lambda pod step epic done`) Create the epic with `lambda tickets create --title "…" --status planning --description-stdin`, opening with an **Intent** section quoting their key lines. Record it: `lambda pod epic $POD_ID <id>`.
4. (`lambda pod step cp1-post start` / `lambda pod step cp1-post done`) Post CP1: `lambda pod checkpoint post --cp 1 --summary "…" --plan-stdin < plan.txt` (see Checkpoints in `dev.md`).

### Existing epic

1. (`lambda pod step epic start` … `lambda pod step epic done` once it is read) `lambda tickets pull <epic>` and read it, plus every child it already has (`lambda tickets get`, or pull each child). Read the code it touches.
2. (`lambda pod step intent start` / `lambda pod step intent done`) Write `intent.md` from the epic: under **{owner}'s words (verbatim)** quote the epic's Intent section (or its opening, if it has none) exactly, marked `(from the epic)`, plus anything {owner} added when starting the pod. Derive principles as usual.
3. Ask {owner} only what the epic genuinely leaves open (one hinge at a time). If it is clear, ask nothing.
4. Do **not** rewrite the epic in this phase. Planning the epic you were given, keeping its tickets, respecting what it already decided and leaving out what it postponed is **protocol — don't log any of it**. Log a decision only where you had to fill a real gap and there was a real alternative.
5. No checkpoint — end your turn.

### Lone ticket

A single existing ticket with no epic. Never create a new epic for it, and never split it on your own: **propose** a split at CP3 and {owner} chooses — accept the split (the ticket becomes the epic) or keep it one ticket.

Lone tickets are often **filed by an agent** — a good write-up, but not {owner}'s words, and possibly stale.

1. (`lambda pod step epic start` … `lambda pod step epic done`) `lambda tickets pull <ticket>` and read it, plus the code it touches. Note its labels — they stay as they are.
2. (`lambda pod step intent start` / `lambda pod step intent done`) Write `intent.md` from the ticket. If an agent wrote it, quote its problem statement under **The ticket's words (verbatim)**, marked `(filed by an agent)` — never under {owner}'s heading.
3. Ask only what the ticket genuinely leaves open. Same protocol rule as an existing epic.
4. No checkpoint — end your turn.

### Batch

Several existing tickets, planned together but each on its own — no epic, nothing split or merged without {owner}.

1. (`lambda pod step epic start` … `done`) Read every ticket (`lambda tickets pull`), one subagent per ticket in parallel: its problem, labels, and the code it points at. Keep a one-line summary per ticket.
2. (`lambda pod step intent start` / `done`) Write `intent.md`: {owner}'s own words when they started the pod, verbatim, then **one short section per ticket** — its problem in its own words (`(filed by an agent)` when it was) and labels.
3. Ask only what their message genuinely leaves open. No checkpoint — end your turn; triage comes next.

## triage — Triage (phase 2, `batch` track)

**Read only — run nothing.** Each ticket gets exactly one proposal (one subagent per ticket, then you check them side by side — duplicates only show up across tickets):

- **plan it** — still real, one dev session;
- **looks already fixed** — the code on the main branch no longer does what it describes: name the commit or `file:line` that shows it. **You never close it** — {owner} closes it themselves;
- **duplicate — merge into …** — say which survives and why. **A ticket that only changes tests** (a flaky or wrong test, coverage, a retired spec) is always a merge — into the batch ticket whose code it tests, or the nearest one; never planned on its own;
- **too big — pull it out** into its own pod (or an epic): it doesn't fit one dev session.

1. (`lambda pod step triage start` … `lambda pod step triage done --found <tickets not "plan it">`, with `--ticket <id> --progress n/N` per ticket) Work out each proposal.
2. (`lambda pod step cp2-post-triage start` / `done`) Post CP2: `lambda pod checkpoint post --cp 2 --summary "<N tickets: how many to plan, how many look fixed, merges, pull-outs>" --plan-file <file>`, one row per ticket in the batch's order: its id, title, the proposal (`plan` | `fixed` | `merge` | `pull-out`), a plain name, `today` (what the ticket says, and what is true in the code now), `after` (the proposal and why — the evidence for "looks already fixed") and its cold read. {owner} changes rows like any checkpoint ("row 3: plan it anyway"): edit the file in place and reply saying what changed.
3. **CP2 decides the shape of the batch, not how to fix each ticket.** Don't ask product questions here. A product choice you already spotted in a ticket ends that row's `after` with its own line: `Asked after research: <the choice, in one sentence>.` It is asked as a normal question once that ticket is researched.

## apply-triage — Apply the triage (phase 2, `batch` track, after CP2)

1. (`lambda pod step apply-triage start` … `done --found <changes made>`) Carry out what {owner} accepted, nothing more:
   - **merge**: fold the duplicate's content into the survivor, then `lambda tickets delete <duplicate> --reason "Merged into … (batch triage)"`;
   - **pull out**: start its own pod — `lambda pod new pullout --text "<id> — pulled out of this batch at triage: <the row's after, in a sentence>" --from-checkpoint <CP2's qid>`. Leave the ticket itself untouched; one `--fyi` naming the new pod;
   - **looks already fixed**: nothing — it's theirs to close; it leaves the batch;
   - then `lambda pod tickets $POD_ID <the tickets still being planned, in order>`.
2. (`lambda pod step epic-red-flags start --pass <n> --ticket <id>` … `done --pass <n> --found <n> --ticket <id>`) Red flags on each remaining ticket, as for a lone ticket (up to 2 passes each, fresh each pass). No checkpoint — end your turn.

## 2 — Epic review

1. Run the `/red-flags` process on the epic (or the lone ticket), **up to 2 passes** (see "Repeated red-flags passes" below). Each pass: `lambda pod step epic-red-flags start --pass <n>` … `lambda pod step epic-red-flags done --pass <n> --found <fixes + questions>`. Engineering findings: fix the ticket and log each with `lambda pod decide --autonomous`. Judgement calls: questions (draft → cold read → commit), never a chat list.
2. `idea` track: (`lambda pod step cp2-post start` / `lambda pod step cp2-post done`) post CP2 once none of this phase's questions are open. **`existing` track: no checkpoint** — end your turn when the passes are done, even if a question is still open (you apply its answer when it comes; the UX review waits for it).

### Repeated red-flags passes

Phases 2 and 3 run `/red-flags` more than once, because fixing one pass's findings changes the ticket and can expose new ones.

- **Every pass starts fresh:** `lambda tickets pull` again first, so it reads the ticket as the previous pass left it, and re-check against the code; don't reuse the previous pass's notes.
- **Short-circuit:** if a pass finds **nothing** (no fix and no question), stop there; don't run the remaining passes.
- A pass that only produced questions still counts as finding something: run the next pass, but don't re-raise an open question.
- Answers to this phase's questions can change the ticket. If one does, that change gets checked on the next pass; if every pass has already run, check just that change once more before you post the checkpoint.

## research — Research and the split proposal (phase 3)

Everything here is grounded in the codebase before a single ticket is written, so {owner} approves a split that will hold.

**Read only.** Planning runs no tests, E2E, dev servers or builds. The only things it starts are `lambda shot` (the project's photo hook) and `lambda design render`, `lambda design walk` and `lambda design snapshot` (short headless renders of designs). `lambda shot search`, `lambda shot check` and the other file-only `lambda design` commands are not runs. `lambda design system build --from <base>` (a local bundle of the design system committed on main, built outside this worktree, for designs) is also allowed. So is `lambda design system prepare`, which does the same and installs it on a canvas. Planning never writes the design system's files and never creates the ticket that makes it.

0. (`lambda pod step verify-premise start` / `lambda pod step verify-premise done --found <claims that were wrong>`) **Check it still holds.** Check every claim the epic or ticket makes about today's behaviour against the code on the main branch (`lambda pod sync` brought it up to date) — `file:line` references, mechanisms, "the only caller", what the user sees. Tickets filed by an agent go stale: the code moves on, and some are already fixed. If the core claim no longer holds (already fixed, or wrong), ask {owner} one question — options **close it** / **rescope it to what is still true** — and stop until it's answered. Smaller drift: correct it in the ticket as you go. A ticket whose cause is unproven by design: check what you can by reading, but don't present the mechanism as fact anywhere (see `tickets`).
1. (`lambda pod step research start` / `lambda pod step research done`) **Deep research.** Use Explore subagents (in parallel) to map every area the work touches: the files and functions it changes, the patterns already used for the same kind of thing, the data and permissions involved, and **the E2E specs that already cover each area**. Keep `file:line` references — every proposed ticket cites them.
2. (`lambda pod step duplicate-check start` / `lambda pod step duplicate-check done --found <overlaps>`) **Duplicate check.** Search the tracker (`lambda tickets list`, `lambda tickets get`) for anything this overlaps or should fold in. Each overlap becomes an `overlaps` entry on the ticket it touches (`folds-in` — this ticket does that work; `overlaps` — both touch it, coordinate; `related` — worth knowing).
3. **Is there something to split?**
   - `idea` track, or an existing epic **with no children**: yes — continue.
   - A **lone ticket**: yes — continue, **whatever its size**. Don't decide for them that it fits one session: draft the best split along the work's natural seams (each ticket shippable on its own, in build order, with its `dependsOn`), and CP3 asks them to accept it or keep one ticket. Only when there is no seam at all — one change in one place — skip it as below with `--note "lone ticket, nothing to split: <why>"`.
   - An existing epic **with children**, or a **batch**: no. `lambda pod step split-proposal skip --note "<has N children | batch>"`, then skip `proposal-red-flags`, `proposal-cold-read` and `proposal-post` the same way, and end your turn — the research feeds the `tickets` phase.
4. (`lambda pod step split-proposal start` / `lambda pod step split-proposal done --found <tickets>`) **Draft the split proposal** — the `/split-ticket` sizing rules (never split work that fits one dev session), numbered in build order (they are built one at a time, in that order). **No ticket only changes tests**: fold that work into the ticket whose code it tests. Per ticket:
   - `number` (`"1"`, `"2"`…), `title` (plain), `what` (what changes, in plain words a user would follow — read aloud),
   - `files` — where it lands, from the research (`path:line`, shown, never read),
   - `dependsOn` — earlier build numbers it needs. The tickets form a tree, not a line: depend only on what is actually needed. Every dependency has a lower number than the ticket, and a reason in `dependsWhy` (`{"1": "needs the sign-up form"}`),
   - `e2e` — `{"kind": "new-file" | "new-tests" | "assertions" | "none", "spec": "<spec path>", "why": "…"}`. **Prefer extending an existing spec**; a `new-file` needs `why` an existing spec can't hold it; `none` needs `why` nothing user-facing needs a test,
   - `overlaps` (from step 2; `[]` if none).
5. (`lambda pod step proposal-red-flags start --pass <n>` … `done --pass <n> --found <n>`, up to 2 passes) **Red flags on the proposal** — the `/red-flags` checks applied to the proposed tickets themselves (wrong premise, missing migration, a test that can't fail, contradictions between tickets). Fix the proposal; judgement calls become questions.
6. (`lambda pod step proposal-cold-read start` / `done --found <rewritten>`) **Cold read**: one fresh subagent gets ONLY each ticket's `title` and `what` and returns `{"restatement", "unclear": []}`; rewrite anything unclear.
7. (`lambda pod step proposal-post start` / `lambda pod step proposal-post done`) Write `proposal.json` in the pod folder as `{"tickets": [{…ticket, "coldRead"}]}` and post it: `lambda pod checkpoint post --cp 3 --summary "<1–2 sentences: N tickets, the shape of the split>" --proposal-file <that file>` (plus `--decisions-cold-read` when it has decisions). Only once none of this phase's questions are open.
8. {owner} changes it like any checkpoint ("merge 3 and 4", "no new spec for 6"): edit `proposal.json` in place — the card updates itself, no re-post — and reply saying what changed. They close it when they're happy.
9. **A lone ticket's CP3 closes one of two ways**, shown on the `split:` line of `lambda pod status`: **accepted** — the ticket becomes the epic and the proposal its children; **one-ticket** — the proposal is dropped and the ticket is brought up to the template as a lone ticket.

## tickets — Write the tickets (phase 3, after the split proposal)

1. (`lambda pod step write-tickets start` … `lambda pod step write-tickets done --found <tickets created, adopted or changed>`)
   - **After a split proposal:** create each approved ticket (`lambda tickets create --title "<number> - <title>" --parent <epic> --status planning --description-stdin < ticket.md`), in build order (`lambda tickets reorder <epic> --order …`), using the full ticket template (acceptance criteria, test plan, security, scope boundaries). Its test plan follows the approved `e2e` line exactly.
   - **An existing epic with children: adopt them, don't re-split.** Put them in build order and number their titles `1 - …`, `2 - …` (`lambda tickets update <id> --title …`, then `lambda tickets reorder`); bring each up to the full template; add a child only for a real gap; split one only if it genuinely can't fit one dev session; merge two only if they only make sense together — the one merged away is deleted. Log every addition, split or merge as an autonomous decision (renumbering is protocol). Never delete a child on your own for any other reason — move anything obsolete to Out of scope and say so.
   - **A batch:** every ticket is a lone ticket (below), each in a subagent. Report each with `--ticket <id>`.
   - **A lone ticket whose split {owner} accepted** (`split: … accepted`): the ticket is now the epic. Rewrite its description as the epic (keep its labels), then write the proposal's tickets as its children, exactly as for a new epic.
   - **A lone ticket** (no split proposed, or `split: … one ticket`): bring it up to the full template in place. Keep its labels. **One ticket stays one ticket:** an agent-filed ticket often tacks on extras ("also add a sweep for…") — keep the core fix in scope and ask {owner} whether each add-on belongs; never fold it in silently.
   - **Prove it first** — the ticket's implementation opens with proof, written into its plan as **step 1** (planning runs no tests: see the rule in research):
     - **A bug:** step 1 is a regression test that **fails on the main branch** for the reason the ticket gives — only then the fix, which turns it green. Name the test file and what it asserts.
     - **A ticket whose cause is not proven:** step 1 is the investigation — reproduce it, find the real cause, and record it on the ticket. Write the suspected mechanism as a **hypothesis**, never as fact, and say what happens if it does **not** reproduce: report back and stop, rather than fixing a guess.
   - Every ticket notes its overlaps under Scope boundaries.
2. (`lambda pod step ux-sketch start` / `done`, `--progress` per ticket) Run `/ux-sketch <epic or ticket>` — every ticket gets a `## UX` section at the top. (A project can switch this step off; `lambda planning show` says so.)
3. **Batch only** (`lambda pod step cross-ticket start` / `done --found <links made>`): one pass across every ticket — **shared causes** (one ticket fixes it; the others say "fixed by … — verify only"), **shared files** (a suggested build order and a conflict note on each ticket that touches the same code), **shared E2E specs** (extend one spec, not two). Each ticket gets a `## Across the batch` section — "Nothing shared." when that's the truth.
4. (`lambda pod step tickets-red-flags start --pass <n>` … `done --pass <n> --found <n>`) Run the `/red-flags` process across **all** tickets together (contradictions between them count), **up to 3 passes**, same rules as "Repeated red-flags passes".
5. No checkpoint — end your turn. **Keep a list of everything that moved from the approved proposal** (a ticket merged or reshaped, an E2E line changed): it opens the UX review.

## ux — UX review (phase 3, before Fill)

{owner} reviews every screen the work changes — before and after, and the journey that brings someone to it — **before** the test plans are written, since Fill writes them against this UX. The pod is still in phase 3.

**Nothing a user sees changes** (a backend fix, a test fixture, tooling)? Then there is no UX review: `lambda pod step ux-surfaces skip --note "<why: no screen, email or notice changes>"`, the same for `ux-cold-read` and `cp4-post`, and end your turn — the Planning manager goes straight to Fill. Don't post an empty CP4.

**Can this computer use Claude Design? Check first.** Run `lambda design capability`. When it prints `unknown`, or the check is more than 7 days old (`checkedAt` in the `design` block of `~/.lambda/config.json`), check again now:

1. `ToolSearch` with `select:Artifact`. If the Artifact tool doesn't load, it isn't available.
2. `Artifact` `list` with `scope: "types"`, and look for a **Design** type (and a **Design System** type, if the same listing shows one).
3. Record what you found: `lambda design capability --set available --type-url <the Design type's URL> [--system-type-url <the Design System type's URL>]`, or `lambda design capability --set unavailable --reason "<what failed, in a sentence>"`.

**One exception:** a session started headless (`claude -p`; `ps -o command= -p $PPID` shows `-p` or `--print`) is never offered the Artifact tool, whatever the account can do. Then don't record anything: this review is ASCII (below), and the CP4 summary says "This pod's Claude session can't use Claude Design (it was started headless), so this review is ASCII."

**Render mode — read it once, now.** Run `lambda pod render-mode $POD_ID` at the start of this phase and keep the answer for the whole phase ({owner} can flip it in the workflow panel; a flip during or after this phase changes only the **next** UX review):

- **`full`**: every changed or new screen gets a brief, before pictures (through `lambda shot`, the project's photo hook), a Claude Design prototype (`/design-screen`) and its pictures; the tickets get `## Design`. If `lambda design capability` says `unavailable`, the review runs as **`ascii`** instead, and the CP4 summary says "Claude Design isn't available with this Claude account, so this review is ASCII."
- **`ascii`**: **skip** the briefs, `lambda shot`, `/design-screen`, `lambda tickets scenarios push` and `## Design` entirely. Screens get no `pictures` and no `prototypeUrl`, tickets get no `## Design` (so the build's visual check skips them), and the CP4 `--summary` says **"ASCII mode"**. Everything else below is the same.

**The design system, in `full` mode.** Designs use the design system committed on the main branch at this pod's base. Each `/design-screen` puts it on its canvas with `lambda design system prepare`, which builds it outside this working folder (the runner's build checkout has the project's packages; this one has none, so never build here) and installs it. It prints at most one summary line; put it, word for word, in the CP4 summary (once, however many screens printed it):

- "<ticket id> is making the design system; these designs use Claude Design's default look." — whenever the project has an open ticket "Make the design system from the app". A setup ticket that hasn't shipped isn't used.
- "The design system on main couldn't be built: <first line of the error>." — the ux phase carries on: designs use Claude Design's default look.
- "No design system: designs use Claude Design's default look." — there is no design system on main and no open setup ticket.
- "No design system on main: designs use Claude Design's default look (couldn't read the tickets: <first line of the error>)." — there is no design system on main, and Lambda couldn't read the project's tickets to look for a setup ticket.

Planning never writes the design system's files and never creates the setup ticket: a project without a design system is designed in Claude Design's own look.

1. (`lambda pod step ux-surfaces start` … `lambda pod step ux-surfaces done --found <screens>` after step 2) List every **surface** the tickets change: screens, dialogs, emails, notices. Start from each ticket's `## UX` section; check the current UI code for the "before" (what exists today, not what a ticket assumes). One entry per surface, even when several tickets touch it.
2. For each surface write:
   - `name` — plain, as a user would call it ("Volunteer sign-up form").
   - `change` — `changed`, `new` or `removed`.
   - `before` / `after` — ASCII sketches (same rules as `/ux-sketch`: mark `← new` / `← changed (was …)`, ≤ 44 chars wide for mobile-first screens). No `before` for a new screen, no `after` for a removed one.
   - `changes` — what someone using it will notice, in plain sentences (read aloud).
   - `journey` — **why this screen exists, from the person's side**, so {owner} sees it in context: `who` is on this screen, `before` (how they get here), `here` (what they do on this screen), `after` (what happens next, for them and for anyone else it reaches). If the same screen serves two different people, pick the main one and mention the other in `after`.
   - `tickets` — the build numbers that build it (`["2", "5"]`).
   - `decisions` — the ids of this checkpoint's decisions that this screen already shows. Link a decision only when the screen's `changes` already says what it decided.
     **Group the screens into flows.** A flow is one journey someone goes through, start to finish — its screens in the order the person meets them. Each flow has a plain `name` and a `summary`: the whole journey in 1–2 sentences, with the person. Every screen belongs to exactly one flow.
3. (`lambda pod step ux-cold-read start` / `lambda pod step ux-cold-read done --found <screens rewritten>`) **Cold read** every screen: one fresh subagent gets ONLY each screen's `name`, `changes` and `journey` (no ASCII, no epic) and returns `{"name", "restatement": "<what a user will notice>", "unclear": ["…"]}` per screen. Put it in each screen's `coldRead`; rewrite and re-read anything unclear.
   3b. **Full mode only — design each screen, before CP4.** A **removed** screen gets no brief, no pictures and no `## Design` entry: its ASCII shows. For every **changed** or **new** screen, with `<slug>` its name in kebab case (`volunteer-sign-up-form`):
   - Write `$LAMBDA_PODS_ROOT/$POD_ID/designs/<slug>/brief.json` — `{"name", "change": "changed" | "new", "changes", "situations": [{"slug", "title", "scenarioId"?}], "path": [{"step", "action"}]}` (add `"viewport": "phone"` for a phone screen). The **first situation is the prototype's opening state**, and every situation is a state in its state switch. `path` is the screen's main path as plain step names, each action exactly `click <target>` (a slug `/design-screen` puts on that control as `data-target`) or `state <situation slug>`. `scenarioId` may be left out; `/design-screen` fills it in.
   - Run `/design-screen <slug>`. It takes the before pictures through the project's photo hook (`lambda shot`), designs and grades the prototype, and photographs the stills. A screen whose run printed `DESIGN FAILED <slug>: …` gets **no `pictures` and no `## Design` entry** (its ASCII still shows) — keep a list of them for the CP4 summary.
   - Read `brief.json` back afterwards for the scenario ids `/design-screen` wrote into it.
   - **Fill the screen's `pictures`** from `designs/<slug>/`, one entry per situation in `brief.json`, in brief order: `situation` = its `title`, `scenarioId` = its `scenarioId` (when it has one), `before` = `designs/<slug>/<situation>.before.png` (**changed** screens with a photo hook only), `after` = `designs/<slug>/<situation>.annotated.png` (a still photographed from the approved prototype), `legend` = the contents of `<situation>.legend.json`; and the screen's `prototypeUrl` = the contents of `designs/<slug>/prototype.url`. Paths are pod-relative. **When the project has no photo hook** (`commands.shot` absent from `lambda.json`), set the screen's `noPhotoHook: true`: its card then says why there's no "before". **The pictures are written before `ux-review.json`**: the card watches only the JSON, and `checkpoint post` refuses a picture whose file isn't there.
   - **Show a prototype in the chat** whenever you tell {owner} about one (a design question, a re-design, a freeform "show me a prototype"): put the line `lambda design snapshot` printed (`[Prototype: <slug> v<n>]`) **on its own line** in your `lambda pod reply`. The inbox turns it into a card: the board's picture, every board side by side, and **Try it**, which opens the working prototype over the inbox. A link to claude.ai alone can't be tried in the inbox.
4. (`lambda pod step cp4-post start` / `lambda pod step cp4-post done`) Write the result to `ux-review.json` in the pod folder as `{"flows": [{"name", "summary", "screens": [{…screen, "coldRead"}]}]}` (screens are numbered 1…N straight through, in flow order) and post CP4: `lambda pod checkpoint post --cp 4 --summary "<1–2 sentences: how many screens, what kind of changes>" --screens-file <that file>`. In `ascii` mode the summary says "ASCII mode" (with the line above that says why, when Claude Design wasn't available or the session was headless); in `full` mode it names every screen whose design failed (`DESIGN FAILED`), which shows as ASCII only, and carries the design system summary line `lambda design system prepare` printed (above). Also:

   - `--understood "<2–3 plain sentences>"` — what you understood {owner} wants, from intent.md. It is read first: on the `existing` track this is where they catch a misread epic, since there was no CP1.
   - `--changes-file <file>` — **after a split proposal**: `{"changes": [{"kind": "screen|ticket|e2e|engineering", "text": "<what it is now>", "before": "<what it was when they approved it>", "why": "<which decision, review or request changed it>"}]}`, what moved since they approved the split; `{"changes": []}` if nothing did. Each change is read on its own, so it must stand alone.
     4b. **Full mode only — each ticket carries its design.** Every ticket that builds a screen with pictures gets a `## Design` section:
   - **When more than one ticket builds a screen**, only the **last** ticket in build order that builds it carries that screen's pictures under `## Design`. Each earlier ticket that builds it gets the same blocks under `## Design reference (checked when ticket <N> is built)` (N = that last ticket's build number), which the build's visual check does not gate on.
   - **Attach each picture first.** Check that every `designs/<slug>/<situation>.annotated.png` the screen's pictures use exists; if one is missing, write no `## Design` for that screen and say so in your next reply. Then, per picture: `lambda tickets attach <id> $LAMBDA_PODS_ROOT/$POD_ID/designs/<slug>/<situation>.annotated.png --name <slug>-<situation>.annotated.png --alt "<screen> — <situation>"` (the `--name` keeps two screens' `default` pictures apart). It prints the picture's ref (a link next to the ticket file on a markdown project, an uploaded file on a tracker).
   - Per picture, one block (no main/other mark — the build's visual check grades all of a ticket's pictures as one set), with a blank line between each part. Only a `###` heading containing `—` is a picture block, and `Scenario:` appears only when the situation has one:

     ```markdown
     ### <screen> — <situation>

     ![<screen> — <situation>](<the ref attach printed>)

     Scenario: <scenario id>

     1. <legend label 1>
     2. <legend label 2>

     Prototype: <prototype url>
     ```

   - Write the section into the ticket: `lambda tickets pull <id>` first (so you start from the ticket as it is now), add the section to the file it names, and `lambda tickets push <id>`. Then attach the scenarios its pictures use: `lambda tickets scenarios push <id> <each $LAMBDA_PODS_ROOT/_scenarios/<scenario id>.scenario.<ext> file>` (a scenario already in the project's tracked scenarios needs no push). It adds their `scenario:` lines under `### Screenshot scenarios` at the end of `## Design`. No photo hook: no scenarios, and nothing to push.

5. If {owner} changes a screen ("screen 2: the Save button should stay enabled"), update the ticket(s) that build it — their `## UX` section and acceptance criteria — and reply saying which. In `full` mode, a changed screen that **already has pictures** is re-designed: update its `brief.json`, run `/design-screen <slug>` again (it moves the old rounds aside itself), refill its `pictures` and `prototypeUrl` — pictures first, then the edited `ux-review.json` — and re-attach its `## Design` and scenarios as in 4b. A screen without pictures (`ascii` mode, or its design failed) is not re-designed.

## 4 — Fill

1. (`lambda pod step e2e-plans start` … `lambda pod step e2e-plans done`, `--progress` per ticket) For each ticket: write its E2E plan. Follow the E2E structure {owner} approved in the split proposal — a ticket marked `new-tests` adds tests to that spec, `assertions` only changes assertions. **Only a NEW spec file the proposal didn't approve** needs their OK (one question per file: why an existing spec can't hold it). Without a proposal (an existing epic with children, a lone ticket): every new spec file needs their OK.
2. (`lambda pod step review-tickets start` … `lambda pod step review-tickets done --found <fixes>`, `--progress` per ticket) Run `/review-ticket <ticket> --fix` on each ticket (fix mode: applies its own suggestions; never splits).
3. No checkpoint. When this phase's questions are all answered, tell the Planning manager: `lambda pod send $POD_ID manager "[dev] phase 4 questions answered"`, then `lambda pod step fill-answered done`.

## 5 — Reconcile

1. Run `/reconcile-tickets <epic>` (fresh-context consistency loop, up to 3 passes; a lone ticket gets one pass against the code). Each pass: `lambda pod step reconcile-tickets start --pass <n>` … `lambda pod step reconcile-tickets done --pass <n> --found <fixes + questions>`.
2. (`lambda pod step ready-check start` / `lambda pod step ready-check done --found <tickets fixed>`, `--progress` per ticket) **Ready to build**: check each ticket the way the build will — run `/review-ticket <ticket>` (grading, not fix mode) and fix until it grades **A**; every acceptance criterion must be testable and every test-plan item able to fail. A ticket that fails here costs minutes; in the build it costs a dev cycle.
3. (`lambda pod step cp5-post start` / `lambda pod step cp5-post done`) Post CP5 once none of this phase's questions are open. **List every dependency link** {owner} approved — and every line of `links.md` in the pod folder (the links and stale-link removals reconcile proposed), word for word — in the CP5 summary, so they see them before Finish. Closing CP5 is their yes to them; Finish writes them. If there was a UX review (CP4), add `--changes-file`: what changed since the UX review — screens, tickets, E2E beyond the approved structure (kind `engineering` for fixes {owner} wouldn't see) — same format as CP4's, `{"changes": []}` if nothing.

## finish

Finishing makes the plan buildable: the tickets move to `ready`, and the links {owner} saw at CP5 are written.

1. (`lambda pod step finish-ready start` / `lambda pod step finish-ready done --note "<n tickets ready>"`) Move every ticket and the epic (a batch has no epic — every ticket on its `tickets:` line) to `ready`: `lambda tickets update <id> --status ready`. Leave their labels alone. If one refuses (it is `done`, `canceled` or deleted), **stop and ask {owner}** — a planned ticket must be open, and something closed or deleted it.
2. (`lambda pod step finish-links start` / `lambda pod step finish-links done --note "<n links written, m removed>"`) **Write the dependency links** {owner} saw at CP5 — every line of `links.md` in the pod folder. Get CP5's qid from `lambda pod question list` (the CP5 checkpoint). For each `B blocked by A — <reason>` line: `lambda tickets block B --by A --checkpoint <CP5's qid>`; for each `remove: B blocked by A — <why stale>` line: `lambda tickets unblock B --by A --checkpoint <CP5's qid>`. The `--checkpoint` gate refuses until {owner} has closed that checkpoint. If any line refuses, **stop and ask {owner}** — never retry with a different qid. No `links.md` (or an empty one) → `done --note "0 links written, 0 removed"`.
3. End your turn with a one-line list of the tickets you moved to `ready` and the links you wrote.
