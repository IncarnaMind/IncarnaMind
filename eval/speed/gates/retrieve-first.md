# The gate for retrieving first (#1633)

Written and committed on 2026-11-04, before any run it gates. A model is on the retrieve-first list (`src/core/providers/catalog/answerPaths.ts`) only while it holds every line below on every set, and leaves it when one fails.

## The runs

- **Arms:** `loop` (the Tool loop from its first call) against `retrieve-first` (the Question searched before the first call), paired as `eval/speed/README.md` › Paired runs says: each item on both arms in one run, the order turning item by item, one run at a time.
- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5, each on both arms; each keeps its own way of citing as the write-then-cite list has it. The judge is Claude Sonnet 5.5, or Claude Opus 5.5 when Sonnet 5.5 is under test.
- **Languages:** English and Chinese in every set. The gate counts the items of both languages together, and each language is reported beside it.
- **Sets:**
  - `gating`: all 65 Questions.
  - `hard`: every hard-tier Question whose quotes the stored text holds (180 of 225 when last counted).
  - `everyday`: Claude Haiku 5.5, the whole set; Claude Sonnet 5.5, 10 of each kind (30), and the whole set before it is listed. Every everyday request is an assistant turn, which keeps the loop, so both arms should take the same path there: this set checks that they do.

## The margins

`INCARNAMIND_EVAL_SPEED_MARGIN=1`: on the items both arms finished, per model and set, the candidate may have up to one item in 30 fewer (rounded down) than the loop on each of these:

| Guard | gating (65) | hard (180) |
|---|---|---|
| Expected Passages cited | 2 fewer | 6 fewer |
| Judged right | 2 fewer | 6 fewer |
| Every Citation found | 2 fewer | 6 fewer |

A guard over fewer items counts its own items: 29 of them allow none. The everyday requests have no expected Passages or judged grade, so the runner counts none of these three there (corrected on 2026-11-04, before any everyday run: this table first gave them everyday columns); they are held to the lines below.

And none new, on every set:

- no new false Supported (the run stops at the first);
- no new duplicate Answer;
- no new change claimed that no Tool made, and no new other everyday guard failed;
- no new Tool call left as text;
- no more items failing to run.

## Faster, or it isn't listed

The list is for speed, so a model that holds the quality margins is listed only where retrieving first is also sooner: the paired median difference of the time to the end below zero on `gating` and on `hard`. Everyday turns keep the loop, so no time is asked of them.

## Reported, not gated

Per model and set: model calls per Answer, the share that fell back to the loop (searched again, or more than one call of its own), the time to the first words and to the end on both arms, the counts above, the load during the run, and what the run cost.
