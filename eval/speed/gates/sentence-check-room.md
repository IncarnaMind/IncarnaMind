# Gate: a batch's room holds a model's thinking (#2951)

Written and committed on 2026-11-10, before any run it gates. Its cases (`../checkRoomCases.ts`) were written with it, and no run or prompt has seen them.

Bars set before any run, 2026-11-10: bar 1 is at most 4 of 88 and a quarter of main's count, bar 2 fails under 1%, the arm `main` is the one bars 2 and 3 compare, and the record shows the limit each batch carried (shared-key rule 4). They replace the first draft's bar 1 (at most 2 of 88) and bar 2 (under 5%). The runs go one after another, never two at once.

2026-11-10, 01:14 UTC: the first Haiku run stopped when it drew the Chinese Document, whose lines the case file gave the Latin font. The run is void and kept; it wrote no report, and the verdicts of its English half were not read. The case file's Chinese pages now use the font for Chinese, and no sentence or line changed. The Haiku run is taken again.

2026-11-10, after the Haiku and Sonnet runs, on review:
- **The model's own output limit.** The larger room now goes only to a model whose own output limit, and its window's room for a reply, hold it. A provider refuses a limit past the model's own, and GPT-4 Turbo's is 4,096.
- **When the room is chosen.** A batch's room is now chosen after main's wait for open batches, so a batch that waited can take the larger room.
- **No gated request changes.** Neither change alters a request of the gated runs: the three models' own limits are 128,000 and 393,216 tokens, and their short Answers always fit the $0.25. The Haiku and Sonnet runs stand, and DeepSeek runs on the new head.
- **Rule 3 in the code.** The gate's section now also prints Void for an Answer whose check left a sentence without a mark, as rule 3 says. The note under bar 3 now says the 5 are counted where main cut and today read whole, as the section always counted them.

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
4. The record shows the limit each batch carried to the provider: 300 × its sentences on both main arms, and 5,000 + 300 × its sentences on `today`. The gate's section prints the limits seen, by arm and batch size, and a run where any batch carried another limit is void.

The three runs go strictly one after another. Each holds the lock on the second Anthropic key for its whole length, the DeepSeek run too, with the DeepSeek key's lock inside it, so another evaluation's timed runs on that key queue between them. No run sends more than four requests at once. Each run's record keeps the one-minute load at its start and end.

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

1. **Cut-offs:** on the `today` arm, at most 4 of the 88 batches reach their room (finish reason "length"), and at most a quarter of main's own count on the same batches. Main's count is the mean of its two arms, rounded up.
   - Why: this is the bar a User needs, under 1 in 20 and a clear drop from main.
   - The base was fitted to the largest of 260 replies with 173 tokens to spare, and DeepSeek owns that tail. A bar of 2 would fail on DeepSeek's tail alone about one run in eight, at 1.4% a batch.
   - Main's two arms are reported beside it.
2. **Verdicts where both were whole:** over the sentences whose batch was read whole on both `main` and `today`, count where `today` gives Supported and `main` doesn't, and the other way round. The two languages are pooled for the bar and reported apart. The bar fails when a one-sided sign test gives today's count a chance under 1%, were the two rooms alike.
   - Why 1%: three models at 5% each would stop a change about one time in seven when the rooms are alike, and a limit the model never sees gives no reason to expect a shift. It is the level of #2847's speed bar.
   - `main` against `main#2` is reported beside it, as the model's own spread.
   - Why a sign test on pairs: each sentence is its own pair, so the bar needs no guess at the spread.
3. **No more wrong Supported:** take the sentences the judge says their quotes don't state. Among those `main` cut and `today` read, today's share of Supported must be no higher than main's share among those it read whole. The test is Fisher's exact, one-sided, and the bar fails at p < 0.05.
   - It is read only where at least 5 of the judge's sentences fell in batches main cut and today read whole, as the gate's section counts them. Below that it prints as not readable, and the bar stands on the unit test that a reply which still reaches its room grants nothing.
   - In bars 2 and 3, "main" is the arm named `main`; `main#2` is only the spread.
