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

## Result, 2026-11-07: gate D met, so the reranker loads while the claims are named; gate E not met, so Check this Note stays at six

The runs were made at 2afea5b0f (`main`), 06e949710 (`preload`) and b0ba53c17 (`twelve`; f6bf40e1a here is the same change), in the order above, on a direct Anthropic key, with the 15-minute load at 5.8 to 7.6. They spent $3.06. Medians are given earlier arm → later arm; the spread is the earlier arm's runs' largest minus smallest first verdict.

### Gate D: `main` → `preload`: met

| Cell | First verdict | Spread | Done | First rerank that scored | Holds |
|---|---|--:|---|---|---|
| Haiku, timing Library, en | 5.1 → 4.8 s | 0.8 s | 12.5 → 11.1 s | 0.8 → 0.1 s | yes |
| Haiku, timing Library, zh-CN | 5.3 → 4.0 s | 1.3 s | 11.3 → 10.4 s | 1.4 → 0.0 s | yes |
| Haiku, mixed Library, en | 6.9 → 5.7 s | 1.4 s | 16.0 → 17.3 s | 1.0 → 0.4 s | yes: the end 1.3 s later, within `main`'s spread of 1.7 s |
| Haiku, mixed Library, zh-CN | 6.1 → 6.1 s | 1.9 s | 13.8 → 11.9 s | 0.8 → 0.3 s | yes |
| Sonnet, timing Library, en | 7.2 → 7.0 s | 0.4 s | 15.9 → 16.3 s | 0.1 → 0.1 s | yes: the end within `main`'s spread |
| Sonnet, timing Library, zh-CN | 7.0 → 6.9 s | 1.0 s | 14.6 → 15.4 s | 0.0 → 0.0 s | yes: the end within `main`'s spread |

- **What it had to show:** on the mixed Library the first search's rerank fell from 1.0 to 0.4 s in English and from 0.8 to 0.3 s in Chinese; it no longer waits for the load.
- **No failure:** no request failed and no rate limit was met.
- **Verdicts:** on Claude Haiku 5.5, judged right 115 → 118 of 120, false Supported 0 → 0, Not checked 6 → 4; on Claude Sonnet 5.5, judged right 60 of 60 on both arms, false Supported 0 → 0, Not checked 0 → 1.

### Gate E: `preload` → `twelve`: not met

| Cell | First verdict | Spread | Done | Rerank median | Holds |
|---|---|--:|---|---|---|
| Haiku, timing Library, en | 4.8 → 4.6 s | 1.8 s | 11.1 → 7.6 s | 0.1 → 0.0 s | yes |
| Haiku, timing Library, zh-CN | 4.0 → 4.6 s | 0.9 s | 10.4 → 7.0 s | 0.0 → 0.0 s | yes: 0.6 s later, within its spread |
| Haiku, mixed Library, en | 5.7 → 6.2 s | 2.2 s | 17.3 → 11.6 s | 1.0 → 2.1 s | yes: 0.5 s later |
| Haiku, mixed Library, zh-CN | 6.1 → 5.2 s | 1.4 s | 11.9 → 11.3 s | 0.5 → 2.2 s | yes |
| Sonnet, timing Library, en | 7.0 → 6.5 s | 0.6 s | 16.3 → 12.4 s | 0.0 → 0.0 s | yes |
| Sonnet, timing Library, zh-CN | 6.9 → 6.8 s | 1.0 s | 15.4 → 10.9 s | 0.0 → 0.0 s | yes |

- **Every timing bar is met,** the mixed Library's first verdict included, for the first time; no request failed and no rate limit was met at twelve.
- **The verdict bar on Claude Haiku 5.5 is not met:** Chinese sentence 3 on the mixed Library was Supported in one of twelve's three runs and none of the preload's. It is the sentence `main` Supported in 2 of gate A's 3 runs, and six in one of gate C's; that doesn't waive it. Otherwise judged right 118 → 116 of 120 and Not checked 4 → 2. On Claude Sonnet 5.5, judged right 60 → 59 of 60, no false Supported, Not checked 1 → 1.

### Each run

The spreads in the tables above are worked from unrounded times, so three of them differ by 0.1 s from the rounded first verdicts below; no bar changes either way.

The text above, written before the runs, stands as written, with three corrections that change no bar:
- **The traced runs:** twelve's were `main` with twelve at once on top, not `main` itself.
- **Processes:** each arm and run took two processes, one per Library, since the mixed Library is set for a whole process.
- **The Sonnet cells can't show step 1:** Sonnet runs after Haiku in the same Library, so the reranker was loaded before its first search on every arm. They are the control: their ends moved +0.4 and +0.8 s with nothing changed for them, within `main`'s spreads of ends of 1.2 and 1.3 s.

