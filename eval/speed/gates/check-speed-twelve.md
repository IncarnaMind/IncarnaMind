# The gate for twelve sentence checks at once

Written and committed on 2026-11-05, before any run it gates. It replaces the timing line of `check-speed.md` for this one step. On the first runs, that line ("neither later") was not met: the first verdict came 0.1 to 0.6 s later in 5 of 14 cells. This gate says how much later counts as later before it is run, and is run fresh.

## The step

On an Anthropic key, a run of sentence checks (Check this Note, Verify and the written check) sends twelve sentences at once instead of six. The claims sort, an Answer's batches, the background watch, a Claude sign-in and every other service keep six.

## The runs

- **Arms:** `today` (`INCARNAMIND_EVAL_SPEED_CHECKS_AT_ONCE=6`) and `step` (`=12`), both on this branch, so a write's marks land as each check ends on both.
- **Order:** one process per arm and run, alternating `today`, `step`, `today`, `step`. Each process runs English, then Chinese, once.
- **Cells,** each a model, language, flow and Library:
  - Claude Haiku 5.5, three runs per arm: Check this Note on the timing's Library; Check this Note on the mixed Library (`INCARNAMIND_EVAL_SPEED_LIBRARY=mixed`); the write of 30 cited paragraphs. That is 6 cells.
  - Claude Sonnet 5.5, two runs per arm: Check this Note on the timing's Library, and the write. That is 4 cells.
- **Cost:** about $4 in all. The run stops before the spend on #2532 passes its $15 cap.

## The bars, per cell

- **Done:** the step's median end comes before today's.
- **First verdict:** the step's median first verdict is not later than today's by more than the cell's spread, and never by more than 1.0 s. The spread is the largest minus the smallest of today's first verdicts in that cell.
- **No failure:** no request fails and no rate limit is met on the step's arm.
- **Verdicts:** a test (since taken out with the step) shows that each sentence's check sends the same requests and lands the same mark at six and at twelve. Verdicts that differ between the arms are reported.

## What decides

A flow (Check this Note, or the written check) takes twelve only if every one of its cells holds every bar. A flow with a cell that fails keeps six, and the failing cell is named in the pull request.

## Result, 2026-11-05: not met, so both flows keep six

The runs were made at commit 47c376aaa, in the order above, on a direct Anthropic key. They spent $2.97. Medians are given today → step, with the cell's spread (today's runs, largest minus smallest first verdict):

| Cell | First verdict | Spread | Done | Holds |
|---|---|--:|---|---|
| Haiku, Note, timing Library, en | 7.8 → 6.3 s | 1.3 s | 17.1 → 10.6 s | yes |
| Haiku, Note, timing Library, zh-CN | 6.1 → 5.7 s | 2.2 s | 13.6 → 11.2 s | yes |
| Haiku, Note, mixed Library, en | 9.4 → 9.5 s | 4.4 s | 20.5 → 18.0 s | yes |
| Haiku, Note, mixed Library, zh-CN | 6.0 → 7.7 s | 2.5 s | 16.5 → 14.9 s | **no:** 1.8 s later, past the 1.0 s cap |
| Haiku, write, en | 3.1 → 2.9 s | 0.3 s | 12.1 → 8.2 s | yes |
| Haiku, write, zh-CN | 2.6 → 2.6 s | 0.1 s | 13.0 → 10.2 s | yes |
| Sonnet, Note, timing Library, en | 9.7 → 9.6 s | 0.5 s | 21.0 → 15.5 s | yes |
| Sonnet, Note, timing Library, zh-CN | 10.5 → 9.1 s | 0.3 s | 19.4 → 16.1 s | yes |
| Sonnet, write, en | 5.5 → 5.6 s | 0.2 s | 22.2 → 14.1 s | yes |
| Sonnet, write, zh-CN | 5.9 → 6.6 s | 0.3 s | 23.9 → 16.1 s | **no:** 0.6 s later, past its 0.3 s spread |

No request failed and no rate limit was met. Cached input was 61–91% on today's arm and 67–93% on the step's. The cost of a run was the same or lower at twelve.

Each flow has one cell that fails the first-verdict bar, so neither Check this Note nor the written check takes twelve. Twelve ended sooner in all 10 cells, by 1.6 to 8.1 s. But on the mixed Library its searches queue at the one built-in reranker, and in a write twelve requests go to the key at once, and in one cell each that delays the first verdict past the bar. The catalog fact that carried the number, and its tests, were taken out with the step.
