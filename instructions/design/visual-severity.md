# How bad is a visual issue?

Planning's design loop (`design-screen`) and the build's visual check grade every
issue they find with one of four levels. A judge picks the level from what is wrong,
not from how long it would take to fix. The code that applies these rules is
Lambda's `src/design/loop.ts` (`DesignSeverity`, `shouldStopDesignLoop`).

This page is Lambda's own: a project can't override it.

Write the level exactly as below, in lower case: `high`, `medium`, `medium-low`,
`low`. Anything else (`High`, `Med`, `critical`) is refused.

## The four levels

| Level        | What is wrong                         | Example (Pawnee Parks and Recreation)                                                                                                                     |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `high`       | Wrong or missing content or behaviour | The trail map's "trail closed" state has no way to see a detour, or it shows the Lot 48 trail's markers instead of Ramsett Park's.                        |
| `medium`     | Wrong layout or hierarchy             | The "Show detour" button sits above the notice saying why the trail is closed, so a hiker sees the action before they know why they need it.              |
| `medium-low` | Spacing, size or colour off           | The volunteer roster has 8px between a volunteer's name and their shift where the rest of the list has 16px, or the Add stall button is the wrong colour. |
| `low`        | Cosmetic                              | The divider under the inspection checklist is 2px instead of 1px, or a corner radius is 10px instead of 12px.                                             |

When an issue fits two levels, use the worse one.

## When to stop

The rule applies to **one thing at a time**:

- in **planning**, a screen's **prototype as one thing**: its whole walk-through (every
  step of its path and every situation) is graded together, one round at a time;
- in the **build**, a ticket's **pictures as one set**: all of them are graded together,
  one round at a time.

After each round, look at the **worst** issue that round found (not how many there are),
and check these in order. The first that matches decides:

1. **No issue worse than `low`** (no issues at all counts) → **stop**, at any round.
2. **Round 4 or later, and the worst issue is `medium-low`** → **stop**.
3. **Round 7** → **stop**, whatever is left.

Otherwise, fix the issues and go again. There is never a round 8.

| Round | No issues / `low` only | Worst `medium-low`          | Worst `medium`   | Worst `high`     |
| ----- | ---------------------- | --------------------------- | ---------------- | ---------------- |
| 1–3   | stop (`only-low`)      | continue                    | continue         | continue         |
| 4–6   | stop (`only-low`)      | stop (`round-4-medium-low`) | continue         | continue         |
| 7     | stop (`only-low`)      | stop (`round-4-medium-low`) | stop (`round-7`) | stop (`round-7`) |

A stop at round 7 with `medium` or `high` issues left is still a stop. The issues
still open stay in that round's record (`rounds.jsonl` in planning, written by
`lambda design round`).
