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

## The runs

- **Arms, paired** as `../README.md` › Paired runs says, the order turning within each cell: `help-marks-quote-only`, main's path (the core's evaluation switch `helpMarksQuoteOnly`: a ✓ beside every found quote, nothing judged), against `today`, this branch.
- **The slice:** `call-help-marks`: 15 English presses, each with a Chinese twin, every case with Documents of its own and its own Meeting and Note. It was committed before any run and no run has read it.
- **Models:** Claude Sonnet 5.5 and Claude Haiku 5.5 as the Answers model (call help on Same as Answers), on a direct Anthropic key; the judge Claude Opus 5.5 for both arms. One route. If the key runs out of credit, the second direct Anthropic key carries on, same models and endpoint, with a dated line here.
- **Samples:** two runs of all 30 presses on each model (`INCARNAMIND_EVAL_SPEED_RUNS=2`), false Supported counted (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), first requests compared (`INCARNAMIND_EVAL_SPEED_SAME_REQUEST=1`). A press waits up to 20 s after the reply's end for its marks to settle; one that doesn't settle counts as failed to run.
- **Load:** each run starts only at a 15-minute load of 24 or less; the load goes in the result.
- **Spend:** about $5. The lane's cap is $8, with $0.53 spent on the pilot, held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`) and `INCARNAMIND_EVAL_SPEED_STOP_USD`.

## What is read, per press, from `report.json`

Counted by Citation number as the panel numbers them. A number shows ✓ when any line it is shown on shows ✓, as each arm's panel draws it: on main, a found quote; here, a line whose sentence the check passed.

- **A wrong ✓:** the judge lists a shown number, its sentence stating as so something its quoted words don't say, and that number shows ✓. A press with one or more counts once (`falseSupported` above 0). A number reused on two lines counts against the branch even when its ✓ sits on the other line.
- **Kept ✓:** of the shown numbers whose quote was found and which the judge doesn't list (`marks.held`), those that show ✓ (`marks.checked`). Of those, the ones the check gave a verdict, passed or found unsupported or contradicted (`marks.judged`). The rest are counted by why they show none (`marks.missed`).
- **The reply:** expected Passages cited, judged right, every Citation found. On both arms a quote counts as found when its quote check found it, whatever its sentence's check then said, and the judge is shown it so.
- **Speed:** the first words the panel shows and the reply's end (`firstWordsMs`, `doneMs`).

## Main's spread, read from its sources

Each run is 15 presses of a language, judged by Claude Opus 5.5, on main's path for the marks:

