---
name: check-ticket
description: Verify an implementation is complete against its ticket. A strict completeness audit, run by QA, which never wrote the code.
---

# Check Ticket Implementation

Verifies that the work fully implements a ticket. This is a **strict completeness audit**, not a code review.

**Philosophy:** agents do well with clear, explicit requirements. If a ticket was written well, every requirement is verifiable. If you can't verify it, the implementation is incomplete.

## Usage

```
/check-ticket PAWNEE-123
```

**Argument:** `$ARGUMENTS` (the ticket id)

---

## Instructions

### Step 1: Fetch the ticket

```bash
lambda tickets pull $ARGUMENTS
```

### Step 2: Read the ticket thoroughly

Read the description (`.lambda/pulled/$ARGUMENTS/description.md`, or the ticket file itself on a markdown project) and any images beside it.

**Note on comments:** rejections, retry notes and other workflow comments reflect intermediate states that have been resolved by the time this runs. Do not treat them as evidence of current failures. Audit only the code as it exists now.

**Note on an `## Addendum`:** if the description ends with one, it is **part of the ticket, not a comment on it** — decisions recorded by the dev after the work started, from measurements that did not exist when the ticket was written. Where it contradicts anything earlier in the description, **the addendum wins, and you audit against the ticket as amended.** It is subject to its own check first — see [The Addendum](#the-addendum--decisions-recorded-after-the-work-started) below.

**Extract EVERY checkable item:**

| Category                  | What to extract                                       |
| ------------------------- | ----------------------------------------------------- |
| **Acceptance criteria**   | Explicit requirements (usually checkboxes or bullets) |
| **Implied requirements**  | Things obviously needed but not stated                |
| **Test plan**             | Unit tests, E2E tests, coverage expectations          |
| **Edge cases**            | Error states, empty states, boundary conditions       |
| **UI/UX specs**           | Behaviour, interaction patterns, component specs      |
| **Files to modify**       | Expected file changes listed in the ticket            |
| **Schema changes**        | Data or type changes specified                        |
| **Verification commands** | Commands to run to verify (e.g. `lambda test X`)      |

### Step 3: Gather the implementation

List what this ticket changed — committed and uncommitted, untracked files included:

```bash
BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)
git diff --name-status "$BASE"
git diff --cached --name-status
git status --porcelain
```

Then read the key changed files to understand what was built **for this specific ticket**.

---

## Step 4: Audit against five dimensions

Evaluate the implementation against **each dimension** independently. A failure in ANY dimension means the ticket is INCOMPLETE.

---

### Dimension 1: Acceptance Criteria (40%)

**Every acceptance criterion must be explicitly verified.**

| Criterion type | How to verify                     | Failure condition              |
| -------------- | --------------------------------- | ------------------------------ |
| Feature works  | Code inspection OR test assertion | No code implementing it        |
| Data changes   | Schema check + migration          | Schema missing or incorrect    |
| API behaviour  | Unit test assertion               | No test covering the behaviour |
| Error handling | Test for the error case           | No error handling code or test |

**Wrong-tier acceptance criteria — reject them.** A criterion requiring **concurrency, bursts or races** at E2E or integration tier is wrong-tier. Flag it and require the property be pushed down to **unit**, where clock and ordering are controlled.

**Split every criterion into OUTCOME and MECHANISM before you rule on it.**

| Part          | What it is                                                                                                  | Status       |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ------------ |
| **Outcome**   | What becomes observable — user-visible behaviour, stored data, an API response, an error the caller can see | **Binding**  |
| **Mechanism** | The route the ticket named to get there — a hook, query, file path, line number, prop, suite name           | **Advisory** |

A ticket is written before the code exists. Its outcomes are the author's decision; its mechanisms are the author's best guess at how the code will look. **Guesses go stale. Decisions do not.**

- Outcome missing or partial → **✗ INCOMPLETE.** Always.
- Outcome delivered by a different mechanism → **⚠️ Deviation**, and the dimension still passes, provided the deviation clears the bar in "Ticket Drift" below.

**Checklist:**

- [ ] Every acceptance criterion has its **outcome** delivered
- [ ] Each delivered outcome is evidenced — code that implements it AND a test that asserts it
- [ ] Every mechanism deviation is ruled against the Ticket Drift bar and listed in the report
- [ ] No unstated assumptions (if the ticket says "CSV export", don't also add "PDF export")
- [ ] Scope boundaries respected (no unrequested features)

**Auto-fail:** any criterion whose outcome is missing; any outcome only partly delivered; a mechanism deviation that fails the Ticket Drift bar.

**Not a failure (report as ⚠️ Deviation):** the outcome delivered by a different mechanism; the criterion describing existing code incorrectly (stale line number, a file that never existed); a criterion prescribing a verification the harness cannot physically perform; the prescribed fix **attempted, measured and reverted on a negative result**, recorded in the `## Addendum` (see [below](#an-attempted-fix-with-a-negative-result-is-a-completed-criterion)).

---

### Dimension 2: Test Plan (30%)

**This is where agent implementations most often fail.** Test plans are requirements, not suggestions. **TDD is the standard**: every implementation has unit tests.

**Unit tests:** exist at the specified place; cover the happy path, error cases and edge cases; pass when run.

**E2E tests (when the ticket specifies them):** the spec exists; it covers the exact user flow described; its assertions match the expected outcomes; it uses the specified test data.

**Auto-fail, each:** no unit tests; "tests for X and Y" but only X is tested; "E2E test for flow A" but no E2E test exists; tests that don't assert the specific behaviour; tests skipped or pending; tests that fail.

**Test plan drift (⚠️ Deviation, not a failure).** The binding part of a test plan is the **behaviour that ends up asserted**; the suite name and path are a guess. A named suite that didn't exist and was created, or the same behaviour asserted in the suite that actually owns it (name the file and test), or a behaviour already pinned by an existing test (quote it) — all deviations. **What still fails:** the behaviour is asserted **nowhere**. Go find the assertion and quote it, or fail the dimension.

---

### Dimension 3: Scenario Coverage (15%)

| Scenario type      | How to check        | Example                          |
| ------------------ | ------------------- | -------------------------------- |
| Happy path         | Main flow works     | User submits form, sees success  |
| Empty state        | What if no data?    | List is empty, shows placeholder |
| Error state        | What if it fails?   | Network error shows a message    |
| Boundary condition | Min/max values      | 0 items, 1000 items, max length  |
| Concurrency        | Races               | Two people edit the same record  |
| Permission denial  | Unauthorized access | A non-owner tries to delete      |

**Auto-fail:** a listed edge case not implemented; an obvious error state not handled; an empty state not considered when displaying a list.

---

### Dimension 4: File Modification Accuracy (10%)

**If the ticket specifies files to modify, verify the diff matches:** every listed file changed; changes match the specification; extra files justified.

**Not a failure** (report as ℹ️ or ⚠️): extra supporting files that enable the ticket's goals; a file the table said to MODIFY that didn't exist and was CREATED (or the reverse); line numbers that no longer match (verify the named _thing_ exists, not the number); a file from "Scope boundaries" changed because the ticket's assumption about it was wrong.

**The design system follows the diff.** When the project has a design system, run `lambda design system changed`. An `update the copy` line means an app file that a hand-made copy in the design system's `patterns/` folder was made from changed. Read that file's diff and rule on it yourself: this audit runs before the design check, so there is no design-check report to lean on. When the change alters what is drawn (a size, colour, spacing, radius, border, an element added, removed or reordered, on-screen wording) and the pattern is unchanged, that is a **gap**: fail this dimension with "Missing file: <dir>/patterns/<file> still copies the old <thing>." (`<dir>` is the design system's folder, `design.system.dir` in `lambda.json`). A logic-only change (a handler, a query, a prop the pattern never draws) is not a gap: note it as "ℹ️ `<file>`: logic only, the copy stands". `rebuild only` lines and `NO DESIGN CHANGES` are never a gap: the next build of the design system picks them up. A project with no design system ("This project has no design system yet") has nothing to check here.

---

### Dimension 5: Verification Commands (5%)

**If the ticket names verification commands, they must be run and pass.** A command naming a target that doesn't exist (a renamed spec, a suite never written) is drift: run the equivalent that does exist and report both. A command that exists and **fails** is still ✗.

---

## Step 5: The verdict

**This is a gate, not a weighted average.** Any failure in any dimension → INCOMPLETE. COMPLETE only when every dimension passes.

### The verdict is derived, not judged

A dimension is failed **if and only if** your report lists at least one `✗` under it.

- **`✗` entries → failed.** Name it in `--failed`.
- **Only `⚠️` and `ℹ️` entries → PASSES.** A deviation is a passing outcome carrying a note.
- **Zero `✗` → record `--complete`.** There is no third state.

Do not let a long list of deviations _feel_ like a failure. Count the `✗` marks.

### Stability

The same tree audited twice must produce the same verdict. **If a dimension passed on an earlier run and nothing in that area has changed, you may only fail it now by naming the specific OUTCOME that is missing.** Re-reading the same deviation and grading it differently is oscillation, not discovery.

---

## Step 6: Report

### If everything passes

```
## ✅ COMPLETE

Ticket $ARGUMENTS is fully implemented.

### Acceptance Criteria: ✓
- [x] <criterion> - verified by <evidence>

### Test Plan: ✓
- Unit tests: <count> tests covering <behaviours>
- E2E tests: <spec> covering <flow>
- All tests passing

### Scenario Coverage: ✓
- Happy path: implemented and tested
- Edge cases: <what was handled>

### Deviations (if any) — these do NOT fail a dimension:
- ⚠️ `<file or criterion>` — <stale premise | mechanism substitution | environment-impossible | attempted-and-measured>
  - Ticket said: "<exact quote>"
  - Shipped instead: <what the code does>
  - Technical cause: <why the letter was unfollowable — not a preference>
  - Outcome met: <the observable result, and the test asserting it>

### Files Modified: ✓
### Verification Commands: ✓
- `<command>` - passed
```

### If anything fails

```
## ❌ INCOMPLETE

Ticket $ARGUMENTS is NOT fully implemented.

### Failed Dimensions:

**Acceptance Criteria: ✗**
- [ ] "<exact quote from ticket>" - NOT IMPLEMENTED
  - Evidence: <what's missing>

**Test Plan: ✗**
- [ ] Ticket requires: "<exact test requirement>"
  - Missing: <specific test not found>

### Deviations (if any) — these do NOT fail a dimension:
- ⚠️ …

### Passing Dimensions:
- Files Modified: ✓
```

---

## Step 7: Record the verdict, then STOP

**Record it.** This is the one action you take. `lambda ship` refuses a ticket without a recorded COMPLETE verdict — a verdict that exists only as text in this pane gates nothing.

```bash
# All dimensions passed
lambda verdict record $ARGUMENTS --complete

# Passed, with the ticket's letter shifted to deliver its intent
lambda verdict record $ARGUMENTS --complete --deviation "Acceptance Criteria: the sort happens in the query, behaviour asserted in parks.test.ts"

# Failed
lambda verdict record $ARGUMENTS --incomplete --failed "Acceptance Criteria,Test Plan"
```

Record the verdict you actually reported — the command refuses COMPLETE alongside a failed dimension.

**Every `⚠️` in your report becomes a `--deviation`, prefixed with its dimension; every `✗` becomes a `--failed`.** A deviation never blocks the gate, but it must reach the record.

**Do not record INCOMPLETE for a ticket whose outcomes are all delivered.** If the only remaining marks are `⚠️`, the verdict is COMPLETE.

**Then STOP.** Do not fix anything. Do not create tasks. Do not ask what to do. Do not offer suggestions. The caller reads your verdict and decides next steps.

---

## The Addendum — decisions recorded after the work started

A description may end with an `## Addendum`: decisions the dev made while the work was in flight, from measurements that did not exist when the ticket was written. **It is part of the ticket.** Where it contradicts anything above it, the addendum wins.

### An attempted fix with a negative result is a COMPLETED criterion

**A criterion whose prescribed fix was built, measured, and found not to work is MET.** The criterion asked for the work to be done; it was done, and the measurement said no. **A negative result is a result.** Grading it as unmet teaches the next dev that the cheapest way through this audit is to never run the experiment.

**All four, or it is `✗`:**

| #   | Test                                                                    | What proves it                                            |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | **It was built**, not estimated                                         | The addendum names what was written                       |
| 2   | **It was measured**, with numbers, on the thing the criterion was about | Before/after figures                                      |
| 3   | **The result is recorded where the next reader lands**                  | The addendum holds the experiment and its result          |
| 4   | **Nothing the criterion promised was dropped with it**                  | Point at the live assertion or guard that still covers it |

⚠️ **"We decided against it" is not an attempt. "It looked expensive" is not a measurement.** An addendum that reasons its way out without having run anything fails test 1.

⚠️ **A reverted attempt still passes test 4**, provided the thing the criterion protected is still measured by something after the revert. A check that still runs and reports as a named warning still measures; an assertion deleted, or a bound moved to fit the failure, does not.

### The addendum must serve the ticket's original intent — this is a check, not advice

Run this before auditing anything against the addendum:

- [ ] **State the original intent in one sentence, sourced from the ORIGINAL description**, never from the addendum.
- [ ] **Rule every decision the addendum records** against that sentence: does it serve the intent, or reduce it?
- [ ] **A decision that drops or narrows a promised OUTCOME does not become legitimate by being written down.** The criterion is `✗`.
- [ ] **A decision that changes MECHANISM, or grows scope toward the intent, passes** (`⚠️` at most).
- [ ] **Each addendum decision is evidenced** — code, a test, or a measurement.

**Drift is about HOW, never WHETHER.** An addendum records decisions and their evidence; it must not restate the acceptance criteria in easier words.

### Nothing on this path blocks

You rule on the addendum with the evidence in front of you, and you record a verdict. Never mark a ticket blocked over an addendum question, never hold a verdict pending confirmation from anyone, and never ask for the description to be rewritten before you will grade it.

---

## Ticket Drift

**A ticket is a set of decisions wrapped in a set of guesses.** The decisions — what must become true — are binding. The guesses — which file, hook, line, suite — were made before anyone opened the editor, and the codebase is allowed to disagree with them.

### The three kinds of legitimate drift

| Kind                            | What happened                                                               | Example                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Stale premise**               | The ticket states something false about existing code                       | The criterion names a component that has since been split in two                                         |
| **Mechanism substitution**      | The outcome is delivered by a different route, for a stated technical cause | Following the named hook literally would add a second listener and bring back the crash the ticket fixes |
| **Environment-impossible spec** | The criterion prescribes a verification the harness can't perform           | "Assert the measured pixel height" in a test environment with no layout engine                           |

### The bar — all four, or it is a failure

1. **The outcome landed** — it exists in the code and is asserted by a test. Point at both.
2. **There is a named technical cause.** "Cleaner", "simpler", "more idiomatic" are preferences, not causes — preference-drift is ✗.
3. **It is recorded where a reader will find it** — a code comment at the site, and a comment on the ticket (`lambda tickets comment`).
4. **Nothing shrank.** No observable the criterion promised went missing.

### The author test

> If the ticket's author read this deviation, would they say **"right — my ticket was wrong about the code"**, or **"no, I specifically wanted that"**?

First → ⚠️, the dimension passes. Second, **or genuine uncertainty** → ✗. Ambiguity resolves toward the ticket.

### The hard line

**Drift is about HOW, never WHETHER.** A dropped outcome is INCOMPLETE however well argued. **Never edit the ticket's acceptance criteria to match what was built** — deviations get documented, never legislated away.

### If the ticket is simply wrong

A ticket that mis-describes the codebase is a **ticket defect**, not an implementation gap. If every outcome is delivered and only the ticket's own factual errors stand between INCOMPLETE and COMPLETE → **record COMPLETE with the deviations listed.** Blocking a ticket is for an outcome that **cannot be delivered** — missing access, an authorization nobody here holds, a dependency that doesn't exist — never for a stale line number.

---

## Strictness rules

1. **Strict about outcomes, not wording.**
2. **No partial credit** — 90% of the outcomes is INCOMPLETE.
3. **No rationalizing** — "the logic is similar so it's covered" is INCOMPLETE. Point at the assertion or fail it.
4. **No recommendations** — say "test is missing", not "you could add a test".
5. **Quote the ticket** for every failure.
6. **Preference is not a cause.**

**DO NOT:** offer choices; make excuses; suggest missing work is optional; give partial credit; ask what to do next; fail a requirement because the ticket described the code wrongly; fail one because its assertion lives in a differently-named file; write a report that passes and a record that fails.

**DO:** report COMPLETE when every OUTCOME is delivered, however far the mechanism drifted; report INCOMPLETE when any outcome is missing, however small; list every deviation with its cause and pass it to `--deviation`; STOP after recording.

## Common implementation gaps

| Gap                                    | How to detect                                                                           | Example                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **No unit tests**                      | Unit tests missing entirely                                                             | Auto-fail                                                          |
| **Test plan ignored**                  | The ticket lists 3 cases, 1 exists                                                      | Missing cases                                                      |
| **Happy path only**                    | No error-case tests                                                                     | The ticket names an error message; no test for it                  |
| **Schema drift**                       | Types don't match the spec                                                              | Spec says `status: 'open' \| 'closed'`, code has `isOpen: boolean` |
| **Implicit assumptions**               | Features not in the ticket                                                              | Asked for a CSV export, also added PDF                             |
| **Skipped edge cases**                 | A listed edge case isn't handled                                                        | "Handle an empty list" not implemented                             |
| **Assertions missing**                 | A test runs but asserts nothing                                                         | Navigates, never `expect()`s                                       |
| **Missing data migration**             | A permission, rule or schema shape changed with no migration for existing data          | Field made required; records saved before it fail to load          |
| **Drift used as cover for scope loss** | A claimed deviation whose "outcome met" is smaller than the criterion, or names no test | That is `✗`, not `⚠️`                                              |
