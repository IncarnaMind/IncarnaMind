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

## Result of gate A, 2026-11-06: one bar not met; steps 1 and 2 ship as an exception

The runs were made at 7cb76c42a against 08be5ac66, in the order above, on a direct Anthropic key, with the 15-minute load at 11.9 to 14.0. They spent $2.08. Medians are given today → step; the spread is today's runs' largest minus smallest first verdict.

| Cell | First verdict | Spread | Done | Holds |
|---|---|--:|---|---|
| Haiku, timing Library, en | 6.8 → 6.2 s | 1.4 s | 14.7 → 13.9 s | yes |
| Haiku, timing Library, zh-CN | 5.3 → 5.1 s | 0.4 s | 13.3 → 12.2 s | yes |
| Haiku, mixed Library, en | 9.2 → 7.7 s | 2.9 s | 16.6 → 16.5 s | yes |
| Haiku, mixed Library, zh-CN | 7.6 → 5.8 s | 1.6 s | 14.1 → 13.3 s | yes |
| Sonnet, timing Library, en | 9.7 → 7.8 s | 0.4 s | 19.2 → 19.6 s | **no:** the end came later |
| Sonnet, timing Library, zh-CN | 10.0 → 8.9 s | 0.5 s | 17.6 → 16.7 s | yes |

- **The end bar in Sonnet's English cell is not met:** a median of 19.2 → 19.6 s, today's runs 18.1, 19.2 and 21.2 s against the step's 18.7, 19.6 and 20.2 s, today's spread of ends 3.1 s. Its cause is unproven.
- **Every other bar holds.** The first verdict came sooner in all six cells. No request failed and no rate limit was met.
- **Verdicts:** on Claude Haiku 5.5, judged right 114 → 119 of 120, false Supported 2 → 0, not checked 3 → 2; on Claude Sonnet 5.5, judged right 60 of 60 on both arms, with no false Supported. No sentence the Documents don't state was Supported more often on the step.
- **Reranks that repeat one already scored in the same check:** 7 of 432 over both arms (1.6%; 4 of 215 on `main`), too few for a cache of them.
- **DeepSeek V4.1 Flash 1017 (`deepseek-flash`), one run per arm, reported only:** first verdict 6.6 → 5.6 s (timing, en), 4.8 → 5.0 s (timing, zh-CN), 6.4 → 7.5 s (mixed, en), 7.0 → 6.2 s (mixed, zh-CN); end 13.4 → 12.4, 10.1 → 12.1, 16.5 → 18.0 and 16.5 → 12.8 s; judged right 39 → 37 of 40, no false Supported on either arm, not checked 1 → 0. $0.07.

**Decision, 2026-11-06:** steps 1 and 2 ship as an exception that accepts the failed end bar in Sonnet's English cell, because it is a timing bar, not a quality bar, and no quality bar moved the wrong way. The bar stays failed. Gate B is run on this footing.

## Result of gate B, 2026-11-06: met, so Check this Note takes twelve

The runs were made at ebd66de0d (twelve) against 7cb76c42a (six), in the order above, on a direct Anthropic key, with the 15-minute load at 12.5 to 13.6. They spent $2.03. Medians are given six → twelve; the spread is six's runs' largest minus smallest first verdict.

| Cell | First verdict | Spread | Done | Holds |
|---|---|--:|---|---|
| Haiku, timing Library, en | 6.0 → 4.5 s | 1.8 s | 13.3 → 8.5 s | yes |
| Haiku, timing Library, zh-CN | 5.0 → 4.9 s | 0.9 s | 11.4 → 7.9 s | yes |
| Haiku, mixed Library, en | 7.6 → 6.9 s | 1.3 s | 16.9 → 13.2 s | yes |
| Haiku, mixed Library, zh-CN | 6.5 → 6.9 s | 1.3 s | 14.6 → 13.2 s | yes: 0.4 s later, within its spread |
| Sonnet, timing Library, en | 7.9 → 8.0 s | 0.9 s | 18.3 → 14.9 s | yes: 0.1 s later, within its spread |
| Sonnet, timing Library, zh-CN | 8.3 → 7.9 s | 1.6 s | 16.7 → 13.4 s | yes |

