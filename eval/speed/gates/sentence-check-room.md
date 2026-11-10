# Gate: a batch's room holds a model's thinking (#2951)

Written and committed on 2026-11-10, before any run it gates. Its cases (`../checkRoomCases.ts`) were written with it, and no run or prompt has seen them.

## The change

An Answer's sentences are judged in batches of up to eight, one request each, on the chat flow. A model that thinks first thinks before it writes the batch's records. On main the batch's room is 300 tokens a sentence, up to 2,400, thinking included, so a short batch has the least room for the most variable part. When the thinking takes the room, the reply is cut off and its sentences stay Not checked.

Here the room is 5,000 tokens for the thinking and 300 a sentence for the records (`sentence-batch`: base 5,000, each 300, most 7,400). Where that room would take a batch past the Answer's limit or the monthly cap at the moment it is sent, the batch goes with main's room instead (`sentence-batch-records`), and is let through, made to wait or refused exactly as main would be. Two things still differ near a limit:
- A later batch may wait for an open one with the larger room to settle, where main would have sent it at once.
- A reply read whole spends more than one cut short, so what was spent can leave a later batch less room than main's cut replies left it. What is set aside never does.

Why 5,000: 260 whole replies were measured with the room lifted to 8,000, on Claude Haiku 5.5, Claude Sonnet 5.5 and DeepSeek V4.1 Flash: 200 on the check-times runner's scripted Answers and 60 on Answers each model wrote to the gating set's Questions. Records took at most 119 tokens a sentence. Thinking took up to 1,579 tokens on Haiku, 573 on Sonnet and 6,234 on DeepSeek. The least base that keeps every one of those replies under its room is 4,827, from DeepSeek's 6,626 tokens for 6 sentences; 5,000 is the next round number.

## Shared keys (the rules of 2026-11-10, before any run)

1. Each run holds a machine-wide lock on its key for its whole length, one lock a run, so no other run shares the key's per-minute limit.
2. Before each run, one smallest request reads the key's allowance left from its rate-limit headers. The run starts only above 90%, and the figure is recorded with the run. DeepSeek gives no such headers, which is recorded instead.
3. A run counts only if none of its requests was refused, failed or timed out, read from its own record: every request's `error` is empty and every Answer's check ended. Otherwise the run is void. It is kept, struck with the reason, and run again, and its numbers are not read. The gate's section of `report.md` prints "Void" at the top of a model's part when its record holds such a request. Refused requests are counted apart from failed ones and never as a cut-off.

Both Claude runs go on a second direct Anthropic key with its own per-minute limit, the key the measurements were made on, so the runs compared with each other share one key. DeepSeek runs on the DeepSeek key.

## The runs

- **Runner:** check-times, `answer` (`../checkTimes.speed.ts`), with these settings:
  - `INCARNAMIND_EVAL_SPEED_ANSWER_SET=room` and `INCARNAMIND_EVAL_SPEED_ANSWER_SENTENCES=1:24,2:12,3:8`: in each language, 24 Answers of one sentence, 12 of two and 8 of three, the set's sentences in order. That is 44 Answers a language and 88 batches a model.
  - `INCARNAMIND_EVAL_SPEED_ROOM_ARMS=main,main,today`: each Answer is checked three times, in an order that turns from Answer to Answer.
    - `main` and `main#2` give each batch main's room exactly, 300 tokens a sentence, set on the request below the meter.
    - `today` gives it this branch's.
- **The same input:** the Answer is scripted, so its sentences, Citations and Passages are the same on every arm. Only the batch's room differs.
- **Models:** Claude Haiku 5.5, Claude Sonnet 5.5 and DeepSeek V4.1 Flash (`deepseek/deepseek-flash`), one run each, each on one route.
- **The judge:** Claude Opus 5.5 reads each of the set's 48 sentences against its quote once, in the Haiku run (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-opus-5-5`, `judged.json`). The Sonnet and DeepSeek runs read that list (`INCARNAMIND_EVAL_SPEED_JUDGED=<its path>`).
- **Thinking:** each model thinks as the chat flow has it (`summary`).
- **Machine and money:** a 15-minute load of 24 or less at each run's start. `INCARNAMIND_EVAL_SPEED_STOP_USD` is 1 on Haiku and DeepSeek and 2 on Sonnet. The spend is about $1.70 in all: Sonnet about $1.40.
- **Time each key is held:**
  - The second Anthropic key: about 20 minutes for Haiku and 25 for Sonnet.
  - The DeepSeek key: 25 to 45 minutes, as its thinking runs long.

## Main's measured rate, the contrast expected

On the room runs above, main's room would have cut 19 of 76 batches of 1 to 3 sentences on Haiku (25%), 4 of 38 on Sonnet (11%) and 7 of 38 on DeepSeek (18%). On the Answers each model wrote to the gating set's Questions, it would have cut 6 of Haiku's 20, none of Sonnet's 20 and 7 of DeepSeek's 20. On #2847's call-help replies it cut 39 of 60 on Haiku. On these 88 batches, each `main` arm is expected to cut about 22 on Haiku, 10 on Sonnet and 16 on DeepSeek.

## Bars (per model; every one must hold)

1. **Cut-offs:** on the `today` arm, at most 2 of the 88 batches reach their room (finish reason "length").
   - Why 2: no measured reply needed more than the room given, but 200 replies are no proof of the tail. 2 of 88 is a fifth of what main is expected to cut on the model it cuts least (Sonnet, about 10).
   - Main's two arms are reported beside it.
2. **Verdicts where both were whole:** over the sentences whose batch was read whole on both `main` and `today`, count where `today` gives Supported and `main` doesn't, and the other way round. The bar fails when a one-sided sign test gives today's count a chance under 5%, were the two rooms alike.
   - `main` against `main#2` is reported beside it, as the model's own spread.
   - Why a sign test on pairs: each sentence is its own pair, so the bar needs no guess at the spread.
3. **No more wrong Supported:** take the sentences the judge says their quotes don't state. Among those `main` cut and `today` read, today's share of Supported must be no higher than main's share among those it read whole. The test is Fisher's exact, one-sided, and the bar fails at p < 0.05.
   - It is read only where at least 5 of the judge's sentences fell in batches main cut. Below that it prints as not readable, and the bar stands on the unit test that a reply which still reaches its room grants nothing.
4. **Long Answers unchanged:** a batch of eight sends main's request, its limit the one difference. This is held by `tests/core/answerCheckingLimit.test.ts`: the same batch of eight sent with either room differs only in `maxOutputTokens`, 7,400 and 2,400.
5. **Limits:** no batch is refused by the Answer's limit or the monthly cap where main lets it through. This is held by the same file, with literal numbers:
   - On Claude Fable 5, whose 7,400-token room alone would pass the Answer's $0.25, every batch still goes, with main's 2,400 and 300.
   - With $0.02 left under the monthly cap, a batch Sonnet's 5,300-token room would take past it goes with main's 300.

No bar moves after a run.

## Reported, not gated

- What a check costs on each arm: the median tokens in and out a batch, and the spend over the arm's Answers.
- The time from the Answer's end to its last verdict on each arm, median and 90th percentile. The extra room only lets a reply finish; it never makes one longer.
- For call help's short replies, how long the marks take to settle is measured in #2847's next gate, which runs on main once this merges.
