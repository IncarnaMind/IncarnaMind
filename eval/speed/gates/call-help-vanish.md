# The check that a call-help reply never vanishes (#2767)

Written and committed with `eval/speed/callHelpVanish.speed.ts` on 2026-11-08, before any run it reads, and before any change to the panel. A change to what the panel shows of a reply ships only while it holds every line below.

## The runs

- **Presses:** the call-help set's "What do they want?" and "What to ask next" cases in English and Chinese (`en-want`, `en-ask-agents`, `zh-want`, `zh-ask-agents`, `eval/speed/callHelpCases.ts`), each pressed 30 times on each model through `askMeetingHelp`, as the floating panel presses it, in a call heard live as the call-help set hears it. Every write of each reply, from the press to its end, is kept in the run's `replies.json`.
- **Models:** Claude Haiku 5.5 on a direct Anthropic key, and DeepSeek V4.1 Flash 1017 (`deepseek-flash`). No judge: nothing is graded.
- **Main and the branch read the same replies.** The paid run is made at this commit, whose `src/renderer/src/helpReply.ts` is main's, so its report is main's panel. The branch's panel then reads the same `replies.json` again with `INCARNAMIND_EVAL_SPEED_VANISH_REPLAY`, asking no model. The panel's rule changes nothing the core sends, so the pair differs only in the panel.
- **The panel at each write:** `shownItems` over `readHelpReply`, streaming while the Answer is, with the lead-in line when the live text is behind, as `HelpSuggestion` lays it out.

## The bar, on each model and each language, over the branch's reading

- No reply that showed words while it was written ends with no item shown ("words, then none at the end"). Main's count is reported beside it.
- No item the panel showed while the reply was written is missing from the panel at the end while the finished reply still has it ("an item shown, then hidden though the reply has it").
- No more replies end with no item than on main.
- No more items shown and then taken back by the core than on main: what #2728 keeps from being drawn (a model's notes before its first option or line) stays undrawn.

A change that fails a line doesn't ship, and the numbers go on the issue.

## Reported, not held

Per model, language and button: the presses that finished and failed, showed words while written, and emptied while written; and the final text of every reply the panel ended with nothing or with less.

## Spend

$4 for every run of this work, held by the run's own `INCARNAMIND_EVAL_SPEED_STOP_USD=4` (the core's own count); each run's spend is listed below.

## The run (2026-11-08, at 0fb62cbf1)

240 presses: each of the four cases 30 times on Claude Haiku 5.5 (a direct Anthropic key) and on DeepSeek V4.1 Flash 1017 (`deepseek-flash`), every press finished. Spent $0.12 by the core's count; with the one-press-a-case smoke run before it ($0.00), $0.12 of $4. One-minute load 2.9 to 4.7 when read during the run. Main's panel read the replies in the run; the branch's (309df83c1, and again at bc900eddc with the same numbers) read the same `replies.json` again with no model asked.

Main → branch, both buttons together, 60 presses a cell:

| Model · language | words, then none at the end | an item shown, then hidden though the reply has it | no item at the end | an item shown, then taken back by the core |
|---|---|---|---|---|
| Claude Haiku 5.5 · English | 0 → 0 | 1 → **1** | 0 → 0 | 2 → 2 |
| Claude Haiku 5.5 · Chinese | 0 → 0 | 1 → 0 | 0 → 0 | 1 → 1 |
| DeepSeek V4.1 Flash · English | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · Chinese | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

