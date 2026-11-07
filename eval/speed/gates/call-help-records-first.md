# The gate for call help in one reply, its records first (#2526)

Written and committed on 2026-11-07, before any run it gates. It holds a step to the bar of `call-help.md`'s last run: ranges over three runs, per language.

## What was measured first

- **Claude Sonnet 5.5 can't stop thinking.** Asked for no thinking, the API answers that it can't be turned off for this model and uses `between_tools`, its least: no thinking before the first reply, and thinking after each Tool's result. The catalog asks for exactly that (`CLAUDE_BETWEEN_TOOLS`).
- **So in the Tool loop its reply comes whole and late.** On today's path in `call-help-writes-first.md`'s runs (on the call rig before its fix, both arms alike), every one of 88 Sonnet presses gave its records first and wrote the reply in a request after `cite`'s result; each such reply came in one piece, a median 4.9 s (English) and 5.2 s (Chinese) after the press, and the press ended there. The first words the panel showed, at 1.3 to 1.5 s, were the model's own notes written before its records, shown and then taken back.
- **Written first, it streams, but cites less of what it says.** That gate's step had the reply written before its records: the first whole option came at 2.7 s instead of 5.0 s, but Chinese false Supported went from 5–7 to 8–11 (three cases in every run), so it was dropped.
- **One structured reply, records first.** Sent straight to the API with a press's Passages, Sonnet 5.5 asked for one JSON object, its records first and the reply after them, began the reply 3.2 s after the request and ended at 3.9 s, in one request and no Tool's result (one sample).

## The step

On a model the list beside the catalog names for `call-help` (`HELPS_IN_ONE_REPLY` in `src/core/providers/catalog/answerPaths.ts`), call help is answered first in one structured reply: its records, then the reply, from the Passages the press was given (the newest lines, the Documents found ahead and those given whole), with no search. The reply shows as it streams; its records are checked once it ends, as any Answer's. A model whose reply isn't JSON after all answers in the Tool loop as before. Unit tests in `tests/core/meetingHelp.test.ts` show both, and that the records come before the reply in what the model is asked for.

## The runs

- **Arms:** `today` against `help-records-first` (`../arms.ts`), paired, as `../README.md` › Paired runs says. `today` is `main`'s path: no model is listed.
- **The set:** the call-help set, all 30 held-out cases, 15 English and 15 Chinese (`../callHelpCases.ts`), heard on the fixed call rig (each turn once). No run of this step has seen it, and no prompt has.
- **Model:** Claude Sonnet 5.5 on a direct Anthropic key, the only one this step lists. Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 aren't listed, so their path is unchanged; they aren't run. The judge is Claude Opus 5.5, the same for both arms.
- **Samples:** three runs of every case (`INCARNAMIND_EVAL_SPEED_RUNS=3`), the arms' order turning case by case and run by run, false Supported counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **Load:** a run starts only once the 15-minute load is 24 or less; a run whose load went above 24 is run again.
- **Spend:** about $5.50. The ledger of this work stops the run before its total passes $16, the cap for this work.

## The bar

Sonnet 5.5 is listed only if it holds every line below. Per language, from each run's per-case records (`report.json`), a range is the lowest and highest of the three runs' counts:

- **False Supported** (cases with a sentence its found Citation doesn't state): the step's range does not sit above today's; its lowest is not above today's highest.
- **Expected Passages cited, judged right and every Citation found:** the step's range does not sit below today's; its highest is not below today's lowest.
- **Done sooner:** the step's median time to the end, over its presses in that language, is below today's.
- **The first whole option sooner:** the step's median time to the first whole option, reading or line is below today's. On today's path the first words are often notes taken back, so the first whole option is the first reply the User can use.

Both languages together:

- **None new:** no more Tool calls left as text, replies that showed nothing, replies written while the live text was behind, or cases failing to run, on the step's arm than on today's.

## Reported, not gated

The first sign and the first words, each a median over the runs and each run's own; where the time went (each request's first byte, first text and end); how often the step's arm answered in its one reply and how often it fell back to the loop; each case with a false Supported, on either arm, with its sentence.

## Result, 2026-11-07: two lines missed; not listed

The runs were made at 1e4c9d92b on a direct Anthropic key, judge Claude Opus 5.5, both arms on the fixed call rig, one-minute load 2.5 to 9.1 (median 5.3). They spent $4.17 (the judge $1.02). Medians over the three runs, today → the step; ranges are the runs' lowest and highest.

| Sonnet 5.5 | First whole option | Done | Done, 90th percentile | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|---|
| en | 4.47 → 2.31 s | 4.47 → 2.76 s | 5.78 → 3.28 s | 3–5 → 5–7 | 15–15 → 13–15 | 13–14 → 12–15 | **15–15 → 13–14** |
| zh-CN | 4.55 → 2.50 s | 4.55 → 3.05 s | 7.05 → 3.60 s | 3–7 → 3–8 | 13–15 → 13–15 | 12–15 → 12–14 | 13–15 → 13–15 |

- Done came sooner in every one of the 87 pairs both arms finished (paired median −1.60 s), and every press of the step was one request.
- **Missed: every Citation found, in English.** en-want's readings quote the call's lines word for word, but four of its eight records named a time a line away; a transcript record with a time is never moved (`takeQuote` in `src/core/answers/citations.ts`), and one structured reply gets no word back from `cite` to fix it, so those quotes stayed not found.
- **Missed: replies that showed nothing, 2 against 0.** Both en-answer-edition: Sonnet wrote the form's "★" and "→" inside the JSON as "β˜…" and "β†’", so the panel found no option. A check of that case gave the same once in two presses.
- Failed to run: 1 on the step against 2 on today's path, all `cache_control cannot be set for empty text blocks` from the API (#2526's comment of 2026-11-07).
- A next try needs both answered (the two form characters read back from that misencoding, and a transcript record's quote placed at the line that holds it, or a fallback to the loop) and a new run of this gate.
