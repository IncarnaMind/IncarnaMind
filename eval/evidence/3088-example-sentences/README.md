# The gate of #3088: the credit example's own sentences

Written and committed before any paid request. The bars are fixed from the first paid round: nothing here changes after it, and a change to a bar or a case would be a new gate that says so. No branch count is read against a bar until all 10 rounds and the four `eval/checks` runs are in.

## What is measured

The fix changes what a check's model is told in two ways: a part of a longer sentence is checked with that sentence named on its own and one rule on reading a part, and a figure's separators are no longer offered as readings (the app reads them). The gate measures both on Claude Haiku 5.5 (`claude-haiku-5-5`), `main` against the branch.

- **The harness** is `tests/live/exampleSentences.live.test.ts`. A round checks every case once, each Note as Check this note does, with the real sort. It writes one JSON line a sentence and one for the round.
- **The arms** are `main` at b283bc51c26fe8481d8d2217e4d4eacc9113ce84, and the branch at 81f2c993e09c0e50109dcfc7a899414bbbd770d4, which is that `main` merged in. The commits after it add only the gate's own files: this README and its results. The same harness file and the same evaluation file (with its spend cap) run in both checkouts.
- **The model** is Claude Haiku 5.5, on a second Anthropic key, one run on the key at a time.
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

