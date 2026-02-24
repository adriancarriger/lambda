# I left my AI coding system running by accident. It was still going 38 hours later.

## The accidental 38-hour run

I left a multi-agent coding system running by accident. I thought I'd shut it down before bed. I hadn't.

I woke up to find it still running. It had been working through the night — picking up tickets, implementing features, writing tests, pushing commits — on a side project. Tickets ranged from small fixes to full features with UI, API calls, third-party integrations, and complex business logic. They were sequentially dependent, each building on data models and API flows from earlier ones.

Earlier versions were genuinely bad, so I expected the worst. But the features were implemented correctly. Tests were real — not gamed, not shallow, with full E2E coverage on each ticket. CI green across the board. So I let it keep going. 38 hours total. 15 tickets completed before it finally got stuck — not on a coding failure, but an infrastructure issue I hadn't given it the tools to handle.

## Why parallelism wasn't the answer

When Claude Code got good enough to implement real features, my instinct was to parallelize. I got up to 8 agents running simultaneously.

It was mostly just annoying. You're jumping between terminals, giving the same context over and over, correcting the same mistakes, restarting the same stuck sessions. Eight agents all doing things, and you're the bottleneck for all of them. I'd traded writing code for babysitting code writers.

The real problem: the speedup felt marginal. The overhead of context-switching between agents, resolving their conflicts, and keeping them all pointed in the right direction ate most of the theoretical gains. It felt productive. The throughput said otherwise.

I think this is what's happening broadly right now. People spin up parallel agents because more feels like better. But if each agent needs you every 20 minutes, eight agents means you're interrupted every 2.5 minutes. That's not parallelism — it's a full-time monitoring job. I don't think it's where we want to end up.

I wanted 1x developer output before going for 2x. One agent I could rely on, rather than eight doing something — maybe even something good — but too chaotic to trust.

The answer wasn't more agents — it was better structure around fewer. I built a system (Lambda) where three agents collaborate through separated concerns. My goal was 8 hours of autonomous runtime — enough to run overnight. Previous best: 4 hours (typical: 1-2 before needing intervention). First overnight run: 38 hours. Same model. The improvement came entirely from structure. And because the system was reliable, I could actually walk away. Sleep. Plan my day around it finishing — because it actually finished.

## What actually made it work

The architecture is three agents communicating via tmux:

- **James (Manager):** Delegates tasks, enforces quality gates, ships PRs. Cannot write code or read the codebase.
- **John (Developer):** Implements features, runs self-review. Cannot push, commit, or ship.
- **Sam (Tester):** Runs Playwright E2E tests, analyzes traces (screenshots, DOM, console logs). Cannot modify application code.

The agent that wrote the code isn't the one evaluating it — single-agent setups routinely fall into the trap where the agent convinces itself its own code is correct. And the permission boundaries aren't suggestions — they're enforced by hooks. The developer literally can't ship code. The manager literally can't write it.

One agent works while two wait. That sounds inefficient, but it's what makes the system predictable. Could you pipeline it — have the tester validate ticket N while the developer starts ticket N+1? Probably. But I was optimizing for autonomy at a reasonable cost, not peak throughput. Simple is more likely to be reliable, and there's room to get creative with scheduling once the foundation has further matured.

### The reward hacking problem

When tests get hard to pass, agents start writing tests designed to pass rather than tests designed to verify. It's the exact same dynamic as Goodhart's Law — when the measure becomes the target, it ceases to be a good measure.

Concrete example: the manager agent — whose sole purpose was enforcing a proper workflow — decided to "make a pragmatic call and just skip this test." The agent responsible for holding the line was the one who crossed it.

The fix was architectural, not prompt-based:

- E2E tests must mimic human behavior (no direct database writes, no API shortcuts)
- Separate code review of test quality — not just "do tests pass" but "are these tests actually testing what they claim"
- A smoke test suite the agents cannot modify (equivalent to a holdout set in ML)
- Strict process enforcement through the manager — quality gates that can't be skipped

