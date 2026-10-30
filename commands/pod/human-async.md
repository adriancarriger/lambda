---
description: (planning pods) {owner} wrote on an inbox item and has already moved on. Do the work, then reply once on that item.
argument-hint: <qid> [m:<id>]: <message>
---

# {owner} wrote on item: $ARGUMENTS

{owner} wrote on item `<qid>` (a decision question or a checkpoint) and has **already moved on**. The item is out of the inbox until you reply on it — and it comes back the moment you do, with your reply shown (and read aloud) first. So:

- **Reply once, after the work**, on this item: `lambda pod reply --qid <qid> --fyi "<reply>"`. Say what you did or what the answer is, in plain words, naming what changed by the numbers on the card ("decision 2", "ticket 3") — never ticket ids.
- **A message with several parts gets a reply split part by part**: write `[{"quote": "<the exact words of that part>", "answer": "<your answer to it>"}, …]` to a file and run `lambda pod reply --qid <qid> --fyi --reply-to <the message's m-id> --parts-file <file>`. It shows and reads question 1, answer 1, question 2, answer 2…; a part that became a decision shows its status and a link automatically (when the decision's `--quote` matches the part's). Every part of the message gets an entry.
- **Progress notes** while you work are optional and never bring the item back: `lambda pod reply --qid <qid> --progress "<note>"`. They are not your reply — always finish with the real one.

Steps:

1. If this `[m:…]` id was already handled earlier in this conversation, it is a re-delivery after a restart — stop here.
2. Read the item (`lambda pod question show <qid>`) and the message. Keep its `[m:…]` id — you need it if this leads to new decisions.
3. Work out what {owner} said — and act on each part:
   - **An answer** to a decision question (an option picked, or a decision) → record it with the exact words: `lambda pod decide "<decision>" --qid <qid> --quote "<the words>"`; if it reveals a general preference, add it to **Later statements** in `intent.md`; apply it to the tickets; run the **ripple check** and the **stale check** (your dev instructions); `lambda pod resolve <qid>`; then reply saying what you took the answer to be and what changed ("Going with B. Updated tickets 2 and 3 …").
   - **A question** ("what happens if…", "why…", "explain 3") → answer it in 2–4 plain sentences. A decision question **stays open** — say so at the end ("The question is still open."). Never treat a question as an answer.
   - **A change** on a checkpoint ("2: use the survey date instead") → record it as {owner}'s: `lambda pod decide "<new decision>" --quote "<the exact words>"`; apply it; run the ripple check; reply with what changed.
   - **"refresh your question"** → withdraw it (`lambda pod question withdraw <qid> --reason "refresh requested"`) and add a corrected one (same `--from-…` origin as the original). Reply saying so.
   - **"1: give me options" / "not sure"** on a checkpoint decision → a full question about it (below). Don't undo the decision until it is answered.
4. **If it needs decisions from {owner} — even one — they go in the queue as real questions, never decided in the chat.** For each: `lambda pod question add --from-message <the m-id> --quote "<the exact part of the message it is about>" --reply "<your answer to just that part>" [--blocks-checkpoint]`, then every section, cold read, commit (your dev instructions). The `--from-message` link is what shows "How we got here" with {owner}'s own words and a link back; one message can lead to several (they are numbered "decision 1 of 3"). Then reply on this item: "That needs N decisions from you — they're next in your inbox." This item then steps aside until they're answered; **after the last is answered and applied, reply on this item again** with what changed — that reply is what brings it back.
5. If the message is genuinely ambiguous, don't guess — ask in your reply (`--ask` is not needed; the reply itself brings the item back).
6. If this was the last open question of a phase whose work is done, post that phase's checkpoint.

## Checkpoint items

A message on a checkpoint ends with **the numbered list of decisions exactly as the card shows them** — "2" means item 2 of that list. If a number doesn't match the list, don't guess — say which numbers exist. **Never resolve a checkpoint yourself**: it stays open until {owner} says "checkpoint complete".

**The UX review (CP4)** also numbers its screens. "screen 2: …" means screen 2 on the card (`lambda pod question show <qid>` lists them in order). A change to a screen means updating every ticket that builds it — its `## UX` sketch and its acceptance criteria — then editing CP4's screens file in place and running `lambda pod checkpoint refresh $POD_ID --cp 4` (no re-post), and replying with which tickets changed. A bare number on CP4 is ambiguous (decision or screen?) — ask.
