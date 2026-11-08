# The quality check for keeping call help's own form (#2778)

Written and committed on 2026-11-08, before any run it gates, and revised before its first run, after an independent review of the change, to the rule the runs measure. #2778 stops the core from judging call help's own lines as the model's working: an option's or a reading's sentence through its "→" line, a "★" line still waiting for its "→" line, a short line ("- "), and the one line "Am I leading them?" puts before its options (`helpOwnLines`, `src/core/answers/meetingHelp.ts`). Every other paragraph or line, notes or a remark before, between or after them or a numbered plan, is judged as on main. An earlier step on #2526 that left such lines unjudged raised Claude Haiku 5.5's Chinese false Supported on the call-help set (5–6 → 7–10, `call-help-form-unjudged`, never merged): the judgement had been dropping some options with no Citation. This check holds the change to main's quality before it ships.

## The runs

- **Arms, paired** as `eval/speed/README.md` › Paired runs says, each arm first in half the pairs of each cell (#2791): `today`, this branch's rule, against `help-form-judged`, main's rule (the core's evaluation switch `helpFormJudged`, which `tests/core/meetingHelp.test.ts` holds to main's behaviour). The two arms send the same requests up to the judgement of the model's working; they differ only in what that judgement is asked about and what the core then keeps.
- **Sets:** `call-help-held-out` (30 presses, 15 English and 15 Chinese) and `call-help-fresh` (16, 8 a language), the slices #2526's later runs used, copied unchanged from that work. No run has read them for this rule, and no prompt has seen them.
- **Models:** Claude Haiku 5.5 on a direct Anthropic key, and DeepSeek V4.1 Flash 1017 (`deepseek-flash`). **Judge:** Claude Opus 5.5 (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-opus-5-5`), never a model under test.
- **Two runs** (`INCARNAMIND_EVAL_SPEED_RUNS=2`), false Supported counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), margin 0. Each run starts only at a 15-minute load of 24 or less.
- **Spend:** $3 for every run of this check, held by `INCARNAMIND_EVAL_SPEED_STOP_USD=3` and one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`).

## The bar, per model and language, over the presses both arms finished

As `call-help-records-first.md` and `call-help-form-unjudged.md` held their steps, over the runs:

- the branch's false Supported range does not sit above main's;
- its cited, judged-right and every-Citation-found ranges do not sit below main's.

Reported beside each: the pooled counts over both runs, each case with a false Supported on either arm with its sentence, and how often each arm's judgement was asked and what it took back.

What the rule now keeps, counted over recorded replies at no cost (Claude Haiku 5.5 and DeepSeek V4.1 Flash, the vanish check's cases): an option or reading with no Citation marker, 35 of 464 in main's 240 replies and 46 of 461 in the 240 at a5bcb7c84 (the form then kept whole); a paragraph with no option mark between options, in 1 reply of each 240, a remark between two readings. This check makes no other claim about them.

## If false Supported rises

The rule changes so that an option or reading that still holds no Citation once the reply ends may be judged and dropped as before, while a written option's "→" line is never taken back. The check then runs again, on `call-help-checks` (20 presses, 10 a language, copied unchanged with the others; no run of this work reads it before then), with the same arms, models, judge and bar, two runs, within the same $3.

A line that fails keeps the change from shipping as it is, and the numbers go on the issue.

## The runs (2026-11-08, at 08749fe6e)

Two runs, `help-form-judged` (main's rule) as the first arm and `today` (this branch's) as the second, each arm first in half the pairs of each cell (92 pairs a run: 48 and 44 in the first, as the runner turns them). Claude Haiku 5.5 on a direct Anthropic key and DeepSeek V4.1 Flash 1017 (`deepseek-flash`), both meant and both ran; judge Claude Opus 5.5. Every press finished on both arms. Spent $2.46 of the $3: $0.03 on a one-press smoke run of the wiring, then $1.20 and $1.23. Each run started at a 15-minute load of 24 or less (23.8 and 23.3); one-minute load 4.8 to 79.4 in the first, 4.9 to 17.1 in the second.

Main's rule → this branch's, per run's range over the two runs (pooled count in brackets), over the 23 presses of each language both arms finished, the two slices together:

| Model · language | False Supported | Expected Passages cited | Judged right | Every Citation found |
|---|---|---|---|---|
| Claude Haiku 5.5 · English | 8–9 → 9–9 (17 → 18) | 18–23 → 19–20 (41 → 39) | 16–18 → 20–21 (34 → 41) | 20–22 → 19–22 (42 → 41) |
| Claude Haiku 5.5 · Chinese | 7–14 → 10–12 (21 → 22) | 18–21 → 17–19 (39 → 36) | 15–17 → 15–16 (32 → 31) | 20–23 → 19–22 (43 → 41) |
| DeepSeek V4.1 Flash · English | 6–11 → 6–9 (17 → 15) | 19–22 → 19–20 (41 → 39) | 17–19 → 18–19 (36 → 37) | 20–22 → 21–22 (42 → 43) |
| DeepSeek V4.1 Flash · Chinese | 9–12 → 9–14 (21 → 23) | 17–21 → 19–20 (38 → 39) | **17–18 → 15–16** (35 → 31) | 21–23 → 22–22 (44 → 44) |

**The bar:** false Supported, cited and every Citation found hold in every cell, so false Supported did not rise by this check's measure and the rule stays as it is. **Judged right fails as written in one cell,** DeepSeek V4.1 Flash in Chinese, and this check says so.

## How the runs were read (added after them)

- **The failed line, read by the independent review.** Seven DeepSeek Chinese presses were judged right on main's arm and not on this branch's (`zh2-answer-earlier` in both runs; `zh2-answer-unknown`, `zh2-want` and `zh2-ask-store` in the first; `zh2-say-offline` and `zh3-answer-android` in the second). That each pair's first request had the same input on both arms, while the outputs differed, holds for every pair at a temperature above zero, and doesn't show what the rule then did with the output that differed. The run reports do: main's rule only removes text with no Citation marker, and in six of the seven it could not have made the reply right. In four (`zh2-answer-unknown`, `zh2-answer-earlier` in the second run, `zh2-say-offline`, `zh3-answer-android`) what the judge read as unstated sits in a marked sentence; in `zh2-answer-earlier` in the first run the fault is an omission, the free training day never written, and its unstated sentence is marked too; in `zh2-want` the weak reading is the first reading's sentence, in a marked paragraph before the last, which main's rule never asks about either. The seventh, `zh2-ask-store` in the first run, is the trade-off this change makes: this branch kept an uncited second option ("订单进来后要自动分配给哪个司机？…") that main's rule would have asked about, and whether dropping it would have made the reply right is unproven. Over the cell, 7 pairs were lost and 3 gained (two-sided sign test p ≈ 0.34); Claude Haiku 5.5 in English moved 34 → 41 the other way. **Dated exception, 2026-11-08:** judged right for DeepSeek V4.1 Flash in Chinese stays failed, accepted for the merge, its cause unproven.
- **False Supported** differs between the arms in 70 of the 184 pairs over both runs: 36 with one only on this branch's arm and 34 only on main's, for every kind of press, short lines among them. Pooled it moved 17 → 18 and 21 → 22 on Haiku, 17 → 15 and 21 → 23 on DeepSeek.
- **What the rule spares** on these runs can't be counted from the reports, which keep the panel's text and not the reply as written; the counts over the vanish check's recorded replies above stand for it.
