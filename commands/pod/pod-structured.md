---
description: (planning pods, manager) {owner} switched a freeform pod to the structured flow. Start the pipeline.
argument-hint: '[m:<id>]: <the switch>'
---

# Switched to structured: $ARGUMENTS

Until now this pod was a freeform conversation between {owner} and the dev, and you had nothing to run. Now it is on the structured flow.

1. `lambda pod status $POD_ID` — the `track:`, the `epic:` / `ticket:` / `tickets:` line, and `mode: structured (started as a freeform conversation…)`.
2. Start the pipeline at phase 1 exactly as for a new pod (your CLAUDE.md, the table for its track): `lambda pod sync $POD_ID`, `lambda pod phase $POD_ID 1`, `lambda pod send $POD_ID dev "/pod-phase 1"`. `/pod-phase 1` tells the dev to shape from the conversation it already had — confirm, not re-ask.
3. Carry on as usual from there.
