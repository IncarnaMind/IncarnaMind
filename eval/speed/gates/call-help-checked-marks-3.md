# The gate for call help's ✓ only where the sentence check passed, third file (#2847)

Written and committed on 2026-11-12, before any run it gates. Its bars are those of `call-help-checked-marks-2.md`, as they were ruled before that file's runs, with the same numbers and the same tests. That file's run on Claude Haiku 5.5 failed bar 2 in Chinese: kept ✓ was 10 of 43. In 24 of its 30 Chinese presses, the sentence check's reply ended at its output limit of 300 tokens a sentence, and the sentences of a cut reply stay Not checked. #2951 fixed that on main.

Before this file, a pilot ran 30 Chinese presses of the second file's slice on Claude Haiku 5.5, on this branch alone. That slice had already been read, and the pilot read no bar. None of the check's 30 requests reached its limit, and the longest reply was 1,365 tokens. Each of the 59 Citations whose quote was found got a verdict on at least one sentence it is cited in, except 7. Those 7 are cited only on lines the check gave no verdict. Two are on a question, and two on what the User offers to do. For the other three, the record doesn't say why.

## What changed since the second file

- **The check's room (#2951, on main).** Each batch of a reply's check now goes out with room for the model's thinking: 5,000 tokens plus 300 a sentence, where it had 300 a sentence. A batch keeps the old room only when what it would set aside for the larger room doesn't fit. That means the Answer's check limit of $0.25, or what the monthly cap has left, which counts it twice. A model with no price sets nothing aside. A call-help reply's check runs under that same $0.25 limit, as it did. On Claude Haiku 5.5, Claude Sonnet 5.5 and a model with no price, a one-sentence batch goes out with 5,300 tokens (`tests/core/callHelpMarks.test.ts`).
- **The ask bar (#2936, on main).** The call-help panel's grid of seven buttons became an ask bar: three prompts, and the rest under More…. A press is still the same kind of press, and its reply's request, prompt and stream are the same, byte for byte, on both arms. The runner presses through the core, as before. The panel's smoke specs press the prompts on the ask bar.

## The change, as it now stands

On main, call help's ✓ beside a Citation means only that its quote was found. Here the reply shows at once with its Citations plain, as before. Once it ends, its cited sentences get the check an Answer's sentences get (#2311), unchanged. A chip shows ✓ only where that check passed the sentence it is cited in: the judgement records those places on each Citation, and the Citation's own check, its sentences' worst, is unchanged. A line the check doesn't judge shows its Citations plain. That covers a line too short to be a claim, a calculated figure's sentence, and the lines #2922 lists. A reply's check runs to its end, as any Answer's does: nothing in the panel ends it, and the ✓ is there whenever the panel shows the reply again. The reply's request, prompt and stream are the same byte for byte as on main with the ask bar (`tests/core/callHelpMarks.test.ts`).

## The runs

- **Arms, paired** as `../README.md` › Paired runs says, the order turning within each cell: `help-marks-quote-only`, main's path (the core's evaluation switch `helpMarksQuoteOnly`: a ✓ beside every found quote, nothing judged), against `today`, this branch.
- **The slice:** `call-help-marks-3` (`../callHelpMarks3.ts`).
  - 15 English presses, each with a Chinese twin, about solar panels on a bakery chain's roofs.
  - The same mix of buttons as the second file's slice.
  - Every case has Documents of its own, and its own Meeting and Note.
  - It was committed before any run, and no run has read it. No Document, line or press of it is in a slice before it, or in a prompt's examples.
  - The second file's slice is not run again: its runs and the pilot have read it.
- **Models, in order:**
  - Claude Haiku 5.5 runs first. Claude Sonnet 5.5 runs only if every bar holds on Haiku. A bar that fails on Haiku stops the gate there.
  - Each is the Answers model, with call help on Same as Answers.
  - Claude Opus 5.5 judges both arms (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-opus-5-5`).
  - One route and one key for every run: a second direct Anthropic key with its own per-minute limit. If it runs out of credit, the run is void, and no run goes on another key before a dated line here names it.
- **Samples:** as the second file.
  - Two runs of all 30 presses on each model (`INCARNAMIND_EVAL_SPEED_RUNS=2`), false Supported counted (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), and first requests compared (`INCARNAMIND_EVAL_SPEED_SAME_REQUEST=1`).
  - A press waits up to 60 s after the reply's end for every mark to settle, within the 3 minutes the press is given from its start. Both arms' ✓ are read on the settled reply. A press that hasn't settled by then counts as failed to run.
  - A press's second run is asked right after its first, in the same Library, Meeting and help conversation. The two runs show how much one press repeats; they are not two independent samples.
- **Shared keys** (the rules of 2026-11-10):
  1. Each run holds a machine-wide lock on its key for its whole length, one lock a run, so no other run shares the key's per-minute limit. The Haiku run and the Sonnet run each hold it on their own, and it is released between them.
  2. Before each run, one smallest request reads the key's allowance left from its rate-limit headers. The run starts only above 90%, and the figure is recorded with the run.
  3. A run counts only if none of its requests was refused, failed or timed out. Otherwise the run is void: it is kept, struck with the reason, and run again, and its numbers are not read. This is read from the run's own record: the gate's section of `report.md` prints "Void" at the top of a model's part when any model request of the press ended other than finished, or any press failed for a reason other than its marks' 60 s wait. That wait is bar 5's.
     The rulings below tighten this rule.
  4. The runs go strictly one after another. No run sends more than four requests at once. A run starts only at a 15-minute load of 24 or less, and its record keeps the one-minute load at its start and end.
- **Spend:** about $3. Haiku costs about $0.75: the second file's Haiku run cost $0.73, the judge $0.66 of it. Sonnet costs about $2.20. #2847's cap is $8, and $1.31 was spent before this file's first run. The cap is held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`, which holds the pilot) and `INCARNAMIND_EVAL_SPEED_STOP_USD=6.74`.

## Rulings of 2026-11-12, before any run

Each is tighter than what it replaces, none looser.

1. **A void can't hide a failure of the branch.** A press can fail on the branch while main finished its pair. If every request of it finished (the product's by their recorded outcome) and the judge's call isn't what threw, that is bar 5's failure. It is not a void, and it is never taken again. The report tells the two apart where the record can. A failed press keeps its requests in the record, and a judge's call that threw is named as such. Where the record can't tell, the report prints the reason and says so. No void run is taken again before its reasons are read.
2. **The count, zero included.** For each model, the section prints how many model requests the record holds and how many ended other than finished. A model request with no outcome recorded voids the run too, and so does a finished press with no model request in the record. `tests/eval/callHelpMarksReport.test.ts` holds this with literal rows:
   - a failed request prints Void;
   - a request with no outcome prints Void;
   - a press that failed on the branch alone with its requests finished prints bar 5's failure and no Void;
   - a clean run prints its count and no Void.
