---
name: red-flags
description: Scan a ticket's plan for red flags. Fixes engineering problems in the ticket itself; brings only judgement calls to the owner.
---

# /red-flags - Is This Plan Right?

Scans a ticket's **plan** for problems that would bite during implementation or after shipping. You fix what you can in the ticket yourself, and bring {owner} **only** the judgement calls.

**How this differs from `/review-ticket`:** `/review-ticket` asks whether the ticket is **well written** (vague terms, missing sections, selectors that exist). This command asks whether the plan is **right**. A ticket can grade A on `/review-ticket` and still be built on a wrong premise. Do not re-grade form; leave that to `/review-ticket`.

**This command never touches code and never commits.** Its only output is edits to the ticket and a short report.

## Usage

```
/red-flags PAWNEE-12
```

**Argument:** `$ARGUMENTS`, the ticket id. If it is empty, ask for it.

---

## Step 1: Pull the Ticket

```bash
lambda tickets pull <TICKET>
```

Then read the description it wrote (`.lambda/pulled/<TICKET>/description.md`, or the ticket file itself on a markdown project) and any images beside it.

## Step 2: Has Work Started?

Work has started if **either** is true:

- the ticket's status is `building` or later, or
- a branch named for the ticket has commits ahead of the main branch.

This decides **how** you edit the ticket in Step 5:

- **Still planning:** edit the body directly.
- **Work started:** do not rewrite the body. Add or extend a `## Addendum` section at the end. `/check-ticket` treats the body as the contract and the Addendum as the record of decisions made after work began. Rewriting the body mid-implementation means the audit checks the code against a plan the developer never saw.

## Step 3: Hunt for Red Flags

Ground every check in the **actual code** and in the project's own docs. Use Explore agents for broad sweeps. Do not trust the ticket's description of the current code; verify it.

| Area               | What to look for                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Premise**        | Does the ticket describe the current code correctly? A wrong "today it does X" sends the whole plan in the wrong direction.                                                                             |
| **Approach**       | Will the planned approach work against the real code? Is there an existing helper or pattern it ignores or duplicates?                                                                                  |
| **Contradictions** | Does it conflict with existing behaviour, the project's docs, another open ticket, or a rule in the project's agent instructions?                                                                       |
| **Reaching users** | Will it actually reach users when shipped? A missing data migration for permissions or a schema change, a feature flag left off, a new query with no index, a frontend live while the backend is inert. |
| **Acceptance**     | Can each acceptance criterion actually be met? Do any two contradict each other?                                                                                                                        |
| **Test plan**      | Can each planned test **fail**? A test that passes with the fix reverted proves nothing. Does the test exercise the real producer, not a hand-built fixture?                                            |
| **Size**           | Is the ticket bigger than it reads (hidden migrations, many call sites, a second surface)?                                                                                                              |

### The evidence bar

A finding must have **both**:

1. **Proof:** a `file:line`, a doc, or a ticket id showing the problem is real.
2. **A concrete failure:** "a user does X, and Y happens" (or the engineering equivalent: "the migration never runs in production, so existing records keep the old shape").

If you cannot write both, **it is not a finding. Drop it.** Do not report suspicions, style preferences, or "might be worth considering". **Finding nothing is a valid, successful result.** Never invent findings to justify the run.

### The severity bar (stop rule)

A finding that clears the evidence bar is acted on **only if discovering it later would cost more than a build cycle**. That means it is one of:

- **A security or privacy hole:** someone gains access, authority or data they shouldn't have.
- **Product behaviour:** what a user sees or experiences would be wrong, or would contradict a decision {owner} made.
- **A wrong premise or an unbuildable plan:** the ticket's approach can't work against the real code, contradicts another ticket badly enough to block, or will not reach users.

**Everything else is below the bar. Drop it, and don't edit the ticket for it.** That covers stale line numbers, test order or fixture placement, duplicate imports, test-id naming, wording, citation drift, and a test that needs adjusting to compile. The implementer meets these against real code within minutes, and `/check-ticket` and `/code-review` catch them cheaply. Each edit for a below-bar item also risks a new inconsistency, which is why repeated passes never converge.

**Repeat passes:** when a ticket has already had a `/red-flags` pass, expect few or no findings above the bar. A pass with only below-bar findings reports `No red flags.`

## Step 4: Sort Each Finding

**Fix it yourself (default).** Engineering calls are yours: the approach, a missing migration, a test that cannot fail, wrong file paths, a premise the code settles, a contradiction with one clearly correct side. Pick the best option and fix the ticket. Being risky, big, or uncertain does **not** make something a judgement call; decide it.

**Bring it to {owner} ONLY if it is one of:**

- **A product or business decision:** what users see or experience, pricing, scope trade-offs between features.
- **An authorization only {owner} can give:** direct production changes, money movement, outward-facing actions.
- **A genuine fork with no deciding evidence:** two defensible options with materially different outcomes, where neither the code, the docs nor the ticket settles it.

Escalating something you could have decided is a failure of this command, not caution.

## Step 5: Fix the Ticket

Apply your fixes to the pulled description (body or `## Addendum` per Step 2), then send them back:

```bash
lambda tickets push <TICKET>
```

Keep edits surgical: change what the finding requires, not the surrounding prose.

## In a planning pod (`$POD_ID` is set)

Instead of a chat report:

- **Each "Needs your call" item becomes a queued question**: `lambda pod question add --ticket <TICKET> --from-work "checking <what the ticket is about> for red flags"`, fill every section, cold read, commit (see the planning dev instructions). Map the report fields: _What's wrong_ → context + problem, _Options_ → options, _Rec_ → recommendation, _Why you_ → the end of problem. If two items hinge on each other, queue only the hinge now.
- **Each "Changed in the ticket" fix is logged** with `lambda pod decide --autonomous "<fix>" --why "<the finding>" --intent-ref …`, so it appears in the checkpoint's list.
- End with a one-line summary for the Planning manager (`N fixed, M questions queued`). No chat list of decisions.

## Step 6: Report

Brief and plain. Assume {owner} is reading this cold: give enough context to decide, no more.

```markdown
# Red Flags: <TICKET>

## Needs your call

### ⚑ <plain-English title>

**What's wrong:** 1–2 sentences, with file:line.
**Options:** A) … B) …
**Rec:** A, because …
**Why you:** <one sentence: why this could not be settled without you>

## Changed in the ticket

- <one line per edit: what changed and why>

## Checked

<one line: what was examined>
```

- Omit an empty section. With nothing found and nothing changed, the whole report is `No red flags.` plus the **Checked** line.
- Below-bar findings are not listed. At most, add one line after **Checked** with a count: `Below the bar (left for the build): N`.
- **Needs your call** comes first, because it is the only part that blocks anything.
- Every escalation **must** have its **Why you** line. If you cannot write it, decide the item yourself and move it to **Changed in the ticket**.
