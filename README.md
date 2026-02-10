# λ

Three AI agents collaborate via tmux to autonomously build full-stack features — optimizing for how long they can work without you, not how fast they work while you watch.

https://github.com/user-attachments/assets/3181c3c6-8f70-4e4b-bb92-e467e0ab174f

Lambda is not a framework. It's an architecture — **division of labor across agents** and **vision-driven validation**. You don't need to clone this repo. Read the philosophy, take what's useful, build your own.

Most multi-agent setups optimize for parallelism — more agents working simultaneously. The bottleneck they don't address is babysitting. If you're monitoring agents, restarting stuck sessions, and course-correcting drift, you haven't automated the work — you've just given yourself a different job. Lambda prioritizes unattended operation: a system you can walk away from and come back to a PR.

An orchestrator that can't code. A developer that can't ship. A tester that can't write production code. E2E screenshots and traces as the feedback loop. These ideas are portable to any stack, any agent framework, any LLM. The implementation here is what worked for me — a reference, not a prescription.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Design philosophy](#design-philosophy)
- [Scaling](#scaling)
- [Architecture](#architecture)
- [CLI](#cli)
- [Transitional architecture](#transitional-architecture)
- [Make it yours](#make-it-yours)
- [Project structure](#project-structure)
- [Security considerations](#security-considerations)
- [Requirements](#requirements)

## How it works

```
                ┌──────────────┐
                │    James     │
                │ orchestrator │
                └──────┬───────┘
              picks task, delegates,
               enforces quality gates
               ┌───────┴───────┐
               │               │
          ┌────▼────┐    ┌─────▼────┐
          │  John   │    │   Sam    │
          │ builds  │    │  tests   │
          └──┬───┬──┘    └─────┬────┘
             │   │             │
  ┌──────────▼┐  └─ fix loop ─┘
  │  Boualam  │
  │  cleanup  │        ┌──────────┐
  └───────────┘        │  Adrian  │
                       │  waits   │
                       └──────────┘
```

James delegates to John and Sam, gating on each step. John builds, self-reviews, and verifies against the ticket. Sam runs E2E tests and analyzes traces. If tests fail, Sam sends diagnostics back and John fixes — the loop repeats until tests pass. James ships the PR. Adrian handles blocking waits on Haiku so the expensive model isn't burning tokens on idle time.

The quality gates are customizable — they live in `manager/CLAUDE.md`. Make them stricter, add domain-specific checks, whatever your project needs. The point is having gates at all, not these specific ones.

## Quick start

> **You don't need any of this to use Lambda's ideas.** The [design philosophy](#design-philosophy) section is the actual value. If you want to build multi-agent workflows in your own stack, start there. The quick start below is for running the reference implementation.

Prerequisites:

- [tmux](https://github.com/tmux/tmux)
- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [iTerm2](https://iterm2.com/) recommended — Lambda auto-detects it and opens tmux windows as native tabs

```bash
git clone https://github.com/adriancarriger/lambda.git
cd lambda
./init.sh        # one-time: install deps, build CLI, install Playwright (runs npm link — may need sudo)
lambda start     # launch agents and connect
# switch to James's tab and tell him: "Take the next ticket"
```

`lambda start` creates a tmux session with three Claude agents and a Next.js dev server, then connects you to it.

> **Note:** `lambda ship` defaults to dry-run mode (`DEMO_MODE` in `src/config.ts`). Pass `--no-dry-run` to actually push and create PRs, or set `DEMO_MODE = false` in the config.

In iTerm2, each agent window (James, John, Sam, scratchPad, dev-server) becomes a native tab — no tmux key bindings to learn. In other terminals, use `Ctrl+B w` to switch between tmux windows.

Disconnected? Run `lambda connect` to reattach.

### The demo

The repo ships with a sample Next.js todo app and three demo tasks. Each task has a failing E2E test. The agents make them pass.

| Task   | Feature                               | Spec                |
| ------ | ------------------------------------- | ------------------- |
| DEMO-1 | Delete button on each todo            | `tickets/DEMO-1.md` |
| DEMO-2 | Completed checkbox with strikethrough | `tickets/DEMO-2.md` |
| DEMO-3 | Filter bar (All / Active / Completed) | `tickets/DEMO-3.md` |

Each task has a spec in `tickets/` and a failing test in `e2e/todos.spec.ts`. The agents read the spec, implement the feature, and iterate until the test passes. The demo tasks are intentionally simple — the architecture shines more on complex, multi-file features where the separation of concerns and quality gates actually matter.

## Design philosophy

### Do what the human would do

Most tickets go through the full cycle autonomously. Lambda systematizes the loop a human developer already runs — read the ticket, tell Claude what to build, watch the output, run tests, read the failures, send Claude back to fix — then replaces the human with James.

The weakest link is flaky E2E tests. When a test passes sometimes and fails others, agents burn cycles chasing phantom failures. Pushing more of that complexity into the CLI (better trace analysis, smarter retry logic) keeps shrinking that gap.

### Separation of concerns

John writes the code. Sam evaluates it. Separate agents avoid the trap where the agent that wrote the code convinces itself the code is correct. John also runs his own code review and ticket verification — James doesn't read code, he just gates on John's self-reported grades before handing off to Sam.

Give a single Claude Code instance a long workflow and it will drift — skip steps, stop following the process, or halt early. James solves this by doing less, not more. He can't write code, can't run shell commands, can't even read the codebase. All he does is delegate, enforce quality gates, and ship when the work passes. He enforces the sequence every time because that's all he does.

### Reliability over parallelism

If one agent needs intervention every 20 minutes, running eight of them means you're interrupted every 2.5 minutes. That's not parallelism — it's a full-time monitoring job. Lambda optimizes for unattended runtime: one team that can complete tickets end-to-end without human input.

The agents are separated for **context isolation**, and context isolation is what makes reliability possible. Sam focuses on testing without John's implementation noise in his context. John focuses on building without Sam's trace analysis cluttering things up. James just enforces the process. Each agent is better at his job because he only sees what's relevant to his job. Focused agents are more reliable agents, and reliability is what makes unattended operation work.

This also makes Lambda token-efficient. You're not paying for three agents thinking simultaneously — you're paying for one agent working while two wait. Adrian handles the blocking waits on Haiku, so the expensive model isn't burning tokens on repeated `sleep` calls.

### Tmux as context engineering

Tmux isn't just a communication channel — it's how each agent gets access to the right context at the right time. John can read any tmux window in the session. If the dev server is throwing compile errors, he checks `lambda tmux dev-server`. If the backend is misbehaving, he reads the logs from whatever window they're in. A React compile error, a backend crash, and a failing test are often the same bug seen from three different angles — John can triangulate, the same way a human developer would glance at different terminal tabs.

James, by contrast, can only see John's and Sam's windows. He doesn't need dev-server logs or shell access — he just needs to know whether his agents are done and whether they succeeded. The permission hooks enforce this. Different agents, different context, different capabilities.

### Vision-driven validation

If you want autonomous front-end development, you need visual feedback. There's no way around it. A text-only agent can't tell you the modal is rendering behind the overlay.

E2E tests are how Lambda structures that feedback. The agent writes a test, runs it, reads the trace (screenshots, DOM, console), and iterates. This is significantly faster than exploratory QA — the test gives the agent a repeatable, targeted feedback loop. Tests can be throwaway — written fresh for each feature, used purely as a verification mechanism, then discarded.

### Code-first, vision-second

Browser MCP tools put the agent behind the steering wheel — look at a screenshot, decide what to click, look at the next screenshot, decide what to type. Every interaction burns vision tokens. A ten-step form fill costs ten rounds of screenshot reasoning.

Lambda inverts this. The agent writes code that drives the browser. Running that code costs nothing — Playwright executes it deterministically, as many times as needed, for negligible tokens. Vision only enters when the code doesn't work. A failing test produces a trace with screenshots, DOM state, and console logs. The agent reads the trace, fixes the code, and runs again.

The expensive part (vision-based reasoning) only happens on failure. The cheap part (executing code) handles all the repetition. Write once, run free.

### Deterministic CLI

The `lambda` CLI pushes complexity out of the agent's context and into deterministic code. Agents are good at reasoning and writing code. They're less good at reliably executing multi-step shell workflows or remembering to follow a twelve-step process every time. Shipping a PR is `lambda ship`, not "create branch, stage files, commit, push, open PR, and don't forget the ticket ID."

Whatever repetitive workflow your agents keep getting wrong, push it into a CLI command. The agent calls one command; the CLI handles the rest.

## Scaling

Once one team works reliably, you scale by spinning up a second team on a different feature set. Two teams, two backlogs, two machines. Each team pulls from different task filters in your ticketing system. This is how human teams scale — independent pods working on separate features, not more people on one task.

The todo app in `sample/` is a demo target. Point Lambda at any codebase — replace the sample app, write different tickets, configure different tests. The architecture is the same; only the inputs change.

This scaling model works in principle but has rough edges in practice. Context windows fill up on long sessions. Flaky tests burn cycles. The architecture is sound; the implementation is still maturing.

## Architecture

### Agent roles

| Agent   | Role           | Can do                                                              | Cannot do                                                   |
| ------- | -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| James   | Orchestration  | Manage tasks, delegate to John/Sam, enforce quality gates, ship PRs | Write code, run shell commands, read the codebase           |
| John    | Implementation | Write code, build, self-review, verify ticket completeness          | Push, commit, ship, talk to Sam directly                    |
| Sam     | Validation     | Run E2E tests, analyze Playwright traces                            | Write application code                                      |
| Boualam | Cleanup        | Format, lint, type check — iterates until all pass                  | Architectural decisions, adding eslint-disable, refactoring |
| Adrian  | Waiting        | Block until a pane finishes, burn zero tokens on expensive models   | Anything else — only has the `await_pane` tool              |

### Communication

Agents coordinate through tmux, not Claude Code native Teams. James sends commands and messages via the `lambda tmux` CLI:

```bash
lambda tmux john 'Implement DEMO-1. See tickets/DEMO-1.md for the spec.'
lambda tmux sam 'Run E2E tests: lambda e2e todos.spec.ts'
lambda tmux john               # Read John's output
```

The `lambda tmux` command auto-cycles the target pane to "accept edits" mode before sending, so agents never get stuck on permission prompts.

### Key patterns

- **Trace analysis**: Sam extracts screenshots, DOM state, and console logs from Playwright traces to produce structured failure diagnostics.
- **Adrian subagent**: Long blocking waits (waiting for John to finish, waiting for E2E to complete) are delegated to a Haiku-powered Adrian subagent. Zero tokens burned on the expensive model while waiting.
- **Boualam subagent**: John delegates format/lint/typecheck busywork to the Boualam subagent that iterates until all checks pass. Keeps John's context clean and focused on implementation. Won't make architectural decisions — escalates back to John after 3 failed attempts.
- **Permission lockdown**: James can only run `lambda` CLI commands — enforced by a permission hook (`manager/scripts/permission-hook.cjs`). John and Sam are blocked from committing or pushing by their own hook (`dev-permission-hook.cjs`).
- **Ralph stop-hook**: Prevents James from exiting while tasks remain in the queue (`manager/scripts/ralph-stop-hook.sh`).

## CLI

```bash
# Session
lambda start                    # Create tmux session, launch agents, connect
lambda start --no-agents        # Create session without launching agents
lambda stop                     # Kill the tmux session
lambda connect                  # Reattach to an existing session

# Tmux
lambda tmux <pane> [command]    # Send command or read output from a pane
lambda await <pane> [--long]    # Block until pane is idle

# Tasks
lambda tasks list               # Show all tasks from TASKS.md
lambda tasks next               # Get next available task
lambda tasks show <id>          # Read ticket spec from tickets/<id>.md
lambda tasks done <id>          # Mark task as completed
lambda tasks block <id>         # Mark task as blocked (--reason)

# Testing
lambda e2e [args...]            # Run Playwright E2E tests
lambda trace diagnose-all       # Debug all Playwright traces
lambda trace summary            # Summarize trace results
lambda trace errors <trace.zip> # Extract errors from a trace

# Shipping
lambda ship <ticket-id>         # Branch, commit, push, open PR

# Agent management
lambda agent compact -w <window>  # Compact agent context
lambda agent clear --self <msg>   # Clear context with handoff message
lambda agent whoami               # Print current tmux window name
lambda agent context -w <window>  # Check token usage
```

## Transitional architecture

Lambda uses tmux because Claude Code Teams was too experimental when this was built (Feb 2026). Tmux is reliable, simple, and proven over many autonomous sessions.

Lambda isn't building a moat. If Claude Code Teams fully replicates the needed feature set — reliable multi-agent coordination, permission isolation, context separation — the tmux layer gets replaced. That's a good outcome. The ideas (agent separation, quality gates, vision-based validation) are independent of the transport layer.

As Claude Code Teams matures and ships pieces of this functionality, Lambda will adopt them incrementally. The architecture is designed so that swap would be a localized change — agent definitions, CLI commands, and permission model stay the same.

## Make it yours

This repo is a reference implementation, not the point. Lambda is the architecture — agent separation, quality gates, vision-based validation. If cloning and modifying works for you, great. If you'd rather build your own version from scratch using these ideas, that's probably even better.

- **Use the workflow, not the repo.** Lambda mimics how human teams already work — tickets, PRs, code review, QA handoff, fix loops. If your team follows this flow, Lambda is a drop-in. If not, take the ideas that fit and leave the rest.
- **Point your own app at it.** Replace `sample/` with your project, update `playwright.config.ts` to point at your dev server, and write your tasks in `TASKS.md`.
- **Add your own tasks.** Write specs in `tickets/`, add entries to `TASKS.md`, and write failing E2E tests. The agents will pick them up.
- **Plug in your ticket system.** The `lambda tasks` commands are a thin interface over `TASKS.md` and `tickets/`. Swap them out to pull from Linear, Jira, GitHub Issues, or whatever you use. There's a commented-out Linear integration stub in `src/commands/tasks/index.ts` as a starting point.
- **Customize agent behavior.** The root `CLAUDE.md` contains instructions for John and Sam. `manager/CLAUDE.md` controls James's orchestration loop.
- **Extend the CLI.** TypeScript + Commander.js in `src/commands/`. Add new commands by creating a directory with an `index.ts` that exports a registration function.
- **Adjust permissions.** James's permissions: `manager/.claude/settings.json` + `manager/scripts/permission-hook.cjs`. John/Sam: `.claude/settings.json` + `.claude/agents/dev-permission-hook.cjs`.

## Project structure

```
lambda/
├── src/commands/          # CLI command implementations
├── manager/
│   ├── CLAUDE.md          # James orchestration instructions
│   └── scripts/           # Permission hooks, stop-hook
├── sample/                # Next.js todo app (the demo target)
├── e2e/                   # Playwright E2E tests
├── tickets/               # Task specs (DEMO-1.md, DEMO-2.md, DEMO-3.md)
├── CLAUDE.md              # John/Sam agent instructions
├── TASKS.md               # Task queue
├── init.sh                # One-time setup (install deps, build CLI)
└── playwright.config.ts   # E2E test configuration
```

## Security considerations

Lambda's permission model is enforced by prompt instructions and hooks, not by hard sandboxing. You should understand the limitations before running it unattended.

**The core issue: tmux is a shared surface.** James can send arbitrary text to John and Sam via `lambda tmux`, including granting permission prompts (`lambda tmux john --raw 'y'`). This is by design — James needs to unblock John when legitimate permission requests come up. But it means John can request escalations and James will typically approve them.

**What the hooks enforce:**

- John and Sam are blocked from `git push`, `git commit`, and `lambda ship` by a `PreToolUse` hook (`dev-permission-hook.cjs`). This is a real gate — the hook runs before the command and denies it programmatically.
- James is restricted to `lambda` CLI commands by his own hook (`manager/scripts/permission-hook.cjs`). He can't run arbitrary shell commands.

**What the hooks don't enforce:**

- James is explicitly set up to grant John's permission requests (`lambda tmux john --raw 'y'` is in James's command reference). You could instruct James to always deny, but there's no guarantee a prompt-level constraint holds under all conditions.
- John has full filesystem access within his Claude Code session. The hooks block specific commands, not filesystem operations.
- Nothing prevents prompt injection via task specs or code content that agents read during work.

**My approach:** I run Lambda on a dedicated machine with limited access to sensitive systems. The permission hooks catch accidental mistakes (John trying to push, James running shell commands), and the prompt instructions handle the rest. This is an acceptable tradeoff for my goals.

**If you need stronger isolation**, wait for Claude Code native Teams, which will provide process-level separation between agents. The README's [transitional architecture section](#transitional-architecture) explains why I haven't migrated yet. The architecture is designed so that migration would be a localized change.

**Practical recommendations:**

- Run on a dedicated machine or VM, not your primary development machine
- Don't store secrets (API keys, credentials) in the project directory
- Review PRs before merging
- Audit the permission hooks if you modify them — they're the only hard gates

## Requirements

- macOS or Linux
- Node.js 20+
- tmux
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

## License

MIT
