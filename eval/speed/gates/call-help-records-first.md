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
- **Missed: every Citation found, in English.** Five of en-want's eight records were not found, though each quotes one of the call's lines word for word. The likely cause, not yet traced: the time each record gave. A transcript record that gives a time is never moved within its Passage (`takeQuote` in `src/core/answers/citations.ts`), and one structured reply gets no word back from `cite` to fix it, as the loop's model does.
- **Missed: replies that showed nothing, 2 against 0.** Both en-answer-edition: Sonnet wrote the form's "★" and "→" inside the JSON as "β˜…" and "β†’", so the panel found no option. A check of that case gave the same once in two presses.
- Failed to run: 1 on the step against 2 on today's path, all `cache_control cannot be set for empty text blocks` from the API (#2526's comment of 2026-11-07).
- A next try needs both answered (the two form characters read back from that misencoding, and en-want's records traced, then placed at the line that holds their quote or sent back to the loop) and a new run of this gate.

## The second run (written on 2026-11-07, before it)

Both missed lines were traced to the reply's shape, and the step changes only there. The bar, the set, the model, the judge, the samples and the arms are as above, on the fixed call rig. The set has been seen by this step's first run; nothing in a prompt names or quotes a case.

- **The form's marks.** Inside the JSON, Sonnet 5.5 wrote "★" and "→" itself, as the characters, as `★` and `→`, and twice as their bytes read in another encoding ("β˜…", "β†’"), which no option was laid out from. Now the reply after the records is fields, `lead` and `items` of `line`, `moment` and `leadsTo`, and IncarnaMind writes "★", "→" and "- " as `<help>` shows (`helpReplyText` in `src/core/answers/meetingHelp.ts`). `<help>` itself is unchanged, so a model that answers in the loop gets the form as before.
- **en-want's records.** Read from the stored records: each not found was `pages-outside-passage`, the location unresolved in the transcript Passage that holds the line, which was the one named; the raw records gave locations such as `[5:56–6:05]`. In the loop, `cite` asks the model to fix such a record; one structured reply can't be asked, and `main`'s structured output (a small local model's) has the same gap. The records-first rules now say a Transcript line's location is the time on that line's own mark, such as "6:00". The matcher is unchanged.
- **No text.** A reply whose records came with no item now answers in the loop, as one that isn't JSON does.

## The second run, 2026-11-07: English passes; Chinese unfinished

At 6e7ad6279 on the direct Anthropic key, fixed call rig, judge Claude Opus 5.5, load 4.8–12.5; $2.59 spent when the key ran out of credit, after English's 15 cases (three runs each) and 4 of Chinese's 15. Today → the step, on the pairs both arms finished:

| Sonnet 5.5 | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|
| en (44 pairs) | 4.34 → 2.58 s | 4.34 → 2.99 s | 2–6 → 2–4 | 13–15 → 14–15 | 14–15 → 14–15 | 13–15 → 14–15 |
| zh-CN (4 cases, 10 pairs) | 4.35 → 2.42 s | 4.35 → 2.87 s | 0–1 → 0–1 | 3–4 → 3–4 | 3–4 → 3–4 | 3–4 → 3–4 |