3. **What the record can't see.** The judge's calls carry one retry in the runner, so a judge request refused once and answered on its retry is not in the record. The run still stands on it: the judge grades a finished reply and can't change what the product did, and its model's per-minute limit is its own. On the product's side, the reply's request has no retry. A batch of the check has one, which the SDK makes around the model call. Each attempt passes through the timing record, which wraps the model alone, so a refused first attempt is in the record and voids the run.

## What is read, per press, from `report.json`

Counted by Citation number as the panel numbers them. A number shows ✓ when any line it is shown on shows ✓, as each arm's panel draws it: on main, a found quote; here, a line whose sentence the check passed.

- **A wrong ✓:** the judge lists a shown number, its sentence stating as so something its quoted words don't say, and that number shows ✓. A press with one or more counts once (`falseSupported` above 0). A number reused on two lines counts against the branch even when its ✓ sits on the other line.
- **W0 and W1, on the branch's own replies:** a press has W0 when it shows a number with a found quote that the judge lists (`marks.listed` above 0): what main's rule would mark ✓ on that very reply. It has W1 when such a number shows ✓ under the branch's rule (`marks.listedChecked` above 0). On one reply the branch's ✓ are a subset of main's, since a ✓ needs both a found quote and a passed check.
- **Kept ✓:** of the shown numbers whose quote was found and which the judge doesn't list (`marks.held`), those that show ✓ (`marks.checked`). Of those, the ones the check gave a verdict, passed or found unsupported or contradicted (`marks.judged`). Every held number without ✓ is counted by why it shows none (`marks.missed`), those the check judged unsupported or contradicted included.
- **The reply:** expected Passages cited, judged right, every Citation found. On both arms a quote counts as found when its quote check found it, whatever its sentence's check then said, and the judge is shown it so.
- **Speed:** the first words the panel shows and the reply's end (`firstWordsMs`, `doneMs`). The runner reads `doneMs` on both arms in `runOnArm` (`paired.ts`) from the same event: the last "answer.finished" or "answer.failed" the arm's core announces while the press runs, and a press makes one Answer. The check's requests start after it, so they never count in `doneMs`.

