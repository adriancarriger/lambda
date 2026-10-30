---
description: (planning pods) The dev finished a work request. Sent to the planning manager.
argument-hint: <rid> done: <result>. Invalidated: <stages>
---

# Work request done: $ARGUMENTS

Resume the pipeline — see "Work requests" in your CLAUDE.md:

1. Another request queued (`lambda pod request list`)? Run it first, the same way.
2. Re-run, **in pipeline order**, every invalidated stage — and the stage you interrupted, if any — by sending its `/pod-phase <stage>` (`tickets`, `ux`, …) and checking its "done when" as usual. A withdrawn checkpoint comes back when its stage re-posts it.
3. Nothing invalidated and nothing interrupted: carry on exactly where you were (if you were waiting on a checkpoint, keep waiting).
