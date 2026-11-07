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
