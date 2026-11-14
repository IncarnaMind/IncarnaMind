# The gate of #3088: the credit example's own sentences

Written and committed before any paid request. Nothing here changes once the first paid round starts; a change to a bar or a case after that is a new gate, and says so.

## What is measured

The fix changes what a check's model is told in two ways: a part of a longer sentence is checked with that sentence named on its own and one rule on reading a part, and a figure's separators are no longer offered as readings (the app reads them). The gate measures both on Claude Haiku 5.5 (`claude-haiku-5-5`), `main` against the branch.

- **The harness** is `tests/live/exampleSentences.live.test.ts`. A round checks every case once, each Note as Check this note does, with the real sort. It writes one JSON line a sentence and one for the round.
- **The arms** are `main` and the branch with `main` merged in at the same commit. The same harness file runs in both checkouts.
- **Alternation:** in round r, odd rounds run `main` first and even rounds run the branch first. Both arms of a round run back to back. There are 10 rounds, so 20 arm-rounds.
- **The check's own evaluation** (`eval/checks`, Find support) is the issue's second bar. It runs `main`, branch, `main`, branch, after the 10 rounds.

## The cases

Every sentence and Document was written into the harness before any run. None is an example that the check's instructions or the unit tests give. The rule's own examples (vacancy 5.8% and 7.1%; 营业收入 4,100 万元 and 3,400 万元) are in no case.

**The example** (`EXAMPLE` in the harness) runs in each language (the interface in that language and the shipped example in it) and in two set-ups each: the example alone, and the example beside one Document of the User's own (the Harbour Foods board pack of #3083's tests).

