---
description: Make the project's design system from the app, the first time. Pull the app's look into the design system's source (one direction only), build and check it, photograph the real app, draw each photographed screen from the design system, grade every pair and loop until it matches. Run by the building pod's dev for the ticket "Make the design system from the app", in place of /start.
argument-hint: <ticket id>
---

# Make the design system from the app

The ticket titled exactly **Make the design system from the app** is built with this command instead of `/start`. It pulls the app's look into a new design system: colours, fonts and spacing from the app's theme, the app's own components where they can run in a canvas, hand-made copies of the ones that can't, one sample data set, and the app's real pages redrawn as reference screens. Then it checks the result against photos of the real app, and loops until they match.

## Usage

```
/design-system-setup PAWNEE-12
```

**Argument:** `$ARGUMENTS` (the ticket id)

## The rules that hold throughout

- **One direction only: from the app to the design system.** You read the app and write the design system. **Never edit the app's code**: not to make a component bundle, not to move a constant, not to add a package. A piece that drags the app's runtime (data, auth, analytics, a map library) into the bundle becomes a pattern copy, or is left out. That is by design, not a gap. `lambda design system manifest write` refuses the ticket when it changed any file outside the design system's folder and its manifest.
- **Between rounds, change only the design system's files**: inside the design system's folder and its manifest. Then rebuild with `--check` and draw again.
- **You never choose the result.** `lambda design system round record` decides from the judges' issues whether the loop goes on, matches, is close enough or is blocked.
- **The judge only gets the two pictures, the scale and one line** (Step 5). Never the ticket, the code, your notes or an earlier round.
- **Round 7 is the most.** There is never a round 8.
- Do not commit. `lambda ship` commits the ticket at the end, through the project's normal ship.

## Where things live

- **The design system's folder** `<dir>`: `design.system.dir` in `lambda.json` (`.lambda/design-system` when it isn't set). The ticket names it too. Its manifest is `design.system.manifest` (by default `<dir>/design-system.json`).
- **The pod's design-system folder** `P = $LAMBDA_PODS_ROOT/$POD_ID/design-system/`: `photos/<scenario id>.png`, `round-<n>/<scenario id>.png`, each round's file, and `rounds.json` and `round-<n>/composite-<scenario id>.png` (both written by `round record`, never by hand).
- **The check canvas** `K = <your pod working folder>/.lambda/design/_system-check/canvas/` (Lambda keeps `.lambda/design/` out of git).

---

## Step 1: Read the app

```bash
lambda tickets pull $ARGUMENTS
lambda design system detect
```

Read the ticket. `detect` prints the stack, the theme files the look comes from, the components it found (most used first), whether the project has a photo hook and screenshot scenarios, and whether a design system already exists. Read the theme files and the listed components before writing anything.

