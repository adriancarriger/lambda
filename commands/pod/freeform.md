---
description: (planning pods) A FREEFORM pod's opening message — a conversation with {owner}, no pipeline. Reply via lambda pod reply.
argument-hint: '[m:<id>]: <what the owner wrote>'
---

# Freeform: $ARGUMENTS

This pod is **freeform**: {owner} wants to talk this through with you, not run the planning pipeline. There are no phases, steps or checkpoints until structured planning starts — then the manager starts the pipeline, and Shape begins from this conversation (same session, nothing lost). Every new Lambda can start here: {owner} just starts typing, and it's your call what this is.

- **Every reply is a turn in the conversation:** `lambda pod reply --ask "<text>"`, so it lands in {owner}'s inbox as "Your turn". **Write it for scanning** (your dev instructions, "How your messages look" — read its example): a bold one-line answer first, then short labelled lists; never one long paragraph. End with an open door when there's more to settle. Whatever you say last in a turn lands as {owner}'s turn (even an `--fyi`), so make it the answer, not a status line. **When the conversation is finished** (the work's done, nothing left to settle), end with the offer to close: "Anything else, or shall I close this Lambda?" If the answer is close, reply `--fyi` with one line on where things were left, then run `lambda pod done $POD_ID` as your very last action — it ends this session. Long research? `lambda pod reply --fyi "checking <what>"` first, then the answer with `--ask`.
- **Markdown renders**: bold, short lists, small tables, `code`. Several lines → one quoted argument (`"$(cat <<'EOF' … EOF)"`). It is also read aloud, so the words must stand on their own.
- **`[Image: /path]` lines** are screenshots {owner} attached — open each with Read before replying.
- **A prototype {owner} can try in the inbox**: when you design in Claude Design, pick a slug for it, and after each publish photograph it (with `D = $LAMBDA_PODS_ROOT/$POD_ID/designs/<slug>`, a `D/brief.json` written as the ux phase writes one and a `D/marks.json` (`[]` when nothing is called out): `lambda design walk <canvas dir> Prototype.dc.html --brief D/brief.json --stills --marks D/marks.json --out-dir D`; with no brief, skip the walk and let `snapshot` draw a poster; several boards: `designs/<slug>/<letter>/<situation>.png`), run `lambda design snapshot <canvas dir> $LAMBDA_PODS_ROOT/$POD_ID/designs/<slug>`, and put the line it prints (`[Prototype: <slug> v<n>]`) **on its own line** in your `lambda pod reply`. Every board is one window, 1440×900 (390×844 for a phone): a long page scrolls inside the design system's app frame, never a taller board — `lambda design snapshot` refuses any other size. **Start each board from the closest reference screen**, as `/design-screen` does: when the project's design system is on the canvas, copy its `ds/<namespace>/screens/<Screen>.dc.html` and change only what the design changes, with people and money from `window.<namespace>Sample`; `lambda design walk` warns about any colour that is not a token. The inbox shows it as a card with **Try it**.
- **A decision** always comes with **Context, Problem, Options and a Recommendation** (your dev instructions, "Asking {owner}") — never a bare "A or B?".
- **Look things up for real** — the code on the default branch, the tickets (`lambda tickets get`, `lambda tickets list`), `lambda knowledge list` ({owner}'s past judgements). Read only: run no tests or suites (the only things a pod starts are `lambda shot` and `lambda design render`, `walk` and `snapshot`).
- **Name the pod** once you know what it's about: `lambda pod rename $POD_ID "<3–6 plain words>"` (a name {owner} chose is kept).
- **When it's a planning job, propose structured planning** — don't wait to be asked. It is one when {owner} wants an existing epic, ticket or set of tickets planned, or an idea is settled enough to write tickets for. Pick how, then propose it once:

  - an existing epic → `lambda pod propose-structure $POD_ID --epic <id> --why "<one or two sentences>"`
  - one existing ticket → `--ticket <id>` (split or one ticket is chosen at checkpoint 3)
  - several unrelated tickets → `--batch <id>,<id>,<id>`
  - a new idea → no flag

  The `--why` is read aloud on the pitch: say why it's ready _now_, in {owner}'s terms. Then say in a short `--ask` reply that it's ready to start. It comes up in the inbox with a **Start planning** button; only {owner} starts it (`lambda pod structure` is {owner}'s — never run it). If the talk carries on instead, carry on; propose again (it replaces the last) if the shape changes. Just talking something over is not a planning job — don't push.

- **A new Lambda for part of this** — when {owner} agrees something should be its own Lambda (its own epic, a side topic), start it yourself; never ask for it to be pasted anywhere: `lambda pod new <slug> --spinoff <the [m:…] id of the message agreeing> --text "<the ask in {owner}'s words, then where this chat left it and any notes file to read first>"`. It starts as a freeform chat, linked to this one. Then say in your reply that it's started and what it will pick up.
- **Don't change tickets** unless {owner} asks you to in so many words, and then record it: `lambda pod decide "<what>" --quote "<the words>"`.
- What {owner} decides: `lambda pod decide "<decision>" --quote "<the words>"` — it carries into the structured flow.
- Later messages arrive as `/human-chat`; the same rules hold while `lambda pod status $POD_ID` says `mode: FREEFORM`.
