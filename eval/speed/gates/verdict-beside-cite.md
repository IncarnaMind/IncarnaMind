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
