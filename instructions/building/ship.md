---
description: Ship a finished ticket with `lambda ship` — behind its verdict gate — and fix what stops it. Reports SHIP: PASSED, FIXED or FAILED.
argument-hint: <ticket id>
---

# Ship

Ship the ticket with `lambda ship`. If it fails, fix the failures and prove each fix. Report the result.

## Usage

```
/ship PAWNEE-123
```

## What `lambda ship` does

1. **Checks the verdict gate first.** It refuses a ticket without a recorded `COMPLETE` verdict from `/check-ticket` (`lambda verdict record`). There is no flag past it: if it refuses, the answer is `/check-ticket`, never a workaround.
2. **Runs the project's own ship command** (`commands.ship` in `lambda.json`) — whatever this project uses to verify and land a change: a CI run, a pull request with checks, a deploy.
3. **Or, with no ship command, the default:** the project's `test` command, then one commit (`<id>: <title>`) of everything changed, on the branch the project has checked out. It never pushes. It's the only thing in this process that ever commits.

## Phase 1: Run it

Run `lambda ship $ARGUMENTS` and wait for it to finish. Do not attempt any fixes during this phase. A ship command can run for a long time; wait for the process to end before reading the result — never analyse half-finished output.

**Passed:** report and stop.

```
SHIP: PASSED
```

**Failed:** go to Phase 2.

## Phase 2: Fix the failures

1. Read which checks failed and their output. For an E2E failure, read the trace before anything else (`lambda trace`), and look at the screenshots — even for a bug that doesn't look visual.
2. Investigate each failure: the error, the trace, the logs.
3. Fix each one at its cause.
4. **Prove each fix in isolation yourself, before reporting** — that one test, suite or spec run alone, and one pass is proof:
   - a unit or integration suite → `lambda test <name>`
   - an E2E spec → `lambda e2e <spec>`, that spec alone
   - typecheck, lint or build → that command alone
5. Run the project's format, lint and typecheck.
6. Report `SHIP: FIXED`, with the proof.

**An intermittent failure is not a code fix.** A spec that passes on some runs and fails on others against the same code — timeouts, a shifting set of failures, network errors — gets re-run, not rewritten. Reliably red means fix it; intermittently red means run it again. Never make a flaky spec pass by adding sleeps or retrying assertions before the action under test: that is a false green that survives.

**A failure this ticket did not cause** is not this ticket's to fix beyond the minimum that stops it shipping. Fix that minimum; leave the rest and say so in your report, with `file:line`.

## Report format

```
SHIP: FIXED

- <what was wrong>: <what you changed>
- Proof: `<the command>` → passed
```

Rules:

- **No proof, no FIXED.** Without the command and its passing result, report `SHIP: FAILED`.
- Keep it minimal — what broke and what you changed.
- Do NOT re-run `lambda ship` yourself after fixing — the Engineering manager re-verifies.
- Never `git commit` or `git push` by hand.
- If you cannot fix a failure after a reasonable attempt, report:

```
SHIP: FAILED

- <what fails, and what you tried>
```
