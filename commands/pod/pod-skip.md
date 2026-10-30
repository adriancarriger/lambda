---
description: (planning pods, manager) {owner} skipped a stage of this pod's flow.
argument-hint: '[m:<id>]: <owner> skipped <stage> (<id>)'
---

# Stage skipped: $ARGUMENTS

{owner} chose to skip a stage. It's recorded on the pod (`skipped:` line of `lambda pod status $POD_ID`) and as {owner}'s decision. Don't question it.

- **A stage you haven't reached:** nothing to do now — when you get there, pass it by and go to the next stage in your table.
- **The stage the dev is in right now:** `lambda pod interrupt $POD_ID dev`, then send the next stage's `/pod-phase …` (set `lambda pod phase` first if the phase number changes).
- **A checkpoint** (`cp<N>`) — or the checkpoint right after the skipped stage: it counts as closed. If you were waiting on it, go on to the next stage now. If the dev already posted it, tell the dev: "CP<N> was skipped — withdraw it (`lambda pod question withdraw <qid>`) and carry on."
- **The stage you are waiting on {owner} for** (e.g. the triage checkpoint was skipped): go on now.