- **A non-React stack** (Vue, Svelte, Angular, Solid) has no components in the design system: its components can't run in Claude Design, which uses React. It gets the look only.
- **Nothing to build from**: when `detect` says the stack is `unknown` and the project has no photos (Step 4 can't take any), stop and block the ticket (Step 8) with: "Lambda can't make a design system for <project>: it found no theme or components in the code, and it has no photos of the app (<the photo reason>)." With `unknown` and photos, the design system is made from the photos only (`source: "photos"`): the look read off the photos goes in `<dir>/tokens.photos.json`, and there is no bundle.

## Step 2: Write the design system's source

All of it in `<dir>`:

| File                                         | What to write                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.tsx`                                  | The bundle entry: imports the theme, defines `Root` (the wrapper the stack needs: the theme provider, or nothing for compiled CSS), re-exports the app's components and the pattern copies, and assigns `window.<namespace>`.                                                                                                                                                        |
| `catalog.ts`                                 | One entry per component and pattern: `summary`, `props` and an `example` that draws it. The build writes each component's README and preview from it.                                                                                                                                                                                                                                |
| `patterns/<Name>.tsx`                        | A hand-made copy of one or more app pieces that can't run in a canvas, recreated from the source's styles with the exact values. Its header comment says in words what it copies.                                                                                                                                                                                                    |
| `sources.json`                               | The source map: `system` holds `<dir>/` itself (and any build script the project's `design.system.build` runs); `tokens` every theme file the look comes from; `components` every re-exported component (`{ "<Name>": "<file>" }`); `patterns` each pattern's app files (`{ "<file>": ["<app file>", …] }`). Paths relative to the project root; an entry ending in `/` is a folder. |
| `sampleData.ts`                              | One sample data set, shaped like what the photographed screens show: made-up names, places and amounts, plain data only (no functions, no `Date`, no dates to compute). Every reference screen and every design draws from it.                                                                                                                                                       |
| `screens/index.ts`, `screens/<Name>.dc.html` | One reference screen per photographed screen (Step 4 picks them): the app's real page redrawn from the design system and the sample data. Its `screens/index.ts` entry names its `file`, `title`, `route`, `summary`, `situations`, `path` and `scenario` (the screenshot scenario that photographs it).                                                                             |
| `sources.test.ts`                            | The map test, in the project's own unit test runner: every file in `patterns/` has a map entry; every entry copies at least one file; every path in the map exists; every `components` name is exported from `index.tsx`. Each failure names the entry.                                                                                                                              |

Each reference screen is one window of exactly 1440×900 (390×844 when its photo is taller than it is wide), with one `[data-screen]`, a `[data-state]` for each situation and a `[data-target]` on each control its path clicks. It draws using only `window.<namespace>` components, the tokens and `window.<namespace>Sample`: no hand-written look-alikes. The page scrolls inside the app's frame, never the window. A screen is written once and fixed between rounds.

A design system with no bundle (look only, or photos only) writes no screens and no sample data, and says so in its README.

There is no committed `tokens.json`: every build derives it from the theme files `sources.json` names under `tokens`. Don't write the manifest by hand either: Step 7 writes it.

**The namespace** `<namespace>` is the project's name in PascalCase with everything but letters and digits removed, prefixed `App` when that doesn't start with a letter: "Pawnee parks map" → `PawneeParksMap`, "3d viewer" → `App3dViewer`. When the project already has a manifest, its `namespace` is the one to use. While there is no manifest yet, `build --check` builds with that same namespace, and Step 7's `manifest write` keeps it, so `index.tsx` assigns `window.<namespace>` and Step 5 installs with `--namespace <namespace>` from the first round.

## Step 3: Build and check it

```bash
lambda design system build --check
```

It builds what is on disk (your uncommitted source) and checks it: the bundle rules, that no component loads the app's runtime ("<Name> loads <package>."), that every component draws ("<Name> failed to draw: …", "<Name> reached <host>."), the reference screens, the sample data and the map test. It changes nothing in the source. **Fix what it names in the design system, never in the app**: a component that loads runtime or reaches a host becomes a pattern copy (`patterns/<Name>.tsx`, its export, catalog entry and map entry) or is left out (taken out of `index.tsx` and `catalog.ts`). Run it again until it passes. Its last line is the built folder.

## Step 4: Photograph the app

Pick **3 to 5** screenshot scenarios (`lambda shot search <words>` finds them by id, title, description and tags): first the ones tagged `design-system`, then ones of **different screens** (a different first word of the id). Photograph each:

```bash
lambda shot <id> --out $LAMBDA_PODS_ROOT/$POD_ID/design-system/photos/<id>.png
```

A shot that fails is skipped; name it in the ticket comment at the end. The photographed screens are the reference screens Step 2 writes.

**Not checked against the app.** When there is no photo hook, there are no scenarios, or every shot fails, go on from the code only: there are no rounds. Skip Steps 5 and 6, and in Step 7 the manifest records `check: { result: "not-checked", reason }` with exactly one of these reasons:

- "this project has no photo hook (commands.shot in lambda.json)"
- "there are no screenshot scenarios to photograph yet"
- "the photo hook failed for every screen (<its last output line>)"

## Step 5: One round

Round `<n>` starts at 1.

1. **Install** the built folder from Step 3 on the check canvas:

   ```bash
   lambda design system install <built folder> <K> --namespace <namespace>
   ```

2. **Draw** each photo's reference screen, its first situation, to the round's folder:

   ```bash
   lambda design render <K> <the reference screen's file> --out $LAMBDA_PODS_ROOT/$POD_ID/design-system/round-<n>/<scenario id>.png
   ```

   With no bundle there are no reference screens: the drawn picture is a throwaway artboard `<K>/project/<scenario id>.dc.html`, sized to the photo's width and height, using only the tokens and plain elements, rendered the same way.

   A photo of another size than its drawn picture is still graded on look, not on size.

3. **Grade** each photo and drawn pair with a **fresh judge subagent**, one per pair. The judge gets **only** the photo, the drawn picture and the severity scale `{severityFile}`, plus this one line:

   > The photo is the real app. Grade how far the drawn picture's look (colours, fonts, spacing, corners, shadows, the shapes of controls) is from it. Different data or wording is not an issue; a missing or wrong control is.

   It returns `{ "issues": [{ "severity", "where", "what" }] }`, each severity exactly `high`, `medium`, `medium-low` or `low`. When its answer isn't that, ask the same judge once more; a second bad answer is an error (below).

4. **Record** the round. Write the round file, `{ "pictures": [{ "scenarioId", "photo", "drawn", "issues" }] }` (one entry per pair, the same scenario ids every round, `photo` and `drawn` the paths above), anywhere under `$LAMBDA_PODS_ROOT/$POD_ID/design-system/`, and run:

   ```bash
   lambda design system round record --round <that file>
   ```

   After its result line it prints one `Composite: <path>` line per screen: that screen's photo | drawn pair side by side in one picture (labelled Photo and Drawn), at `$LAMBDA_PODS_ROOT/$POD_ID/design-system/round-<n>/composite-<scenario id>.png`. These are the pictures you post on the ticket (Steps 7 and 8).

## Step 6: The loop

`round record` prints exactly one line. Act on it:

- **`SYSTEM: CONTINUE (round n) — fix: <id>, <id>`** → fix the named screens' differences **in the design system's files only** (the theme mapping, `Root`, a pattern copy, a reference screen, the sample data), rebuild with `lambda design system build --check` (Step 3), and do round n + 1 (Step 5).
- **`SYSTEM: MATCH`** or **`SYSTEM: CLOSE`** → Step 7.
- **`SYSTEM: BLOCKED`** (a high issue left at round 7) → Step 8.
- **`SYSTEM: ERROR — <reason>`** (a judge's answer failed twice, a render failed, or the round's composites couldn't be drawn) → nothing was recorded. Fix the named cause and repeat the **same** round. A second `SYSTEM: ERROR` in a row → Step 8.
- **`Refused: <reason>`** (round 8, a missing picture or one outside `$LAMBDA_PODS_ROOT/$POD_ID/design-system/`, a different set of scenario ids from round 1's, a file that isn't a round) → nothing was recorded. It is a mistake in the round file, not an error: fix the round file as named and run `round record` again. It never counts toward the two `SYSTEM: ERROR`s in a row.

## Step 7: Write the result and ship

On `SYSTEM: MATCH` or `SYSTEM: CLOSE`, write the manifest from the rounds:

```bash
lambda design system manifest write --ticket $ARGUMENTS --rounds $LAMBDA_PODS_ROOT/$POD_ID/design-system/rounds.json
```

Not checked (Step 4): no `--rounds`; give the reason instead, exactly one of Step 4's three, word for word:

```bash
lambda design system manifest write --ticket $ARGUMENTS --not-checked "<reason>"
```

- "this project has no photo hook (commands.shot in lambda.json)"
- "there are no screenshot scenarios to photograph yet"
- "the photo hook failed for every screen (<its last output line>)"

When you left any piece out (Step 3: a component that loads the app's runtime or reaches a host, taken out of `index.tsx` and `catalog.ts`), write the list as JSON, `[{ "name": "<piece>", "why": "<why>" }]`, to `$LAMBDA_PODS_ROOT/$POD_ID/design-system/left-out.json` (in the pod's folder, never in the checkout: a file there counts as a change outside the design system), and add `--left-out` to the same command:

```bash
lambda design system manifest write --ticket $ARGUMENTS --rounds $LAMBDA_PODS_ROOT/$POD_ID/design-system/rounds.json --left-out $LAMBDA_PODS_ROOT/$POD_ID/design-system/left-out.json
lambda design system manifest write --ticket $ARGUMENTS --not-checked "<reason>" --left-out $LAMBDA_PODS_ROOT/$POD_ID/design-system/left-out.json
```

`--base <commit>` names the commit the setup started from, when it isn't where this branch forks from the default branch (the default). It writes the manifest: the namespace, version 1, the commit it was made from, this ticket, the check's result, and the components, patterns, reference screens and what was left out. It refuses when this ticket changed any file outside the design system's folder and its manifest: take those changes back out of the app and run it again.

Then post the last round's pictures on the ticket: **one composite per screen**, the `Composite:` lines the last `round record` printed. Never post a screen's photo and drawn picture as two separate images: the composite already holds both, side by side.

```bash
lambda tickets comment $ARGUMENTS "Design system checked against <n> photos: <MATCH or CLOSE>, round <n>. Photo | drawn for each screen." --image $LAMBDA_PODS_ROOT/$POD_ID/design-system/round-<n>/composite-<scenario id>.png --image $LAMBDA_PODS_ROOT/$POD_ID/design-system/round-<n>/composite-<another scenario id>.png …
```

(one `--image` per screen, all on this one comment; for a design system that wasn't checked, say why instead, with no pictures). Then report back to the Engineering manager that the build is done, and the ticket ships through the project's normal steps like any other: the check-ticket verdict and the rest of the building steps apply as usual.

## Step 8: Blocked

Three things end here: `SYSTEM: BLOCKED`, a second `SYSTEM: ERROR` in a row, and nothing to build from (Step 1). In each, **commit nothing** and write no manifest, then report to the Engineering manager that the ticket is blocked, with exactly one of these lines:

- On `SYSTEM: BLOCKED`: post the high issues on the ticket with each of their screens' composite from the last round (one picture per screen, never its photo and drawn picture separately): `lambda tickets comment $ARGUMENTS "…" --image $LAMBDA_PODS_ROOT/$POD_ID/design-system/round-<n>/composite-<scenario id>.png …`, and report:

  > After 7 rounds the design system still didn't match the app: <first high issue>.

- On a second `SYSTEM: ERROR` in a row: post the error on the ticket and report it, the `<reason>` of the second `SYSTEM: ERROR` line, as the reason.
- On nothing to build from (Step 1): there are no rounds and no pictures; post and report:

  > Lambda can't make a design system for <project>: it found no theme or components in the code, and it has no photos of the app (<the photo reason>).

A `Refused:` line from `round record` never brings you here: fix the round file and record it again (Step 6).

The Engineering manager blocks the ticket through the usual blocked path. The project stays with no design system, and designs keep using Claude Design's default look.

---

## Report format

```
DESIGN SYSTEM: MADE | NOT CHECKED | BLOCKED

- Stack: <stack> · look from <theme files>
- Components: <n> re-exported · patterns: <names> · left out: <name — why> | none
- Reference screens: <titles> | none — <why>
- Photos: <n> (<scenario ids>) | none — <reason>
- Rounds: <n>, last <MATCH | CLOSE | BLOCKED> | none
- Manifest: written | not written
```
