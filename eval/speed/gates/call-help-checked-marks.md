# The gate for call help's ✓ only where the sentence check passed (#2847)

Written and committed on 2026-11-09, with its fresh slice (`../callHelpMarks.ts`), before any run it gates, pilots included.

## The change

On main, a Citation in call help's reply shows ✓ when its quote is found on the page, though no check read the sentence: the judged runs on #2526 and #2847 found a ✓ beside a sentence its cited line doesn't hold in 23 of 45 Chinese presses and 12 of 45 English on Claude Sonnet 5.5. Here the reply shows at once, as before, with its Citations plain; once it ends, its cited sentences get the check an Answer's sentences get (#2311: `judgeAnswer` and `checks/answerCheck.ts`, on the model that wrote the reply, on the chat flow already allowed), and a ✓ shows only beside a sentence that check passed. The reply's request, prompt and stream don't change: `tests/core/callHelpMarks.test.ts` holds them byte for byte. No prompt, Tool, rule or wording changes.

## The runs

- **Arms, paired** as `../README.md` › Paired runs says, the order turning within each cell: `help-marks-quote-only`, main's path (the core's evaluation switch `helpMarksQuoteOnly`: a ✓ beside every found quote, nothing judged, which `tests/core/callHelpMarks.test.ts` holds to main's behaviour), against `today`, this branch.
- **The slice:** `call-help-marks`, 15 English presses each with a Chinese twin, about an office-cleaning contract, every case with Documents of its own and its own Meeting and Note, committed with this file. No run has read it. The call-help set and the earlier slices (`callHelpCases.ts`, and the twins and Chinese slices of the earlier tries) have all been run and read: they are for building and pilots only.
- **Models:** Claude Sonnet 5.5 and Claude Haiku 5.5 as the Answers model (call help on Same as Answers, the default), each on a direct Anthropic key; the judge Claude Opus 5.5 for both arms (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-opus-5-5`), as the earlier call-help gates had. One route: if the key runs out of credit, the second direct Anthropic key, same models and endpoint, with a dated line here; never another route or model.
- **Samples:** two runs of all 30 presses on each model (`INCARNAMIND_EVAL_SPEED_RUNS=2`), false Supported counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), the first requests compared (`INCARNAMIND_EVAL_SPEED_SAME_REQUEST=1`). A press waits for its marks to settle, up to 20 s after the reply ends (`answerEnded`); one that doesn't settle by then counts as failed to run.
- **Load:** each run starts only once the 15-minute load is 24 or less, and the load goes in the result.
- **Spend:** about $5 (a Sonnet pair about $0.07 with the judge and the check, a Haiku pair about $0.02). The lane's cap is $8 over its pilot and runs, held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`) and `INCARNAMIND_EVAL_SPEED_STOP_USD`.
- **The pilot,** before the first run: at most 8 presses of the call-help set on Claude Sonnet 5.5, one run, both arms, at most $0.60, to try the wiring and to read whether the check misreads call help's sentences (a line to say aloud, a reading of what they said). If it misreads them, nothing runs here: the examples go on #2847 first.

## What is read, per press, from `report.json`

- **A wrong ✓:** the judge lists a shown Citation's number, its sentence stating as so something its quoted words don't say, and that Citation shows ✓ as the arm's panel draws it: on main, a found quote; here, a sentence the check passed. A press with one or more counts once (`falseSupported` above 0).
- **Kept ✓:** of the Citations the panel shows whose quote was found and whose number the judge doesn't list, the share that show ✓ (`marks.checked` of `marks.held`), pooled over the cell. A press whose judge reply couldn't be read has no `marks`.
- **The reply:** expected Passages cited, judged right, every Citation found. On both arms a quote counts as found when its quote check found it, whatever its sentence's check then said, and the judge is shown it as found, so the two arms' replies are read alike.
- **Speed:** the first words the panel shows and the reply's end (`firstWordsMs`, `doneMs`), unchanged by a check that runs after the end.

## The bars, set from main's own spread before any run

Main's spread, from the runs on main's path published on #2526 and #2847, each run 15 presses of a language, the judge Claude Opus 5.5: presses with a wrong ✓ ranged 3–5 (English) and 6–9 (Chinese) over three runs of the call-help set on Sonnet 5.5, and 6–10 and 7–8 on Haiku 5.5; one run each on other slices gave 1–7. Cited ranged 15–15 on Sonnet and 12–15 on Haiku, every Citation found 14–15 and 13–15, judged right 14–15 on Sonnet and 9–13 on Haiku in Chinese. The reply's end on Sonnet 5.5 had medians of 4.50 to 5.02 s across the call-help slices, and on Haiku 5.5 2.73 and 2.87 s.

A cell is a model and a language; its counts are pooled over the two runs, 30 presses an arm.