| Arm | Run | Model, Library | Language | 15-minute load | First rerank that scored | Rerank median | First verdict | Done |
|---|--:|---|---|--:|--:|--:|--:|--:|
| `main` | 1 | Haiku, timing | en | 6.0 | 2.1 s | 1.3 s | 5.6 s | 12.9 s |
| `main` | 1 | Sonnet, timing | en | 6.0 | 0.1 s | 0.0 s | 7.1 s | 16.6 s |
| `main` | 1 | Haiku, timing | zh-CN | 6.0 | 0.6 s | 0.0 s | 4.6 s | 12.9 s |
| `main` | 1 | Sonnet, timing | zh-CN | 6.0 | 0.0 s | 0.0 s | 7.5 s | 14.6 s |
| `main` | 1 | Haiku, mixed | en | 5.9 | 1.0 s | 1.6 s | 6.9 s | 16.5 s |
| `main` | 1 | Haiku, mixed | zh-CN | 5.9 | 1.0 s | 0.9 s | 5.7 s | 13.8 s |
| `main` | 2 | Haiku, timing | en | 7.2 | 0.8 s | 0.6 s | 4.7 s | 11.9 s |
| `main` | 2 | Sonnet, timing | en | 7.2 | 0.0 s | 0.0 s | 7.2 s | 15.4 s |
| `main` | 2 | Haiku, timing | zh-CN | 7.2 | 1.4 s | 0.0 s | 5.9 s | 11.3 s |
| `main` | 2 | Sonnet, timing | zh-CN | 7.2 | 0.1 s | 0.0 s | 6.5 s | 14.2 s |
| `main` | 2 | Haiku, mixed | en | 7.2 | 0.9 s | 1.4 s | 6.9 s | 14.8 s |
| `main` | 2 | Haiku, mixed | zh-CN | 7.2 | 0.6 s | 0.8 s | 7.6 s | 15.1 s |
| `main` | 3 | Haiku, timing | en | 6.8 | 0.8 s | 0.0 s | 5.1 s | 12.5 s |
| `main` | 3 | Sonnet, timing | en | 6.8 | 0.2 s | 0.1 s | 7.5 s | 15.9 s |
| `main` | 3 | Haiku, timing | zh-CN | 6.8 | 1.6 s | 0.0 s | 5.3 s | 11.1 s |
| `main` | 3 | Sonnet, timing | zh-CN | 6.8 | 0.0 s | 0.0 s | 7.0 s | 15.5 s |
| `main` | 3 | Haiku, mixed | en | 6.8 | 1.4 s | 2.2 s | 5.6 s | 16.0 s |
| `main` | 3 | Haiku, mixed | zh-CN | 6.8 | 0.8 s | 0.6 s | 6.1 s | 12.9 s |
| `preload` | 1 | Haiku, timing | en | 5.8 | 0.1 s | 0.1 s | 4.1 s | 10.7 s |
| `preload` | 1 | Sonnet, timing | en | 5.8 | 0.1 s | 0.0 s | 6.8 s | 16.3 s |
| `preload` | 1 | Haiku, timing | zh-CN | 5.8 | 0.0 s | 0.0 s | 3.7 s | 12.1 s |
| `preload` | 1 | Sonnet, timing | zh-CN | 5.8 | 0.0 s | 0.0 s | 7.6 s | 15.8 s |
| `preload` | 1 | Haiku, mixed | en | 6.0 | 0.4 s | 0.9 s | 4.8 s | 17.5 s |
| `preload` | 1 | Haiku, mixed | zh-CN | 6.0 | 0.3 s | 0.4 s | 6.2 s | 14.3 s |
| `preload` | 2 | Haiku, timing | en | 7.0 | 0.1 s | 0.1 s | 4.8 s | 11.1 s |
| `preload` | 2 | Sonnet, timing | en | 7.0 | 0.1 s | 0.1 s | 7.4 s | 15.5 s |
| `preload` | 2 | Haiku, timing | zh-CN | 7.0 | 0.1 s | 0.0 s | 4.0 s | 9.3 s |
| `preload` | 2 | Sonnet, timing | zh-CN | 7.0 | 0.0 s | 0.0 s | 6.6 s | 15.4 s |
| `preload` | 2 | Haiku, mixed | en | 7.0 | 0.8 s | 1.5 s | 7.0 s | 17.3 s |
| `preload` | 2 | Haiku, mixed | zh-CN | 7.0 | 0.2 s | 0.5 s | 6.1 s | 11.7 s |
| `preload` | 3 | Haiku, timing | en | 6.8 | 0.1 s | 0.0 s | 5.8 s | 11.6 s |
| `preload` | 3 | Sonnet, timing | en | 6.8 | 0.1 s | 0.0 s | 7.0 s | 16.6 s |
| `preload` | 3 | Haiku, timing | zh-CN | 6.8 | 0.0 s | 0.0 s | 4.6 s | 10.4 s |
| `preload` | 3 | Sonnet, timing | zh-CN | 6.8 | 0.0 s | 0.0 s | 6.9 s | 14.1 s |
| `preload` | 3 | Haiku, mixed | en | 6.9 | 0.4 s | 1.0 s | 5.7 s | 13.1 s |
| `preload` | 3 | Haiku, mixed | zh-CN | 6.9 | 0.5 s | 0.5 s | 4.8 s | 11.9 s |
| `twelve` | 1 | Haiku, timing | en | 7.3 | 0.1 s | 0.0 s | 4.7 s | 7.8 s |
| `twelve` | 1 | Sonnet, timing | en | 7.3 | 0.1 s | 0.0 s | 7.2 s | 12.4 s |
| `twelve` | 1 | Haiku, timing | zh-CN | 7.3 | 0.1 s | 0.0 s | 4.6 s | 7.0 s |
| `twelve` | 1 | Sonnet, timing | zh-CN | 7.3 | 0.1 s | 0.0 s | 6.8 s | 11.8 s |
| `twelve` | 1 | Haiku, mixed | en | 7.3 | 0.4 s | 2.1 s | 4.6 s | 11.4 s |
| `twelve` | 1 | Haiku, mixed | zh-CN | 7.3 | 0.4 s | 1.8 s | 5.8 s | 11.7 s |
| `twelve` | 2 | Haiku, timing | en | 6.9 | 0.1 s | 0.0 s | 4.6 s | 7.5 s |
| `twelve` | 2 | Sonnet, timing | en | 6.9 | 0.0 s | 0.0 s | 6.3 s | 15.3 s |
| `twelve` | 2 | Haiku, timing | zh-CN | 6.9 | 0.0 s | 0.0 s | 3.8 s | 6.4 s |
| `twelve` | 2 | Sonnet, timing | zh-CN | 6.9 | 0.1 s | 0.0 s | 7.3 s | 10.9 s |
| `twelve` | 2 | Haiku, mixed | en | 6.8 | 0.4 s | 2.1 s | 6.2 s | 11.6 s |
| `twelve` | 2 | Haiku, mixed | zh-CN | 6.8 | 0.2 s | 2.2 s | 4.9 s | 9.9 s |
| `twelve` | 3 | Haiku, timing | en | 7.0 | 0.1 s | 0.0 s | 3.2 s | 7.6 s |
| `twelve` | 3 | Sonnet, timing | en | 7.0 | 0.1 s | 0.0 s | 6.5 s | 12.3 s |
| `twelve` | 3 | Haiku, timing | zh-CN | 7.0 | 0.0 s | 0.0 s | 4.7 s | 11.0 s |
| `twelve` | 3 | Sonnet, timing | zh-CN | 7.0 | 0.0 s | 0.0 s | 6.4 s | 10.6 s |
| `twelve` | 3 | Haiku, mixed | en | 7.1 | 1.1 s | 3.7 s | 9.4 s | 17.0 s |
| `twelve` | 3 | Haiku, mixed | zh-CN | 7.1 | 0.2 s | 2.3 s | 5.2 s | 11.3 s |

### DeepSeek V4.1 Flash 1017 (`deepseek-flash`), one run per arm, reported only

- **First verdict** (timing en, timing zh-CN, mixed en, mixed zh-CN): `main` 4.6, 4.9, 4.2, 6.9 s; `preload` 4.6, 4.6, 5.3, 4.5 s; `twelve` 4.6, 4.2, 5.6, 5.8 s.
- **End:** `main` 12.3, 11.9, 14.1, 12.8 s; `preload` 10.1, 9.9, 14.6, 14.1 s; `twelve` 7.7, 7.1, 11.1, 8.7 s.
- **Judged right:** 34, 36 and 37 of 40. `main`'s one false Supported is English sentence 3 on the mixed Library; none on the other two. $0.10.

**Decision, 2026-11-07:** the reranker loads while the claims are named. Check this Note stays at six: twelve's timing now holds, and what stands in its way is the false Supported on one Chinese sentence, which the check gives on every arm from time to time.