- **A** (#2526, comment of 2026-11-08 17:41 UTC, `call-help-fastest.md`): three runs of the call-help set.
  - Claude Sonnet 5.5: wrong ✓ 3–5 English and 6–9 Chinese; cited 15–15 and 15–15; every Citation found 15–15 and 15–15; judged right 14–15 and 14–15; reply's end, median, 4.64 s and 5.02 s.
  - Claude Haiku 5.5: wrong ✓ 6–10 and 7–8; cited 13–15 and 12–14; found 14–15 and 13–15; judged right 13–13 and 9–13; end 2.73 s and 2.87 s.
- **B** (#2847, comment of 2026-11-08 22:12 UTC, main's arm): one run each, on a fresh Chinese slice and the call-help set's English.
  - Sonnet: wrong ✓ 4 and 7; cited 15 and 14; right 15 and 15; found 15 and 14.
  - Haiku: 7 and 5; cited 14 and 14; right 13 and 8; found 14 and 15.
- **C** (#2847, comment of 2026-11-09 01:19 UTC, Part A's main arm): one run each, on the twins slice.
  - Sonnet: wrong ✓ 1 and 2; cited 15 and 15; right 15 and 14; found 14 and 15.
  - Haiku: 6 and 3; cited 14 and 15; right 13 and 12; found 14 and 15.
- **D** (#2526, comment of 2026-11-08 18:18 UTC, `today`'s arm on its own slice): Sonnet's reply's end, median over three runs, 4.50 s English and 4.92 s Chinese.

A is the only source that gives each measure's range over repeated runs of one slice; D gives a median over its three runs, not a range. A's Claude Haiku 5.5 runs are its quick-model arm: Haiku writing call help under Claude Sonnet 5.5 as the Answers model, thinking off, as call help always runs. Here Haiku is the Answers model itself. No source gives repeated runs of that, so A is the nearest.

Every median in this file is the middle value, or the mean of the two middle values when the count is even. The runner's own `report.md` prints the lower of the two middle values; it isn't what these bars read.

## The bars, set before any run

A cell is a model and a language. Its counts are pooled over the two runs: 30 presses an arm, 60 in all.

1. **Wrong ✓ falls by more than chance.** In each cell, the fall must be larger than main's flips there. The fall is main's pooled count of presses with a wrong ✓ less the branch's. A flip is a press of the slice that main gave a wrong ✓ in exactly one of its two runs; a press main failed to finish in either run counts as a flip too. Both are computed from the run. Where main's pooled count is no larger than its flips, no fall could show, and there the branch must have none. On each model, the branch's Chinese count may exceed its English count by no more than the larger of the branch's own flips in its two cells, counted the same way on the branch. Why: main's own two runs on the same presses show how much the count moves by chance (A's runs moved by 1–4 presses). A fall smaller than that is no evidence. A press with no result can't show it held, so it counts toward chance.
2. **Kept ✓ isn't nothing.** In every cell, at least a third of the shown numbers the judge says their lines hold show ✓ on the branch (`marks.checked` of `marks.held`). Why: this is a floor against a check that shows nothing, not parity with Answers. A trust fix must not be held back by lines the check was never able to judge (#2922). A branch that shows no ✓ fails it.
3. **The reply holds.** In every cell, expected Passages cited, judged right and every Citation found on the branch are each no lower than main's pooled count by more than D. D is twice main's widest range of one run on that measure in that model and language, across A's three runs, and at least 2:

   | Cell | Cited | Judged right | Every Citation found |
   |---|---|---|---|
   | Sonnet 5.5 · English | 2 (15–15) | 2 (14–15) | 2 (15–15) |
   | Sonnet 5.5 · Chinese | 2 (15–15) | 2 (14–15) | 2 (15–15) |
   | Haiku 5.5 · English | 4 (13–15) | 2 (13–13) | 2 (14–15) |
   | Haiku 5.5 · Chinese | 4 (12–14) | 8 (9–13) | 4 (13–15) |

   Why: both arms answer the same slice with the same request, so a slice's difficulty is out, and only chance moves these. Two runs pooled can move by up to twice one run's range. A's three runs are the only repeated runs of one slice on main's path. The floor of 2 is there because three runs that didn't move are no proof that a measure can't.
4. **The reply is as fast.** In every cell, the median of the paired differences (branch less main) in first words, and in the reply's end, is within ±S. S is the larger of main's own move, the difference between its two runs' medians in that cell (computed from the run), and a floor: 0.5 s on Sonnet 5.5, 0.3 s on Haiku 5.5. Why: the reply's requests are the same on both arms, so only the network and the load move them. Main's move between its own runs is the measure of that. The floor is what the pilot's identical requests gave on Sonnet: paired medians of +0.44 s and +0.49 s over its 4 pairs a language, at a one-minute load of 12.7–19.2. The lower middle values, which its `report.md` printed, were −0.2 s and −0.4 s. The floor is scaled to Haiku's shorter reply, which ends at 2.73–2.87 s against Sonnet's 4.50–5.02 s (A, D).
5. **No press fails on the branch alone.** In every cell, no press fails to run on the branch where main finished it. Why: a branch press waits for its marks and main's doesn't, so a check that never settles would otherwise drop out of both arms' counts instead of counting against the branch.

Every bar must hold. A bar that fails keeps the change from shipping, and the numbers go on #2847. No bar moves after a run.

Bars 1 and 2 differ from #2847's acceptance criteria as written, "Chinese no higher than English" and "the sentences their lines do hold keep their ✓", by the decision of 2026-11-09 this file records. The criteria on #2847 should say the same before the change ships.

## Reported, not gated

- **Kept ✓ among the lines the check judged** (`marks.checked` of `marks.judged`), against 83% English and 78% Chinese: the check's rate on an Answer's one-fact sentences on Claude Haiku 5.5, 92% and 87% (#2515, as shipped), less 9 points.
- **The lines that showed no ✓, by reason** (`marks.missed`).
- **How long after the reply's end every mark had settled:** median, 90th percentile, and the share within 3 s and within 5 s, per cell.
- **What a press costs the User:** its model requests and their input and output tokens, from the press until its marks settled, the median per press on each arm, the check's requests apart.
- **The same first request:** in how many pairs it was the same on both arms, their libraries' ids aside.
- **Each press with a wrong ✓ on either arm,** with its sentence and its check. Also the load at each run's start and during it, and the spend, with the judge's share apart.
