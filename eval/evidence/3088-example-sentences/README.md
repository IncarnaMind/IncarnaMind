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

Every sentence and Document was written into the harness before any run. None is an example that the check's instructions or the unit tests give. The rule's own two examples, one English and one Chinese, are in no case.

**2026-11-14, after the runs:** the cases' own words are taken out of this file and of `results.md`, which name each case by its id and kind. The harness and the run files hold the words, unchanged; no case, bar or count changed.

**The example** (`EXAMPLE` in the harness) runs in each language (the interface in that language and the shipped example in it) and in two set-ups each: the example alone (`example`), and the example beside one Document of the User's own (`example+own`, the board pack of #3083's tests).

| Note | Id | Sentence | Expected |
|---|---|---|---|
| The issue's | `note-comparative` | the example's first sentence: a figure, then the same measure in the earlier period, citing the example's report | ✓ |
| | `note-figure` | the example's second sentence: a revenue figure and its growth | ✓ |
| Twin 1 | `twin-1` | the first sentence with a wrong earlier-period figure | never ✓ |
| Twin 2 | `twin-2` | the first sentence with the two periods' figures swapped | never ✓ |
| Twin 3 | `twin-3` | the second sentence with two of its figure's digits swapped | never ✓ |

**Held out** (`HELD_OUT` in the harness): 12 pairs, each case with its own Folder, its own Document and a Note of one sentence. In each pair the right sentence is expected ✓ and the wrong one never ✓.

| Pair | Kind | Right / wrong |
|---|---|---|
| en-a1 | comparative clause | the earlier period's figure right / wrong |
| en-a2 | comparative clause | the direction right / flipped |
| en-a3 | comparative clause | the two years right / swapped |
| zh-a1 | comparative clause | the earlier period's figure right / wrong |
| zh-a2 | comparative clause | the direction right / flipped |
| zh-a3 | comparative clause | the two years right / swapped |
| en-b1 | comma figure, short Note | right / two digits swapped; the Passage writes it the same way |
| en-b2 | comma figure, short Note | right / two digits swapped; the Passage writes it in billions |
| en-b3 | comma figure, short Note | a plain count, right / two digits swapped |
| zh-b1 | comma figure, short Note | right / two digits swapped; the Passage writes it the same way |
| zh-b2 | comma figure, short Note | right / two digits swapped; the Passage writes it with no separator |
| zh-b3 | comma figure, short Note | en-b3's English Note under the Chinese interface |

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

On Claude Haiku 5.5, meant and run, on one key, one run on it at a time.
- **`main`** at b283bc51c, for every round and evaluation run.
- **The branch** at f99379156, for every round and evaluation run, as the evaluation's reports name it. Its source is 81f2c993e's: the two commits after 81f2c993e change only this folder and the live harness, which both arms ran.
- **Files:** each arm-round's lines and console output are `runs/<arm>-<round>-a.jsonl` and `.log`, and `results.md` is `score.ts`'s reading of them. Each evaluation run's report and log are `runs/eval-<arm>-<run>-report.md` and `.log`, and `runs/eval-compare.md` is the evaluation's own comparison.

**Runs.**
- **Arm-rounds:** 20, 10 for each arm, alternated. They sent 5,972 requests, with 0 refused, 0 failed, 0 timed out and 0 held at the stop, and none was void.
- **Two starts before the first round** were not counted (`runs/start-*.log`). The first refused its own output path, which was under the repository rather than a temporary folder, after one example core. The second was stopped at once. Neither wrote a line of its own, so $0.10 is counted for them.
- **`eval/checks`:** four runs, `main`, branch, `main`, branch. Each reached all 208 Find support sentences and 10 received documents. They made 1,481, 1,460, 1,481 and 1,459 requests, 5,881 in all, counted from the reports' requests: Find support's 834, 830, 832 and 812, Verify's checks, and 10 extractions. No request failed or was refused, by the logs and the core's own reasons.

