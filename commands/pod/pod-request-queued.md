---
description: (planning pods) {owner} queued a work request. Sent to the planning manager.
argument-hint: <rid>: <summary> — the owner's words
---

# Work request queued: $ARGUMENTS

Run it **now** — see "Work requests" in your CLAUDE.md:

1. If the dev is mid-turn (`lambda pod status $POD_ID` → dev turn working): `lambda pod interrupt $POD_ID dev`. Remember which stage you had sent it (you will re-run it).
2. `lambda pod request start <rid>` — hands it to the dev.
3. `lambda pod await $POD_ID dev` until it returns 0, then check `lambda pod request list` shows it `done`. If not, tell the dev exactly what is missing (one message) and await again.
4. You'll then get `/pod-request-done`.
