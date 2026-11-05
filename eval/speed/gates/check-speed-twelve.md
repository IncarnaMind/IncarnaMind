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
- **Cost:** about $4 in all. The run stops before the lane's spend passes $15.

## The bars, per cell

- **Done:** the step's median end comes before today's.
- **First verdict:** the step's median first verdict is not later than today's by more than the cell's spread, and never by more than 1.0 s. The spread is the largest minus the smallest of today's first verdicts in that cell.
- **No failure:** no request fails and no rate limit is met on the step's arm.
- **Verdicts:** the test (`tests/core/checkSpeed.test.ts`) shows that each sentence's check sends the same requests and lands the same mark at six and at twelve. Verdicts that differ between the arms are reported.

## What decides

A flow (Check this Note, or the written check) takes twelve only if every one of its cells holds every bar. A flow with a cell that fails keeps six, and the failing cell is named in the pull request.