**Spend, at the app's own count.**
- the arm-rounds: $1.62 (the harness's own pricing matched it to the cent);
- the two uncounted starts: $0.10, as above;
- the evaluation runs: $1.01 and $1.02 where the meter was logged (runs 3 and 4). Runs 1 and 2 made as many requests but logged no meter, so about $1.01 each, and $1.50 each was held against the stop while they ran.

That is **about $5.77 in all**, within the $9 stop.

| Bar | `main` (b283bc51c) | branch (f99379156) | Result |
|---|---|---|---|
| 1. The issue's two sentences ✓, each set-up and language | 10, 10, 10, 10 (EN); 10, 10, 10, 9 (ZH) of 10 | 10, 10, 10, 10 (EN); 10, 9, 10, 10 (ZH) of 10 | met |
| 1. `note-comparative`'s part: first reply contradicted, the example alone | 0 of 10 (EN, ZH) | 0 of 10 (EN, ZH) | met |
| 1. The same, beside the User's Document | not measured (below) | not measured (below) | not measured |
| 1. `note-figure`'s figure Not checked, with the User's Document | 0 (EN), 1 (ZH) of 10 | 0, 0 of 10 | met |
| 2. Any wrong sentence's ✓ more on the branch | the twins 0; held-out wrong: en-a2 7, zh-a2 1, others 0 of 10 | twins 0; en-a2 6, zh-a2 0, others 0 | met |
| 3. Held-out right ✓, per case (fails at 3 fewer) | 97 in all | 117 in all; the largest loss is 1 (en-a3, zh-a2) | met |
| 3. Held-out right ✓, in all (fails at a drop of max(6, 2 × 3) = 6) | 97 | 117 (a rise of 20) | met |
| 4. Contradicted on sentences labelled contradicted, Find support | 48 + 47 = 95 of 108 | 48 + 40 = 88 of 108 | **missed** (needed 93, `main`'s spread 1, allowed 2) |
| 4. Paired: Contradicted in both `main` runs, not in both branch runs | | fs-142, fs-151 | **missed** |

**Bar 4, run by run** (Find support; each run has 54 sentences labelled contradicted):

| Run | Commit | Requests | Spend | Contradicted, of 54 | fs-142 | fs-151 | fs-046 | Report and log |
|---|---|---|---|---|---|---|---|---|
| `main` 1 | b283bc51c | 1,481 | about $1.01 (no meter logged) | 48 | Contradicted | Contradicted | Contradicted | `runs/eval-main-1-report.md`, `runs/eval-main-1.log` |
| branch 1 | f99379156 | 1,460 | about $1.01 (no meter logged) | 48 | Unsupported | Not checked | Contradicted | `runs/eval-branch-1-report.md`, `runs/eval-branch-1.log` |
| `main` 2 | b283bc51c | 1,481 | $1.01 | 47 | Contradicted | Contradicted | Contradicted | `runs/eval-main-2-report.md`, `runs/eval-main-2.log` |
| branch 2 | f99379156 | 1,459 | $1.02 | 40 | Unsupported | Not checked | Not checked | `runs/eval-branch-2-report.md`, `runs/eval-branch-2.log` |

**Fault 1 did not reproduce on `main`, with the example alone.** At b283bc51c, `main`'s first reply on `note-comparative`'s part said supported in 10 of 10 checks with the example alone. In Chinese the real sort often didn't split the sentence at all. So the gate shows the part rule costs no ✓, and no wrong comparative passes because of it. It can't show the rule fixing a first reply that is already right.

**2026-11-15, after the runs: bar 1's first replies beside the User's Document weren't measured.**
- Both set-ups of an arm-round ran in one process, the example alone first. `firstReplyOf` searched the arm-round's one list of replies, and the two set-ups check the same sentence and part. So the first reply recorded beside the User's Document is the example alone's, in 111 of its 120 rows over both arms.
- In the other 9 (Chinese, where the example alone's sentence wasn't split into parts), it is its own, and it said supported.
- The run files keep each check's verdicts, not the model's replies, so those first replies can't be recounted.
- The harness now reads only the replies of the core that checks the sentence, and takes the first reply whose verdict the check's own reader reads, in any form it accepts. The run files above were written before that change.

**Fault 2 shows on the held-out comma figures in a short Note.** The right sentence's ✓ of 10, `main` against the branch: en-b2 5 → 10, en-b3 2 → 10, and zh-b3 (en-b3's Note under the Chinese interface) 2 → 10.

**The wrong comparatives, read apart** (✓ and Contradicted of 10, `main` then branch):

| Case | `main` | branch |
|---|---|---|
| en-a1 | 0 and 10 | 0 and 10 |
| en-a2 | 7 and 3 | 6 and 4 |
| en-a3 | 0 and 10 | 0 and 10 |
| zh-a1 | 0 and 10 | 0 and 10 |
| zh-a2 | 1 and 4 | 0 and 7 |
| zh-a3 | 0 and 10 | 0 and 10 |

Naming the whole sentence made no wrong clause pass more often. en-a2's wrong sentence, its direction flipped, is a ✓ on both arms, 7 and 6 times of 10: a fault of `main`'s, which this change neither causes nor fixes.

**Bar 4, read apart from its verdict.**
- None of the sentences whose Contradicted differs between runs was checked in parts.
- For a whole sentence, the branch's instructions and message differ from `main`'s only when a figure in it has a separator the sentence doesn't settle: those readings are no longer offered. fs-142 and fs-151 have no such figure. What fs-151's check sends was later captured and replayed, below; fs-142's was not.
- Branch run 2 lost 10 contradicted sentences against branch run 1 and gained 2.
  - 6 of the 10 ended Not checked the same way: a verdict given without `cite`, and the quote it gave when asked afterwards not found. 2 of those, fs-023 and fs-046, have such a figure; the other 4 don't.
  - Of the other 4, fs-121 gave no quote at all, fs-066's reply couldn't be read after the strict judgement, and fs-013 and fs-112 ended Unsupported. None of those 4 has such a figure.

The bar is as written, and it stays missed.

## The confirming run of bar 4 (2026-11-14, written before it)

The owner allowed one confirming run of bar 4 alone, past the first stop. The second reader's rulings were built before it:
- step 1 settles a figure only where its Note leaves the separators open, or reads them as its Passage does. Where the Note's own language reads the same writing the other way, the figure is Not checked with both readings named;
- a figure read three or more ways says only that it reads several ways;
- the Chinese card writes readings in 万 and 亿 with the currency's Chinese name.

**Cases the step-1 change moves: 0.** A free count over the gate's 401 sentences and Notes (the 208 Find support sentences, the labelled claims, the example's Notes and the held-out cases) found no figure that its Note settles one way while a Passage, or a Document it could cite, writes it identically under the other decimal mark. A control, a German Note holding `note-figure`'s figure beside the example's English report, was found.

