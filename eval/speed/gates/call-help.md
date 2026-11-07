# The gate for faster call help (#2526)

Written and committed on 2026-11-04 with the held-out cases (`eval/speed/callHelpCases.ts`), before any run it gates. A step ships only while it holds every line below, on both models; a step that fails one is dropped and the reason recorded.

## The runs

- **Arms:** `today` against each step's own arm, paired as `eval/speed/README.md` › Paired runs says: each case on both arms in one run, the order turning case by case, one run at a time. Each step is its own run against today's path:
  - (b) only the newest stretch of the transcript the button needs;
  - (c) one search before the first call, falling back to the loop;
  - (d) the reply written first and shown as it streams, its records and their check after it (`write-then-cite`).
- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5 as the User's Answers model. The judge is Claude Sonnet 5.5, or Claude Opus 5.5 when Sonnet 5.5 is under test. The run in "Main against this head" below uses Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017.
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

## Main against this head (written 2026-11-06, committed before its first run)

The change this PR ships is call help skipping the check of the changes a reply claims, and nothing else: the quick-tasks-model path is not in the product. This run compares origin/main (the check kept) with this head (the check skipped) on the call-help set, from two checkouts: a fresh worktree of origin/main and this worktree, the same eval files copied into each — including the fake capture's quiet-source argument, so both arms hear the same call — a temporary HOME and its own data folders for every run. Each checkout runs the paired runner with today's path twice (`today,today`), one run per sample, and the runs alternate between the checkouts — main 1, head 1, main 2, head 2, main 3, head 3 — so drift over time meets both alike. The two arms within a run are the same path in separate cores, and their samples are read together for that checkout. The per-language tables the run writes are the source of the split.

- **Models:** Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 (`deepseek-flash`), each language its own. Judge: the same judge for both arms.
- **Samples:** three runs per checkout, each run on its two cores, alternating run by run (main 1, head 1, main 2, head 2, …), so drift over time meets both arms alike.
- **The bar, per language, on each model:** the head's false Supported range does not sit above main's; its cited range does not sit below main's; and done is sooner. Ranges are computed from each run's per-item records (`report.json`) across the runs; the per-language tables in `report.md` give each run's medians.
- **Reported, not held:** the first words (the first option's words as they stream) and the first whole option.
- **The check's rewrites:** in main's arm every reply the change-claim check rewrites is recorded with its text before the check and after it, in the run's `rewrites.json`, and listed with this gate's results.

The path-identity reading below stays a failed step as written: Haiku moved a guard line wrong (false Supported 10 → 13) and Sonnet another (cited 18 → 16), so the earlier claim that the check's step passed does not stand. The earlier Sonnet run is reported, not gated.

## A step found by the first measurement (written before its run, committed after it)

The first press measured (Claude Haiku 5.5, en-answer-sso, a smoke run of the harness) showed the reply in one call, its first words at 0.9 s, and its end held 1.2 s more by a check of the changes it claims, which asks a model again. Call help is offered no Tool that changes a Note or runs a command, and its reply is lines for the User to say, so that check has nothing to protect there. The branch skips it for call help; over both runs the check rewrote one reply in 90, and call help's replies are written without it. The run that measured the step (the check kept against the branch) held to every line above; the arm that did so was removed with the switch.

## False Supported counted over the set (written before the full runs, committed after them)

Two smoke runs on Claude Haiku 5.5 stopped at their first case, en-answer-sso, on a sentence only the step's arm wrote: "Team doesn't include single sign-on, so Enterprise is the plan that meets your security review", cited to the Enterprise line, which doesn't say it. The second pairing was the check kept against the branch, which send the same requests until the reply is written: its reply can't depend on the arm, so the difference was chance, the same sentence written on one sample and not the other. Today's path writes it too. Stopping at the first new one would end every run at its first case where a reply varies, so for this set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`) false Supported is held as a count instead: a step holds only where its arm has no more cases with a false Supported than today's path, over the cases both finished, and each case with one, on either arm, is listed with its sentence. Every other line above holds as written.

## How the claims step's runs were read (added on 2026-11-05, after its runs)

This reading was decided after both runs, and it applies only to the step that skips the check of the changes a reply claims. That check runs once the reply is written; until then every request is the same with the check and without it, so the reply each arm showed is the same path sampled twice, and a guard that moved between the arms moved by chance. As written, one line failed on each model, each the other way on the other:

- Claude Haiku 5.5: false Supported 10 → 13 cases (10 new, 7 gone); cited 18 → 19, judged right 11 → 14.
- Claude Sonnet 5.5: cited 18 → 16 (2 lost, both Chinese, none gained); judged right 15 → 16, false Supported 18 → 14.

The path-identity reading is recorded as a failed step, not a pass: the check moved a guard line on both models, so the step stays failed until the main-against-head run above settles it. The end came 1.3 s sooner on Haiku and 1.2 s on Sonnet, each in 24 of 30 cases. A step that changes the reply (the newest stretch, writing first) is never read this way: its lines hold as written above.
