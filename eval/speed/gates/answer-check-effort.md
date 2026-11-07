# The gate for the effort of an Answer's check

Written and committed on 2026-11-07, before any run it gates. The step: the judgement of an Answer's sentences against what they cite (#2311), which thinks at its provider's default effort today (3 s a request on Claude Haiku 5.5, about 1,150 tokens on DeepSeek), asks for a lower effort through the catalog's `check` kind (#1631). Thinking turned off was tried and failed (`check-speed.md`, step 3: on Haiku judged right fell from 129 to 105 of 180, with 11 sentences the rules don't state Supported in more runs), so this step lowers the effort and never turns it off. It is a step that changes what the judge is sent, so it is held to `check-speed.md`'s bars for such a step, as written there, with the runs below.

## Arms

- **Today:** every model at its provider's default effort, as `main` sends the batches: `INCARNAMIND_EVAL_SPEED_THINKING=summary` for the timing runs, `INCARNAMIND_EVAL_SUPPORT_THINKING=summary` for `eval:support`.
- **The step:** the catalog's `check` effort for the model (`low` on Claude): the same commands with neither variable set.

The two arms run one after the other on the same computer, alternating, each language in turn, on the same commit, at a 15-minute load of 24 or less.

## Runs

- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5 on a direct Anthropic key. Three runs of each arm on Haiku and two on Sonnet, since one sentence's verdict varies from request to request.
- **The Answer's check:** `INCARNAMIND_EVAL_SPEED_CHECK_TIMES=answer`, English and Chinese: the second written held-out set's 30 sentences over the membership rules in each language (`../writtenHeldOut.ts`), 7 the rules state and 23 near-copies they don't, cited and judged as an Answer judges its own.
- **`npm run eval:support`'s cases** with `INCARNAMIND_EVAL_SUPPORT_JUDGE=answer` and `INCARNAMIND_EVAL_SUPPORT_SETS=cases`: the fixtures, the held-out sentences and the controls, `INCARNAMIND_EVAL_SUPPORT_REPEATS=3` on Haiku and 2 on Sonnet, each arm.

## Bars, per model, both languages together, on the sentences both arms finished

- **No new false Supported:** no sentence the Documents don't state is Supported in more of the step's runs than of today's, in the timing runs; and no fixture or held-out sentence of `eval:support` keeps its green check in more of the step's runs than of today's.
- **Judged right** (Supported for a sentence the Documents state, anything else for one they don't) no lower than today's by more than one sentence in 30, rounded down.
- **Not checked** no higher than today's by more than one sentence in 30, rounded down; and `eval:support`'s controls marked or not checked no more often than today's by more than one in 30, rounded down.
- **Faster:** the median end of the Answer's check (from the Answer's end to its last verdict) sooner than today's, and its median first verdict no later, per model over both languages. A model whose check isn't faster keeps the default.

A model that fails any bar keeps its provider's default for the check, and the reason is written here. Models not run here keep their default.

## Results
