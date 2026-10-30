---
description: Fresh-context consistency loop across an epic and all its children (plus a pod's intent and decision logs). Fixes engineering drift; raises judgement calls. Repeats until a pass changes nothing (max 3).
argument-hint: <epic id>
---

# /reconcile-tickets $ARGUMENTS

Later decisions make earlier tickets wrong. This loop finds and fixes that drift across the whole epic.

## Each pass

1. `lambda tickets pull` the epic and every child.
2. **Spawn a fresh-context subagent** (Agent tool, general-purpose). You are too close to these tickets to see their contradictions. Give it the paths of:

   - `.lambda/pulled/<epic>/description.md` and every child's (on a markdown project, the ticket files themselves)
   - in a pod: the pod folder's `intent.md`, `human-decisions.jsonl`, `autonomous-decisions.jsonl`

   Ask it for a list of findings, each with the ticket(s), the exact conflicting text, and the fix. It checks:

   - a ticket contradicts a recorded decision ({owner}'s words in `human-decisions.jsonl` win)
   - tickets contradict each other: names, field and data shapes, UX between screens, shared test ids and selectors, shared test fixtures
   - every acceptance criterion and every E2E test is owned by **exactly one** child
   - dependency order: no child depends on a later-numbered one; each child's `## Dependencies` lines match reality
   - epic scope not covered by any child; a child doing work the epic does not ask for
   - **overlap check** — a "blocked by" link is what keeps two tickets from being built at once. Two children need a link (the later-numbered one blocked by the earlier) when one **needs the other's code**, or they share a **migration** (or both add one) or a **schema** file, or change the same **permissions** or the same user-facing **wording** — places where a clean text merge can still be silently wrong — or they share **3 or more source files** (not counting tests, E2E specs, docs and append-only registries). Lighter overlap needs no link: it is resolved when the work is merged. Report each missing link with the reason.
   - **existing links** — run `lambda tickets get` on every child and read its blockers (`lambda tickets list --json` shows `blockedBy`). Flag a link whose blocker was merged away, canceled or deleted, or is no longer needed (the overlap that justified it is gone), with why it is stale.

3. Apply the findings:
   - **Engineering** (a rename, a shape, a selector, an ownership move): fix the tickets directly and push. In a pod, log each with `lambda pod decide --autonomous "<fix>" --why "<conflict>" --intent-ref …`.
   - **Links are proposed, never written here** — adding or removing one needs {owner}'s yes:
     - in a pod, write each change as one line of `links.md` in the pod folder: `B blocked by A — <reason>` to add, `remove: B blocked by A — <why stale>` to lift. Update the child's `## Dependencies` section to match and push. CP5 lists every line, and Finish writes them once {owner} has closed it (`lambda tickets block … --checkpoint <CP5's qid>`);
     - outside a pod, list them in the report under "Needs your call".
   - **Judgement** (what users see, a scope trade-off, two decisions that genuinely conflict): in a pod, a question (draft → cold read → commit); outside a pod, a "Needs your call" item.
4. If the pass changed **nothing**, stop: the epic is consistent. (A pass that only re-found links already in `links.md` changed nothing.)

## The cap

Run at most **3 passes**. If pass 3 still changes something, stop and raise **one** question to {owner} listing what keeps changing and why — oscillation means two requirements fight, which is their call.

## Report

```
Passes: N · Fixed: K · Questions: Q · Links proposed: L
- <one line per fix>
```
