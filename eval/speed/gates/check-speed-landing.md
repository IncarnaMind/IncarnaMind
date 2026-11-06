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

## Result, 2026-11-05: the first mark came sooner in every cell; two bars weren't met

The runs were made at 32dc8ee60 against 9d23dc0a4, in the order above, on a direct Anthropic key. Medians are given today → step; the spread is today's runs' largest minus smallest end.

| Cell | First mark | End | Spread | End bar |
|---|---|---|--:|---|
| Haiku, English | 13.3 → 3.5 s | 14.2 → 14.2 s | 5.0 s | holds |
| Haiku, Chinese | 14.3 → 3.6 s | 16.4 → 14.3 s | 2.5 s | holds |
| Sonnet, English | 15.4 → 4.3 s | 16.9 → 21.1 s | 0.8 s | **not met:** 4.1 s later |
| Sonnet, Chinese | 22.3 → 4.8 s | 23.4 → 20.6 s | 1.4 s | holds |

- **Sonnet's first runs don't count.** They ran while other work on this computer took the load to 35–134, past the 24 these runs are held to, so Sonnet's cells were run again, alternating, each process waiting for the load to fall to 24. Those are the rows above. The first runs gave English 31.5 → 21.3 s and Chinese 29.4 → 25.1 s to the end.
- **Where the end goes:** in every run of both arms the end comes 0.01–0.09 s after the last model request ends. That measures only the tail: it doesn't show what made the last request end when it did. The step's runs made 1–6 more requests than today's (more cuts and their checks; a run cut 0–3 sentences on either arm).
- **No failure:** no request failed and no rate limit was met.
- **Verdicts:** six sentences' marks differed between the arms over all the runs. One counts against the step under the bar: `h2-zh-copy-damage`, which the rules don't state, was Supported in 3 of 3 of the step's Haiku runs in Chinese and in 1 of 3 of today's. In English the same sentence went the other way: 3 of 3 today, 1 of 3 on the step. The other five were Supported no more often on the step.
- **Spent:** $2.78 on these runs, and $0.06 on one Check this Note for the reranker's waits.

So the step doesn't hold every bar: the end in Sonnet's English cell, and the verdict of one sentence in Haiku's Chinese cell. Whether it ships is decided in a dated note below.

## Decision, 2026-11-06

Two bars are not met and stay failed: Sonnet 5.5 English ended 4.1 s later against a 0.8 s spread, and h2-zh-copy-damage was Supported 3/3 against 1/3 on main in Haiku Chinese. Their cause is unproven. The step ships as an exception that accepts this risk, because the first mark comes 9.8–17.5 s sooner in all four cells.

What landing costs, read from these runs' saved requests with no new run: a mark that doesn't wait reaches a copy of the Note the timing watches a median 4–9 ms after its sentence's last request ends (when the page paints it isn't measured), and a worker that finishes a sentence starts its next one a median 10 ms later on Haiku and 6 ms on Sonnet, where `main` takes 6 ms and 3 ms (90th percentile 21 and 19 ms, against 13 and 17 ms). That is a few milliseconds a landing, too little to account for 4.1 s, but it doesn't prove the cause either.