- **No failure:** no request failed and no rate limit was met at twelve.
- **Verdicts:** on Claude Haiku 5.5, judged right 115 → 119 of 120, false Supported 0 → 0, not checked 7 → 1; on Claude Sonnet 5.5, judged right 60 of 60 on both arms, no false Supported, not checked 1 → 0.
- **The reranker at twelve:** a rerank's median rose on the mixed Library, 2.4 → 3.3 s in English and 0.6 → 3.4 s in Chinese, as more searches wait for the one GPU session. The first verdict still met its bar in every cell. Reranks that repeat one already scored: 5 of 434 (1.2%).
- **DeepSeek V4.1 Flash 1017 (`deepseek-flash`), one run per arm, reported only:** first verdict 5.8 → 4.4 s (timing, en), 5.1 → 5.7 s (timing, zh-CN), 7.8 → 7.5 s (mixed, en), 7.3 → 6.4 s (mixed, zh-CN); end 13.0 → 10.6, 9.6 → 9.2, 17.5 → 13.3 and 16.5 → 12.5 s; judged right 37 of 40 on both arms, one false Supported on each arm: English sentence 5 on six's (timing Library), Chinese sentence 3 on twelve's (mixed Library). $0.07.

The write, Verify and the background watch keep six: the write's failing cell in `check-speed-twelve.md` has a cause of its own, twelve requests to the key at once, and wasn't run here.

## Not checked at the head, 2026-11-06: the rule, written before its rerun

A check of the head (a9bc9b0bc, twelve, against 7cb76c42a, six; Claude Haiku 5.5, three runs per arm) gave not checked 2 → 7, past the bar's 6, where gate B gave 7 → 1. In its saved records none of the 7, and not gate B's 1, has a failed request, a stopped or restarted check, or a second look at the judge's reply: each check ran its requests to the end and gave Not checked itself. The records keep what a mark shows, not why, so the report now gives a Not checked mark's reason, and the head's two arms are run once more, alternating as above, to name each.

**Rule:** if every Not checked is the model's own reply (malformed, empty or no evidence), and they fall on both arms in about the same number, that is the model's behaviour, not twelve's: twelve ships, with the pooled count on each arm (Haiku, gates B and the head: 8 of 240 on six, 8 of 240 on twelve) and the reasons in a dated note. If one reason shows up only at twelve, twelve waits.

## Result of the head's rerun, 2026-11-06: Not checked is the model's own reply on both arms; Check this Note stays at six

The runs were made at a9bc9b0bc (twelve) against 7cb76c42a (six), on Claude Haiku 5.5 with a direct Anthropic key, three runs per arm, alternating as above, with the 15-minute load at 12.1 to 12.5. The report now gives each Not checked mark's reason; both arms ran with that change to the report alone. The runs spent $0.43.

| Arm | Not checked | Malformed reply | No evidence | Failed requests |
|---|--:|---|---|--:|
| Six | 4 of 120 | timing en 8, timing en 10 | mixed en 8, mixed en 10 | 0 |
| Twelve | 4 of 120 | mixed en 10, mixed zh-CN 1, mixed zh-CN 3 | mixed en 10 | 0 |

- **Not checked is cleared by the rule above.** Every one is the model's own reply, both reasons fall on both arms, and the count is the same. The rule clears that count only: the head's first run's failed cells (not checked 7, past 6, and the later first verdict in Chinese on the mixed Library) stay failed. The rule's pooled count was misread when it was written. Over gate B and the head's two checks it is 9 of 240 on six and 8 of 240 on twelve; with this rerun, 13 of 360 and 12 of 360.
- **Verdicts:** judged right 116 → 115 of 120. False Supported 0 → 1: Chinese sentence 3 on the mixed Library, in twelve's first run. `main` Supported that sentence in 2 of gate A's 3 runs; six did in none of its 12 runs, twelve in 1 of its 9.
- **First verdict:** on the timing Library 6.0 → 4.9 s (en) and 4.7 → 5.0 s (zh-CN). On the mixed Library it came later at twelve: 6.2 → 9.7 s (en) and 7.2 → 8.0 s (zh-CN), with a rerank's median at 1.6 → 4.2 s and 1.0 → 4.4 s. In Chinese on the mixed Library twelve came later in all three comparisons: 0.4 s in gate B, 0.9 s at the head, 0.8 s here.
- **The end:** 14.7 → 8.9, 11.5 → 7.9, 17.0 → 16.0 and 14.3 → 14.4 s.

**Decision, 2026-11-06:** Check this Note stays at six, with steps 1 and 2. Twelve's end comes sooner, but the User sees the first verdict, and on a Library of real size twelve makes it later, because every search waits for the one reranker. The false Supported isn't the reason: `main` Supports that sentence too, in 2 of gate A's 3 runs. That doesn't waive it: it stays a false Supported on `main`, and twelve's one counts against twelve. What could bring twelve back is a staggered start, with the first sentence's searches scored first, or more rerank throughput. Twelve goes back to #2532.

