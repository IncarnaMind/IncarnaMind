# Evidence for #2255

The real-model runs behind #2397's numbers: Claude Haiku 5.5 (`claude-haiku-5-5`) on a direct
Anthropic key, thinking off, from 2026-10-30 to 2026-11-02. Each file is one run's report, one line
for each language, as the live test writes it to `INCARNAMIND_LIVE_REPORT`: its counts, every
figure that came out other than expected, its requests, tokens and cost. A key or token appears
in none of them. The per-request traces stay out: they repeat the whole check prompt on every line.

## The two sets

1. **`held-out-*.jsonl`**: `tests/live/figureMeasures.live.test.ts`, 20 pairs (each a right figure
   beside the same number for a measure the Document never states) and five two-figure swaps a
   language. `wrongSupported` must be 0; `rightSupported` is the recall.

   ```sh
   INCARNAMIND_LIVE_ANTHROPIC_KEY=… INCARNAMIND_LIVE_REPORT=held-out.jsonl \
   npx vitest run tests/live/figureMeasures.live.test.ts
   ```

2. **`tie-out-*.jsonl`**: `tests/live/tieOut.live.test.ts`, the 40-figure results memo of #1932.
   `supportedKept` of `supported` is the recall; `misses` lists each figure that wasn't what its
   truth says, with the not-checked reason (`unread` is a figure no check covered: the claim sort
   left its sentence out, #2447). A run fails its test when a wrong figure is such a cell, as on `main`'s English run.

   ```sh
   INCARNAMIND_LIVE_ANTHROPIC_KEY=… INCARNAMIND_LIVE_REPORT=tie-out.jsonl \
   npx vitest run tests/live/tieOut.live.test.ts
   ```

## The replay

With `INCARNAMIND_LIVE_MEASURES` set, either test also keeps each figure's measure as the check
read it: its words, the sentence's texts, the quote, the bound number and the texts around the
quote (`tests/live/measureLog.ts`). `replay-b971c404e.md` runs those lines again through
`measureFinding` at other commits, so a change to the rule shows what it does to real replies.

## Which code each file ran

| File | Commit |
|---|---|
| `held-out-main-first.jsonl` | `main` at the branch's start, the 10 pairs only |
| `held-out-main.jsonl` | `main` at the branch's start |
| `held-out-2fa61c46d.jsonl` | 2fa61c46d |
| `held-out-63360a737.jsonl`, `held-out-63360a737-traced.jsonl` | 63360a737 |
| `held-out-157066709.jsonl` | 157066709 |
| `held-out-0c65c6a5b.jsonl` | 0c65c6a5b |
| `held-out-ad8bb4f26.jsonl` | ad8bb4f26 |
| `held-out-522d9ef0e.jsonl` | 522d9ef0e |
| `held-out-b971c404e.jsonl` | b971c404e |
| `tie-out-main.jsonl` | `main` at the branch's start |
| `tie-out-0c65c6a5b.jsonl` | 0c65c6a5b |
| `tie-out-7a7236b05.jsonl` | 7a7236b05 |
| `tie-out-2f8825747.jsonl` | 2f8825747 |
| `tie-out-0c971765c.jsonl` | 0c971765c, English only |
| `tie-out-ad8bb4f26.jsonl` | ad8bb4f26 |
| `tie-out-c87869603.jsonl` | c87869603 |
| `tie-out-522d9ef0e.jsonl` | 522d9ef0e |
| `tie-out-b971c404e.jsonl` | b971c404e |
| `replay-b971c404e.md` | the b971c404e runs' measures, replayed at 38325e8ca, 1a05b929b and b971c404e |
