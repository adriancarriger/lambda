---
description: Write a UX section (ASCII + short "what changes" notes) at the top of a ticket, or of every child of an epic.
argument-hint: <ticket id | epic id>
---

# /ux-sketch $ARGUMENTS

{owner} reviews plans fastest through their UX: a short, visual summary of every screen that changes makes it obvious where the plan filled a gap with something they would not have chosen. This command writes that summary.

## Step 1: Targets

`lambda tickets pull $ARGUMENTS`. If the ticket has children (it is an epic), the targets are **every child**; otherwise the ticket itself.

## Step 2: Ground the "before"

For each target, find every screen, dialog, message or email it changes. Read the **current** UI code for each, and the project's docs where they describe it, so the "before" matches what exists today — not what the ticket assumes.

## Step 3: Write `## UX` at the top of each ticket

Insert it directly under the title, before everything else. For each surface:

````markdown
## UX

### <Surface name> — <changed | new | removed>

```
┌ Ron Swanson · Shifts ──────────────────┐
│ Harvest Festival   Oct 3      2 shifts │
│ Lot 48 cleanup     Oct 5       1 shift │ ← new
│ Total                         3 shifts │ ← changed (was 2)
└────────────────────────────────────────┘
```

- The cleanup shows up as its own line instead of being hidden.
- The total includes it.
````

Rules:

- Mark every changed element: `← new`, `← changed (was …)`, `← removed`. Show a before/after pair when an existing screen changes a lot.
- 1–3 short notes per surface: **what** changes and **why**. No implementation detail.
- Use realistic fictional data, never real people's names or data.
- Mobile is 375px wide: keep boxes ≤ 44 characters wide when the surface is mobile-first.
- A ticket with no user-facing change gets exactly `## UX — no user-facing change` plus one line saying why. Never leave it out.
- This command writes ASCII only.

## Step 4: Push and log

Send each ticket back (`lambda tickets push <id>`).

**In a planning pod** this command raises **no questions** — the UX is what {owner} reviews at the UX review. Every assumption you had to make to draw a screen (a label, an empty state, an order) is logged so it shows up on the checkpoint:

```bash
lambda pod decide --autonomous "<assumption>" --why "<why>" --intent-ref "…"
```

Outside a pod, list those assumptions at the end of your report.
