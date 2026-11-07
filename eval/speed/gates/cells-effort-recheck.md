# Rechecking Claude Haiku 5.5's low effort for comparison cells (#2720)

Written and committed on 2026-11-07, before any run it gates. Since #1631, Claude Haiku 5.5 fills a comparison table's cells (`task`) at low effort, admitted where its gate held "no new false Supported" on the `cells` set. The paired runner then read false Supported in a cell as 0, whatever the cell said (#2720). #2706 measures it now: each cell line with a found Citation, judged once against all its found quotes by Claude Sonnet 5.5, each flagged line listed with its quotes. This recheck asks whether low effort holds on that measure.

## The runs

- **Arms:** `default-effort` (the provider's default effort, as cells were sent before #1631) against `today` (low), paired as `eval/speed/README.md` › Paired runs says: each arm in a core of its own, the order turning item by item.
- **Set:** `cells`, the gating set's 65 Questions, each asked as a comparison table's one cell. Two whole runs, false Supported counted rather than stopping at the first (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), `INCARNAMIND_EVAL_SPEED_MARGIN=1`.
- **Model:** Claude Haiku 5.5 on the direct key. Judge: Claude Sonnet 5.5.

## The decision

Every flagged line of both arms in both runs is read by hand against its quotes. A flag is right when the line states something its quotes don't (a figure, a period, a name, a claim); it is wrong when the quotes state the line and it adds only the Document's own title or is half of a sentence the splitter cut in two. A flag that turns on a year or place the Passage gives but the quote leaves out is counted apart, as borderline. An arm's real false-Supported rate in a run is its right flags over its found Citations.

- If `today`'s real false-Supported rate is above `default-effort`'s in both runs, by more than either arm's own difference between its two runs, Haiku's cells go back to the provider's default effort in a pull request named for #2720.
- If not, the numbers go on #2720 and low effort stays.

The other lines of #1631's gate (expected Passages cited, judged right, every Citation found, duplicates, items failing to run) and the times are reported.

## Spend

At most $4, held by `INCARNAMIND_EVAL_SPEED_LEDGER` with `INCARNAMIND_EVAL_SPEED_STOP_USD=4`.
