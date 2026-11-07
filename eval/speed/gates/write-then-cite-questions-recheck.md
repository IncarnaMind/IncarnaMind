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

## Spend

At most $5 for this recheck, held by `INCARNAMIND_EVAL_SPEED_LEDGER` with the cap the run is given.