4. **Long Answers unchanged:** a batch of eight sends main's request, its limit the one difference. This is held by `tests/core/answerCheckingLimit.test.ts`: the same batch of eight sent with either room differs only in `maxOutputTokens`, 7,400 and 2,400.
5. **Limits:** no batch is refused by the Answer's limit or the monthly cap where main lets it through. This is held by the same file, with literal numbers:
   - On Claude Fable 5, whose 7,400-token room alone would pass the Answer's $0.25, every batch still goes, with main's 2,400 and 300.
   - With $0.02 left under the monthly cap, a batch Sonnet's 5,300-token room would take past it goes with main's 300.

No bar moves after a run.

## Reported, not gated

- What a check costs on each arm: the median tokens in and out a batch, and the spend over the arm's Answers.
- The time from the Answer's end to its last verdict on each arm, median and 90th percentile. The extra room only lets a reply finish; it never makes one longer.
- For call help's short replies, how long the marks take to settle is measured in #2847's next gate, which runs on main once this merges.

## Result (2026-11-10)

Every bar held on all three models. Each run went alone, from one head, on its key, with no request refused, failed or timed out, and every batch carried its arm's limit:
- `main` and `main#2`: 300, 600 and 900 tokens for 1, 2 and 3 sentences.
- `today`: 5,300, 5,600 and 5,900.

| | Claude Haiku 5.5 | Claude Sonnet 5.5 | DeepSeek V4.1 Flash |
|---|---|---|---|
| Ran (UTC) | 01:16–01:24 | 01:24–01:32 | 02:40–02:49 |
| 1. Cut-offs: today / main's two arms | 0 / 7 and 8: holds | 0 / 0 and 0: holds | 0 / 2 and 5: holds |
| 2. Today Supported where main wasn't / the other way, sentences both whole | 0 / 0 of 137 (English 71, Chinese 66), p = 1: holds | 0 / 0 of 144, p = 1: holds | 0 / 0 of 141, p = 1: holds |
| 3. Judge's unstated sentences: Supported on today among those main cut / on main among those whole | 0 of 7 / 0 of 53, p = 1: holds | not readable (none cut) / 0 of 60 | not readable (2 cut, 0 Supported) / 0 of 58 |
| Main against main#2 | 0 / 0 of 136 | 0 / 0 of 144 | 0 / 0 of 135 |
| From an Answer's end to its last verdict, median: main / today | 1.1 s / 1.1 s | 1.6 s / 1.6 s | 1.8 s / 1.8 s |
| A batch's tokens out, median: main / today | 154 / 156 | 107 / 111 | 155 / 165 |
| Spend | $0.044, the judge $0.013 of it | $0.699 | $0.077 |

The judge, Claude Opus 5.5, listed as unstated exactly the ten sentences of each language the case file marks "not stated".

**Void, kept and run again:** the first Haiku run, 2026-11-10 01:11–01:14 UTC. It stopped when it drew the Chinese Document in the Latin font. It wrote no report, and the verdicts of its English half were not read.

**Changed after the runs, and why the runs stand.** In every gated Answer, each batch is one batch of 1 to 3 sentences, sent alone, on a model whose own limit is 128,000 or 393,216 tokens, and its set-aside is far under $0.25. So each change below leaves every gated request as it was, and a unit test holds the gated models' rooms at 5,300, 5,600 and 5,900.
- **At a78051c60 and edb162365, on review:** the room is held within the model's own limit, it is chosen after the old wait, and a run whose check left a sentence unmarked is void. DeepSeek ran on this head. The Haiku and Sonnet reports were rendered again with its code, and they print the same.
- **On a second review, before merge:**
  - A batch has the room for thinking only where every batch still to come keeps the room it would have anyway, so no batch waits or is refused because of it. Within the same check, that ends the first of the two differences named under "The change". Near the monthly cap, a request from elsewhere, set aside after a batch was given the larger room, can still make a later batch wait for the others to settle.
  - Where not every batch can have it, the fewest sentences have it first.
  - The room is held to the model's own room, never under the records' room, rather than dropped to the records' room.
  - "Check the rest" estimates with the same rule as the send.
  - A batch that waited reads nothing once the Answer is stopped or the core has closed.
  - A void run prints its bars as not read.
  - A model with no price keeps the larger room whatever the cap says, since nothing is set aside for it.
  - "Check the rest" reads nothing once the core has closed during its wait for the model's shape.

Rendered again with the final code, the three runs' sections print the same bars, and none is void.

