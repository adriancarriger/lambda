---
name: review-ticket
description: Grade a ticket for agent-developer readiness (A–F across six dimensions), with actionable fixes. `--fix` applies them.
---

# Review Ticket for Agent-Developer Readiness

Evaluates a ticket for readiness to be built by an agent. Outputs letter grades (A–F) across 6 dimensions with actionable improvement suggestions.

**Philosophy:** vague specs are the most common cause of agent failures. An agent will not ask; it will guess. This rubric enforces the specificity an agent needs to succeed.

## Usage

```
/review-ticket PAWNEE-123
/review-ticket PAWNEE-123 --fix
```

**Argument:** `$ARGUMENTS` — the ticket id, optionally followed by `--fix`. Wherever this file says `$ARGUMENTS` in a command, use just the ticket id.

### Fix mode (`--fix`)

Without `--fix` this command only reports. With `--fix` it **applies its own suggestions** to the ticket and pushes, the way `/red-flags` does:

- Before work has started (status before `building`, and no commits on the ticket's branch), edit the body directly. After that, add to a `## Addendum` section instead — `/check-ticket` treats the body as the contract.
- Fix everything you can settle from the code, the project's docs and the ticket itself: missing selectors, vague assertions, missing file paths, missing scope boundaries, missing security notes.
- **Never split in fix mode.** Do not propose, create or recommend splitting the ticket. Scope findings become edits (trim an "and also", move an unrelated item to Out of scope).
- A suggestion that needs {owner}'s judgement (what users see, pricing, scope trade-offs) is not edited in. In a planning pod (`$POD_ID` is set) it becomes a question (`lambda pod question add --from-work "reviewing <what the ticket is about>"` → cold read → commit; see the planning dev instructions). Outside a pod, list it under **Needs your call** in the report.
- Re-grade after the edits. The report then shows the grades **after** fixing, plus a short **Changed in the ticket** list.
- Send it back with `lambda tickets push <TICKET>`.

## Instructions

### Step 1: Fetch the ticket

```bash
lambda tickets pull $ARGUMENTS
```

### Step 2: Read the ticket

Read the description it wrote (`.lambda/pulled/$ARGUMENTS/description.md`, or the ticket file on a markdown project) and any images beside it.

### Step 3: Verify the E2E test specs against the codebase

**This step is critical and must not be skipped.** Before grading, verify that any E2E test snippets in the ticket are actually compatible with the codebase:

1. **Referenced test ids exist** — search the UI code for each test id the snippet uses. If one doesn't exist, check the ticket lists it in a "New Selectors" table.
2. **Helpers exist and are used the same way** — check every imported test helper exists, and grep for existing usage to confirm the calling pattern matches.
3. **Navigation routes are real** — the URLs the test visits route to real pages.
4. **Text and role selectors match** — if the snippet selects by visible text, that text actually appears in the component.
5. **Test data is consistent** — users, fixtures and any shared test registries the project uses (reserved names, time slots, seed ids) match what exists, and the ticket names any new entry it needs.

Use Explore agents or grep. Record any discrepancies — they become issues in the Test Plan grade.

### Step 4: Analyse each dimension

Evaluate the ticket against each rubric below. Be strict — a B should feel earned, not given.

---

## Dimension 1 — Clarity & Specificity

| Grade | Criteria                                                                   |
| ----- | -------------------------------------------------------------------------- |
| A     | Zero vague terms; every requirement has a specific, measurable description |
| B     | 1 minor ambiguity that can be reasonably inferred from context             |
| C     | 2–3 vague terms but core functionality is determinable                     |
| D     | Multiple ambiguities; an agent would need to make assumptions              |
| F     | Dominated by vague terms; an agent would be guessing at requirements       |

**Capped at D:** "improve" / "enhance" / "better" without a before/after; "clean up" / "refactor" without scope and success criteria; "optimize" / "faster" without targets; "handle errors" without listing the errors; "similar to X" without the differences; "should work" without defining "work"; "user-friendly" / "intuitive" without specific behaviours.

**Capped at C:** undefined acronyms or domain terms; pronouns without clear antecedents ("it should update" — what is "it"?).

---

## Dimension 2 — Completeness

| Grade | Criteria                                                                |
| ----- | ----------------------------------------------------------------------- |
| A     | All 6 checklist items present; nothing left for the agent to assume     |
| B     | 5 of 6 present; one minor gap that's inferable                          |
| C     | 4 of 6 present; some requirements need discovery                        |
| D     | 2–3 present; significant exploration required before coding             |
| F     | Missing most; the agent would be designing the feature, not building it |

**Checklist:**

- [ ] **Acceptance criteria** — explicit pass/fail conditions
- [ ] **Edge cases** — empty states, limits, concurrent access, null values
- [ ] **Error scenarios** — what can fail, and for each: throw, show the user a message, or handle silently
- [ ] **Scope boundaries** — what is explicitly NOT included
- [ ] **Affected user roles** — who can and cannot do this
- [ ] **Data requirements** — what data exists, what is created, any schema change

---

## Dimension 3 — Test Plan Quality

This dimension is critical: an agent cannot verify its own work without explicit test criteria. Tests drive the implementation.

| Grade | Criteria                                                                         |
| ----- | -------------------------------------------------------------------------------- |
| A     | Complete plan for unit tests (where there is logic) AND E2E; specific assertions |
| B     | Plan present with minor gaps; assertions specific and verifiable                 |
| C     | Has scenarios but missing key assertions or a test type                          |
| D     | Mentions "should be tested" without specific scenarios                           |
| F     | No test plan; no way to verify completion                                        |

### Unit tests (wherever there is logic)

Required categories: **happy path**; **negative cases** (invalid input, unauthorized access, constraint violations); **edge cases** (boundaries, unusual states); **error handling** (specific error types and messages); **permission checks**.

### E2E tests (always required for user-facing change)

- Always test the happy path from a user's perspective, focused on what a real user does.
- Extending an existing spec is often enough; major new functionality gets its own spec.
- Don't duplicate unit-test edge cases in E2E. Do test that errors display correctly to users (not every error type).

**Every E2E test MUST include a code snippet** showing the exact test: real or planned test ids (new ones listed in a "New Selectors" table with component file and purpose), the full flow (navigation, actions, waits, assertions), real helpers, proper waits (never arbitrary sleeps), and isolation (setup and cleanup when tests share state). A prose description like "verify the dialog appears" is useless: the developer needs to know which element, how to get there, and what the assertion looks like.

**Assertion quality:** each test has a specific, objectively verifiable assertion; unit tests name the data and expected values.

**Tooling exemption.** A ticket with **no user-facing app change** (the project's CLI, scripts, agent instructions, local dev tools) has no browser E2E to write. Grade its plan on **unit tests plus scripted checks** (exact commands and the observable result each must produce).

**Capped at D:** "verify it works correctly"; "test that errors are handled"; "check the UI updates"; logic changes with no unit-test plan; no E2E expectation; E2E in prose only.

**Capped at C:** a snippet uses test ids that don't exist and aren't listed as new; uses helpers or patterns that don't exist; is incomplete (assertions without setup or navigation); ignores a shared test registry the project uses.

---

## Dimension 4 — Context Sufficiency

| Grade | Criteria                                                             |
| ----- | -------------------------------------------------------------------- |
| A     | All 6 checklist items present; the agent can start without exploring |
| B     | 5 of 6; minor context inferable from codebase patterns               |
| C     | 3–4; some exploration needed                                         |
| D     | 1–2; extensive exploration required                                  |
| F     | No technical context                                                 |

**Checklist:**

- [ ] **File paths** — exact files to create or modify
- [ ] **Code patterns** — links to existing similar implementations to follow
- [ ] **Schema / types** — data names, field types, validation schemas
- [ ] **APIs** — which functions or endpoints are involved
- [ ] **Dependencies** — related tickets, prerequisites, blockers
- [ ] **Architecture decisions** — why this approach over the alternatives (stops the agent "improving" it)

---

## Dimension 5 — Scope & Vertical Slicing

**Full-stack vertical slices only.** Every ticket delivers a complete user-facing change: data → backend → frontend → tests. Never split work by layer.

| Grade | Criteria                                                                       |
| ----- | ------------------------------------------------------------------------------ |
| A     | Fits one focused dev session; full-stack; clear "done"                         |
| B     | Fits one session with several related changes; all full-stack                  |
| C     | Reasonable but missing a layer (e.g. no E2E plan) or slightly too broad        |
| D     | Too broad; mixes unrelated concerns; unclear where to start                    |
| F     | Epic-sized; multiple features bundled; or split by layer instead of by feature |

**Grade size by "does it fit one dev session", not by counting changes.** Splitting a ticket that fits one session costs more than it saves. Never recommend a split unless the ticket genuinely cannot be finished in one session — and never in `--fix` mode.

**Capped at D:** covers one layer only; "the frontend comes in a follow-up"; no E2E expectation; mixes unrelated features.

**Capped at C:** "while we're at it" additions **unrelated** to the goal; several **unrelated** acceptance criteria; refactoring of untouched code mixed with feature work.

---

## Dimension 6 — Security Considerations

An agent will not infer security requirements: if the spec doesn't mention permission checks, they won't be added.

| Grade | Criteria                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------- |
| A     | Explicit: permission model, data scoping and input-validation boundaries all defined           |
| B     | Addressed with 1 minor gap                                                                     |
| C     | Partially addressed; permission model implied but not explicit                                 |
| D     | Not addressed despite touching sensitive data or permissions                                   |
| F     | Introduces obvious risks with no mitigation                                                    |
| N/A   | No security implications (purely cosmetic: styling, copy, layout; no data access or endpoints) |

**Checklist:** permission model (who, which roles); data scoping (users reach only their own data); input validation (where the boundaries are, what is validated); sensitive data (personal or credential data and how it's protected).

**Capped at D:** a new endpoint with no permission checks mentioned; changed data access with no scoping; personal or credential data with no security notes.

**Capped at C:** "only authorized users" without saying who; validation mentioned without the rules.

---

### Step 5: Overall grade

**Weakest link:** overall = the minimum dimension grade (N/A excluded). Passing threshold: B. A ticket graded C or below should be improved before it is built.

### Step 6: Suggestions

For any dimension below A, write specific, actionable suggestions framed as questions the ticket MUST answer ("What error message shows when the email is already taken?", not "add more detail about errors"). Prioritise: test plan gaps, then clarity, context, completeness, and scope (only when it can't be finished in one session). Never suggest splitting by layer.

### Step 7: Report

```markdown
# Ticket Review: $ARGUMENTS

## UX Changes (What Users Will See)

<2–5 plain bullets: what users can now do, what looks different, what workflows change. No technical detail.>

---

## Overall Grade: <GRADE>

| Dimension                | Grade     | Summary    |
| ------------------------ | --------- | ---------- |
| Clarity & Specificity    | <A-F>     | <one line> |
| Completeness             | <A-F>     | <one line> |
| Test Plan Quality        | <A-F>     | <one line> |
| Context Sufficiency      | <A-F>     | <one line> |
| Scope & Vertical Slicing | <A-F>     | <one line> |
| Security Considerations  | <A-F/N/A> | <one line> |

**Verdict:** <READY TO BUILD / NEEDS REVISION>

---

## Detailed Analysis

<per dimension: the grade, the checklist status with [x]/[✗]/[n/a], and the issues found, quoting the ticket>

---

## Suggested Fixes

<only when overall < B>

### Critical (must fix before building)

1. …

### Recommended

1. …

### Consider splitting

<only if it cannot be finished in one dev session; never in --fix mode; otherwise omit>
```

**Key insight:** agents compound errors. A vague requirement plus a vague test plan gives code that appears to work but doesn't. Strictness at the spec level prevents costly rework.
