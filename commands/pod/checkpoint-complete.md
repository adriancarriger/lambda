---
description: (planning pods) {owner} closed a checkpoint. Sent to the planning manager.
argument-hint: [m:<id>]: Checkpoint N is complete…
---

# $ARGUMENTS

{owner} closed this checkpoint. Ignore it if this `[m:…]` id was already handled (re-delivery after a restart).

Run `lambda pod status $POD_ID` and continue the pipeline from your CLAUDE.md: CP1 → phase 2, CP2 → phase 3, CP3 → **UX review** (`/pod-phase ux`, phase stays 3), CP4 (the UX review) → phase 4, CP5 → **Finish**.

A lone ticket's CP3 says how it was closed — **kept one ticket** or **accepted the split** (also the `split:` line of `lambda pod status`). Pass that on to the dev, word for word, with the next phase.
