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

A guard over fewer items counts its own items: 29 of them allow none. The rule is one item in 30 of the items both arms finished, rounded down; the counts in the table are for the sizes expected. The hard tier asked 224 Questions when it ran, so 7 were allowed there (this sentence was added on 2026-11-04, after the hard-tier run; it changes no result). The everyday requests have no expected Passages or judged grade, so the runner counts none of these three there (corrected on 2026-11-04, before any everyday run: this table first gave them everyday columns); they are held to the lines below.

And none new, on every set:

- no new false Supported (the run stops at the first);

*Added on 2026-11-08, before any run it changes (#2720): false Supported is measured, not read as 0. Each sentence of an Answer shown with a found Citation is judged once, against all its found quotes together, by the judge above: a sentence that states as so something its quoted words don't say (a figure, a date, a period, a name, a term, a yes or a no), or says it in other words or another language, is stated. A sentence with several found Citations counts once, and a Citation not found shows as not checked, so it can't make one (`eval/speed/unstated.ts`, the same measure as every Questions set). A judge reply that can't be read twice counts as an item failure (`false-supported-unread`), never as none.*
- no new duplicate Answer;
- no new change claimed that no Tool made, and no new other everyday guard failed;
- no new Tool call left as text;
- no more items failing to run.

## Faster, or it isn't listed

The list is for speed, so a model that holds the quality margins is listed only where retrieving first is also sooner: the paired median difference of the time to the end below zero on `gating` and on `hard`. Everyday turns keep the loop, so no time is asked of them.

## Reported, not gated

Per model and set: model calls per Answer, the share that fell back to the loop (searched again, or more than one call of its own), the time to the first words and to the end on both arms, the counts above, the load during the run, and what the run cost.

## How the everyday lines were read (added on 2026-11-04, after the everyday run)

This reading was decided after the run, and it applies only to a set that the changed path never reaches. On Claude Haiku 5.5's everyday run (173 pairs), two "none new" lines failed as written:

- change claimed, none made: 4 → 7 (6 new, 3 gone);
- other everyday guard failed: 40 → 46 (11 new, 5 gone).

Every everyday request is an assistant turn. An assistant turn never searches first, and a unit test (`tests/core/retrieveFirst.test.ts`, "an assistant turn … word for word") shows that every request it sends the model is byte-identical with the list on and off. So on this set the gate is path identity, and that test decides it. The deltas are noise: items flipped both ways, and the sign tests (6 against 3, 11 against 5) are not significant. Part of the noise was a fault in the runner: both arms shared one core, so the second arm found the first arm's Note of the same title and wrote into it. Each arm now has a core of its own. A set the changed path does reach is never read this way: its lines hold as written above.