**How it runs.**
- **Arms:** `main` at 23df13e89 against the branch's pushed head, which is `main` merged in. The rule is bar 4's as written above: Contradicted on sentences labelled contradicted over two runs, and the paired rule.
- **Order:** `main`, branch, `main`, branch, one lease each on the first Anthropic key, with Claude Haiku 5.5 and a probe before each run.
- **What each run checks:** Find support only (`INCARNAMIND_EVAL_CHECKS_FIND_SUPPORT_ONLY=1`), since bar 4 reads nothing else, at about $0.57 a run.
- **Stop:** $4.00 in all for this run, held by the app's cap on each run. A run doesn't start with less than $0.90 left.
- **Void rule:** a run with any refused or failed request is void.
- **Environment:** the evaluation runs with a temporary HOME and model cache, a copy of the one it reads, and its own temporary data folder.

### The confirming run's results (2026-11-14)

On Claude Haiku 5.5, meant and run, on the first Anthropic key: `main` at 23df13e89 and the branch at 9eeddbab9, as the reports name them. Only the new log files of this folder were uncommitted while the branch ran. The comparison is `runs/confirm-compare.md`.

- **Runs:** four, `main`, branch, `main`, branch. Each reached all 208 Find support sentences.
- **Requests:** 3,310 in all. None was refused, failed or timed out, by the logs, and no run was void. One sentence in `main`'s first run, fs-118, read "refused": the model's own reply declined, and its requests all returned. It is labelled supported, so it is outside bar 4.
- **Spend at the app's own count:** **$2.28 in all**, against the $4.00 stop.

| Run | Commit | Requests | Spend | Contradicted, of 54 | fs-142 | fs-151 | fs-046 | Report and log |
|---|---|---|---|---|---|---|---|---|
| `main` 1 | 23df13e89 | 824 | $0.57 | 42 | Contradicted | Contradicted | Not checked | `runs/confirm-main-1-report.md`, `runs/confirm-main-1.log` |
| branch 1 | 9eeddbab9 | 815 | $0.57 | 47 | Contradicted | Not checked | Contradicted | `runs/confirm-branch-1-report.md`, `runs/confirm-branch-1.log` |
| `main` 2 | 23df13e89 | 866 | $0.59 | 44 | Unsupported | Contradicted | Not checked | `runs/confirm-main-2-report.md`, `runs/confirm-main-2.log` |
| branch 2 | 9eeddbab9 | 805 | $0.55 | 46 | Not checked | Not checked | Contradicted | `runs/confirm-branch-2-report.md`, `runs/confirm-branch-2.log` |

