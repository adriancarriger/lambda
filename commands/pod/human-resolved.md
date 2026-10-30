---
description: (planning pods) A conversation between {owner} and a fork of you about one question has ended. Apply what was decided.
argument-hint: <qid> [m:<id>] + decisions, deferred items and full transcript
---

# Conversation resolved: $ARGUMENTS

{owner} talked about question `<qid>` with a **fork** of you, so your own conversation was not interrupted. The message above was built from the files: the decisions **with {owner}'s exact words**, anything deferred, and the **full transcript, both sides**.

1. Ignore if this `[m:…]` id was already handled (re-delivery after a restart).
2. Check each decision against the transcript — the quotes are what count, not the paraphrase.
3. **If it says UNCONFIRMED** (the fork died before it finished), apply only what the transcript makes unambiguous and ask anything else as a new question. Never guess.
4. Apply the decisions to the tickets (they are already in `human-decisions.jsonl` — do not record them again).
5. Append general preferences to **Later statements** in `intent.md`, with the quotes.
6. Run the ripple check and the stale check (your dev instructions).
7. Treat DEFERRED items as out of scope for now; note them where the ticket would otherwise be silent.
8. If it needs decisions that weren't settled, queue them as questions with `--from-message <the [m:…] id of the message that raised it>` (your dev instructions).
9. **A decision question:** `lambda pod resolve <qid>`. If that was the phase's last open question, post the checkpoint.
   **A checkpoint:** never resolve it — it stays open until {owner} says "checkpoint complete".
10. **Reply once on the item, after the work** — `lambda pod reply --qid <qid> --fyi "<what changed>"`, naming changes by the numbers on the card. That reply is what brings the item back to the inbox (and is read first when it does); without it a checkpoint stays out of the inbox.

## `/human-resolved chat` — from the Chat panel

The same, but it covers **several topics** (`## About q7 (Checkpoint 3)`, `## About the whole pod`, …): what {owner} said in the sidebar chat since the last hand-off, handed to you just **before** the answer on an item (which arrives next as `/human-async`). Per topic, do steps 2–8 above. Then:

- **Never resolve anything because of the chat** — a chat isn't an answer. The answer on the item (the next message) is what you act on to resolve or reply on it; fold the chat's decisions into that work.
- A topic about an item not being answered now: apply its decisions, and reply once on that item (`lambda pod reply --qid <qid> --fyi "…"`) only if they changed it.
- "The whole pod": apply decisions to the epic / intent as usual; no reply needed unless something changed that {owner} would want to hear.