| Note | Sentences | Expected |
|---|---|---|
| The issue's | "Underlying EBITDA was £96 million, against £118 million a year earlier." citing the report's Highlights line, then "Revenue was £1,284 million, up 4.2% year on year." (Chinese: the example's own two sentences) | ✓ both |
| Twin 1 | a wrong earlier-period figure: "… against £128 million a year earlier." (上年同期为 1.28 亿英镑), citing the same line | never ✓ |
| Twin 2 | this period's figure given as the earlier period's: "Underlying EBITDA was £118 million, against £96 million a year earlier." (基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑), citing the same line | never ✓ |
| Twin 3 | "Revenue was £1,248 million, up 4.2% year on year." (集团收入为 12.48 亿英镑) | never ✓ |

**Held out** (`HELD_OUT` in the harness): 12 pairs, each case with its own Folder, its own Document and a Note of one sentence. In each pair the right sentence is expected ✓ and the wrong one never ✓.

| Pair | Kind | Right / wrong |
|---|---|---|
| en-a1 | comparative clause | earlier figure right / wrong (£25m for £52m) |
| en-a2 | comparative clause | "up from 76%" / "down from 76%" (the direction) |
| en-a3 | comparative clause | net debt $3.4bn against $2.9bn / the two years swapped |
| zh-a1 | comparative clause | 上年同期为 3,180 万元 / 3,810 万元 |
| zh-a2 | comparative clause | 有所上升 / 有所下降 (the direction) |
| zh-a3 | comparative clause | 18.6 亿元 against 15.2 亿元 / the two years swapped |
| en-b1 | comma figure, short Note | £2,615 million / £2,165 million, against a Passage that writes it the same way |
| en-b2 | comma figure, short Note | $1,075 million / $1,705 million, against "$1.075 billion" |
| en-b3 | comma figure, short Note | a plain 4,310 / 3,410 |
| zh-b1 | comma figure, short Note | 2,615 万英镑 / 2,165 万英镑 |
| zh-b2 | comma figure, short Note | 1,075 万美元 / 1,705 万美元, against "1075 万美元" |
| zh-b3 | comma figure, short Note | an English short Note under the Chinese interface, 4,310 / 3,410 |

## The bars

Read by `score.ts` beside this file, from the rounds that aren't void.

1. **The issue's two sentences, on the branch, in each language and each set-up:** each is ✓ in at least 9 of 10. The comparative part's first reply says contradicted in at most 1 of 10. With the User's Document present, the revenue sentence's figure is Not checked in 0 of 10. `main`'s numbers are given beside them.
2. **No wrong sentence gains a ✓:** for every twin and every held-out wrong sentence, the branch's ✓ count is at most `main`'s.
3. **No held-out right sentence loses its ✓:**
   - no case has 3 or more fewer ✓ (of 10) on the branch than on `main`;
   - over all 12 right cases, the branch's ✓ total is fewer than 10 below `main`'s.
4. **Wrong figures are caught no less often (`eval/checks`, Find support):** over the two runs of each arm, the branch's "Contradicted" on sentences labelled contradicted is at least `main`'s total, less the larger of 2 and `main`'s own spread between its two runs. As the paired rule, no contradicted sentence goes from Contradicted in both `main` runs to not Contradicted in both branch runs (`eval/checks/compare.ts` lists the flips).

**How often bar 3 fails a prompt that changed nothing.** These rates are worked out from the binomial with both arms at the same rate p, before any run:

| p | One case loses 1 or more | One case loses 3 or more | The total of 12 drops by 10 or more |
|---|---|---|---|
| 1.0 | 0 | 0 | 0 |
| 0.95 | 27% | 0.7% | under 1% |
| 0.9 | 34% | 3% | 2% |
| 0.8 | 39% | 8% | 6% |

A literal "loses one" per case would fail an unchanged prompt about a third of the time for any case whose ✓ isn't certain, so the bar is set at 3. Bar 2 has no such floor, because a wrong sentence's ✓ rate is 0 on `main` unless `main` already has a bug there.

## A run that counts

- **Void rule:** an arm-round is void, kept and struck if any of its requests was refused, failed or timed out, counted by the harness from every request. It is also void if any check or figure in it reads a reason that a request failed (rate limit, failed, timed out, out of credit, the spend cap, the plan's limit). A void arm-round is run again beside its pair, in the same round, and both are reported.
- **Before each round:** one request of one token reads the key's remaining input allowance from the response headers, and the round starts only above 90% of it. The key is never printed or written down.
- **Every request is kept:** the harness's JSON lines and each round's console output go beside this file.

## Dry run (no cost)

`INCARNAMIND_LIVE_GATE_DRY=1` runs the harness with a scripted judge. That judge sorts each sentence at its first comma, searches once and finds nothing; nothing is sent. Run on the branch and on `main` (a94f0cac7), one round each:

- each arm-round checked 44 sentences in 24 held-out Notes and 16 example Notes (4 cores), with 378 scripted requests and 0 refused, failed or timed out;
- every case wrote its row, and the comparative parts' first replies were read;
- `score.ts` read both files and scored every bar.

The dry run's judge finds nothing, so its bars 1 read "missed" by design. Even so, `main` showed the issue's fault at no cost: the revenue sentence's figure was Not checked on `main` (the reading left unread) and not on the branch.

The evaluation's own tests (`tests/eval/checkPipeline.test.ts`, `checkCompare.test.ts`, `checkScoring.test.ts`) stand as bar 4's dry run. No saved `eval/checks` run from after its replies were kept (#2910) is left to compare.

## Estimate and stop

- **Rounds:** an arm-round of the scripted judge sent 378 requests. A real one sends about 400 to 450, with search, cite, the reply and a contradiction's confirmation. Priced from a held-out set of #2184, at about 50,000 input tokens a sentence's check, 60% of them cache reads, an arm-round is about 3.5M input and 60,000 output tokens. At the catalog's Haiku 5.5 price ($0.10 a million input, $0.01 cache reads, $0.50 output) that is **about $0.19**, so 20 arm-rounds are **about $3.80**.
- **`eval/checks`:** a Find support run on Haiku 5.5 took 21 minutes, 10.4M input tokens (6.4M cache reads) and 0.18M output, **about $0.60**. Four runs are **about $2.40**.
- **Total:** about **$6.20**, and about 4.5 hours with the rounds kept under the key's limit (4 Notes at once).
- **Stop:** the gate stops at **$12** spent at the app's own count, summed over the arm-rounds and the evaluation's reports. It also stops at the first arm-round that is void twice running. Each core's own monthly cap is $5.
