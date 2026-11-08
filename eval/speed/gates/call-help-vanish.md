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

240 presses: each of the four cases 30 times on Claude Haiku 5.5 (a direct Anthropic key) and on DeepSeek V4.1 Flash 1017 (`deepseek-flash`), every press finished. Spent $0.12 by the core's count; with the one-press-a-case smoke run before it ($0.00), $0.12 of $4. One-minute load 2.9 to 4.7 when read during the run. Main's panel read the replies in the run; the branch's (309df83c1) read the same `replies.json` again with no model asked.

Main → branch, both buttons together, 60 presses a cell:

| Model · language | words, then none at the end | an item shown, then hidden though the reply has it | no item at the end | an item shown, then taken back by the core |
|---|---|---|---|---|
| Claude Haiku 5.5 · English | 0 → 0 | 1 → **1** | 0 → 0 | 2 → 2 |
| Claude Haiku 5.5 · Chinese | 0 → 0 | 1 → 0 | 0 → 0 | 1 → 1 |
| DeepSeek V4.1 Flash · English | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| DeepSeek V4.1 Flash · Chinese | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

Over every write of the 240 replies, the branch's panel differs from main's only at the end of those two Haiku presses, and never while a reply is written.

**The bar:** lines 1, 3 and 4 hold in every cell. Line 2 fails as written in one cell: one Claude Haiku 5.5 English press, the same press on main.

## How the run was read (added after it)

- **The cause, in both presses main's panel hid an item at the end:** Haiku wrote two readings, each with its "→" line, then recorded its Citations; the core's judgement of the model's working took back the last reading's "→" line, and main's panel drops an item with no "→" line once the reply ends. A reply of one option or reading that loses its "→" line this way ends with only the heading, which is #2767's report; none of these 240 replies was of one item, so none ended empty on either panel. The unit tests read these two replies, and four one-item replies (a reading and an option in each language) made from recorded ones with their "→" line taken back, each red on main.
- **The press that fails line 2 on the branch** (Haiku, `en-want`): between its two readings the model wrote "Actually, a more explicit reading of their last lines:", drawn for 0.1 s as the line being written and left out as a remark once the next reading came. Main draws it the same way. While a line after the first option is written, the panel can't tell a remark from the second option, and #2728's tests hold that the second option shows as it is written. Line 2 stays failed for this cell as written; whether this ships is not decided here.
