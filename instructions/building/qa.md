---
description: Find the tests a ticket's changes could affect, run them, and report. Detection only — never fixes anything.
argument-hint: <ticket id>
---

# Quality Assurance Test Runner

Finds the tests this ticket's changes could affect, runs them, and reports what passed and what failed.

## What this command does

1. **Pulls the ticket and its comments** to find tests a previous run flagged.
2. **Lists the changes** this branch made (committed and uncommitted, untracked files included).
3. **Picks the tests** those changes could affect — unit tests and E2E specs — each with a one-line reason.
4. **Writes `qa.md`** at the project root as a checklist.
5. **Runs the unit tests first** (faster feedback), then **the E2E specs, one at a time**.
6. **Stops on the first failure**, reports it, and keeps `qa.md`.
7. **Cleans up on success**: deletes `qa.md`.

## Usage

```
/qa PAWNEE-123
```

## CRITICAL BOUNDARIES

**This command is DETECTION ONLY:**

- NEVER attempt to fix failing tests
- NEVER suggest code fixes or patches
- NEVER modify any source or test files
- ONLY report: which tests passed, which failed, and the failure output
- On failure: report the error and STOP

**A failure is a failure, period.** Report it whether or not it looks pre-existing, unrelated to the ticket, "already broken before these changes", or flaky. Do NOT dismiss, skip or downplay any failure. The branch must be green to ship.

## Step 1: Pull the ticket and its comments

```bash
lambda tickets pull $ARGUMENTS
```

Read the comments (`.lambda/pulled/$ARGUMENTS/`, or the `## Comments` section of the ticket file on a markdown project). Look for test files earlier runs flagged — `.spec.ts` (E2E) and `.test.ts` (unit) names in failure comments. **Flagged tests are always included**, whether or not the diff touches them: they catch regressions in tests that didn't change but broke through a shared fixture or dependency.

## Step 2: List the changes

```bash
BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)
git diff --name-status "$BASE"
git diff --cached --name-status
git status --porcelain
```

If nothing changed, report "No changes detected" and stop.

## Step 3: Pick the tests

- **Unit tests**: tests next to or importing each changed source file (search for imports of the changed module), plus any changed test file, plus the flagged ones. Use the project's own test layout and naming.
- **E2E specs**: every spec the change could affect — a changed spec, a spec that uses a changed helper or a changed test id, a spec that drives the screen or flow the change touches, plus the flagged ones. Each needs a one-line reason. List what the ticket could affect, not the whole suite. Never include specs whose job is to delete shared test accounts or data.

## Step 4: Write `qa.md`

```markdown
# QA Test Checklist

Generated: <timestamp>
Changed files: <count>

## Unit Tests

- [ ] `parks.test.ts` - Pending (changed: src/parks.ts)

## E2E Specs

- [ ] `park-map.spec.ts` - Pending — changes the map's pin layer

## Progress

- Total: X · Passed: 0 · Failed: 0
```

No tests found for the changes? Report "No related tests found. Looks good!" and stop without writing `qa.md`.

## Step 5: Run the unit tests

**Check first for `.only(` in any test file** — it silently skips the rest of a suite. Flag it as a failure.

Run them with the project's test command (`lambda test <names>`), a few at a time, waiting for each call to finish before the next. After each call, update `qa.md`. **On ANY failure, STOP**: add the details to `qa.md`, report the output, run nothing more.

## Step 6: Run the E2E specs

Run each selected spec **on its own**: `lambda e2e <spec>`. Never the whole suite at once — one spec alone gives a clear answer and fits the machine. After each, update `qa.md`. **On ANY failure, attach the failing spec's screenshot (below, with `--failed`), then STOP** and report it, with the trace path `lambda e2e` printed.

**Record what the run saw.** For each spec, attach its key screenshot so {owner} sees it under Test in the app, with the page, its console errors and your one-line conclusion:

```
lambda pod screenshot <file.png> --url <the page's address> --console "<a console error>" --conclusion "<what it shows, in one line>" --failed
```

`--passed` instead of `--failed` for one that shows the check passing; one `--console` per error, none when there were none. It finds your pod by itself, so it still works after a `/clear`. Outside a building pod there's nowhere to attach them: skip this.

## Step 7: Report

**All passed:** delete `qa.md` and report:

```
QA: PASSED — X/X tests (U unit, E E2E specs)
```

**Any failed:** keep `qa.md` and report:

```
QA: FAILED — <test>
<the error output>
See qa.md for details.
```

Then STOP. Do not suggest fixes.
