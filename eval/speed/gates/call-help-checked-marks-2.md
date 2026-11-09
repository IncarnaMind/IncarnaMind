# The gate for call help's ✓ only where the sentence check passed, second file (#2847)

Written and committed on 2026-11-09, before any run it gates. It replaces `call-help-checked-marks.md`, whose bars never ran on the slice: that file's one run was a pilot of 8 presses of the call-help set, which earlier runs had read. The slice `call-help-marks` (`../callHelpMarks.ts`) is still unread.

## The change, as it now stands

On main, call help's ✓ beside a Citation means only that its quote was found. Here the reply shows at once with its Citations plain, as before; once it ends, its cited sentences get the check an Answer's sentences get (#2311), unchanged. A chip shows ✓ only where that check passed the sentence it is cited in: the judgement records those places on each Citation, and the Citation's own check, its sentences' worst, is unchanged. A line the check doesn't judge shows its Citations plain. That covers a line too short to be a claim, a calculated figure's sentence, and the lines #2922 lists. The panel ends only the check of a reply it asked for itself once it no longer shows it, and never a reply. The reply's request, prompt and stream are the same byte for byte (`tests/core/callHelpMarks.test.ts`).

## What changed from the first file, and why

- **The ✓ is per sentence, not per Citation.** A line too short to be judged no longer takes the ✓ its marker earned in another sentence. A marker reused by a sentence that didn't pass no longer takes the ✓ away from one that did.
- **The stops end only a check, and only of a reply the panel asked for itself and no longer shows.** The first file's stops ended the reply itself, so they could cut a reply the User was reading in the assistant.
- **Bar 1** is now a rule computed from the run: a fall larger than main's own flips. The first file's "at most half" didn't hold its own reasoning.
- **Bar 2** is now a floor against a check that shows nothing, not parity with Answers (decided on #2847, 2026-11-09). A trust fix must not be held back by lines the check was never able to judge. Those lines are reported, by reason.
- **Bars 3 and 4** use main's spread read right. The first file mixed A's repeated runs of one slice with B's and C's single runs on other slices, and misstated them: it gave Claude Sonnet 5.5's cited as 15–15 though B gave 14, and Claude Haiku 5.5's Chinese judged right as 9–13 though B gave 8. Its 0.52 s spread mixed English with Chinese. Here a measure's chance range comes from A's repeated runs of one slice, since both arms answer one slice; B and C are shown for how much a slice's difficulty moves the counts, which a paired run doesn't meet.
- **A new bar:** no press fails on the branch where main finished. A press on the branch waits for its marks, and main's has none to wait for.

## What changed from the first draft of this file, and why (2026-11-09, before any run)

1. **Bar 1 measures the check on the same replies, not between the arms** (W0 and W1, with Fisher's test). Between arms the replies are sampled twice, and on a slice where main gives 1 or 2 wrong ✓ per 15 the rule would fail a change that can't be worse. Chinese against English now decides how the pull request closes, not whether it ships.
2. **Bar 4 is a sign test on the pairs, plus the same first request in every pair.** The draft's fixed ±0.5 s would fail by chance more often than not, and its floor came from the branch's own pilot.
3. **Bar 5's wait is 60 s, not 20,** with the share settled within 3, 5, 10 and 20 s reported.

## The runs

- **Arms, paired** as `../README.md` › Paired runs says, the order turning within each cell: `help-marks-quote-only`, main's path (the core's evaluation switch `helpMarksQuoteOnly`: a ✓ beside every found quote, nothing judged), against `today`, this branch.
- **The slice:** `call-help-marks`: 15 English presses, each with a Chinese twin, every case with Documents of its own and its own Meeting and Note. It was committed before any run and no run has read it.
- **Models:** Claude Sonnet 5.5 and Claude Haiku 5.5 as the Answers model (call help on Same as Answers), on a direct Anthropic key; the judge Claude Opus 5.5 for both arms (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-opus-5-5`, which a run of Haiku alone would otherwise not get). One route. If the key runs out of credit, the second direct Anthropic key carries on, same models and endpoint, with a dated line here.
- **Samples:** two runs of all 30 presses on each model (`INCARNAMIND_EVAL_SPEED_RUNS=2`), false Supported counted (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), first requests compared (`INCARNAMIND_EVAL_SPEED_SAME_REQUEST=1`). A press waits up to 60 s after the reply's end for every mark to settle, within the 3 minutes the press is given from its start, and both arms' ✓ are read on the settled reply; one that hasn't settled by then counts as failed to run. A press's second run is asked right after its first, in the same Library, Meeting and help conversation, as A's runs were: the two runs show how much one press repeats, not two independent samples.
- **Load:** each run starts only at a 15-minute load of 24 or less; the load goes in the result.
- **Spend:** about $5. The lane's cap is $8, with $0.53 spent on the pilot, held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`) and `INCARNAMIND_EVAL_SPEED_STOP_USD`.

## What is read, per press, from `report.json`

Counted by Citation number as the panel numbers them. A number shows ✓ when any line it is shown on shows ✓, as each arm's panel draws it: on main, a found quote; here, a line whose sentence the check passed.

- **A wrong ✓:** the judge lists a shown number, its sentence stating as so something its quoted words don't say, and that number shows ✓. A press with one or more counts once (`falseSupported` above 0). A number reused on two lines counts against the branch even when its ✓ sits on the other line.
- **W0 and W1, on the branch's own replies:** a press has W0 when it shows a number with a found quote that the judge lists (`marks.listed` above 0): what main's rule would mark ✓ on that very reply. It has W1 when such a number shows ✓ under the branch's rule (`marks.listedChecked` above 0). On one reply the branch's ✓ are a subset of main's, since a ✓ needs both a found quote and a passed check.
- **Kept ✓:** of the shown numbers whose quote was found and which the judge doesn't list (`marks.held`), those that show ✓ (`marks.checked`). Of those, the ones the check gave a verdict, passed or found unsupported or contradicted (`marks.judged`). The rest are counted by why they show none (`marks.missed`).
- **The reply:** expected Passages cited, judged right, every Citation found. On both arms a quote counts as found when its quote check found it, whatever its sentence's check then said, and the judge is shown it so.
- **Speed:** the first words the panel shows and the reply's end (`firstWordsMs`, `doneMs`). The runner reads `doneMs` on both arms in `runOnArm` (`paired.ts`) from the same event: the last "answer.finished" or "answer.failed" the arm's core announces while the press runs, and a press makes one Answer. The check's requests start after it, so they never count in `doneMs`.

## Main's spread, read from its sources

Each run of A, B and C is 15 presses of a language; D's slice has 12. All were judged by Claude Opus 5.5, on main's path for the marks:

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

## The bars, set before any run

A cell is a model and a language, 30 pairs over the two runs. Bars 2, 3 and 4b and the reported kept ✓, settle times and costs count the pairs both arms finished. Bar 1 counts the branch's presses on a model, finished or not. Bar 5 counts the pairs main finished. In bar 3, a press with no Citation counts as not having every Citation found, and a judge's grade that couldn't be read as not right, on both arms alike. The runner's guards that gave A's counts left such presses out, which a paired cell doesn't need.

1. **The check clears wrong ✓, measured on the same replies.** On each model, over the branch's own replies, pooled over both languages and both runs (60 presses):
   - **1a, it clears most of them:** W1 is at most half of W0, rounded down. Where W0 is under 4 on a model, half can't be told from chance, and there W1 must be at most 1.
   - **1b, it tells held from wrong:** over the shown numbers with a found quote, the share that show ✓ among those the judge doesn't list must be higher than among those it lists. The test is Fisher's exact, one-sided, p < 0.05, on [[held with ✓, held without], [listed with ✓, listed without]]. A model where the judge lists no such number gives p = 1 and fails, since nothing would show the check telling held from wrong.
   - **Reported, not gated:** main's arm's pooled count of presses with a wrong ✓, its flips between its two runs, and the fall between the arms (the "before" a reader recognises). Also W0 beside main's count, as a check that the arms are alike.
   - **How the pull request closes:** on each model, if the branch's Chinese W1 is no higher than its English W1 plus the branch's own flips, it closes #2847. Otherwise it is "Part of #2847", naming what is left and pointing to #2922. The branch's own flips are the larger of its two language cells' counts of presses whose W1 differs between its two runs, a press it didn't finish in one or both of them included; main's flips are counted the same way.

   Why on the same replies: on one reply the branch's ✓ are a subset of main's, so W0 less W1 is the check's work alone. Between the arms, the replies are sampled twice. On the twins slice main's Sonnet gave only 1 and 2 wrong ✓ per 15 (C). There a rule between arms would demand none of the branch, and fail a change that can't be worse on one sampled reply. Why 1b: a filter that dropped ✓ at random could pass 1a and bar 2 together, and this is the bar it can't pass. Numbers within one press aren't independent, so the test is a floor, not a measurement. Why Chinese against English isn't a bar: the change improves both languages by construction, so parity can't be a reason not to ship it; it is the reason the issue stays open.
2. **Kept ✓ isn't nothing.** In every cell, at least a third of the shown numbers the judge says their lines hold show ✓ on the branch (`marks.checked` of `marks.held`). Why: this is a floor against a check that shows nothing, not parity with Answers. A trust fix must not be held back by lines the check was never able to judge (#2922). A branch that shows no ✓ fails it, and so does a cell where the judge says no shown number holds.
3. **The reply holds.** In every cell, expected Passages cited, judged right and every Citation found on the branch are each no lower than main's pooled count by more than D. D is twice main's widest range of one run on that measure in that model and language, across A's three runs, and at least 2:

   | Cell | Cited | Judged right | Every Citation found |
   |---|---|---|---|
   | Sonnet 5.5 · English | 2 (15–15) | 2 (14–15) | 2 (15–15) |
   | Sonnet 5.5 · Chinese | 2 (15–15) | 2 (14–15) | 2 (15–15) |
   | Haiku 5.5 · English | 4 (13–15) | 2 (13–13) | 2 (14–15) |
   | Haiku 5.5 · Chinese | 4 (12–14) | 8 (9–13) | 4 (13–15) |

   Why: both arms answer the same slice with the same request, so a slice's difficulty is out, and only chance moves these. Two runs pooled can move by up to twice one run's range. A's three runs are the only repeated runs of one slice on main's path. The floor of 2 is there because three runs that didn't move are no proof that a measure can't.
4. **The reply is as fast.**
   - **4a, the same request:** in every pair, the first request is the same on both arms, their libraries' ids, times and file dates aside (`sameRequest`). `tests/core/callHelpMarks.test.ts` holds, with the scripted model, that the reply's end is announced before any request of its check starts.
   - **4b, not slower beyond chance:** in each cell, for first words and for the reply's end, count the pairs both arms finished where the branch was slower; ties are left out. The bar fails when a one-sided sign test gives that count a chance under 1% were the arms equally fast. The exact chance decides: at 30 untied pairs that is 22 or more, at 28 it is 21, at 26 or 27 it is 20.
   - **Reported:** the median paired difference per cell, and main's own move between its two runs' medians.

   Why: the pairs carry their own noise, so the bar needs no guess at it. The pilot's identical requests on Sonnet gave paired differences whose two middle values were −0.2 s and about +1.1 s on 4 pairs. A median of 30 such differences moves by some tenths of a second on its own, so a fixed ±0.5 s over 8 tests would fail by chance far too often. And a floor taken from the branch's own pilot is the one thing a bar may not be set from.
5. **No press fails on the branch alone.** In every cell, no press fails to run on the branch where main finished it. A press waits up to 60 s after the reply's end for its marks. Why: a branch press waits for its marks and main's doesn't, so a check that never settles would otherwise drop out of both arms' counts instead of counting against the branch. 60 s, not 20: one slow provider answer among 120 presses shouldn't decide the gate, while a check that truly never settles still fails it.

Every bar must hold. A bar that fails keeps the change from shipping, and the numbers go on #2847. No bar moves after a run.

#2847's acceptance criteria are amended to match these bars on 2026-11-09, before any run: Chinese against English decides how the pull request closes, and kept ✓ is a floor.

## Reported, not gated

- **Kept ✓ among the lines the check judged** (`marks.checked` of `marks.judged`), against 83% English and 78% Chinese: the check's rate on an Answer's one-fact sentences on Claude Haiku 5.5, 92% and 87% (#2515, as shipped), less 9 points.
- **The lines that showed no ✓, by reason** (`marks.missed`).
- **How long after the reply's end every mark had settled:** median, 90th percentile, and the share within 3, 5, 10 and 20 s, per cell. The owner will judge whether marks that late are worth having.
- **What a press costs the User:** its model requests and their input and output tokens, from the press until its marks settled, the median per press on each arm, with how many of those requests were the check's (its tokens are in the medians).
- **The same first request:** gated in bar 4a.
- **Each press with a wrong ✓ on either arm,** with its sentence and its check. Also the load at each run's start and during it, and the spend, with the judge's share apart.
