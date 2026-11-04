# The gate for faster call help (#2526)

Written and committed on 2026-11-04 with the held-out cases (`eval/speed/callHelpCases.ts`), before any run it gates. A step ships only while it holds every line below, on both models; a step that fails one is dropped and the reason recorded.

## The runs

- **Arms:** `today` against each step's own arm, paired as `eval/speed/README.md` › Paired runs says: each case on both arms in one run, the order turning case by case, one run at a time. Each step is its own run against today's path:
  - (a) the quick-tasks model first, thinking off, the User's model only when the quick reply is flagged or a quote isn't found (#1667, step E);
  - (b) only the newest stretch of the transcript the button needs;
  - (c) one search before the first call, falling back to the loop;
  - (d) the reply written first and shown as it streams, its records and their check after it (`write-then-cite`).
- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5 as the User's Answers model. A step that sends the same requests on a model (the quick model first, where the Answers model is the quick one) is shown so by a unit test, not run. The judge is Claude Sonnet 5.5, or Claude Opus 5.5 when Sonnet 5.5 is under test.
- **The User's reasoning model:** GPT-6.1 Sol through OpenRouter, where the key allows, on today's path and on the steps that pass, reported and not gated.
- **Languages:** all 30 cases, 15 English and 15 Chinese. The guards count both languages together; each language is reported beside them.

## The guards

`INCARNAMIND_EVAL_SPEED_MARGIN=0`: on the cases both arms finished, per model, the step's arm may have no fewer than today's on:

- expected Passages cited (every line the case rests on quoted by a found Citation the panel shows);
- judged right.

And none new:

- no new false Supported (the run stops at the first);
- no new Tool call left as text, reply that showed nothing, or reply written while the live text was behind;
- no more cases failing to run.

## Faster, or it doesn't ship

The step is for speed: it ships only where the paired median difference of the time to the first words is below zero, and that of the time to the end is not above zero, on both models.

## Spend

$15 for all the runs of this work, held by the runner itself: each run reads what the runs before it spent from `INCARNAMIND_EVAL_SPEED_LEDGER`, adds its own as it goes, and stops before the next case once the total reaches `INCARNAMIND_EVAL_SPEED_STOP_USD=15`.

## Reported, not gated

Per model and step: the times to the first sign, the first words, the first whole option and the end; where the time went (each request's first byte, first text and end, the requests for other steps, reasoning); model calls; how often a reply searched again or went to the User's model; each language's counts; the load; and what each run cost.