| Bar 4 | `main` | branch | Result |
|---|---|---|---|
| Contradicted on sentences labelled contradicted, 2 runs | 42 + 44 = 86 of 108 | 47 + 46 = 93 of 108 | met (needed 84: `main`'s spread 2, allowed 2) |
| Paired: Contradicted in both `main` runs, not in both branch runs | | fs-151 | **missed** |
| The other way: Contradicted in both branch runs, not in both `main` runs | fs-046 | | (reported) |

**The paired rule is missed,** in the first gate (fs-142 and fs-151) and again here (fs-151). If this change ships, it ships as a dated exception, with the bar recorded as missed. What was shown about fs-151 follows, all of it free, with scripted models and nothing sent. The evaluation keeps each request's kind, reply and Tool calls, but not what the request sent, so nothing here is a real run's request.

**1. A one-row capture** (2026-11-14, after the confirming run).
- **The test:** a throwaway test, not committed. It sets up a core with the unit tests' helpers (`setUpWithDocuments`), with a scripted model that searches once and replies unsupported (`checkGenerate({})`). It adds one CSV, a copy of fs-151's table with only its header row and fs-151's own row, sets the interface to Chinese, and checks fs-151's sentence with `checkClaim`. It writes each check Run's instructions and message to a file.
- **The command:** `SENT_OUT=<file> npx vitest run <the test>`, with a temporary HOME, once in each checkout.
- **The checkouts:** `main` at 23df13e89; the branch with b0734765d's changes in place, before they were committed (b0734765d has `main` at 23df13e89 merged in); and the branch again at 618ff6223.
- **The result:** three files of 38,786 bytes, each with sha256 `579f10b33b19fccb6fc766bc2254519733834e4359d541483a95bf9f1bd3e8a8`, the same bytes, ids included. The files hold the case's words, so they aren't committed.

**2. A replay of the eight saved runs** (2026-11-15).
- **What it replays:** each run's saved replies for fs-151, in order: its searches, replies, cite calls and evidence reply. Each request a code makes is answered with the saved reply of its kind, the kind the evaluation named it by, from its instructions.
- **How:** through `main` at 23df13e89 and through the branch at 618ff6223. It runs against the evaluation's own copy of fs-151's Document, with the evaluation's provider and model (Anthropic, `claude-haiku-5-5`).
- **The result:** each run came back with its saved outcome on both codes, with the same requests in the same order and every saved reply used. Both codes read all eight the same way.

| Saved run | Outcome, saved and replayed on both codes | Requests, by kind and order |
|---|---|---|
| First gate, `main` 1 | Contradicted | check, check, check, confirm, strict |
| First gate, branch 1 | Not checked (no-evidence) | check, check, evidence |
| First gate, `main` 2 | Contradicted | check, check, check (asked to calculate first), confirm, strict |
| First gate, branch 2 | Not checked (no-evidence) | check, check, evidence |
| Confirming, `main` 1 | Contradicted | check, check, confirm, strict |
| Confirming, branch 1 | Not checked (no-evidence) | check, check, evidence |
| Confirming, `main` 2 | Contradicted | check, check, check, confirm, strict |
| Confirming, branch 2 | Not checked (no-evidence) | check, check, evidence |

**3. The replay's full requests.** Each request's instructions and whole prompt were compared, as the two codes sent them in the replay. That covers every message, the Passages its searches returned, and its Tool results, tools and response format. In all, 31 requests and 961,828 bytes on each code, the same on both, in all eight runs. These are the requests the two codes make when given the same replies.

**4. What ends the branch's four runs Not checked.**
- In each, the model gave its verdict without a record the reader takes, and the app asked for its evidence.
- The evidence reply quoted the table's row with its raw tabs, inside a JSON string. The judged replies' shared JSON reader doesn't read a raw tab in a string, so the reply was unreadable (#3125).
- With only the tabs escaped, both codes read the reply, and the sentence ends Contradicted. With only its location changed to the Passage's own, it still reads not found.
- The same fault ends contradicted labels no-evidence on both arms: 13 on `main` over its four runs and 12 on the branch over its four. fs-046 on `main` in both confirming runs is one of them.