Over every write of the 240 replies, read item by item with nothing left out (the check's own count leaves out an item with no letter or digit), the branch's panel differs from main's only at the end of those two Haiku presses, and never while a reply is written.

**The bar:** lines 1, 3 and 4 hold in every cell. Line 2 fails as written in one cell: one Claude Haiku 5.5 English press, the same press on main.

## How the run was read (added after it)

- **The cause, in both presses main's panel hid an item at the end:** Haiku wrote two readings, each with its "→" line, then recorded its Citations; the core's judgement of the model's working took back the last reading's "→" line, and main's panel drops an item with no "→" line once the reply ends. A reply of one option or reading that loses its "→" line this way ends with only the heading, which is #2767's report; none of these 240 replies was of one item, so none ended empty on either panel. The unit tests read these two replies, and four one-item replies (a reading and an option in each language) made from recorded ones with their "→" line taken back, each red on main.
- **The press that fails line 2 on the branch** (Haiku, `en-want`): between its two readings the model wrote "Actually, a more explicit reading of their last lines:", drawn for 0.1 s as the line being written and left out as a remark once the next reading came. Main draws it the same way. While a line after the first option is written, the panel can't tell a remark from the second option, and #2728's tests hold that the second option shows as it is written. Line 2 stays failed for this cell as written; whether this ships is not decided here.
- **What the branch shows that main didn't:** a line after the last option, with no "→" line, now stays once the reply ends, as it showed while it was written: an option or reading whose "→" line was taken back, and also a closing remark when there is room for it (none of these 240 replies had one under the two-option cap). Leaving such a remark out once the reply ends is what made a reply vanish.

## A "→" line the panel showed stays (#2778), written before its runs

Written and committed on 2026-11-08, with the check's new count, before the change it gates and before any run that reads it.

- **What changes.** The core never judges a help reply's form as a model's working (#2371): from its first option or reading (its "★" line, or its first "→" line when it has none; for "Am I leading them?" its first line) to the end of its last "→" line, or in short lines from the first "- " line to the last. A part that runs into the form is judged by its lines outside it. So no "→" line of a written option is taken back. Text before the form is a model's notes (#2526) and text after it a remark the model added; both are judged as before, as is a reply with no form yet. The panel shows Pin and Add to note only under something to pin or add, and a help Answer stopped before its first option says so with Try again.
- **The new count:** "a → line shown, then gone at the end": an option or reading the panel showed with its "→" line, still shown at the end but without one.
- **The replay (no model):** the 240 kept replies above, read by main's panel at this commit, then by the branch's. Every count is the same on both, the new one too: the panel's change touches only a stopped Answer, and none of the 240 is.
- **The fresh run:** at the branch's head, the same four cases (`en-want`, `en-ask-agents`, `zh-want`, `zh-ask-agents`), each pressed 15 times on Claude Haiku 5.5 (a direct Anthropic key) and on DeepSeek V4.1 Flash 1017 (`deepseek-flash`): 120 presses, 30 a cell. Held by `INCARNAMIND_EVAL_SPEED_STOP_USD=2`, this work's cap.

### The bar, on each model and language of the fresh run

- "a → line shown, then gone at the end": none.
- "words, then none at the end" and "no item at the end": none.
- "an item shown, then taken back by the core": no more than main's count in that cell of the 240 (Claude Haiku 5.5: 2 in English, 1 in Chinese; DeepSeek V4.1 Flash: none), and each press counted is read and named. Only notes before the form or a remark after it may be taken back, never an option, a reading or a short line of the form.
- "an item shown, then hidden though the reply has it": each press counted is read and named. One that is a remark drawn for a moment between two options while it was written is the failure this check already holds as a dated exception (above); any other fails this bar.

A line that fails keeps the change from shipping, and the numbers go on the issue.

**Amended before the fresh run, 2026-11-08,** after the replay of main's 240 with this check (no model asked). As first written, the change judged only text before the first option. In one Claude Haiku 5.5 press (`en-want`), main's judgement took back a remark the model wrote after its one reading, "Wait — let me cite the passages first."; left unjudged, the panel would show it as a second reading once the reply ends. So text after the form's last "→" line is judged as before, and the bar on items taken back by the core compares with main's count instead of asking for none. Main's replay: "a → line shown, then gone at the end" 1 in each of Haiku's English and Chinese, none on DeepSeek; every other count as in the table above.

### Reported, not held

The done time's median per cell, beside main's over the 240: a reply with nothing to judge no longer waits for the judgement's request.

### The runs (2026-11-08)

- **The replay,** with no model asked: main's panel (552266d07) and the branch's (701c53148) read the 240 kept replies with the same counts in every cell, the new one included: "a → line shown, then gone at the end" is 1 in Claude Haiku 5.5's English and 1 in its Chinese, both lines the core took back in main's replies, and none on DeepSeek V4.1 Flash.
- **The fresh run,** at 701c53148: 120 presses, every one finished, on Claude Haiku 5.5 (a direct Anthropic key) and DeepSeek V4.1 Flash 1017 (`deepseek-flash`); both were meant and both ran. Spent $0.05 by the core's count, of the $2 cap. One-minute load 10.9 at the start and 5.2 at the end.

Main's 240 (60 presses a cell) → the fresh run (30 a cell), both buttons together:

| Model · language | a → line shown, then gone at the end | words, then none at the end | no item at the end | an item shown, then taken back by the core | an item shown, then hidden though the reply has it |
|---|---|---|---|---|---|
| Claude Haiku 5.5 · English | 1 → **0** | 0 → 0 | 0 → 0 | 2 → 0 | 1 → 0 |
| Claude Haiku 5.5 · Chinese | 1 → **0** | 0 → 0 | 0 → 0 | 1 → 1 | 0 → 0 |
| DeepSeek V4.1 Flash · English | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · Chinese | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

**The bar holds on every line.** The one item taken back by the core (Haiku, `zh-want`) is a remark the model wrote after its one reading's "→" line, "Wait — the format requires cite records before the answer. Recording the…", judged the model's working as on main; the reading and its "→" line stayed.

The done time's median, main's 240 → the fresh run, per button (reported, not held; two runs at different times): Haiku English 3.27 → 3.68 s and 2.95 → 2.88 s, Haiku Chinese 3.16 → 2.01 s and 2.67 → 2.61 s; DeepSeek English 2.05 → 1.66 s and 2.76 → 2.64 s, DeepSeek Chinese 2.10 → 1.86 s and 2.92 → 2.55 s ("What do they want?", then "What to ask next").

**Second amendment, before the second fresh run, 2026-11-08.** An independent review of the change found that 60 fresh presses on a model can show no "→" line gone with no fix at all (main lost one in 120 Haiku presses of each language), that #2778 asks for the same 240 presses, and three edges of the form: a reply with no "★", the lead-in line of "Am I leading them?", and a part that runs into the form, which was left unjudged whole. The form now covers the first two and judges such a part by its lines outside the form, with unit tests for each. The fresh run is made again at the head with those fixes, **30 presses a case, 240 in all as main's**, and each cell (60 presses) is read against main's cell, with the same bar. The first fresh run stays above as it was, at 701c53148.


### The second fresh run (2026-11-08, at a5bcb7c84)

240 presses, every one finished: each of the four cases 30 times on Claude Haiku 5.5 (a direct Anthropic key) and on DeepSeek V4.1 Flash 1017 (`deepseek-flash`); both were meant and both ran. Spent $0.11 by the core's count; with the first fresh run, $0.16 of the $2 cap. One-minute load 13.3 at the start and 45.7 at the end (15-minute 12.1 and 21.9), from other work on the machine.

Main's 240 → the head's 240, 60 presses a cell, both buttons together:

| Model · language | a → line shown, then gone at the end | words, then none at the end | no item at the end | an item shown, then taken back by the core | an item shown, then hidden though the reply has it |
|---|---|---|---|---|---|
| Claude Haiku 5.5 · English | 1 → **0** | 0 → 0 | 0 → 0 | 2 → 0 | 1 → 0 |
| Claude Haiku 5.5 · Chinese | 1 → **0** | 0 → 0 | 0 → 0 | 1 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · English | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · Chinese | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

**The bar holds on every line,** in every cell. Two Haiku presses (one a language) showed no words while written and ended with their options, as a reply that comes whole does.

The done time's median, main's 240 → the head's 240 (reported, not held; the end of this run was under heavy load): Haiku English 3.27 → 3.66 s and 2.95 → 2.43 s, Haiku Chinese 3.16 → 2.34 s and 2.67 → 2.62 s; DeepSeek English 2.05 → 2.23 s and 2.76 → 2.38 s, DeepSeek Chinese 2.10 → 2.16 s and 2.92 → 2.78 s ("What do they want?", then "What to ask next").

**The rule narrowed after an independent review, 2026-11-08.** The review found that the form, kept whole from its first option to its last "→" line, spared a model's notes between options, before "Am I leading them?"'s lead-in, among short lines and in a numbered plan, which main took back. The core now spares only a reply's own lines (`helpOwnLines`): an option's or reading's sentence through its "→" line, a "★" line still waiting for its "→" line, a short line, and "Am I leading them?"'s lead-in. Every "→" line is still one of them, so this check's bar is untouched; the runs above were made at the wider rule. Its quality is checked in `call-help-form-kept.md`.


**A third fresh run, written before it, 2026-11-08:** the same 240 presses (30 a case) at 08749fe6e, the narrowed rule, with the same bar and `INCARNAMIND_EVAL_SPEED_STOP_USD=0.5`, inside the $3 approved for the quality check.

### The third fresh run (2026-11-08, at 08749fe6e's code)

240 presses, every one finished, on Claude Haiku 5.5 (a direct Anthropic key) and DeepSeek V4.1 Flash 1017 (`deepseek-flash`); both were meant and both ran. Spent $0.10. One-minute load 5.6 at the start and 10.7 at the end (15-minute 11.2 and 10.0).

| Model · language | a → line shown, then gone at the end | words, then none at the end | no item at the end | an item shown, then taken back by the core | an item shown, then hidden though the reply has it |
|---|---|---|---|---|---|
| Claude Haiku 5.5 · English | 1 → **0** | 0 → 0 | 0 → 0 | 2 → 1 | 1 → 1 |
| Claude Haiku 5.5 · Chinese | 1 → **0** | 0 → 0 | 0 → 0 | 1 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · English | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · Chinese | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

**The bar holds on every line.** The item taken back (Haiku, `en-want`) is a remark the model began after its reading's "→" line, "Note: Before you cite…", drawn as the line being written from 1.2 s to 2.9 s and judged the model's working, as on main. The item hidden (Haiku, `en-want`) is a remark between two readings, "Wait — I must follow the format exactly…", drawn as the line being written and left out once the next reading came: the dated exception above.