**2026-11-14, before the first paid round:** bar 3's total is replaced, by the second reader's ruling. Across the 12 held-out right sentences, the total fails at a drop of max(6, 2 × `main`'s spread) or more. `main`'s spread is its best round's total of ✓ over those 12, less its worst round's, over its ten rounds. A total drop of 3 or more that still passes is named in the pull request, with its cases. The per-case bar and the other bars are unchanged.

**Read apart, beside the bars:** the held-out comparative clauses whose right reading isn't a ✓ (the three English and three Chinese wrong comparatives, two of them a flipped direction). Their ✓ and Contradicted counts on both arms show whether naming the whole sentence makes the judge pass a wrong clause.

## A run that counts

- **Void rule:** an arm-round is void, kept and struck if any of its requests was refused, failed or timed out, counted by the harness from every request. It is also void if any check or figure in it reads a reason that a request failed (rate limit, failed, timed out, out of credit, the spend cap, the plan's limit). A void arm-round is run again beside its pair, in the same round, and both are reported.
- **Before each arm-round:** one request of one token reads the key's remaining input allowance from the response headers. The arm-round starts only above 90% of it; at 90% or less the gate stops. The key is never printed or written down, and nothing the harness keeps holds it.
- **Every request is kept:** the harness's JSON lines and each round's console output go beside this file.

## Dry run (no cost)

`INCARNAMIND_LIVE_GATE_DRY=1` runs the harness with a scripted judge. That judge sorts each sentence at its first comma, searches once and finds nothing; nothing is sent. Run on the branch and on `main` (a94f0cac7), one round each:

- each arm-round checked 44 sentences in 24 held-out Notes and 16 example Notes (4 cores), with 378 scripted requests and 0 refused, failed or timed out;
- every case wrote its row, and the comparative parts' first replies were read;
- `score.ts` read both files and scored every bar.

Run again on the merged branch (81f2c993e) and on `main` (b283bc51c) before the first paid round, with the same counts: 44 sentences each, 378 scripted requests, 0 refused, failed or timed out, every row scored.

The dry run's judge finds nothing, so its bars 1 read "missed" by design. Even so, `main` showed the issue's fault at no cost: the revenue sentence's figure was Not checked on `main` (the reading left unread) and not on the branch.

The evaluation's own tests (`tests/eval/checkPipeline.test.ts`, `checkCompare.test.ts`, `checkScoring.test.ts`) stand as bar 4's dry run. No saved `eval/checks` run from after its replies were kept (#2910) is left to compare.

## Estimate and stop

- **Rounds:** an arm-round of the scripted judge sent 378 requests. A real one sends about 400 to 450, with search, cite, the reply and a contradiction's confirmation. Priced from a held-out set of #2184, at about 50,000 input tokens a sentence's check, 60% of them cache reads, an arm-round is about 3.5M input and 60,000 output tokens. At the catalog's Haiku 5.5 price ($0.10 a million input, $0.01 cache reads, $0.50 output) that is **about $0.19**, so 20 arm-rounds are **about $3.80**.
- **`eval/checks`:** a Find support run on Haiku 5.5 took 21 minutes, 10.4M input tokens (6.4M cache reads) and 0.18M output, **about $0.60**. Four runs are **about $2.40**.
- **Total:** about **$6.20**, and about 4.5 hours with the rounds kept under the key's limit (4 Notes at once).
- **Stop:** the gate stops at **$9** spent, about the estimate plus room for void reruns. The meter is watched between requests, not only between rounds:
  - in the harness, no request is sent once the gate's spend before the arm-round plus the arm-round's own reaches $9 less $0.05 for the requests in flight. The spend is priced from each reply's own usage at the catalog's price, beside the app's own count per core;
  - in `eval/checks`, `INCARNAMIND_EVAL_SPEND_CAP` sets the app's monthly cap to what is left of the $9, so the app sends no request that could pass it.

  The gate also stops at the first arm-round that is void twice running, and when a probe shows 90% or less of the allowance left. When any stop fires, what is in is reported and nothing more is spent.

## Results (2026-11-14, read after all 10 rounds and the four `eval/checks` runs)

`main` at b283bc51c and the branch at 81f2c993e (the source every round and evaluation run measured; the later commits add only gate files) on Claude Haiku 5.5, meant and run, on one key, one run on it at a time. `results.md` is `score.ts`'s reading of `runs/*.jsonl`; `runs/eval-*-report.md` and `runs/eval-compare.md` are the evaluation's own.

**Runs.**
- **Arm-rounds:** 20, 10 for each arm, alternated. They sent 5,972 requests, with 0 refused, 0 failed, 0 timed out and 0 held at the stop, and none was void.
- **Two starts before the first round** were not counted (`runs/start-*.log`). The first refused its own output path, which was under the repository rather than a temporary folder, after one example core. The second was stopped at once. Neither wrote a line of its own, so $0.10 is counted for them.
- **`eval/checks`:** four runs, `main`, branch, `main`, branch. Each reached all 208 Find support sentences and 10 received documents, with 834, 830, 832 and 812 requests (counted from the reports' requests). No request failed or was refused, by the logs and the core's own reasons.

**Spend, at the app's own count.**
- the arm-rounds: $1.62 (the harness's own pricing matched it to the cent);
- the two uncounted starts: $0.10, as above;
- the evaluation runs: $1.01 and $1.02 where the meter was logged (runs 3 and 4). Runs 1 and 2 made as many requests but logged no meter, so about $1.01 each, and $1.50 each was held against the stop while they ran.

That is **about $5.77 in all**, within the $9 stop.

| Bar | `main` | branch | Result |
|---|---|---|---|
| 1. The issue's two sentences ✓, each set-up and language | 10, 10, 10, 10 (EN); 10, 10, 10, 9 (ZH) of 10 | 10, 10, 10, 10 (EN); 10, 9, 10, 10 (ZH) of 10 | met |
| 1. The comparative part's first reply contradicted | 0 of 10 in each | 0 of 10 in each | met |
| 1. The revenue figure Not checked, with the User's Document | 0 (EN), 1 (ZH) of 10 | 0, 0 of 10 | met |
| 2. Any wrong sentence's ✓ more on the branch | the twins 0; held-out wrong: en-a2 7, zh-a2 1, others 0 of 10 | twins 0; en-a2 6, zh-a2 0, others 0 | met |
| 3. Held-out right ✓, per case (fails at 3 fewer) | 97 in all | 117 in all; the largest loss is 1 (en-a3, zh-a2) | met |
| 3. Held-out right ✓, in all (fails at a drop of max(6, 2 × 3) = 6) | 97 | 117 (a rise of 20) | met |
| 4. Contradicted on sentences labelled contradicted, Find support | 48 + 47 = 95 of 108 | 48 + 40 = 88 of 108 | **missed** (needed 93, `main`'s spread 1, allowed 2) |
| 4. Paired: Contradicted in both `main` runs, not in both branch runs | | fs-142, fs-151 | **missed** |

**Fault 1 did not reproduce on `main`.** At b283bc51c, `main`'s first reply on "against £118 million a year earlier" said supported in 10 of 10 checks, with the example alone and beside a User's Document. In Chinese the real sort often didn't split the sentence at all. So the gate shows the part rule costs no ✓, and no wrong comparative passes because of it. It can't show the rule fixing a first reply that is already right.

**Fault 2 shows on the held-out comma figures in a short Note.** `main` against the branch: en-b2 "Costs came to $1,075 million" 5 → 10, en-b3 "Headcount was 4,310" 2 → 10, zh-b3 (the same English Note under the Chinese interface) 2 → 10.

**The wrong comparatives, read apart** (✓ and Contradicted of 10, `main` then branch):

| Case | `main` | branch |
|---|---|---|
| en-a1 | 0 and 10 | 0 and 10 |
| en-a2 | 7 and 3 | 6 and 4 |
| en-a3 | 0 and 10 | 0 and 10 |
| zh-a1 | 0 and 10 | 0 and 10 |
| zh-a2 | 1 and 4 | 0 and 7 |
| zh-a3 | 0 and 10 | 0 and 10 |

Naming the whole sentence made no wrong clause pass more often. en-a2, "Occupancy averaged 82% in July, down from 76% a year before", is a ✓ for a wrong direction on both arms, 7 and 6 times of 10: a fault of `main`'s, which this change neither causes nor fixes.

**Bar 4, read apart from its verdict.**
- None of the sentences whose Contradicted differs between runs was checked in parts. For a whole sentence, the branch's instructions and message differ from `main`'s only when a figure in it has a separator the sentence doesn't settle: those readings are no longer offered.
- fs-142 (3.0%) and fs-151 (78%) have no such figure, so they were sent the same on both arms. On the branch, fs-142's confirmation judged "same" and fs-151's reply gave no `cite`, in both runs.
- Branch run 2 lost 10 contradicted sentences against branch run 1 and gained 2.
  - 6 of the 10 ended Not checked the same way: a verdict given without `cite`, and the quote it gave when asked afterwards not found. 2 of those (fs-023 "£45,500", fs-046 "£3,210") have such a figure; the other 4 were sent the same as on `main`.
  - Of the other 4, fs-121 gave no quote at all, fs-066's reply couldn't be read after the strict judgement, and fs-013 and fs-112 ended Unsupported. None of those 4 has such a figure.

The bar is as written, and it stays missed.