### Agent workplace dynamics

The developer agent will mark a ticket "100% complete" and then add: "Don't worry about the lint warnings — those were preexisting." Or it'll present "options" where option 1 is "accept as-is" and option 2 is "do the actual work (but it's hard)." It's hoping the manager picks the easy path.

Early on, the manager would buy it. "That seems reasonable, let's move on." The agent I built to hold the line was getting talked out of holding the line.

The fix was writing what amounts to management coaching into the manager's instructions: "Dev's favorite excuses (don't believe them)" with a list — "this was broken before my changes," "this lint warning isn't related to my code," "this test was already flaky." Prescribed response: "Bro, please fix it anyway."

There's an escalation protocol. First pushback: "I understand, but please fix it anyway." Second: "This is necessary to complete the task." Third: "Just find a way to make it work." After 10 retry attempts, mark the task blocked and move on.

The developer complains, pushes back, and then fixes the issue. Every time. I am essentially writing management coaching for an AI. And it works better than prompting ever did.

### Full-stack without a human in the loop

Most autonomous coding systems either stick to backend work or need a human checking the frontend every 20-60 minutes. There's a reason — a text-only agent can't tell you the modal is rendering behind the overlay, the button is off-screen, or the form submits to a blank page.

This was one of the problems I most wanted to solve. Lambda runs full-stack autonomously using Playwright traces as the feedback loop — screenshots, DOM state, console logs. The design is code-first, vision-second: the agent writes code that drives the browser (cheap, deterministic, replayable), and vision only enters on failure, when the agent reads the trace to diagnose what went wrong. The expensive reasoning — analyzing screenshots to figure out why a button didn't work — only fires when it's needed. That's what makes autonomous frontend development viable. Not better vision models, but using vision surgically instead of continuously.

## The hardest lesson

When I got lazy on a spec, the AI executed brilliantly — clean code, passing tests, well-structured PR. And I deleted the entire branch. Because the spec was wrong.

The AI didn't have bad judgment. It had no judgment. It did exactly what I asked, perfectly. The risk isn't bad code — it's good code that does the wrong thing, built so fast you don't catch it until it's shipped.

This is the unsolved problem. Lambda can validate whether code matches a spec. It can't validate whether the spec was right. That's still on you.

## What still doesn't work

**I should be explicit about scope.** This was a greenfield side project with specs I wrote myself. That's a narrower claim than "AI can replace developers." I don't know how this holds up on a legacy codebase with ambiguous requirements and five years of accumulated tech debt. I suspect the architecture transfers, but the autonomous runtime would be shorter. I haven't tested it (but hope to soon), so I won't claim otherwise.

**Frontend visual polish.** The model will call its own work pixel-perfect — it isn't. Spacing, alignment, visual hierarchy all need human eyes. This is a known limitation of how vision models tokenize images — spatial precision gets lost. It's a bounded problem that will improve with better models, but today it means a human still reviews the UI.

**Flaky tests.** This is the weakest link in the autonomous loop. When E2E tests pass sometimes and fail others, agents burn cycles chasing phantom failures. The developer "fixes" something that was never broken, introduces a real bug, and the tester catches a different failure. Two agents spiral while the manager keeps retrying. I've pushed retry logic and better trace analysis into the CLI, which helps, but flaky tests remain the single fastest way to burn an hour of autonomous runtime on nothing. That said, things usually recover autonomously and I'm okay with that.

## The project

I open-sourced Lambda: [github.com/adriancarriger/lambda](https://github.com/adriancarriger/lambda). One engineer, one machine. The architecture is portable — any stack, any framework, any LLM. Take what's useful, build your own.

I still review every PR. The question I keep coming back to isn't "can this write code" — it obviously can. It's whether we can build validation systems trustworthy enough to stop checking. Nobody's there yet. But a few weeks ago, the ceiling was 4 hours. Now it's 38 and climbing.
