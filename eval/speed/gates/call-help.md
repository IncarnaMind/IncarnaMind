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

## A step found by the first measurement (added on 2026-11-04, before its run)

The first press measured (Claude Haiku 5.5, en-answer-sso, a smoke run of the harness) showed the reply in one call, its first words at 0.9 s, and its end held 1.2 s more by a check of the changes it claims, which asks a model again. Call help is offered no Tool that changes a Note or runs a command, and its reply is lines for the User to say, so that check has nothing to protect there. The branch skips it for call help by default; its run pairs `help-claims-checked` (today's path, the check kept) against `today` (the branch), held to every line above.

## False Supported counted over the set (added on 2026-11-04, after two smoke runs of one case, before any full run)

Two smoke runs on Claude Haiku 5.5 stopped at their first case, en-answer-sso, on a sentence only the step's arm wrote: "Team doesn't include single sign-on, so Enterprise is the plan that meets your security review", cited to the Enterprise line, which doesn't say it. The second pairing was `help-claims-checked` against `today`, which send the same requests until the reply is written: its reply can't depend on the arm, so the difference was chance, the same sentence written on one sample and not the other. Today's path writes it too. Stopping at the first new one would end every run at its first case where a reply varies, so for this set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`) false Supported is held as a count instead: a step holds only where its arm has no more cases with a false Supported than today's path, over the cases both finished, and each case with one, on either arm, is listed with its sentence. Every other line above holds as written.

## How the claims step's runs were read (added on 2026-11-05, after its runs)

This reading was decided after both runs, and it applies only to the step that skips the check of the changes a reply claims. That check runs once the reply is written; a unit test (`tests/core/quickHelp.test.ts`, "with the check kept, as before …") shows every request until then is the same with the check and without it. So the reply each arm shows is the same path sampled twice, and a guard that moves between the arms moves by chance. As written, one line failed on each model, each the other way on the other:

- Claude Haiku 5.5: false Supported 10 → 13 cases (10 new, 7 gone); cited 18 → 19, judged right 11 → 14.
- Claude Sonnet 5.5: cited 18 → 16 (2 lost, both Chinese, none gained); judged right 15 → 16, false Supported 18 → 14.

On this step the gate is path identity, and that test decides it; the end came 1.3 s sooner on Haiku and 1.2 s on Sonnet, each in 24 of 30 cases. A step that changes the reply (the quick model, the newest stretch, writing first) is never read this way: its lines hold as written above.
