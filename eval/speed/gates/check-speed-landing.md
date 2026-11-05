# The gate for a write's marks as each lands, run again

Written and committed on 2026-11-05, before any run it gates. It replaces the timing of `check-speed.md` for this one step. The first numbers set `main`'s runs beside the step's from another hour, and the step's end came later in every cell: on Claude Haiku 5.5, 12.4 → 13.5 s in English and 12.5 → 13.2 s in Chinese; on Claude Sonnet 5.5, 19.4 → 19.8 s and 20.9 → 22.0 s. This gate says how much later counts as later, and is run fresh with the arms alternating.

## The step

When the assistant writes into a Note, a sentence's mark lands as its check ends. A sentence in a table and a sentence whose check cut it wait, and land together after every check, in their order. So the Note's words don't change while sentences are checked.

## The runs

- **Arms:** `today`, the commit this step is built on (9d23dc0a4), where every mark lands after the last check; and `step`, the head of the pull request. Both arms run the same timing code, `eval/speed/checkTimes.ts` and `checkTimes.speed.ts`, the write flow only (`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=write`).
- **Order:** one process per arm and run, alternating `today`, `step`, `today`, `step`. Each process runs English, then Chinese, once.
- **Cells,** each a model and a language, on a direct Anthropic key, six checks at once on both arms:
  - Claude Haiku 5.5, three runs per arm, English and Chinese.
  - Claude Sonnet 5.5, two runs per arm, English and Chinese.
- **Cost:** about $2.50 in all. The runs stop before the spend on #2532 passes its $15 cap.

## The bars, per cell

- **First mark:** the step's median first mark comes before today's.
- **End:** the step's median end is not later than today's by more than the cell's spread, and never by more than 1.0 s. The spread is the largest minus the smallest of today's ends in that cell.
- **No failure:** no request fails and no rate limit is met on the step's arm.
- **Verdicts:** each sentence's mark is compared across the arms. A sentence whose mark differs is reported. It counts against the step if the step's arm marks it Supported more often than today's.

## What decides

The step holds on timing only if every cell holds every bar. If a cell fails, the pull request names it with its numbers and the step's fate is decided in a dated note below, not by reading these bars again.
