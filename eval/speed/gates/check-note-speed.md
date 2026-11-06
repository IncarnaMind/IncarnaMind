# The gate for Check this Note's next speedups (#2532)

Written and committed on 2026-11-06, before any run it gates. It follows `check-speed-twelve.md` and `check-speed-landing.md`: arms alternating, one process per arm and run, the bars said before the runs.

## What the reranker can't do

The built-in reranker scores one search at a time, in one process, on one GPU session (on the CPU, one pair at a time). Measured on this computer (Apple M2 Max, WebGPU, fp16) on twelve searches of 20 mixed-Library Passages each:

- Scored one by one: 0.27 to 0.36 s a search, 3.3 to 4.2 s for the twelve. Tokenizing is 12% of it; the rest is the GPU.
- Their 240 pairs batched across searches, 8 at a time: 3.6 to 4.1 s; 16, 32 or 64 at a time: 4.2 to 5.7 s. The GPU is busy already, so batching saves nothing.
- Batching across searches also changes scores: up to 0.045 logits, and the order of 4 to 6 of the 12 searches. Each search scored alone gives the same scores, bit for bit, run after run.
- Two or three GPU sessions in their own processes: 3.0 to 3.5 s for the twelve, within the noise. Two in one process stop it (SIGABRT).
- A CPU session scores differently (int8) and takes 0.8 to 2 s a search, so it can't share the work with the GPU.

So a rerank's median at twelve can't come down to its median at six without changing scores. This gate replaces that line of #2532 with twelve's first-verdict bar, below.

## The steps

1. **Searches in the order of their checks.** A check's next search is scored before the searches of checks started after it; outside any check, a search goes by when it is asked. Each search is still scored alone, with its own texts, so no score changes. A Passage's tokens are kept between searches, read once; the pair is the one the tokenizer gives whole.
2. **Each sentence's check starts once its claims are named.** The model's reply naming the claims streams, and a sentence's check starts as soon as the reply has named its parts. The marks are written when the reply ends, as on `main`. The run then takes a check started early only if what it would send is the same, word for word; it stops any other one and drops its result. A reply that fails, or a Stop, leaves nothing marked, as on `main`.
3. **Twelve at once for Check this Note,** tried only after 1 and 2 hold. The write, Verify and the background watch keep six.

Steps 1 and 2 change only when requests are sent. Unit tests show a check started early is the run's own request, sent once, and that one sent with other words is sent again (`tests/core/mindCheck.test.ts`); that each search is scored alone, one at a time, in its check's order (`tests/core/reranking.test.ts`); and that a kept Passage's pair is the pair read whole, with the real tokenizer too (`tests/core/realReranker.test.ts`).

## The runs

`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note` (`../README.md` › Where a check's time goes), on a direct Anthropic key.

- **Gate A, steps 1 and 2:** `today` is `main` at 08be5ac66, `step` is this pull request's head before step 3. Both run this pull request's `eval/speed/checkTimes.ts` and `checkTimes.speed.ts`, so they time the same way.
- **Gate B, step 3:** `today` is the commit before step 3 (six at once), `step` is the commit with it (twelve).
- **Order:** one process per arm and run, alternating `today`, `step`, `today`, `step`. Each process runs English, then Chinese, once.
- **Cells,** each a model, language and Library, three runs per arm:
  - Claude Haiku 5.5: the timing's Library, and the mixed Library (`INCARNAMIND_EVAL_SPEED_LIBRARY=mixed`), where twelve's first verdict failed on `main`.
  - Claude Sonnet 5.5: the timing's Library.
- **Load:** a process starts only once the 15-minute load is 24 or less, and a run whose 15-minute load was above 24 is run again. Each run's load is in the table.
- **Reported, not gated:** Haiku's arms once each on DeepSeek V4.1 Flash 1017 (`deepseek-flash`); each run's rerank median and the reranks that repeat one already scored in that check (the same query over the same Passages).
- **Cost:** about $4.50 for both gates. The runs stop before this work's spend passes its $10 cap.

## The bars, per cell

- **Done:** the step's median end comes before today's.
- **First verdict:** the step's median first verdict is not later than today's by more than the cell's spread, and never by more than 1.0 s. The spread is the largest minus the smallest of today's first verdicts in that cell.
- **No failure:** no request fails and no rate limit is met on the step's arm.

## The verdict bars, per model, both languages and Libraries together

The Note's ten sentences say what `eval/repeats` says of them: the agreement states some and not the others (`checkTimes.speed.ts`). Over the runs both arms finished:

- **No new false Supported:** no sentence the Documents don't state is Supported in more of the step's runs than of today's.
- **Judged right** (Supported for a sentence they state, anything else for one they don't) no lower than today's by more than one in 30, rounded down.
- **Not checked** no higher than today's by more than one in 30, rounded down.

## What decides

A gate holds only if every cell holds every bar and each model holds the verdict bars. If gate A fails, steps 1 and 2 keep `main`'s path for what failed, and the pull request names the cell. Gate B is run only after gate A holds; if it fails, Check this Note keeps six and the failing cell is named.