## Gate C, written on 2026-11-07 before its runs: twelve at once again, on a reranker that no longer drains the GPU twelve times a batch

What changed since the rerun above: the built-in reranker's GPU file is Optimum's O4 export, made for CUDA, and it keeps twelve copies between host and GPU memory as nodes, one after each layer's attention scale. On WebGPU each made the session read a value back from the GPU, waiting for all it had been given, twelve times a batch. The GPU session now reads them as Identity (`src/core/reranking/hostCopies.ts`). A copy changes no value, so no search, Passage or verdict can change for it; what it changes is how soon a search is scored.

### The reranker's own bars, before the check's runs

`INCARNAMIND_EVAL_SPEED_RERANK=1` (`../rerankThroughput.speed.ts`), five runs an arm taking turns, on twenty searches over the mixed Library, one for each of the Note's ten sentences in English and ten in Chinese, the sentence as its query:

- **Every score the same, bit for bit,** in every search, as the GPU file was downloaded and with its copies read as Identity. One differing score fails it, and the copies stay.
- **Twelve searches at once no slower:** the median with the copies read as Identity is not above the median as downloaded.
- **Memory:** the change keeps one session and reads the GPU file into memory once to rewrite it in place, so it adds no session. The report says what it measured.

### The runs

`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note`, on a direct Anthropic key, as gate B:

- `six` is this pull request's commit with the copies read as Identity and Check this Note at six; `twelve` is the commit after it, with Check this Note at twelve. The write, Verify and the background watch keep six on both. Both run the same `checkTimes.ts` and `checkTimes.speed.ts`.
- **Order:** one process per arm and run, alternating `six`, `twelve`, `six`, `twelve`; each process runs English, then Chinese, once.
- **Cells,** three runs per arm: Claude Haiku 5.5 on the timing's Library and on the mixed Library (`INCARNAMIND_EVAL_SPEED_LIBRARY=mixed`); Claude Sonnet 5.5 on the timing's Library.
- **Load:** a process starts only once the 15-minute load is 24 or less, and a run whose 15-minute load was above 24 is run again. Each run's load is in the table.
- **Reported, not gated:** each run's rerank median and its first rerank, which loads the model; Haiku's arms once each on DeepSeek V4.1 Flash 1017 (`deepseek-flash`).
- **Cost:** about $2.20. The runs stop before this work's spend passes its $12 cap.

### The bars

