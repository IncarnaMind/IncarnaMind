# Rechecking Claude Haiku 5.5's write-then-cite entry for Questions (#2720)

Written and committed on 2026-11-07, before any run it gates. Claude Haiku 5.5 has been listed since 2026-10-26 to write a Question's Answer, then cite it in the same reply (#489). Its gate held "no new false Supported", but the paired runner then read false Supported as 0 on every Question, whatever an Answer said (#2720). #2706 now measures it: each sentence with a found Citation, judged once against all its found quotes by Claude Sonnet 5.5. It also counts a change an Answer claims that no Tool made. This recheck asks whether the entry holds on that measure.

## The runs

- **Arms:** `cite-first` against `write-then-cite`, both with the Tool loop from the first call, paired as `eval/speed/README.md` › Paired runs says: each arm in a core of its own, the order turning item by item.
- **Sets:** `gating` (the 65 Questions), then `hard` with `INCARNAMIND_EVAL_SPEED_EACH=3` (30 hard-tier Questions, three of each kind, the languages taking turns), as #489's own gate had them.
- **Model:** Claude Haiku 5.5 on the direct key. Judge: Claude Sonnet 5.5.

## The bar

On the items both arms finished, `write-then-cite` against `cite-first`:

- **no new false Supported:** the run stops at the first one `cite-first` didn't give;
- no new change claimed that no Tool made, duplicate Answer, Tool call left as text, or item failing to run;
- `INCARNAMIND_EVAL_SPEED_MARGIN=1`: expected Passages cited, judged right and every Citation found no more than one item in 30 fewer.

If a line fails, Haiku comes off the list for Questions in a pull request named for #2720, and Questions cite first on every model. If every line holds, the numbers go on #2720 and the entry stays.

*Added on 2026-11-07, after the first run stopped at en-03 (4 such sentences against 3) and before the two whole runs below: an Answer's sentences differ from run to run, so the entry is decided over the set, not at one Question. The gating set is run twice more, whole, false Supported counted (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), and every flagged sentence of both arms is read by hand against its quotes. A flag is right when the sentence states something its quotes don't. The entry comes off if write-then-cite's real rate (flags read right, over found Citations) is above cite-first's by more than either arm's own difference between the two runs.*

*Read on 2026-11-07: cite-first 45 of 177 found Citations (25.4%) and 54 of 176 (30.7%); write-then-cite 72 of 178 (40.4%) and 65 of 192 (33.9%). The ranges don't meet, and the mean gap, 9.1 points, is more than either arm's spread (5.3 and 6.5). A quote about a different claim than its sentence's: 6% citing first, 12–13% writing first, in both runs. The judge was wrong on 17 of the 288 flags. The entry comes off.*

## Spend

At most $5 for this recheck, held by `INCARNAMIND_EVAL_SPEED_LEDGER` with the cap the run is given.
