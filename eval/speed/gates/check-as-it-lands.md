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