## Main's spread, read from its sources

As the second file read them. Each run of A, B and C is 15 presses of a language; D's slice has 12. All were judged by Claude Opus 5.5, on main's path for the marks:

- **A** (#2526, comment of 2026-11-08 17:41 UTC, `call-help-fastest.md`): three runs of the call-help set.
  - Claude Sonnet 5.5: wrong ✓ 3–5 English and 6–9 Chinese; cited 15–15 and 15–15; every Citation found 15–15 and 15–15; judged right 14–15 and 14–15; reply's end, median, 4.64 s and 5.02 s.
  - Claude Haiku 5.5: wrong ✓ 6–10 and 7–8; cited 13–15 and 12–14; found 14–15 and 13–15; judged right 13–13 and 9–13; end 2.73 s and 2.87 s.
- **B** (#2847, comment of 2026-11-08 22:12 UTC, main's arm): one run each, on the call-help set's English and a fresh Chinese slice.
  - Sonnet: wrong ✓ 4 and 7; cited 15 and 14; right 15 and 15; found 15 and 14.
  - Haiku: 7 and 5; cited 14 and 14; right 13 and 8; found 14 and 15.
- **C** (#2847, comment of 2026-11-09 01:19 UTC, Part A's main arm): one run each, on the twins slice.
  - Sonnet: wrong ✓ 1 and 2; cited 15 and 15; right 15 and 14; found 14 and 15.
  - Haiku: 6 and 3; cited 14 and 15; right 13 and 12; found 14 and 15.
- **D** (#2526, comment of 2026-11-08 18:18 UTC, `today`'s arm on its own slice): Sonnet's reply's end, median over three runs, 4.50 s English and 4.92 s Chinese.

A is the only source that gives each measure's range over repeated runs of one slice; D gives a median over its three runs, not a range. A's Claude Haiku 5.5 runs are its quick-model arm: Haiku writing call help under Claude Sonnet 5.5 as the Answers model, thinking off, as call help always runs. Here Haiku is the Answers model itself. No source gives repeated runs of that, so A is the nearest.

Every median this file computes is the middle value, or the mean of the two middle values when the count is even. A's and D's medians are as their comments give them; how they were taken isn't said. The runner's own tables in `report.md` print the lower of the two middle values, and its own guards (cited, judged right, every Citation found and false Supported, each with its own verdict) aren't what this gate reads. The gate reads the section the runner adds for this set.

## The bars, as the second file ruled them before its runs

A cell is a model and a language, 30 pairs over the two runs. Bars 2, 3 and 4b and the reported kept ✓, settle times and costs count the pairs both arms finished. Bar 1 counts the branch's presses on a model, finished or not. Bar 5 counts the pairs main finished. In bar 3, a press with no Citation counts as not having every Citation found, and a judge's grade that couldn't be read as not right, on both arms alike.

1. **The check clears wrong ✓, measured on the same replies.** On each model, over the branch's own replies, pooled over both languages and both runs (60 presses):
   - **1a, it clears most of them:** W1 is at most half of W0, rounded down. Where W0 is under 4 on a model, half can't be told from chance, and there W1 must be at most 1.
   - **1b, it tells held from wrong:** over the shown numbers with a found quote, the share that show ✓ among those the judge doesn't list must be higher than among those it lists. The test is Fisher's exact, one-sided, p < 0.05, on [[held with ✓, held without], [listed with ✓, listed without]]. It is read only on a model where the judge lists at least 4 found numbers on the branch's replies. Below 4 it is printed as not readable, and 1a's rule for few (W1 at most 1, as where W0 is under 4) is the bar that stands there.
   - **Reported, not gated:** main's arm's pooled count of presses with a wrong ✓, its flips between its two runs, and the fall between the arms (the "before" a reader recognises). Also W0 beside main's count, as a check that the arms are alike.
   - **How the pull request closes:** on each model, if the branch's Chinese W1 is no higher than its English W1 plus the branch's own flips, it closes #2847. Otherwise it is "Part of #2847", naming what is left and pointing to #2922. The branch's own flips are the larger of its two language cells' counts of presses whose W1 differs between its two runs, a press it didn't finish in one or both of them included; main's flips, reported, are counted the same way but over both of its cells together.

   Why on the same replies: on one reply the branch's ✓ are a subset of main's, so W0 less W1 is the check's work alone. Between the arms, the replies are sampled twice. Why 1b: a filter that dropped ✓ at random could pass 1a and bar 2 together, and this is the bar it can't pass. Numbers within one press aren't independent, so the test is a floor, not a measurement. Why Chinese against English isn't a bar: the change improves both languages by construction, so parity can't be a reason not to ship it; it is the reason the issue stays open.
2. **Kept ✓ isn't nothing.** In every cell, at least a third of the shown numbers the judge says their lines hold show ✓ on the branch (`marks.checked` of `marks.held`). Why: this is a floor against a check that shows nothing, not parity with Answers. A trust fix must not be held back by lines the check was never able to judge (#2922). A branch that shows no ✓ fails it, and so does a cell where the judge says no shown number holds.
3. **The reply holds.** In every cell, expected Passages cited, judged right and every Citation found on the branch are each no lower than main's pooled count by more than the allowance: twice main's widest range of one run on that measure in that model and language, across A's three runs, and at least 2:

   | Cell | Cited | Judged right | Every Citation found |
   |---|---|---|---|
   | Sonnet 5.5 · English | 2 (15–15) | 2 (14–15) | 2 (15–15) |
   | Sonnet 5.5 · Chinese | 2 (15–15) | 2 (14–15) | 2 (15–15) |
   | Haiku 5.5 · English | 4 (13–15) | 2 (13–13) | 2 (14–15) |
   | Haiku 5.5 · Chinese | 4 (12–14) | 8 (9–13) | 4 (13–15) |

   Why: both arms answer the same slice with the same request, so a slice's difficulty is out, and only chance moves these. Two runs pooled can move by up to twice one run's range. The floor of 2 is there because three runs that didn't move are no proof that a measure can't.
4. **The reply is as fast.**
   - **4a, the same request:** in every pair, the first request's model, system prompt, Tool definitions and parameters are the same on both arms, their libraries' ids, times and file dates aside, and each library's own prompt-cache key (`sameSetup`). No exception. Reported, not gated: each pair whose messages differ, with where they differ (`messageDifference`). If more than 3 of a cell's 30 pairs differ that way, the gate's section of `report.md` says so at its top: 4b is weaker for that cell, and it is read before anything ships. `tests/core/callHelpMarks.test.ts` holds, with the scripted model, that the reply's end is announced before any request of its check starts.
   - **4b, not slower beyond chance:** in each cell, for first words and for the reply's end, count the pairs both arms finished where the branch was slower; ties are left out. The bar fails when a one-sided sign test gives that count a chance under 1% were the arms equally fast. The exact chance decides: at 30 untied pairs that is 22 or more, at 28 it is 21, at 26 or 27 it is 20.
   - **Reported:** the median paired difference per cell, and main's own move between its two runs' medians.
5. **No press fails on the branch alone.** In every cell, no press fails to run on the branch where main finished it. A press waits up to 60 s after the reply's end for its marks. Why: a branch press waits for its marks and main's doesn't, so a check that never settles would otherwise drop out of both arms' counts instead of counting against the branch.

Every bar must hold on both models. A bar that fails keeps the change from shipping, and the numbers go on #2847. No bar moves after a run.

## Reported, not gated

- **Kept ✓ among the lines the check judged** (`marks.checked` of `marks.judged`), against 83% English and 78% Chinese: the check's rate on an Answer's one-fact sentences on Claude Haiku 5.5, 92% and 87% (#2515, as shipped), less 9 points.
- **The lines that showed no ✓, by reason** (`marks.missed`).
- **How long after the reply's end every mark had settled:** median, 90th percentile, and the share within 3, 5, 10 and 20 s, per cell. The owner will judge whether marks that late are worth having.
- **What a press costs the User:** its model requests and their input and output tokens, from the press until its marks settled, the median per press on each arm, with how many of those requests were the check's (its tokens are in the medians).
- **Each press with a wrong ✓ on either arm,** with its sentence and its check. Also the load at each run's start and during it, the allowance read before it, and the spend, with the judge's share apart.

## Result, 2026-11-12

**Bar 1a fails on Claude Sonnet 5.5: W1 is 12 against at most 10 (W0 21).** The gate fails and nothing ships. Every other bar holds on both models, and neither run is void.

Both runs were at commit c893ebab2, judged by Claude Opus 5.5, on the second direct Anthropic key, one after the other. Each held the key's lock for its whole length.

| | Claude Haiku 5.5 | Claude Sonnet 5.5 |
|---|---|---|
| Run (UTC) | 02:40:21–02:54:49 | 02:58:37–03:14:44 |
| Allowance before it | 99% | 99% |
| 15-minute load, start → end | 9.18 → 7.51 | 7.28 → 4.70 |
| One-minute load, start / end (range) | 5.70 / 7.59 (4.6–8.9) | 7.19 / 2.88 (2.6–6.5) |
| Model requests in the record, ended other than finished | 250, 0 | 307, 0 |
| Spend (the judge's share) | $0.78 ($0.71) | $2.01 ($0.61) |

### The bars

| Bar | Claude Haiku 5.5 | Claude Sonnet 5.5 |
|---|---|---|
| **1a**, W1 at most half of W0 | W0 31, W1 5, at most 15: holds | **W0 21, W1 12, at most 10: fails** |
| 1b, ✓ held against listed (Fisher) | 41 of 76 (54%) against 7 of 42 (17%), p = 0.0000554: holds | 94 of 107 (88%) against 16 of 28 (57%), p = 0.000602: holds |
| Reported: main's presses with a wrong ✓ (its flips) | 31 (7) | 21 (7) |
| Reported: how it would close (Chinese W1, English W1, flips) | 5, 0, 3: Part of #2847 | 6, 6, 4: Closes #2847 |
| 2, kept ✓, English · Chinese | 24 of 44 (55%) · 17 of 32 (53%): holds | 41 of 50 (82%) · 53 of 57 (93%): holds |
| 3, cited, English | 27 → 27: holds | 30 → 30: holds |
| 3, judged right, English | 18 → 20: holds | 27 → 27: holds |
| 3, every Citation found, English | 30 → 29: holds | 30 → 30: holds |
| 3, cited, Chinese | 30 → 29: holds | 30 → 30: holds |
| 3, judged right, Chinese | 18 → 18: holds | 26 → 28: holds |
| 3, every Citation found, Chinese | 30 → 30: holds | 29 → 30: holds |
| 4a, the same request | 60 of 60: holds | 60 of 60: holds |
| 4b, first words, slower pairs, English · Chinese | 13 · 12 of 30: holds | 19 · 19 of 30, p = 0.100: holds |
| 4b, the reply's end, slower pairs, English · Chinese | 15 · 11 of 30: holds | 19 · 19 of 30, p = 0.100: holds |
| Reported: median paired difference, the reply's end, English · Chinese | +0.03 s · −0.18 s | +0.07 s · +0.04 s |
| 5, failed on the branch alone | 0 · 0: holds | 0 · 0: holds |

Reported, per cell:

- **Marks settled after the reply's end:**

  | | Median | Within 5 s |
  |---|---|---|
  | Haiku · English | 3.31 s | 29 of 30 |
  | Haiku · Chinese | 3.98 s | 18 of 28 |
  | Sonnet · English | 1.92 s | 29 of 30 |
  | Sonnet · Chinese | 2.08 s | 29 of 30 |

  Haiku's Chinese settle times count 28 presses, not 30: in two presses the judge's reply came back empty twice, cut at its length. The runner keeps a press's marks only with a judgement it can read, so those two drop out of bar 2 and the settle times. Bar 3 counts them as not judged right.
- **A press's cost, median.** Main: 1 to 2 requests. The branch: 3, one of them the check's.

  | | Main, tokens out | The branch, tokens out |
  |---|---|---|
  | Haiku | 263 to 287 | 893 to 1,062 |
  | Sonnet | 273 to 286 | 472 to 495 |

  On the branch the tokens in rise by about 1,000 to 1,500.
- **Kept ✓ among the lines the check judged:** Haiku 24 of 34 and 17 of 29; Sonnet 41 of 44 and 53 of 57.
- **On Claude Sonnet 5.5, first words and the reply's end are the same pairs.** In all 120 presses, on both arms, the first words came within 0.7 ms of the reply's end (median 0.2 ms). The reply's request gave its first text a median 4 ms before it ended. So the two sign tests count the same pairs. On Haiku the first words came a median 1.1 s before the end.

Spend: $2.85 with the pilot ($0.05). #2847 is at $4.11 of its $8.

### The presses with W1, line by line (a reading made after the run; it changes no bar)

For each number the judge lists that shows ✓ on the branch, this gives the lines that carry it and its Citation's check. A Citation's check is the worst of its sentences. The record holds, per Citation, that check and whether ✓ shows on any line. It holds no verdict per line. The judge names numbers, not lines. So where a listed number sits on one line, the ✓ is on the line whose claim the judge faults. Where it sits on several lines, the record can't say which line carries the ✓, or which line's claim the judge faults.

| Model | Press | Listed number with ✓ | Lines carrying it | Its Citation's check | The ✓ |
|---|---|---|---|---|---|
| Haiku | zh12-answer-two run 1 | 1, 2 | 2 each | not checked, both | on one line at least; which, not recorded |
| Haiku | zh12-answer-two run 2 | 1, 2 | 2 each | not checked, both | on one line at least; which, not recorded |
| Haiku | zh12-no-monday run 1 | 1 | 1 | passed | on the line the judge faults |
| Haiku | zh12-check-right run 1 | 2 | 1 (a → line) | passed | on the line the judge faults |
| Haiku | zh12-want-bills run 2 | 1 | 2 | unsupported | on one line at least; which, not recorded |
| Sonnet | en12-answer-unknown run 1 | 1; 2 | 2; 1 | unsupported; passed | 2: on the line the judge faults |
| Sonnet | en12-answer-unknown run 2 | 1 | 2 | unsupported | on one line at least; which, not recorded |
| Sonnet | en12-answer-earlier run 1 | 1 | 2 | unsupported | on one line at least; which, not recorded |
| Sonnet | en12-check-right run 1 | 2 | 2 (one a → line) | not checked | on one line at least; which, not recorded |
| Sonnet | en12-sum run 1 | 1 | 1 ("…by Wednesday, and they agreed") | passed | on the line the judge faults |
| Sonnet | en12-sum run 2 | 3 | 1 ("…by Wednesday, and they agreed") | passed | on the line the judge faults |
| Sonnet | zh12-answer-price run 1 | 1 | 2 | not checked | on one line at least; which, not recorded |
| Sonnet | zh12-answer-two run 1 | 1, 2 | 2 each | not checked, both | on one line at least; which, not recorded |
| Sonnet | zh12-answer-unknown run 1 | 1, 2 | 1 each | passed, both | on the line the judge faults |
| Sonnet | zh12-answer-unknown run 2 | 1; 2 | 2; 1 | unsupported; passed | 2: on the line the judge faults |
| Sonnet | zh12-ask-shops run 1 | 1 | 1 | passed | on the line the judge faults |
| Sonnet | zh12-check-right run 1 | 1 | 1 | passed | on the line the judge faults |

- **Claude Haiku 5.5:** of 5 presses with W1, 2 have a ✓ on the very line the judge faults. In the other 3, the listed number sits on two lines, and not every sentence carrying it passed. The record doesn't say whether the ✓ is on the faulted line.
- **Claude Sonnet 5.5:** of 12, 7 have a ✓ on the very line the judge faults. In the other 5, the listed number sits on two lines, and not every sentence carrying it passed; the record doesn't say whether the ✓ is on the faulted line.
- **Presses with the ✓ only on another line of the same number:** the record can't count them. At most, they are the 3 and the 5 above.
