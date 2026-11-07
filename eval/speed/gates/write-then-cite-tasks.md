# The gate for writing, then citing, in comparison cells and Meeting notes (#489, #1624)

Written and committed on 2026-11-07 with the meeting-notes cases (`eval/speed/meetingNotesCases.ts`), before any run it gates. #1624 asks that writing the Answer first and giving its records after it in the same reply (#489) be measured, paired, on comparison table cells and on Meeting notes before either flow is admitted for a model; until then both keep today's path, which gives the records first on every model (the list beside the catalog admits Claude Haiku 5.5 for Questions only). A flow is admitted for a model only while it holds every line below on that flow and model; one that fails a line keeps today's path, and its numbers go on #1624.

## The runs

- **Arms:** `today` against `write-then-cite`, paired as `eval/speed/README.md` › Paired runs says: each item on both arms in one run, each arm in a core of its own, the order turning item by item, one run at a time.
- **Sets:**
  - `cells`: the gating set's Questions whose Passages are all in one Document, each asked as a comparison table's one cell over that Document, as a Task asks it. One run.
  - `meeting-notes`: the 12 cases, 6 English and 6 Chinese, each a long call heard live and stopped, its notes filled in from its Transcript. Each case is stopped once a run, so the set runs twice: 24 pairs a model, read together.
- **Models:** Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 (`deepseek-flash`), each as the User's Answers model. The judge is Claude Sonnet 5.5.
- **Languages:** both, counted together; each language is reported beside them.

## The guards

`INCARNAMIND_EVAL_SPEED_MARGIN=1`, as #489's own gate: on the items both arms finished, per model and set, `write-then-cite` may have at most one item in 30 fewer than `today` (on 24 pairs, none fewer) on:

- expected Passages cited: for a cell, a found Citation in the cell covering each Passage's pages; for notes, each line the case rests on quoted by a found Citation of the Transcript;
- judged right;
- every Citation found.

And none new:

- no new false Supported: for notes, a sentence with a found Citation that states something its quoted words don't say, as the judge reads it. The run stops at the first one `today` didn't give, and the flow fails on that model;
- no new Tool call left as text, notes with a problem or with nothing written;
- no more items failing to run.

*Added on 2026-11-07, after review and before the cells are run again: the first cells runs never measured false Supported or duplicates, which read 0 on both arms whatever the cells said, so their "no new false Supported" line doesn't stand. For a cell, false Supported is now a cell line with a found Citation that states something its quoted words don't say (a figure, a period, a name, a yes or a no), as Claude Sonnet 5.5 reads each found Citation's line against its quote (`eval/speed/unstated.ts`); a duplicate is a cell that says the same paragraph twice. A judge reply that can't be read counts as a failure on that item, not as none. The cells set is run again on both models, paired, with every other line above as written, and a model is admitted for cells only on that run.*

## Faster, or it isn't admitted

Writing first is for speed: a flow is admitted on a model only where the paired median difference of the time to the end is below zero on that set and model.

## What admission changes

A flow and model that hold every line are listed beside the catalog (`src/core/providers/catalog/answerPaths.ts`) for that flow alone, with the day and these numbers, in a pull request of its own. Today a cell, a Meeting's notes and a check's own Run share one flow there ("check"), so that pull request first tells them apart, so that admitting one never admits the others.

## Spend

$12 for all of this piece of work's runs, the baseline table's included, held by the runner: each run reads what the runs before it spent from `INCARNAMIND_EVAL_SPEED_LEDGER` and stops before the next item once the total reaches `INCARNAMIND_EVAL_SPEED_STOP_USD=12`. The core counts DeepSeek V4.1 Flash at its catalog price (`overrides.ts`, the peak price); the provider's balance is read before and after each run as a check, though other work spends from the same key.

*Corrected on 2026-11-07, after the two cells runs and before the meeting-notes runs: this paragraph first said the catalog had no price for DeepSeek Flash. No bar or run changed.*

## Reported, not gated

Per model and set: the times to the first sign, the first words (for notes, when they go into the page) and the end; model calls and tokens; each language's counts; every item side by side; the load during the runs; and what each run cost.
