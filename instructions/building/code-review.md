---
name: code-review
description: Review this ticket's changes (committed and uncommitted) for issues, with a grade and a path to A.
---

# /code-review - Code Review

Review this ticket's changes for issues, prioritized by severity: everything this branch committed since it left the main branch, plus the working tree (staged, unstaged and untracked).

## Instructions

### Step 1: Gather the changes

```bash
BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)
git diff --name-status "$BASE"
git diff --cached --name-status
git status --porcelain
```

Then read each changed file's diff with `git diff "$BASE" -- <file>`.

**Review every changed file, untracked ones included** — `git diff` cannot see untracked files, and a ticket that adds new files is exactly the one most likely to hide something in them. If nothing changed, report "No changes to review."

### Step 2: Gather context

**Read the full content** of each modified file — reviewing just the diff misses important context.

### Step 3: Check the hard blockers

These MUST be fixed before shipping:

| Check                             | Rule                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| Lint suppressions                 | Must have a justification comment on the line above                    |
| `@ts-ignore` / `@ts-expect-error` | Must have a justification comment on the line above                    |
| Debug output                      | No `console.log` and friends in production code (test files exempt)    |
| `TODO` / `FIXME`                  | Must reference a ticket: `TODO(PAWNEE-123)`                            |
| Commented-out code                | 2+ consecutive commented lines = flag for deletion                     |
| Hard-coded secrets                | `password = "..."`, `apiKey: "sk_..."`, `token = "ghp_..."`            |
| `.only()` in tests                | Skips other tests — never allowed                                      |
| Test assertion tampering          | Changing expected values to make tests pass instead of fixing the code |
| E2E accommodations in app code    | App code changed solely to make E2E tests pass                         |
| E2E shortcuts                     | Test bodies that change data without driving the UI                    |
| Silent failures                   | Swallowing errors with conditionals instead of throwing                |

**Any hard blocker present = max grade D.**

#### Test assertion tampering

A common agent anti-pattern: instead of fixing broken code, change the test to match the (wrong) behaviour. **This hides regressions.**

Red flags: changed expected values; weakened assertions (`toEqual()` → `toBeDefined()`, assertions removed); deleted test cases; test names rewritten to match new (broken) behaviour.

For each modified test, compare the assertion changes with the production changes. Production code fixed a bug → the assertion change is likely legitimate. Production code unchanged but assertions changed, or expectations lowered → **red flag**. Ask: "What code change made this expected value change?"

**Auto-fail:** assertions changed with no production change explaining why; test cases removed without a clear reason (such as the feature being deleted).

#### E2E accommodations in app code

App code must NEVER change solely to make E2E tests pass. If an E2E test is flaky or failing, fix the test, not the app.

