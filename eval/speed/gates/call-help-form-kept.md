# The quality check for keeping call help's own form (#2778)

Written and committed on 2026-11-08, before any run it gates. #2778 stops the core from judging call help's own lines as the model's working, so it no longer takes back an option, a reading, a short line or a "→" line it showed. An earlier step on #2526 that left such lines unjudged raised Claude Haiku 5.5's Chinese false Supported on the call-help set (5–6 → 7–10, `call-help-form-unjudged`, never merged): the judgement had been dropping some options with no Citation. This check holds the change to main's quality before it ships.

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

## If false Supported rises

The rule changes so that an option or reading that still holds no Citation once the reply ends may be judged and dropped as before, while a written option's "→" line is never taken back. The check then runs again, on `call-help-checks` (20 presses, 10 a language, copied unchanged with the others; no run of this work reads it before then), with the same arms, models, judge and bar, two runs, within the same $3.

A line that fails keeps the change from shipping as it is, and the numbers go on the issue.
