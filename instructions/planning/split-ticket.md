---
name: split-ticket
description: Split a large ticket into smaller, vertically-sliced child tickets. Each child is E2E testable and executable by an agent on its own.
---

# Split Ticket into Children

Breaks a large ticket down into vertically-sliced child tickets. Each child is testable from the user's perspective (E2E) and carries enough context for an agent to build it on its own.

## Usage

```
/split-ticket PAWNEE-12
```

**Argument:** `$ARGUMENTS` — the ticket id. If it is empty, use the ticket the conversation is about; if there is none, report: "No ticket specified. Usage: /split-ticket <id>".

## Core Principles

1. **Vertical slicing** — no frontend-only or backend-only tickets. Each ticket delivers user-visible value.
2. **Dependency tree** — tickets are built one at a time, in number order, but each depends only on the earlier tickets it actually needs — and says why. The tickets form a tree, not a line: a ticket that needs nothing from #2 does not wait on #2.
3. **The parent's E2E tests are final** — the parent ticket's E2E tests are the source of truth. Each child implements the subset of those exact tests that match its scope. When all children are complete, the codebase must contain exactly the parent's E2E tests — no more, no less. Include an "E2E Test File Ownership" table in the proposal showing which test lands in which ticket.
4. **E2E coverage** — all work folds under an E2E test.
5. **Right-sized, not smallest** — each child should fit one focused dev session. Never split work that already fits one session, and never produce children that only make sense together. More tickets means more reviews and more cross-ticket consistency to keep — split only when a piece genuinely cannot be done in one session. **No ticket only changes tests** (a flaky or wrong test, added coverage, a retired spec): fold that work into the ticket whose code it tests.
6. **Agent-executable** — each child has complete context for autonomous execution.
7. **TDD for unit tests** — comprehensive unit tests, written before the implementation.
8. **Happy-path E2E** at minimum; more coverage for core product areas.

## Instructions

### Step 1: Fetch the ticket

```bash
lambda tickets pull <TICKET>
```

Read its description (`.lambda/pulled/<TICKET>/description.md`, or the ticket file on a markdown project) and any images beside it.

### Step 2: Analyse and propose the breakdown

**Understand the ticket:** what user-facing features it describes, what acceptance criteria it has, and where the natural vertical slices are.

**Apply the slicing rules:**

| Good split                | Bad split              |
| ------------------------- | ---------------------- |
| Feature A end-to-end      | Frontend for Feature A |
| Feature B end-to-end      | Backend for Feature A  |
| Independent enhancement C | "All endpoints"        |
| Edge-case handling for A  | "All UI components"    |

**Each child MUST:** deliver testable value from the user's perspective, include both frontend and backend work where needed, be independently shippable, and have a clear E2E scenario.

**Propose the breakdown:** a numbered list, the dependency tree and an E2E ownership table. Usually a thin first ticket, then slices that each depend only on what they need. Every dependency points at a lower-numbered ticket and carries a reason:

```
## Proposed Breakdown for <TICKET>

Parent: <ticket title>

### Children:

1. **<Title>**
   - Scope: <1-2 sentences>
   - E2E Test: <which of the parent's E2E tests this ticket writes>
   - Dependencies: <"#N — <reason>" for each earlier ticket it needs, or "None">

2. **<Title>**
   - Scope: <description>
   - E2E Test: <which tests>
   - Dependencies: #1 — <why it needs #1's code>

### Dependency tree
#1
├── #2 (needs #1: <reason>)
└── #3 (needs #1: <reason>)

### E2E Test File Ownership

| E2E file | Tests | Written in |
|---|---|---|
| `existing-spec.spec.ts` | Tests X-Y | #1 |
| `new-feature.spec.ts` | setup + tests 1-3 | #2 |
| `new-feature.spec.ts` | Tests 4-6 | #3 |

Ready to create these children?
```

**STOP and wait for approval before creating anything.** (In a planning pod, the approval is {owner} closing the split-proposal checkpoint.)

### Step 3: Write each child in full

After approval, write each child with this template:

```markdown
## Summary

<1-2 sentences: what this ticket accomplishes>

## Acceptance Criteria

- [ ] <Specific, testable criterion>

## Test Plan

### Unit Tests (TDD)

Write these tests FIRST, then implement:

- [ ] Test: <description> -> Expected: <result>

### E2E Tests

Full test snippets, not prose:

- [ ] Happy path: <user flow> — snippet with real test ids, navigation and assertions
- [ ] <Additional scenarios for core areas>

**New selectors** (if any): | test id | Element | File |

(Tooling children with no user-facing change: unit tests and scripted checks instead.)

## Security

- <Data scoping, permissions, validation — or "N/A: <why>">

## Implementation Context

### Files to Modify

- `path/to/file.ts` - <what changes>

### Patterns to Follow

- See `path/to/similar/implementation.ts`

### Schema Changes (if any)

- <Data shape changes, or "None">

## Scope Boundaries

NOT included in this ticket:

- <Explicit exclusion>

## Dependencies

- Blocked by: <id — reason, one line per earlier ticket it needs, or "None">
- Blocks: <id or "None">
```

### Step 4: Create the children

For each approved child, in build order:

1. `lambda tickets create --title "<N> - <title>" --parent <PARENT> --status planning --description-stdin < child.md` — titles are **numbered in build order** (`1 - …`, `2 - …`), so every dependency has a lower number than the ticket that needs it. Capture the new id it prints.
2. Once all children exist, set their order to match the numbering: `lambda tickets reorder <PARENT> --order <ID_1> <ID_2> <ID_3>`.

Dependency links between children are **not** written here: inside a planning pod they need {owner}'s yes and are written at Finish.

### Step 5: Report

```
## Children Created

Parent: <PARENT> - <parent title>

Created:
- <ID_1>: <title>
- <ID_2>: <title>

Dependency tree:
<ID_1>
├── <ID_2> (needs <ID_1>: <reason>)
└── <ID_3> (needs <ID_1>: <reason>)
```

## Example

```
## Proposed Breakdown for PAWNEE-500

Parent: Park usage counts with export

### Children:

1. **Visit counts + dashboard**
   - Scope: Count visits per park, and a new dashboard page showing them with a date range picker.
   - E2E Test: `park-usage.spec.ts` tests 1-3 (Leslie views the dashboard, counts update, the date range filter works)
   - Dependencies: None

2. **CSV export**
   - Scope: An Export button on the dashboard downloads the counts as CSV.
   - E2E Test: `park-usage.spec.ts` test 4
   - Dependencies: #1 — the export reads the dashboard's counts

3. **PDF report**
   - Scope: A formatted PDF report of the counts.
   - E2E Test: `park-usage.spec.ts` test 5
   - Dependencies: #1 — the report renders the dashboard's counts; it needs nothing from the CSV export
```

## Anti-patterns to Avoid

**DON'T create horizontal slices:** "Add all database schemas", "Create all API endpoints", "Build all UI components".

**DO create vertical slices:** "A user can add a park", "A user can view counts for a date range", "A user can export counts to CSV".

**DON'T create tickets that aren't E2E testable:** "Refactor the counts service", "Add TypeScript types", "Improve error handling".

**DO ensure every ticket has a user-visible outcome:** "An error message shows when the export fails", "A loading state shows while the counts load".