1. **Wrong ✓ falls.** In every cell the branch's count of presses with a wrong ✓ is below main's and at most half of it, rounded down; and on each model, Chinese is no higher than English on the branch. Why half: one run's count on main moves by up to 4 presses of 15 by chance, so a fall smaller than that could be noise; half of main's pooled count is beyond it wherever main gives 4 or more. A cell where main gives fewer than 2 over both runs can't show a fall; there the bar is that the branch gives none.
2. **Kept ✓ holds.** In every cell, at least 83% of the Citations the judge says their lines hold show ✓ in English, and 78% in Chinese. Why: the check's known rate on an Answer's one-fact sentences is 119 of 129 (92%) in English and 115 of 132 (87%) in Chinese on Claude Haiku 5.5 (#2515, as shipped); less 9 points, the spread (two standard deviations) of a share near 90% over the 40–50 Citations a cell holds. A branch that shows no ✓ has 0% and fails.
3. **The reply holds.** In every cell, expected Passages cited and every Citation found are no lower than main's by more than 2, and judged right by more than 4. Why: those are main's widest ranges of one run on these measures (12–14 and 13–15 for cited and found, 9–13 for judged right, on Haiku in Chinese). The reply's request is the same on both arms, so a larger fall would be the harness, not the reply.
4. **The reply is as fast.** In every cell, the median of the paired differences (branch less main) in first words and in the reply's end is within ±0.5 s on Sonnet 5.5 and ±0.3 s on Haiku 5.5. Why: main's end medians spread over 0.52 s across the call-help slices on Sonnet, and 0.14 s on Haiku, doubled for two runs.

Every bar must hold. A bar that fails keeps the change from shipping, and the numbers go on #2847. No bar moves after a run.

## Reported, not gated

- How long after the reply's end every mark had settled (`marks.settledMs`): the median, the 90th percentile, and the share within 3 s and within 5 s, per cell.
- What a press costs the User: its requests and their input and output tokens, from the press until its marks settled (`requests`), the median per press on each arm.
- The same first request: in how many pairs the two arms' first requests were the same, their libraries' ids aside.
- Each press with a wrong ✓ on either arm, with its sentence; the load at each run's start and during it; the spend, the judge's share apart.

## The pilot, 2026-11-09: the check misreads call help's sentences, so the gate doesn't run

Eight presses of the call-help set (`en-answer-total`, `en-check-wrong`, `en-want`, `en-sum`, `zh-answer-edition`, `zh-sum`, `zh-check-right` and `zh-want`), Claude Sonnet 5.5 on a direct Anthropic key, one run, both arms, the judge Claude Opus 5.5. Spent $0.53. The 15-minute load was 17.8 at the start; the one-minute load reached 29 from other work.

| Sonnet 5.5 | Presses with a wrong ✓ (main → branch) | Kept ✓ on the branch | Marks settled, median (90th pct.) |
|---|---|---|---|
| English, 4 presses | 2 → 0 | 5 of 9 (56%) | 4.3 s (9.0 s) |
| Chinese, 4 presses | 2 → 1 | 4 of 7 (57%) | 1.9 s (2.9 s) |

The first requests were the same on both arms in all 8 pairs. Kept ✓ sits far under its bar (83% and 78%). Replayed through the core with a scripted judge that calls every sentence supported, at no cost, the misses come from the check's own figure rule, not from the model's verdict:

1. **A line of Check what was said** sets their claim against the Document: "They claim 99.99% uptime, but the terms say 99.9% each month, with a 5% service credit below it [1][2]". It is never judged, even with their figure in digits: two figures of one unit across two quotes can't each be pinned to one quote, so the sentence is left Not checked. That button's form does this by design.
2. **Two Documents' figures side by side:** "去年的开通费是 6,000 元，今年调整为 8,000 元 [2][1]" is never judged for the same reason. Because the option reuses [1], the sentence before it ("今年的开通费是一次性 8,000 元 [1]"), which passes alone, loses its ✓ too.
3. **A worked-out total:** "For 40 Enterprise seats it comes to $1,620 a month: $45 per seat [1], and 10% off from 40 seats [2]" isn't judged, as the rule means (no calculation was made). In the paid run this press sent no check at all and its Citations stayed found with no ✓; the scripted replay ends Not checked. The cause of that difference isn't known.

The rest are the check being stricter than this gate's judge: a promise on a → line ("书面承诺上线节点和早班支持安排 [3]") and a line that adds "in writing" to its quote, which the judge lets pass. One Chinese sum kept a wrong ✓ on all three of its lines ("试点定在三月三号开始，你已确认没问题，价格尚未谈 [1]"): the check read the whole Transcript Passage, which holds the other lines, and called the quoted words stating, while the judge reads the quote alone.

As this file says, nothing more runs: no gate run reads `call-help-marks`, which stays unread for the next try. Changing how the check's figure rule reads a claim set against a Document, or a marker shared by two sentences, changes a check's verdict for every Answer, and needs a decision first.

### Before a next try's first run

An independent review of the branch at b06bd4ada found, besides the misread above:

- **The spread this file sets its bars from is misread in places.** Sonnet 5.5's cited ranged 14–15, not 15–15, and Haiku 5.5's Chinese judged right ranged 8–13, so bar 3's "by more than 4" rests on a range at least 5 wide. A 0.52 s spread doubled is ±1.0 s, not ±0.5 s. Half of 4 is a fall of 2, less than the chance move of 4 that bar 1 cites. A next try sets its bars again, from these numbers read right, before its first run.
- **A press can fail on the branch alone:** its marks must settle within 20 s. A bar is needed that no press fails on `today` where main finished.
- **The stops added for the next press, Stop on the Meeting and closing the panel stop the reply itself, not only its check.** With the panel closed, presses go to the assistant, so the next press cuts the earlier reply mid-sentence while the User may be reading it, and closing the panel stops a reply asked through ⌘K. A pinned reply's check that hasn't settled ends at the next press, and it never gets its ✓. A next try ends only the check, and only of a reply the panel no longer shows.
- **A ✓ is drawn per Citation, and the check judges sentences.** A line too short to be a claim ("→ Same price [1]") isn't judged; it shows the ✓ that its marker's other sentence earned.
