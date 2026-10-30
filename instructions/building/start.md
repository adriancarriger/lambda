---
description: Start a ticket — pull it, plan the work, implement it test-first and run every test.
argument-hint: <ticket id>
---

# Start Ticket Implementation

Pull the ticket, plan the work, implement with TDD, and run all tests.

## Step 1: Pull the ticket

Run `lambda tickets pull $ARGUMENTS` to get the full description, comments and any attached images (`.lambda/pulled/$ARGUMENTS/`, or the ticket file itself on a markdown project). Read everything carefully before proceeding.

## Step 2: Read the project's own guidance

Read the project's agent instructions (the files `lambda.json` lists under `instructions`, such as `CLAUDE.md`) and any skills or docs they point to for the areas this ticket touches. Use them: they hold the project's conventions, commands and known traps.

## Step 3: Plan the work

Create a task list from the ticket's acceptance criteria and test plan. Break it into concrete steps covering:

- Unit tests to write
- Implementation changes
- E2E tests to write
- E2E tests to run

**Stay in scope.** The ticket's acceptance criteria are the job. Anything you notice beyond them — a pre-existing bug, a refactor, polish — is not this ticket's work unless the ticket cannot finish without it (then fix the minimum) or this branch caused or worsened it (then it is yours). Note the rest in your report for {owner} rather than growing the diff.

## Step 4: Implement (TDD)

1. **Write unit tests first** — cover the new behaviour before writing implementation code.
2. **Run them** — `lambda test <name>` — and verify they fail **for the right reason**.
3. **Write the implementation** — make the tests pass.
4. **Run them again** — verify they pass.
5. **Write E2E tests** — cover the user-facing behaviour the ticket's test plan names.
6. **Run E2E tests** — `lambda e2e <spec>`, one spec at a time — and verify they pass.

A ticket that fixes a bug opens with a regression test that **fails on the main branch** for the reason the ticket gives; only then the fix, which turns it green. A ticket whose cause is unproven opens with the investigation: reproduce it, find the real cause, and if it does **not** reproduce, report back and stop rather than fixing a guess.

## Step 5: Run the tests

**THIS IS NOT OPTIONAL. YOU MUST ACTUALLY RUN THE TESTS.**

Every test you write or modify MUST be executed and MUST pass before you report completion:

- **Unit tests**: `lambda test <name>`
- **E2E tests**: `lambda e2e <spec>`

Do NOT skip this step. Do NOT report completion without running tests. Do NOT assume tests pass because the code looks correct.

## Step 6: Clean up

Before reporting: run the project's typecheck, lint and format; remove debugging output, temporary files and focused tests (`.only`); make sure every new file is meant to ship. Run `lambda design system changed`: for each `update the copy` line it prints, update that copy now, as `design-check.md` describes (it never publishes and never commits), so check-ticket doesn't find it stale. If it fails (exits 1: the design system's `sources.json` is missing or broken), fix `sources.json` as `design-check.md` Step 1 says and run it again; if it fails a second time, say so in your report with its error line. Never commit — `lambda ship` does that later, behind its verdict gate.

## Step 7: Report completion

Only after ALL tests pass and cleanup is done, report:

- What was implemented
- Which tests were run, and their results
- Any notable decisions or trade-offs
- Anything you noticed beyond the ticket and left alone, with `file:line`

---

## Testing rule

**The failure mode this command exists to prevent**: writing tests but never running them, then reporting "implementation complete."

The correct sequence is:

1. Write the test
2. **Run the test**
3. See the result
4. If it fails, fix and re-run
5. Only move on when it passes

If you find yourself typing "implementation complete" and you haven't seen test output scroll by — stop. Go back and run the tests.
