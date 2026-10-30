---
description: (planning pods) {owner} asked the pod to DO something (a work request). Sent to the pod dev by the planning manager.
argument-hint: <rid>: <summary> — the owner's words: "…"
---

# Work request: $ARGUMENTS

{owner} asked this pod to do real work — anything from "rebase on epic 1 and its children" to "add a ticket for the trail-closure banner". The manager stopped whatever you were doing for it; **that stage will be re-run from the top afterwards**, so don't try to finish it. While this request runs, all of the pod's inbox items are hidden.

Follow your dev instructions throughout (decisions, questions, cold reads).

1. Read the words — the quote is what counts, not the summary. If they are genuinely ambiguous, ask (`lambda pod reply --ask "…"`) before changing anything — with Context, Problem, Options and a Recommendation (your dev instructions, "Asking {owner}"), never a bare "A or B?".
2. Do the work, fresh: `lambda tickets pull` every ticket you touch first, and read what the request points at (another epic and its children: `lambda tickets get <epic>`, pull each child; code that has landed on the default branch).
   - Engineering calls: fix them and log each with `lambda pod decide --autonomous` (Before / Why / Instead), as always.
   - A ticket's lane ("make 2 a quick fix"): as in `/human-chat` — `lane` in `proposal.json` before the tickets exist, the label (`lambda tickets update <id> --label <lane>`) once they do.
   - Anything that changes what the product's users see, or what {owner} decided: a question (draft → cold read → commit), never a guess.
3. **Stale check** on everything this pod has in the inbox (`lambda pod question list --pod $POD_ID --status open`): for each open question — still valid (leave it), changed by the request (rewrite it), or moot (`lambda pod question withdraw <qid> --reason "<why>"`). Your recorded decisions stay; re-apply any that the request touched (the ripple check), and ask about any that no longer fit.
4. **What did it make stale?** List the workflow stages whose output no longer matches (`lambda pod status $POD_ID` shows the track; `lambda planning steps` lists the stage ids). Typical: changed tickets → `tickets` (if their UX sections or red flags need redoing) and `ux-review` (if it was done or under way). Nothing → `none`.
5. Finish with:
   ```bash
   lambda pod request done <rid> --result "<one plain line: what changed, decisions logged, questions asked>" --invalidates <stage,stage | none>
   ```
   It withdraws the stale checkpoint (it is re-posted when the stage is redone) and tells the manager what to re-run. Then end your turn.
