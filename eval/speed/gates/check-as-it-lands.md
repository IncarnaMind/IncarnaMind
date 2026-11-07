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

## Result, 2026-11-07

All 36 runs ran on one route per model: Claude Haiku 5.5 and Claude Sonnet 5.5 on the direct Anthropic route, DeepSeek V4.1 Flash 1017 on DeepSeek's API; `main` at 01677e631 with the flow added, the step at b3c945449. Seconds; medians of three runs. "Lead": how long before the write's input ended its first written check began, each run (on `main`, always 0.1 to 0.2 s after).

| Cell | Done, `main` → step | First written check, `main` → step | Lead, step | Not checked in the cap, `main` → step | Bars it fails |
|---|---|---|---|---|---|
| Haiku, English | 56.4 → 56.6 | 25.8 → 20.4 | −0.2, 4.8, 2.5 | 4 → 5 | 1, 3 (a 74.4 s run against 67.2), 4 |
| Haiku, Chinese | 47.6 → 52.5 | 24.9 → 18.3 | −0.1, −0.1, 1.8 | 8 → 4 | 1 |
| Sonnet, English | 27.2 → 33.2 | 11.3 → 9.1 | 1.0, 1.9, 2.2 | 0 → 0 | 1 |
| Sonnet, Chinese | 29.6 → 24.6 | 10.2 → 9.4 | 0.7, 1.8, 0.4 | 2 → 2 | none |
| DeepSeek, English | 95.9 → 86.4 | 73.9 → 67.4 | 2.2, 2.7, 3.2 | 1 → 3 | 4 |
| DeepSeek, Chinese | 74.3 → 87.5 | 45.3 → 69.6 | 5.2, 2.5, 2.7 | 3 → 3 | 1, 2, 3 (a 103.5 s run against 77.7) |

- No written-check request failed or met a rate limit in any run of either arm. The sentences not checked inside the cap were not checked for what the check found (no evidence, a reply it couldn't read, an empty sentence), never a request that failed.
- Bar 5 holds: the request equivalence tests pass unchanged, and the figure and streaming tests pass.
- #1635's Sonnet bar, from the step's runs: first change 9.0 s in English (15.2, 7.7, 9.0) and 7.5 s in Chinese; Done 33.2 s and 24.6 s. It holds in Chinese only.
- Written-check requests per write, `main` → step (medians): Haiku 51 → 48 and 43 → 48; Sonnet 24 → 27 and 24 → 13; DeepSeek 53 → 48 and 64 → 69.

What the runs show: on the step the first check began while the write was still coming in, 0.4 to 5.2 s before its end, in 15 of 18 runs; the three that didn't came in at once or held figures. Done moves between runs of one arm by 3 to 40 s with what the model searches and how much it writes, more than this step can move it, so three runs a cell can't show a gain of a few seconds either way.

The gate fails: bar 1 in four cells, bar 3 in two, bar 4 in two, bar 2 in one. What ships is the decision below. Spent: $3.08 (Sonnet $2.37, Haiku $0.37, DeepSeek $0.34).
