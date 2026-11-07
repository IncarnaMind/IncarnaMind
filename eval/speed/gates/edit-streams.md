# The gate for edit_mind's new text coming in as it is written (#1635)

Written and committed on 2026-11-07, before any run it gates.

## The step

When `edit_mind` gives the whole new text of the assistant's own text (`content`, its `part` named before it), each paragraph the model has finished takes the place of the next paragraph of the old text, as the model writes it. Before, nothing changed in the Note until the call had all of its input. The call ends exactly as the same call made whole, in one step with what came in; a call refused once whole, Stop, or a failed model takes back what came in.

## The runs

- **Arms:** `main`, the commit this step is built on, unchanged; and `step`, the head of the pull request. Both run `npm run eval:speed`, flows only, the flow `assistant-longer` (a summary added with Add to note, then "Make the summary longer.").
- **Order:** one process per arm, model, language and run, alternating `main`, `step`, `main`, `step`, so neither always meets a warm cache or a quieter machine.
- **Cells**, each a model and a language, three runs per arm:
  - Claude Sonnet 5.5 (`claude-sonnet-5-5`), direct Anthropic route, English and Chinese.
  - Claude Haiku 5.5 (`claude-haiku-5-5`), direct Anthropic route, English and Chinese.
  - DeepSeek V4.1 Flash 1017 (`deepseek-flash`), English and Chinese.
- **Kept:** each run's data folder (`INCARNAMIND_EVAL_KEEP_DATA=1`), to read what the calls did.
- **Load:** a run starts only while the 15-minute load is at most 24.
- **Cost:** about $1.20 for Sonnet, $0.50 for Haiku and $0.30 for DeepSeek.

## The bars, per cell

1. **The page changes sooner:** the step's median first change in the page is earlier than `main`'s, over the runs whose page changed, and the step's page changes in at least as many runs as `main`'s.
2. **No later by much:** no single run's Done on the step is later than `main`'s slowest run in the cell by more than `main`'s own spread (its slowest minus its fastest).
3. **No worse outcome:** on the step, no fewer runs end with the summary written over by `edit_mind` than on `main`, and no more `edit_mind` calls are refused, read from the kept data folders.
4. **The same end:** the tests of a whole call's new text in `tests/core/assistantOwnChanges.test.ts` pass unchanged, and the new tests hold that the call that came in ends as the same call made whole.

## Reported, not bars

- How much sooner the first change comes, each cell: the target is 2 to 3 seconds sooner on Sonnet.
- For each arm, how many runs' `edit_mind` call gave `content` with its `part` named first, so its text could come in.

## What decides

The step ships if every cell holds every bar. If a cell fails one, the pull request names it with its numbers, and what ships is decided in a dated note below, not by reading these bars again.

## Result, 2026-11-07

All 36 runs ran on one route per model: Claude Haiku 5.5 and Claude Sonnet 5.5 on the direct Anthropic route, DeepSeek V4.1 Flash 1017 on DeepSeek's API; `main` at 84d621707, the step at f43c66763 (the later commits change only a take-back's report, tests and the feel check). Seconds; medians of three runs, over the runs whose page changed for the first change.

| Cell | First change, `main` → step (runs that changed the page) | Done, `main` → step | Runs written over by `edit_mind` | Refused `edit_mind` calls | Bars it fails |
|---|---|---|---|---|---|
| Haiku, English | – → – (0 → 0) | 17.6 → 14.3 | 0 → 0 | 0 → 0 | 1 can't be read: no run in either arm called `edit_mind` |
| Haiku, Chinese | 24.1 → 16.3 (1 → 3) | 18.1 → 28.5 | 1 → 3 | 1 → 5 | 3 |
| Sonnet, English | 14.9 → 14.0 (3 → 3) | 23.9 → 27.9 | 2 → 1 | 4 → 3 | 3 |
| Sonnet, Chinese | 13.2 → 14.0 (3 → 3) | 27.2 → 24.3 | 1 → 2 | 3 → 3 | 1 |
| DeepSeek, English | – → 22.8 (0 → 1) | 49.9 → 58.1 | 3 → 3 | 2 → 2 | 2 (a 77.9 s run against 73.0) |
| DeepSeek, Chinese | 35.5 → 30.9 (3 → 3) | 49.4 → 46.5 | 3 → 3 | 3 → 2 | none |

- Every refusal, in either arm, was one the call makes of the model's input as before: off the length asked for, sentences added without a Citation, a part that names no heading, content over the User's text, changes waiting. None was "changed" (the User's text changed meanwhile) or a take-back. No request failed or met a rate limit.
- Bar 4 holds: the whole-call tests pass unchanged, and the new tests hold the end equal to the whole call's.
- Calls whose text could come in, `content` with its `part` named first and no `instruction` before it, over the assistant's own text: on the step, 1 of Sonnet's 10 calls, none of Haiku's 8, and 5 of DeepSeek's 12 (two of which were refused once whole and taken back). Sonnet and Haiku mostly name `part` after `content`, give `instruction` beside it, or give content over the User's text, which is refused. So the step rarely acted on Claude, and the target of 2 to 3 s sooner on Sonnet isn't met: 14.9 → 14.0 s in English, 13.2 → 14.0 s in Chinese.

The gate fails: bar 1 in one cell and unreadable in another, bar 2 in one, bar 3 in two. What ships is the decision below. Spent: $2.56 (Sonnet $2.12, Haiku $0.15, DeepSeek $0.29).
