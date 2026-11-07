# The gate for the verdict beside `cite` (#2532)

Written and committed on 2026-11-07 with its held-out set (`../writtenHeldOut3.ts`), before any run and before the step's instruction was written.

## The step

A sentence's check today takes three requests in a row: a search, then `cite` to record the deciding quote, then the verdict, written once `cite` has returned. The Tool loop already ends a check's Run at a step whose words read as its reply and whose only calls are records, once every record's quote is found (`src/core/answers/engine.ts`, `endsAfter`). The step tells a listed model to write its verdict lines in the same reply as `cite`, after recording the quote. A quote that isn't found still sends the model back, as today, and a reply with no verdict still asks for one, as today. One request fewer per sentence: about 1.2 s on Claude Haiku 5.5 and 2.2 s on Claude Sonnet 5.5 (#2532).

It changes the check's instructions, so it runs only for a model on its list beside the catalog (`src/core/providers/catalog/checkPaths.ts`). A model goes on the list only if it holds every bar below.

## The runs

`INCARNAMIND_EVAL_SPEED_PAIRED=today,verdict-beside-cite`, `INCARNAMIND_EVAL_SPEED_SETS=written3` (`../README.md` › Paired runs), on a direct Anthropic key:

- **The set:** the third held-out set's 26 sentences, 13 in English and 13 in Chinese. Each is written into a Note of its own, in a Library of only its terms, with one Citation. 10 are stated, word for word or in other words. 16 are not: may for must and must for may, the parties the other way round, a condition dropped, a line a lead-in limits to some customers, and a rule a later "notwithstanding" overrides.
- **The arms:** `today` checks as `main` does; `verdict-beside-cite` has the model write its verdict beside `cite`. Both run in the same process, item by item, the order turning.
- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5, each the Answers model under test.
- **Runs:** two of the whole set per model (`INCARNAMIND_EVAL_SPEED_RUNS=2`).
- **Margin:** `INCARNAMIND_EVAL_SPEED_MARGIN=1`.
- **Load:** the run starts only once the 15-minute load is 24 or less.
- **Cost:** about $2.50. The runs stop before this work's spend passes its $12 cap.

## The bars, per model, over the items both arms finished

- **No new false Supported:** no sentence the terms don't state is Supported on `verdict-beside-cite` in a run where `today` didn't Support it. The arm stops at its first.
- **Judged right** (Supported for a stated sentence, anything else for one not stated) no lower than `today`'s by more than one in 30.
- **Not checked** no higher than `today`'s by more than one in 30.
- **Faster:** fewer model calls per checked sentence at the median, and a lower median time per checked sentence, than `today`.

## Reported, not gated

- Each verdict's reply: whether it came beside `cite` or after it.
- How often a quote wasn't found and sent the model back.
- For a listed model, Check this Note's times on the timing Library, `main` against this pull request, once each (`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note`).

## What decides

A model goes on the list only if it holds every bar. A model that fails a bar stays off the list, and its numbers go on #2532.

## Result, 2026-11-07: no model is listed

Claude Haiku 5.5 and Claude Sonnet 5.5 each fail the first bar on a sentence that drops a condition of the terms. DeepSeek V4.1 Flash 1017 holds every bar on the set, then gave a false Supported in the timed Notes that today's check didn't, so it stays off too. The list ships empty, with the instruction, the set and the arm, so a next wording starts from them.

**The gate, at 536b10081,** each model's arms on one route, item by item:

| Model, route | Items both finished | Calls a sentence | Done, median | Judged right | False Supported | Other guard failed | Holds |
|---|--:|--:|--:|--:|--:|--:|---|
| Haiku 5.5, OpenRouter | 19, stopped at `w3-en-condition-deposit` | 4.84 → 3.84 | 6.2 → 5.5 s | 18 → 17 | 0 → 1, new | 0 → 2 | no |
| Sonnet 5.5, direct key | 45, stopped at `w3-zh-condition-deposit` | 4.00 → 3.29 | 6.8 → 6.7 s | 39 → 38 | 4 → 4, one new | 4 → 7 | no |
| DeepSeek V4.1 Flash, DeepSeek | 52, the whole set twice | 4.81 → 3.96 | 5.8 → 4.5 s | 44 → 44 | 8 → 6, none new | 8 → 8 | yes |

- **Haiku** ran through OpenRouter (`anthropic/claude-haiku-5.5`), the direct keys being out of credit then: same model, another route. DeepSeek ran in the same process until it stopped, 18 items, every guard held.
- **Sonnet** ran on a direct key and was judged by Claude Opus 5.5. On the English dropped-condition decoys `today` gave a false Supported in all four runs, as the step did in three.
- **DeepSeek** ran under this work's rule that a new gate runs it beside Haiku, though the Models line above names only the Claude models. On the step, Chinese `w3-zh-condition-deposit` went from a false Supported to Not checked; nothing went the other way.
- **Not split out by the report:** whether each verdict came beside `cite`, and how often a quote sent the model back. The calls a sentence stand for both.

**DeepSeek's timed Notes** (`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note`, the timing Library, four runs an arm and language: one each, then three each). Off the list is this branch sending `main`'s requests word for word; on the list is b89b32bca. The 15-minute load was 14.6 to 16.8.

| Language | First verdict, median | Done, median | Judged right | False Supported |
|---|--:|--:|--:|--:|
| en | 5.0 → 4.3 s | 11.4 → 11.0 s | 37 → 35 of 40 | 0 → 1 |
| zh-CN | 4.9 → 4.3 s | 10.7 → 9.6 s | 39 → 38 of 40 | 0 → 0 |

The false Supported is English sentence 3, "Staff may work from home two days a week.", which the agreement only partly states: Supported in one of four runs on the list. `main` Supported the same sentence on DeepSeek once before, on the mixed Library (`check-note-preload.md`). That doesn't waive it. The list's bar is no new false Supported, so b89b32bca's entry is taken off in the commit after it. Sentence 7, a stated paraphrase, ended Unsupported in two of four runs off the list and three of four on it.

**Before the gate:**
- **The first wording** ("record the quote, then write the verdict", at bf4faa89a), Haiku and Sonnet on a direct key, was stopped by hand after five English items twice each. Neither model followed it: the step took as many calls as `today`. Every verdict was right on both arms. The wording was then changed on the first written set, which earlier runs had seen (8c3d5a8c8); this set wasn't used to tune it.
- **A run at 8c3d5a8c8,** Haiku through OpenRouter and DeepSeek, read the 13 English items twice each, then stopped: the Chinese pages couldn't be drawn, and the English "sell" line ran off its page, so its quote wasn't found. In that half, Haiku's `today` Supported `w3-en-condition-deposit` in both runs and the step in neither; DeepSeek Supported it on both arms in one run. The pages were repaired at 536b10081 and the gate run again, whole.

**Spent on this step:** about $2.21. That is about $0.35 for the stopped first run, about $0.70 for the wording's probes and the run that stopped at the pages, then $0.08 for Haiku, $0.97 for Sonnet, $0.04 for DeepSeek and $0.07 for the timed Notes.
