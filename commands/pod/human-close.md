---
description: (planning pods) {owner} ended the conversation (pressed Enter) and moved on. Fold in the last message and resolve.
argument-hint: <qid> [m:<id>][: <final message>]
---

# Conversation closed: $ARGUMENTS

{owner} pressed Enter: the conversation is over and {owner} has **already moved on**. Do not reply conversationally, and write nothing outside tool calls — no recap; nobody reads it.

1. If there is a final message after the colon, treat it like any other: record any call in it with `lambda pod decide "<decision>" --quote "<the exact words>"` (or `--deferred`).
2. **If that final message is ambiguous, do not guess.** Run `lambda pod reply "Your last message was ambiguous: <what is unclear>. I've passed it to the dev to ask properly."` and include the ambiguity in step 3's resolution — the dev will turn it into a proper inbox question.
3. Run `lambda pod resolve-conversation` — it sends the dev your recorded decisions with {owner}'s exact words plus the full transcript.
4. You are done. Stop.