English holds every line: done sooner in 43 of 44 pairs, every step press one request, no reply that showed nothing. The one failed press, on today's path, was the evaluation's judge (#2701). Chinese's other 10 cases wait for a funded direct key, on this same route, before any model is listed.

Not through OpenRouter: there Sonnet 5.5 doesn't think between Tools, today's path ended at 2.9 s and 3.7 s on two presses against 3.5 s and 3.9 s for the step, so the step is listed, if at all, for the direct route only. On Claude Haiku 5.5 (through OpenRouter) and DeepSeek V4.1 Flash 1017, four presses each: done 0.4–1.0 s sooner, but the first whole option 0.5–1.0 s later, as those models already write the reply in their first request; not run as a gate.

## DeepSeek V4.1 Flash 1017 (written on 2026-11-07, before its run)

The same step, arms, set, fixed rig, samples and bar as above, on DeepSeek V4.1 Flash 1017 (`deepseek-flash`) on its own key, for a `call-help` entry of its own. The judge is DeepSeek V4 Pro (`deepseek-v4-pro`), not the model under test and the same for both arms; no Claude judge is funded for this run. DeepSeek is listed only if it holds every line on its own runs. Four presses already seen (en-answer-sso, en-say-records, zh-want, zh-ask-agents) ended 0.4–0.8 s sooner on three and 0.8 s later on one, with the first whole option later on three: DeepSeek already writes its reply in its first request, so the first-option line may not hold. Today's path on this run is also the measure of call help on DeepSeek, reported per language.

## The second run restarted whole (written on 2026-11-07, before it)

The key that ran the second run (direct Anthropic) ran out of credit after English and 4 of Chinese's cases. The runs that decide are now one whole run of the second run's design on another key of the same direct Anthropic route (the owner's word of 2026-11-07 allows it): the account that pays doesn't change the model, the endpoint or the request. It starts whole rather than finishing Chinese, because the evaluation's judge changed in between (a judge whose first reply is empty is asked again without it, #2701), and one Chinese case was cut off mid-run. The bar, the set, the fixed rig, the arms, the model and the judge are as above; the partial run is reported, not used.

## DeepSeek V4.1 Flash 1017, 2026-11-07: one line missed; not listed

At bb7b63aab, DeepSeek's own key, judge DeepSeek V4 Pro, fixed rig, one-minute load 6.1–22.9 (median 12.1); $0.34 (the judge $0.28). Today → the step, all 90 pairs finished:

| DeepSeek V4.1 Flash | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|
| en | 2.54 → 1.74 s | 2.97 → 2.14 s | 2–4 → 1–4 | 13–14 → 14–14 | 9–12 → 11–14 | 14–15 → 14–15 |
| zh-CN | **1.45 → 1.72 s** | 2.97 → 1.97 s | 2–3 → 2–3 | 12–15 → 13–14 | 10–12 → 11–12 | 15–15 → 15–15 |

Every quality line holds and done is a second sooner in both languages (sooner in 83 of 90 pairs, one request in 89 of 90), but in Chinese the first whole option comes later: on today's path DeepSeek already writes its Chinese reply in its first request, and the records now come before it. Today's path here is also call help's measure on DeepSeek: the first whole option at 2.54 s (English) and 1.45 s (Chinese), done at 2.97 s in both.

## The restarted second run, 2026-11-07: one line missed; not listed

At 78eafccb4 on the direct Anthropic route (another key, same model and endpoint), fixed rig, judge Claude Opus 5.5, one-minute load 5.5–39.9 (median 12.8; a run whose 15-minute load passed 24 would be rerun, and none did); $4.26 (the judge $1.04). Today → the step, all 90 pairs finished:

| Sonnet 5.5 | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|
| en | 4.37 → 2.72 s | 4.37 → 3.11 s | 3–4 → 2–3 | 14–15 → 14–15 | 14–15 → 14–14 | 14–15 → 14–15 |
| zh-CN | 4.72 → 2.81 s | 4.72 → 3.31 s | 4–8 → 4–6 | 15–15 → 15–15 | **15–15 → 12–14** | 14–15 → 14–15 |

Done came sooner in 86 of 90 pairs (paired median −1.54 s), every step press was one request, and no reply showed nothing or failed. But in Chinese, judged right fell below today's lowest run: zh-say-records (twice), zh-sum, zh-check-wrong, zh-no-price and zh-answer-unknown (once each) went from right to partly, each a reply that left out part of what today's covered or added a sentence its quote doesn't state. As written, the step fails, and no model is listed. The set has now been seen by three runs of this step; a next try needs a held-out set of its own.