Red flags: comments like `// for e2e` or `// workaround for test`; skipping real behaviour (bypassing webhooks, short-circuiting async flows so tests needn't wait); `if (isTest)` branches; weakened logic (looser validation, removed race protections) "because tests run in parallel".

| Scenario                                                    | Verdict                               |
| ----------------------------------------------------------- | ------------------------------------- |
| E2E found a real bug → app fix with a regression test       | **Legitimate**                        |
| E2E is slow waiting for a webhook → skip the webhook in app | **Not OK** — poll or wait in the test |
| Parallel tests conflict → weaken a uniqueness rule in app   | **Not OK** — fix test isolation       |
| A test needs seeded state → auto-create it in app code      | **Not OK** — use test setup           |

Ask: "Would we make this change if E2E tests didn't exist?"

#### E2E shortcuts — bypassing the UI

E2E tests verify the app as a real user experiences it. Inside a `test()` body, the only backend interactions allowed are **reads** (for verification); every **write** must come from driving the UI. Setup and teardown hooks may write directly.

**Trace the full call chain.** A helper called in a test body may look harmless; read its source, and the source of everything it calls, until you reach UI actions, assertions, pure reads or side-effect-free leaves. A write three levels deep is as much a violation as one in the test body.

Red flags in a test body: calls to backend functions that create or change data; direct database writes; `page.evaluate()` that sets app state or storage; direct API calls (`fetch`, `page.request`); `page.route()` mocking of the real backend.

#### Silent failures

Code must **fail loudly** when something required is missing. Wrapping a critical operation in an `if` that silently skips it hides the failure from you — not from the user, who still ends up in a broken state.

| Pattern                                                  | Verdict                                        |
| -------------------------------------------------------- | ---------------------------------------------- |
| `if (!store) throw new Error('Storage not configured')`  | **Good** — fails loudly                        |
| `if (store) { save(...) }` (silently skips otherwise)    | **Not OK** — the save silently never happens   |
| `if (!user.preferences) return defaultPrefs`             | **OK** — absence is expected and harmless      |
| `catch (e) { logger.error('Save failed', e); throw e; }` | **Good**                                       |
| `catch (e) { return undefined; }`                        | **Not OK** — the caller never learns it failed |

Ask of every guard and catch: "If this triggers in production, would we want to know? Would the user be affected?" If yes, it must throw, or log at error level and rethrow.

### Step 4: Security audit

Every review includes one.

**Always:** no secrets or credentials exposed; no sensitive data logged (passwords, tokens, personal data); input validated at system boundaries; error messages don't leak internals.

**For auth and other sensitive code, also:** permission checks present and correct; audit logging for sensitive operations; rate limiting considered; session and token handling secure.

### Step 5: Test coverage

- New logic (functions, endpoints, hooks, pure utilities) MUST have unit tests.
- Complex component logic MUST have unit tests or be extracted into something testable.
- **Every bug fix MUST include a test that would have caught the bug.** If none: "Where is the failing test that reproduces this bug?"
- Flag tests that only assert `toBeDefined()` / `toBeTruthy()`, that lack error cases, or that assert nothing beyond "it doesn't throw".
- E2E files: no `test.skip()` without a ticket reference; no hard-coded shared test data where the project has a registry for it; no debugging artifacts left behind (screenshots, debug logs, arbitrary waits); every data change in a test body driven through the UI.

### Step 6: Architecture

Check the change against the project's own conventions (its agent instructions and the patterns around the changed code). In particular:

- Business logic in UI components (belongs in hooks or services)
- Missing permission checks on writes
- External API calls without error handling
- Breaking changes without a migration path
- Duplicating a helper that already exists
- Mocking the project's own database in tests that should hit a real or emulated one (only external services should be mocked)
- External data entering the system without validation
- **Design system changes are code.** A change to the design system's source (its folder is `design.system.dir` in `lambda.json`): a pattern (`patterns/*.tsx`), `catalog.ts`, a reference screen (`screens/`), the sample data (`sampleData.ts`) or the source map (`sources.json`), is reviewed like any other change. This covers the copies the Dev updates while building, before this review; what `/design-check` changes later, right before ship, is checked by `lambda design system build --check` and the map test instead. Does the copy match the app source it names, with the exact values, not "similar"? Does a new pattern carry its `index.tsx` export, its catalog entry and its `sources.json` entry? Does no pattern import the app's runtime (data, auth, analytics)?

### Step 7: Analyse for issues

Review as a senior engineer. Focus on **real issues**, not nitpicks:

1. **Critical** — security holes, data exposure, injection, authentication bypasses
2. **Warning** — logic bugs, silent failures, missing error handling, edge cases, races, null risks
3. **Performance** — N+1 queries, unnecessary re-renders, inefficient algorithms, leaks
4. **Suggestion** — naming, minor improvements (only if impactful)

**Be honest.** If the code is solid, say so. Don't manufacture issues to look thorough.

### Step 8: Output

````
## Code Review: <N> issues found

### Hard Blockers (X items)

**<Blocker type>**
`path/to/file.ts:42`

<Description and what must be done to fix it>

### Security Audit

- [x] No exposed secrets
- [ ] ⚠️ Missing permission check on updateShift

### Test Coverage

- [ ] ⚠️ New function `createShift` has no unit tests
- [x] Bug fix includes a regression test

### Test Integrity

- [x] No suspicious assertion changes

### Critical (X issues)

**<Issue title>**
`path/to/file.ts:42`

<What's wrong and why it matters>

**Suggested fix:**
```typescript
// Concrete, copy-paste-ready fix
```

### Warning (X issues)
### Performance (X issues)
### Suggestions (X items)
````

**Always end with a grade and, if below A, a path to A:**

```
## Grade: <A+/A/A-/B+/B/B-/C+/C/C-/D/F>

<Brief justification, referencing specific issues>

## Path to A

- [ ] **<Action>** — <exact file:line and what to do>
```

**Grading integrity rule:** every grade below A MUST have a "Path to A" with concrete, actionable items. If you can't name specific actions to reach A, the grade is A — give the A. At A or above, omit "Path to A" entirely.

### Grading rubric

| Grade | Criteria                                                                 |
| ----- | ------------------------------------------------------------------------ |
| A+    | No issues. Exemplary code with excellent test coverage.                  |
| A     | Minor suggestions only. Tests present and meaningful.                    |
| A-    | 1–2 suggestions. Production-ready with adequate tests.                   |
| B+    | Few suggestions, no warnings. Test coverage acceptable.                  |
| B     | Minor warnings or several suggestions.                                   |
| B-    | Multiple warnings OR missing test coverage for new code.                 |
| C+    | Significant warnings OR poor test quality.                               |
| C     | Multiple warnings, likely bugs or missed edge cases.                     |
| C-    | Serious issues OR no tests for testable code.                            |
| D     | Critical issues OR hard blockers present.                                |
| F     | Critical security or logic flaws OR multiple hard blockers. Do not ship. |

### Grade caps

| Condition                                             | Max grade |
| ----------------------------------------------------- | --------- |
| Any hard blocker                                      | **D**     |
| Test assertion tampering                              | **F**     |
| E2E accommodations in app code                        | **D**     |
| E2E shortcuts in test bodies                          | **D**     |
| Silent failures on critical operations                | **D**     |
| Debugging artifacts left in                           | **D**     |
| Missing tests for new logic                           | **C**     |
| Poor test quality (only `toBeDefined`, no edge cases) | **B**     |
| Missing validation at a system boundary               | **B+**    |
| Any warning                                           | **B+**    |

**A- or higher = production-ready, no fixes required.**

## Review guidelines

**DO:** explain _why_ each issue matters; give concrete, working fixes; reference `file:line`; consider the surrounding code, not just the diff; demand evidence the code works (tests); give security, logic errors and edge cases extra scrutiny — generated code misses these most.

**DON'T:** nitpick formatting; flag things that are technically wrong but harmless; suggest rewrites that fix nothing; create alert fatigue; add issues to look thorough; block on old workflow comments on the ticket — review the code as it exists now.
