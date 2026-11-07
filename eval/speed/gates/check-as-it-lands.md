# The gate for checking each paragraph as it lands (#1635)

Written and committed on 2026-11-07, before any run it gates.

## The step

When the assistant writes into a Note and its text streams in, each finished paragraph's cited sentences start their checks as the paragraph lands, instead of all of them after the whole text is in. It is still one check of the whole write: one request, the first 12 cited sentences in the write's order, one limit on checks at once across the write, and a table's marks and a cut still land together after every check (#2534). A write taken back while it streams stops its check and lands nothing more.

## The runs

- **Arms:** `main`, the commit this step is built on, with `assistant-write-long` (eight paragraphs) added to its `eval/speed/flows.ts` and no other change; and `step`, the head of the pull request. Both run `npm run eval:speed`, flows only.
- **Order:** one process per arm, model, language and run, alternating `main`, `step`, `main`, `step`, so neither always meets a warm cache or a quieter machine.
- **Cells**, each a model and a language, three runs per arm, of `assistant-write-long`:
  - DeepSeek V4.1 Flash 1017 (`deepseek-flash`), English and Chinese.
  - Claude Haiku 5.5 through OpenRouter (`anthropic/claude-haiku-5.5`), English and Chinese.
  - Claude Sonnet 5.5 is not run: the OpenRouter share for this work is $3, and Sonnet's cells would cost about that alone.
- **Load:** a run starts only while the 15-minute load is at most 24.
- **Cost:** Haiku about $0.60 through OpenRouter; DeepSeek about $1.

## The bars, per cell

1. **Sooner:** the step's median Done is lower than `main`'s.
2. **The check starts sooner:** the step's median start of the first written-check request, from the User's action, is earlier than `main`'s.
3. **No later by much:** no single run's Done on the step is later than `main`'s slowest run in the cell by more than `main`'s own spread (its slowest minus its fastest).
4. **No worse checks:** on the step, no more written-check requests fail or meet a rate limit than on `main`, over the cell, and no more of the write's cited sentences land Not checked for a reason other than the 12-sentence cap.
5. **The same requests:** `tests/core/writtenChecks.test.ts`' normalized request equivalence tests pass unchanged: a sentence's check sends what it sends on `main`, whenever it starts.

## What decides

The step ships if every cell holds every bar. If a cell fails one, the pull request names it with its numbers, and what ships is decided in a dated note below, not by reading these bars again.

## Amended 2026-11-07, before any Claude cell ran

The direct Anthropic route answers again, so the Claude cells run on it, not through OpenRouter: Claude Haiku 5.5 (`claude-haiku-5-5`) and Claude Sonnet 5.5 (`claude-sonnet-5-5`), English and Chinese, three runs per arm, alternating as above. Sonnet's cells also give #1635's own bar for this write: its first paragraph under 8 s and its end under 25 s, read from the step's runs (reported, not one of this gate's bars). The DeepSeek cells, already running, finish as written. The bars are unchanged.

## Amended again 2026-11-07, before any counted run

The independent pre-review found the first version could check more of a write's sentences at once than its check holds, and read a figure before the Note's later paragraphs were in. Six DeepSeek runs had been made on that version; they are not counted, and every cell runs fresh on the version below.

- **The step now:** one run checks the write's sentences, pushed in as their paragraphs land, so one limit at once, one pause and one stop hold for all of them. The first 12 cited sentences in the write's order are the ones checked, as before. A sentence with a digit waits for the whole write, as a figure is read with the Note's language and number separators. A write taken back sends nothing more.
- **Bar 4** is read from each run's kept data folder (`INCARNAMIND_EVAL_KEEP_DATA=1`): the write's tool call's `selfCheck` (`failed` and its reasons from the marks) and its written-check requests in `ai_timings`.
- **Bar 5** now reads: a sentence with no digit sends what it sends on `main`, whenever it starts (the normalized equivalence tests and the streaming tests in `tests/core/writtenChecks.test.ts`); a sentence with a digit is checked only once the whole write is in (a test holds that it waits).
- **Reported, not a bar:** written-check requests per write, each arm.

The other bars are unchanged.

## Amended a third time 2026-11-07, before any counted run

A second review found the digit rule missed figures written without digits (Chinese numerals such as 百分之二十五, ², ½). DeepSeek's English cell had run on the version before; it is not counted, and every cell runs fresh. The step now holds back, until the whole write is in, any sentence whose read finds a figure, or that has a digit; a held sentence lands in its place in the write's order, as on `main`. While the call's input is still coming in, its row says it is writing, as on `main`; the count of sentences being checked shows once the input is whole. Bar 5 reads: a sentence with no figure and no digit sends what it sends on `main`, whenever it starts. The other bars are unchanged.
