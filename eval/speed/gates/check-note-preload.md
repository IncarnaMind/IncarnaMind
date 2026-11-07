# The gate for loading the reranker while the claims are named, and twelve at once on it (#2532)

Written and committed on 2026-11-07, before any run it gates. It follows `check-note-speed.md`, whose gates A, B and the head's rerun it builds on; its gate C, on the reranker's GPU copy, is in #2695.

## The steps

1. **The reranker loads while the claims are named.** Check this Note asks the built-in reranker to load once its model is ready and before the reply naming the claims, so the first sentence's search finds it loaded instead of starting it and waiting for its model. Nothing loads with reranking off or on a service. No request, Passage or score changes; only when the model loads.
2. **Twelve at once for Check this Note,** on top of step 1. The write, Verify and the background watch keep six.

## Measured before this gate, reported and not gated

Six traced runs of Claude Haiku 5.5 on the mixed Library (three at six, three at twelve, alternating, on `main`), with the reranker's own thread timed:

- A run's first rerank starts the reranker. Building its tokenizer took 0.31 to 0.55 s; opening it on the GPU and scoring its check took 0.17 to 1.4 s, the longest for the first language in a process.
- The load took as long at twelve as at six. The core's thread never held it up: its event loop's delay was 20 to 31 ms at the 99th percentile, 79 ms at most, and each search was sent to the reranker within a few milliseconds of the last one's answer.
- Gate C's longer loads at twelve, 2.1 to 2.4 s in three of six runs, did not come back.
- At twelve the provider's slowest first bytes grew a little (the 90th percentile 0.95 → 1.11 s), with the same requests per sentence and the same median wait.

## The runs

`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note` (`../README.md` › Where a check's time goes), on a direct Anthropic key.

- **Arms:**
  - `main` is `origin/main` at the commit this branch starts from (six at once).
  - `preload` is this pull request's commit with step 1 (six at once).
  - `twelve` is that commit with step 2 on top.
  All three run the same `checkTimes.ts` and `checkTimes.speed.ts`.
- **Order:** one process per arm and run, `main`, `preload`, `twelve`, three times over; each process runs English, then Chinese, once.
- **Cells,** each a model, language and Library, three runs per arm:
  - Claude Haiku 5.5 on the timing's Library and on the mixed Library (`INCARNAMIND_EVAL_SPEED_LIBRARY=mixed`).
  - Claude Sonnet 5.5 on the timing's Library.
- **Load:** a process starts only once the 15-minute load is 24 or less, and a run whose 15-minute load was above 24 is run again. Each run's load is in the table.
- **Reported, not gated:**
  - Each run's first rerank (the one that loaded the model on `main`) and its rerank median.
  - Haiku's arms once each on DeepSeek V4.1 Flash 1017 (`deepseek-flash`).
- **Cost:** about $3.20 for all three arms. The runs stop before this work's spend passes its $12 cap.

## Gate D: step 1 against `main`, per cell

- **First verdict:** `preload`'s median first verdict is not later than `main`'s by more than `main`'s spread in that cell (its runs' largest minus smallest first verdict), and never by more than 1.0 s.
- **Done:** `preload`'s median end is not later than `main`'s by more than `main`'s spread of ends in that cell.
- **What it must show:** on the mixed Library, in both languages, `preload`'s median first rerank is shorter than `main`'s: the first sentence's search no longer waits for the load.
- **No failure:** no request fails and no rate limit is met on `preload`.

## Gate E: step 2 against step 1, per cell

Gate C's bars, unchanged:
- **Done:** `twelve`'s median end comes before `preload`'s.
- **First verdict:** `twelve`'s median first verdict is not later than `preload`'s by more than `preload`'s spread in that cell, and never by more than 1.0 s.
- **No failure:** no request fails and no rate limit is met at twelve.

## The verdict bars, for each gate, per model, both languages and Libraries together

Over the runs both arms finished, the later arm against the earlier one:

- **No new false Supported:** no sentence the Documents don't state is Supported in more of the later arm's runs than of the earlier one's.
- **Judged right** (Supported for a sentence they state, anything else for one they don't) no lower than the earlier arm's by more than one in 30, rounded down.
- **Not checked** no higher than the earlier arm's by more than one in 30, rounded down.

## What decides

- **Step 1** ships if gate D holds in every cell and on both models' verdict bars.
- **Step 2** ships, in a pull request of its own after step 1, only if gate D holds and gate E holds in every cell and on both models' verdict bars. Otherwise Check this Note stays at six, and the failing cell is named.
