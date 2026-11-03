# Evidence for #2447

The real-model runs behind the pull request's numbers, made on 2026-11-02 with Claude Haiku 5.5
(`claude-haiku-5-5`) on a direct Anthropic key. `main` is `a832fcbfb`; `head` is the branch's check
code as merged with that `main` (`6104e873c`; the commits after it change tests only). A key or
token appears in none of these files.

## The runs

- **`sort-probe-main.jsonl`**: the cause. The tie-out memo of `tests/live/tieOut.live.test.ts`,
  sorted only (`findMindClaims`), on `main`, in English and Chinese: every request the sort made
  and the model's reply. A table's value cell goes to the sort as its bare words ("540"), and the
  model gives most of them no parts; a cell given no parts, or none decided, is never checked.
- **`sort-probe-labels-with-headings.jsonl`**: the same memo sorted with every body cell given its
  row's label and its column's heading, the row's own label cell included. The model then takes
  the label cells ("日用食品") for facts too, which is why a row's own label is sent as its words
  alone.
- **`heldout-30-*.jsonl`**: `tests/live/sortedTables.live.test.ts` with its first held-out tables
  (30 figures a language, none of them the memo's), Check this Note once a run. `*-sorts.jsonl`
  holds that run's sort requests and replies.
- **`heldout-39-*.jsonl`**: the same test after two more tables a language were committed (39
  figures): one whose row labels only name their rows, one whose labels assert something.
- **`tieout-*.jsonl`**: `tests/live/tieOut.live.test.ts`, the 40-figure memo with its two tables,
  twice on each side.

Each report line is one language's run: what the sort made of each table cell (`sortedCells`,
`sorting`) and of each row's label it was shown, the figure counts the test scores, every figure
that came out other than expected, and the spend. Run with:

```sh
INCARNAMIND_LIVE_ANTHROPIC_KEY=… INCARNAMIND_LIVE_REPORT=report.jsonl \
INCARNAMIND_LIVE_TRACE=sorts.jsonl npx vitest run tests/live/sortedTables.live.test.ts
```

in the `main` worktree for `main` (with this branch's two live tests and `tests/helpers/sortCalls.ts`
copied in) and in this branch for `head`.