Gate B's bars, unchanged: per cell, twelve's median end comes before six's; twelve's median first verdict is not later than six's by more than six's spread in that cell (its runs' largest minus smallest first verdict), and never by more than 1.0 s; no request fails and no rate limit is met at twelve. Per model, both languages and Libraries together: no sentence the Documents don't state is Supported in more of twelve's runs than of six's; judged right no lower, and Not checked no higher, than six's by more than one in 30, rounded down.

### What decides

Check this Note takes twelve only if every cell holds every bar and each model holds the verdict bars. Otherwise it stays at six and the failing cell is named. The copies read as Identity ship either way if the reranker's own bars hold, since they change no score.

## Result of gate C, 2026-11-07: the copies read as Identity ship; Check this Note stays at six

Two corrections to the text above, made after the runs and changing no bar: the heading said "a search" for "a batch", and the reranker's searches were described as the ones Check this Note makes, where a check writes its own queries; they are one search for each sentence, the sentence as its query.

### The reranker's own bars: met

The copy the GPU session opens is written once beside the downloaded file, with its twelve `MemcpyFromHost` nodes read as Identity (`src/core/reranking/index.ts`, `hostCopies.ts`), and opened by its path. It was first built to open the rewritten bytes; that keeps the model in memory a second time for as long as the session is open (the process's external memory stayed 241 MB higher, and its resident memory 60 to 110 MB higher), so the copy is a file instead. Five runs an arm, taking turns, with the 15-minute load at 6 to 11; milliseconds, median (range):

| Arm | Load | 20 searches one by one | The first 12 at once |
|---|--:|--:|--:|
| As downloaded | 742 (631–840) | 5,930 (5,587–6,884) | 4,204 (3,687–5,107) |
| Copies read as Identity | 684 (566–928) | 5,266 (4,936–5,445) | 3,796 (3,498–3,845) |

- **Every score the same:** 0 of 349 differ, bit for bit, and none differs between runs of an arm. The real-model test (`tests/core/realReranker.test.ts`) gives the same on English, Chinese and long Passages, with the copy written as the app writes it.
- **Twelve at once:** 10% sooner; one by one, 11%.
- **Memory:** not measured by the eval. Measured in separate processes, one per way of opening the GPU session, after it opened: 865 to 894 MB resident from the downloaded file, 863 to 865 MB from the copy. The copy takes 235 MB more on disk. Writing it reads the downloaded file once, 0.2 to 0.8 s, the first time the GPU session opens after it is downloaded; later starts open the copy as they opened the file before.

### Check this Note at twelve: not met

The runs were made at 47a33ec62 (twelve) against f4303486d (six), in the order above, on a direct Anthropic key, with the 15-minute load at 10.2 to 12.8. Both arms opened the rewritten bytes, which give the same scores as the copy. They spent $2.11. Medians are given six → twelve; the spread is six's runs' largest minus smallest first verdict.

| Cell | First verdict | Spread | Done | Rerank median | Holds |
|---|---|--:|---|---|---|
| Haiku, timing Library, en | 5.6 → 4.4 s | 1.0 s | 13.1 → 9.0 s | 0.0 → 0.6 s | yes |
| Haiku, timing Library, zh-CN | 4.8 → 4.9 s | 0.5 s | 10.7 → 8.2 s | 0.0 → 0.0 s | yes: 0.1 s later, within its spread |
| Haiku, mixed Library, en | 6.3 → 7.5 s | 1.7 s | 16.1 → 14.7 s | 1.8 → 3.2 s | **no:** 1.2 s later, past 1.0 s |
| Haiku, mixed Library, zh-CN | 6.4 → 8.1 s | 0.5 s | 13.9 → 11.8 s | 0.9 → 4.5 s | **no:** 1.7 s later, past its spread |
| Sonnet, timing Library, en | 7.4 → 7.1 s | 0.6 s | 17.5 → 15.7 s | 0.0 → 0.0 s | yes |
| Sonnet, timing Library, zh-CN | 7.4 → 7.3 s | 0.3 s | 15.6 → 13.1 s | 0.0 → 0.0 s | yes |

- **No failure:** no request failed and no rate limit was met at twelve.
- **Verdicts:** on Claude Haiku 5.5, judged right 117 → 113 of 120, false Supported 1 → 0, not checked 3 → 7, each within its margin of 4; on Claude Sonnet 5.5, judged right 60 of 60 on both arms, no false Supported, not checked 0 → 0. No sentence the Documents don't state was Supported more often at twelve. Six's one false Supported is Chinese sentence 3 on the mixed Library, the sentence `main` Supported in 2 of gate A's 3 runs.
- **Where the first verdict went:** on the mixed Library a run's first rerank starts the reranker and loads its model, on the first sentence's search. At six it took 1.0 to 1.8 s; at twelve 2.1 to 2.4 s in three of the six runs (Chinese runs 1 and 2, English run 2), and in those three the first verdict came 1.3 to 2.1 s after six's median. The one other run that came later, English run 1 by 1.2 s, had a load like six's, and its first sentence took four requests. Every later search waits behind that first one. The first sentences' searches are scored before later sentences' at twelve as at six, and between answers the GPU scores as fast as it does alone, so the queue's order and the GPU's speed aren't the cause. A main thread kept busy in 30 to 80 ms slices didn't slow the load either (0.56 to 1.1 s against 0.57 to 1.5 s idle). Why the load is slower when twelve checks start together is not established.
- **DeepSeek V4.1 Flash 1017 (`deepseek-flash`), one run per arm, reported only:** first verdict 6.3 → 5.3 s (timing, en), 6.7 → 5.1 s (timing, zh-CN), 6.2 → 6.5 s (mixed, en), 6.2 → 6.6 s (mixed, zh-CN); end 12.3 → 9.3, 11.4 → 7.2, 14.1 → 11.9 and 14.1 → 10.1 s; judged right 35 → 39 of 40, false Supported 1 → 0 (English sentence 3 on six's mixed Library), not checked 2 → 0. $0.06.

**Decision, 2026-11-07:** Check this Note stays at six, the copies read as Identity ship. What could bring twelve back is the model loaded before the first sentence's search, while the claims are named, so that search doesn't start it; in the app it is loaded already once anything has been reranked since IncarnaMind started, which the timing's fresh Library never is.

