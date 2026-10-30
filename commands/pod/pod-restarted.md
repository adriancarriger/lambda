---
description: (planning pods) The machine restarted and this pod agent was resumed. Your last turn may have been cut off.
argument-hint: [m:<id>]
---

# The machine restarted

You were just resumed with your conversation intact, but **your last turn may have been cut off mid-step**. Messages that had not reached you are being re-sent with their original `[m:…]` ids — ignore any id you already handled.

**First, re-read your instructions — they may have changed since you started**: the manager its `CLAUDE.md`, the dev its dev instructions (especially "How your messages look"). Follow the new version from now on.

**If you are the planning manager:** run `lambda pod status $POD_ID`, check the current phase's "done when" column in your CLAUDE.md against the artifacts (the tickets, question files, pod.json — not your memory), then finish those checks or re-send `/pod-phase <n>`. Never re-create something that already exists. If you were waiting at a checkpoint, keep waiting.

**If you are the dev:**

1. `lambda pod question list --status draft` — finish each draft (cold read → commit) or withdraw it. No draft may be left behind.
2. If you were in the middle of a ticket edit, `lambda tickets pull` it and check whether your change landed before redoing it.
3. Then stop and wait for the manager.
