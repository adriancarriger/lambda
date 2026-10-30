---
description: Check whether a ticket's changes affect the project's design system and update its source (patterns, catalog, source map, reference screens, sample data) to match, in this same ticket. Runs right before ship. Never publishes, never commits.
argument-hint: <ticket id>
---

# Design Check (keeping the design system in step)

Decide whether this ticket's changes alter how something looks in a way the design system should follow, and bring the design system's **source** up to date if they do.

The design system is committed source in this project: the folder `design.system.dir` in `lambda.json` names (`.lambda/design-system` when it isn't set), and its manifest (`design.system.manifest`, by default `design-system.json` in that folder). Below, `<dir>` is that folder. Planning designs every changed screen from the design system as it is on the main branch, so a design system that still draws last month's card is planning designing against the wrong app.

The goal: **the design system is always in step with the app.** The focus is this ticket's own changes, not a full re-audit. This runs in every building ticket, normal and quick alike; the Engineering manager skips it only when the project has no design system on the ticket's base.

## Usage

```
/design-check
/design-check PAWNEE-12
```

**Argument:** `$ARGUMENTS` (optional ticket id, for context only)

---

## The question

> Of the files this ticket changed, does any one change how something looks, such that the design system should change?

**"Nothing in this diff changes the design" is a valid, common outcome.** Pure logic, data, copy-only text, tests and backend code are not design changes. Do not make an edit just to look busy.

## Cost rules

- **No E2E.** Not one spec. QA's test step runs what the ticket needs.
- **It never publishes.** This step changes the design system's source only, and those changes ride in the ticket's own commit, so they are reviewed and ship with the change. Never make an Artifact call here and never run `lambda design system publish`.
- **It never changes the manifest.** What a later ticket changed is read from git, not stored. Never run `lambda design system manifest write` here.
- **It does not commit.** `lambda ship` commits the ticket, design system changes included.
- **Read the app's source, not screenshots.** The patterns are copied from the source's styles, so the source is almost always enough.

---

## Step 1: Ask the source map

```bash
lambda design system changed
```

It reads `<dir>/sources.json` against this ticket's changes (committed since the merge base with the project's main branch, plus the working tree: staged, unstaged and untracked files) and never guesses. A file the map doesn't name is never a design change. Each line is labelled:

| Line                                  | What it means                                                                                                       | What you do                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `rebuild only     theme <file>`       | A theme file the look is derived from changed: the next build's `tokens.json` changes                               | Step 6 rebuild                                       |
| `rebuild only     component <Name> …` | An app component the design system re-exports changed; the rebuild picks it up                                      | Step 6 rebuild. Check its catalog example still fits |
| `rebuild only     system <file>`      | The design system's own source changed (this ticket edited it)                                                      | Step 6 rebuild                                       |
| `update the copy  pattern <file> ← …` | An app file a hand-made copy in `<dir>/patterns/` was made from changed. **This is the case that drifts silently.** | Step 2                                               |
| `NO DESIGN CHANGES`                   | Nothing the map names changed                                                                                       | Step 3, then report                                  |

If it prints "This project has no design system yet (…)", there is nothing to keep in step: report `DESIGN: NO CHANGE` with that line and stop.

If it fails (exits 1, most often because `<dir>/sources.json` is missing or not the map's shape), the map is what's broken: fix `<dir>/sources.json` (only the design system's files, never the app) so it names the design system's files under `system`, its theme files under `tokens`, its components under `components` and each pattern's app files under `patterns`, then run it again. If it fails a second time, stop and report `DESIGN: FAILED` with its error line, for the Engineering manager.

## Step 2: Update each copy

For every `update the copy` line:

1. Read the app file's change (`git diff <base> -- <file>`, plus the working tree).
2. Decide whether it changes what the pattern draws: a size, colour, spacing, radius, border, an element added, removed or reordered, wording on the screen. A logic-only change (a handler, a query, a prop the pattern never draws) is not one: say "logic only, the copy stands" in the report and move on.
3. If it does, edit `<dir>/patterns/<file>` so the copy matches the app again, with the exact values taken from the source, as the pattern's header comment says it was made. Update its `catalog.ts` entry (`example`, `props`, `summary`) when the shape changed.
4. If the change moved the pattern onto other app files (a component split, a file renamed), update that pattern's entry in `sources.json`.

## Step 3: A new reusable element?

Judge whether the diff adds a screen element that designs will want and that has no component or pattern yet (a new kind of card, a new row shape used on more than one screen). **Judge it; don't add every one.** One-off layout on one screen is not a pattern.

A new pattern means four things: a file under `<dir>/patterns/` recreated from the source's styles (its header comment naming that source), its export in `<dir>/index.tsx`, its `catalog.ts` entry, and its `sources.json` entry. The map test fails when any of them is missing. A pattern never imports the app's runtime (data, auth, analytics): it copies how the piece looks, nothing more.

## Step 4: Reference screens and sample data

The reference screens (`<dir>/screens/`) are the app's real pages redrawn from the design system, and the sample data (`<dir>/sampleData.ts`) is what they and every design draw from. When this ticket visibly changed a page a reference screen draws (an element added, moved or restyled, a new section), update that screen to match. When the page now shows a kind of data the sample data doesn't have, add it to `sampleData.ts`: plain, made-up data, no dates to compute.

## Step 5: Fix what else is out of step

While reading the touched area, note any other place where it and the design system disagree (a pattern already stale before this ticket, a catalog example that no longer matches). Keep it to the area this ticket touched; this is not a full re-audit.

That is **extra work**: code this ticket didn't write. Follow the project's own rule for extra work (its agent instructions, the files `lambda.json` lists under `instructions`). When that rule lets this ticket take it on, fix it here; when it says the work waits, don't fix it: record it where the rule says and report it as carried over. With no such rule, fix it here.

A pattern this ticket's own change made stale is Step 2, never extra work.

## Step 6: Rebuild and test

Only when Steps 2 to 5 changed something, or Step 1 printed a `rebuild only` line:

```bash
lambda design system build --check
```

It builds the working tree, so your uncommitted edits are what is checked: the bundle rules (no app runtime, the size cap), every component drawing, the reference screens, and the map test (every file in `patterns/` has an entry, every entry copies at least one file, every path in the map exists, every `components` name is exported from `index.tsx`). Then run the project's own copy of the map test, `<dir>/sources.test.ts`, when it has one (`lambda test sources`, or the project's way of running one unit test file). Both must pass. Fix what they name in the design system and run them again.

On `NO DESIGN CHANGES` with nothing changed in Steps 3 to 5, run nothing.

---

## Report format

**Nothing to change:**

```
DESIGN: NO CHANGE

- lambda design system changed: NO DESIGN CHANGES | <lines>, and why none changes what is drawn
- New pattern: none — <why>
- Carried over: <finding, file:line> | none
- Ran: nothing | lambda design system build --check + the map test
```

**Changed:**

```
DESIGN: UPDATED

- Patterns: <file> — <what now matches which app change>
- Catalog / sources.json: <entries changed> | unchanged
- New pattern: <name> from <source> | none — <why>
- Reference screens / sample data: <what changed> | unchanged
- Other fixes: <what was out of step> | none
- Carried over: <finding, file:line> | none
- Ran: lambda design system build --check + the map test — passed
```

**The source map is broken** (`lambda design system changed` failed twice):

```
DESIGN: FAILED

- lambda design system changed: <its error line>
- Tried: <what you fixed in sources.json>
```

Rules:

- Keep it short: what changed and what proves it.
- **No E2E was run**, **nothing was published** and **the manifest is unchanged**, in every report from this step.
- Do not commit. Report and stop.
