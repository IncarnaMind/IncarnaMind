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
