---
name: visual-check
description: The build's visual check. Photograph a design ticket's screenshot scenarios in this checkout, grade each picture against its design, and record the round. Run by QA in the Engineering manager's visual-check step.
---

# Visual Check

Checks that the screens a ticket built look like the design pictures it carries. Each run
is **one round**: photograph every picture, grade every picture, record the round.
`lambda verdict visual record` decides whether the loop goes on, never you.

## Usage

```
/visual-check PAWNEE-5
```

**Argument:** `$ARGUMENTS` (the ticket id, e.g. `PAWNEE-5`)

**What this is not:** a pixel diff, a baseline, or a code review. The judge grades the
**numbered callouts** in the design picture (its legend) by the levels in Lambda's severity
scale, `{severityFile}`.

**Where the records go:** `<verdicts>` below is the project's verdicts folder, `verdicts.dir`
in `lambda.json` (`.lambda/verdicts` when it isn't set). Use that folder exactly; never
assume `.lambda/verdicts` in a project that sets another one.

---

## The output contract

The last thing you print is exactly **one** of these, and the Engineering manager acts on it:

- the `VISUAL:` line `lambda verdict visual record` printed — `VISUAL: CONTINUE (round n) — fix: <id>, <id>`,
  `VISUAL: MATCH (round n)`, `VISUAL: SHIPPED_WITH_MISSES (round n) — …` or `VISUAL: BLOCKED (round n) — …`,
  **verbatim**, followed (on CONTINUE) by the `Expected: <expected>, actual: <actual>` lines
  it printed, one per picture with an issue;
- or `VISUAL: ERROR — <reason>`, when nothing was recorded (the cases in "Errors" below).

Never choose or rewrite the result yourself. Never print a `VISUAL:` line the command did
not print, with three exceptions: `VISUAL: ERROR`, and the two "nothing to check" lines at
the end of this file.

---

## Step 1: Pull the ticket

```bash
lambda tickets pull $ARGUMENTS
```

On Linear or Jira this writes `.lambda/pulled/$ARGUMENTS/`: `description.md`, with each
picture in it downloaded beside it and the description pointing at the **local** file. On a
markdown project the ticket file itself is the description, and its pictures are in
`<tickets dir>/$ARGUMENTS/` beside it. That local file is the picture's expected image.
Check each one exists in Step 2.

## Step 2: Read the pictures out of `## Design`

Read the description. Only the section under the exact heading `## Design` counts. A
`## Design reference (checked when ticket <N> is built)` section is an earlier ticket's copy
of a later ticket's pictures and is **never** checked here.

Inside `## Design`, planning writes one block per picture:

```markdown
### <screen> — <situation>

![<screen> — <situation>](<local image file>)

Scenario: <scenario id>

1. <legend label 1>
2. <legend label 2>

Prototype: <prototype url>
```

The rules for reading it:

- **Only `### ` headings containing `—` are pictures.** `### Screenshot scenarios` (and any
  other `### ` heading without `—`) is skipped.
- **The id comes only from a case-sensitive `Scenario: <id>` line** in the picture's block.
  Never take it from `scenario: [..](..)` links or anywhere else.
- The **situation** is the heading text without `### ` (`<screen> — <situation>`).
- The **expected** image is the block's image, as a checkout-relative path: under
  `.lambda/pulled/$ARGUMENTS/` on Linear or Jira, under `<tickets dir>/$ARGUMENTS/` on a
  markdown project.
- The **legend** is the numbered list in the block.

Each design picture is one board, exactly 1440×900 (desktop) or 390×844 (phone). The photo
is whatever size the photo hook draws for the scenario's viewport. **Never resize either**,
not before judging and not anywhere else: a difference is only visible at the size the judge
saw it.

All of the ticket's pictures are **one set**. There is no main picture and no "other"
pictures: every one is photographed, graded and recorded, every round.

## Step 3: Work out the round number

The command numbers the round itself; you need the number only for the folder name:

- if `<verdicts>/$ARGUMENTS.visual.json` exists, the last loop finished and this is
  round **1** of a new one;
- otherwise it is 1 + the number of entries in `<verdicts>/$ARGUMENTS.visual/rounds.json`
  (round 1 when the file is missing).

## Step 4: Photograph every picture

For **every** picture (none is skipped, even one that matched last round), in this checkout:

```bash
lambda shot <scenario id> --out <verdicts>/$ARGUMENTS.visual/round-<n>/<scenario id>.png
```

`lambda shot` runs the project's photo hook (`commands.shot` in `lambda.json`) for that
scenario. It never builds or starts anything: whatever the hook needs running must already
be running.

## Step 5: Grade every picture with a fresh judge

For each picture, start a **new** subagent (the Agent tool, one per picture, never reused
across pictures or rounds) and give it only:

- the expected image path (the design picture), and tell it to `Read` it;
- the actual image path (this round's photo), and tell it to `Read` it;
- the picture's legend, the numbered callouts the design draws attention to;
- `{severityFile}`, to read and grade by.

Tell it: compare the actual screen with the design, callout by callout. A difference counts
only if the person using the app would see it. Grade each one `high`, `medium`,
`medium-low` or `low` exactly as the severity scale defines them, using the worse level when
two fit. Reply with JSON only:

```json
{
  "issues": [
    {
      "severity": "medium-low",
      "where": "Show detour button",
      "what": "blue, not black"
    }
  ]
}
```

`{"issues": []}` when it matches. The reply must be one JSON object holding an `issues`
list, each with a lowercase known `severity` and a non-empty `where` and `what` —
`lambda verdict visual record` refuses anything else. If a reply isn't that, ask a **new**
judge once more. A second failure for the same picture is an error (below).

## Step 6: Record the round

Write `<verdicts>/$ARGUMENTS.visual/round-<n>/round.json`:

```json
{
  "pictures": [
    {
      "scenarioId": "<id>",
      "situation": "<screen> — <situation>",
      "expected": "<the expected image, checkout-relative>",
      "actual": "<verdicts>/$ARGUMENTS.visual/round-<n>/<id>.png",
      "issues": [{ "severity": "…", "where": "…", "what": "…" }]
    }
  ]
}
```

`expected` and `actual` are checkout-relative PNG paths. Then:

```bash
lambda verdict visual record $ARGUMENTS --round <verdicts>/$ARGUMENTS.visual/round-<n>/round.json
```

The command validates the file, numbers the round, applies the stop rule to **all the
pictures' issues together** (the worst issue across the set decides, never one picture at a
time) and prints the result. On a stop it writes `<verdicts>/$ARGUMENTS.visual.json` and,
for SHIPPED_WITH_MISSES, posts the expected | actual comment to the ticket itself.

Print its `VISUAL:` line verbatim, followed, on `VISUAL: CONTINUE`, by its
`Expected: <expected>, actual: <actual>` lines (one per picture with an issue, the paths
from `round.json`), so the Engineering manager can hand both pictures to the Dev.

If it exits 1 (it refused the file and wrote nothing), print `VISUAL: ERROR — <its error>`.

---

## Errors: print `VISUAL: ERROR — <reason>` and record nothing

- `lambda shot` exits non-zero: `VISUAL: ERROR — lambda shot <id> failed: <its message>`.
- An expected image is missing locally:
  `VISUAL: ERROR — expected image for <heading> is missing (<path>)`.
- A judge's reply fails twice for one picture:
  `VISUAL: ERROR — the judge's reply for <id> did not parse twice: <the error>`.
- Some `## Design` pictures have a `Scenario:` line and one doesn't:
  `VISUAL: ERROR — <heading> has no scenario id`. Never skip it silently.
- `## Design` is present but no picture parses out of it:
  `VISUAL: ERROR — ## Design has no pictures`.
- `lambda verdict visual record` refuses the round file: `VISUAL: ERROR — <its error>`.

The Engineering manager fixes the named cause and re-runs the same round; a second ERROR in
a row blocks the ticket.

## Nothing to check

These record nothing. In a building pod the Engineering manager skips the step before it
would call you, so you only see them when run by hand:

- The description has no `## Design` heading at all: print
  `VISUAL: MATCH — no ## Design section, nothing to check` and stop.
- `## Design` has no `Scenario:` line in any picture (planning leaves them out when the
  project had no photo hook): print `VISUAL: MATCH — no scenario ids in ## Design, nothing to check`
  and stop.
