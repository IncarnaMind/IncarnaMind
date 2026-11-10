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

## 2026-11-10: the written check alone, staggered, on Claude Haiku 5.5, Claude Sonnet 5.5 and GPT-6.1 Sol

Written and committed before any run it gates. The bars above are unchanged and decide it. On GPT-6.1 Sol a write's check ended 20–28 s after the write at the median on 2026-11-09, and 5–10 s of that was the last sentences waiting for one of six places (#2532).

### The step

- **What changes:** the written check alone sends a write's checked sentences twelve at once instead of six, on a model whose two cells hold every bar.
- **The stagger:** the first six start exactly as today. The other six start once each of the first six's first requests has come back. The wait ends early for a place whose sentence ends or fails before its reply.
- **Never later than today:** a later sentence never starts later than it would at six places. If the first six's first replies are slow, a place freed by a finished sentence is taken at once, as today.
- **Requests:** every request of the check, the first six's included, waits for one of twelve places for requests.
- **A rate limit:** the first one met in a run at twelve drops it straight to six places. Below six it is today's one fewer per limit. Every limited sentence is tried again as today, and none ends Not checked for the limit.
- **Who keeps six:** Check this Note, Verify, every other flow, every other model, a model on this computer, and a Claude or ChatGPT sign-in.
- **Where the number lives:** a model takes twelve only if both its cells hold every bar. It is a per-model fact in the catalog, for that model on its provider's own service.

### The runs

- **Arms:** `today` (`INCARNAMIND_EVAL_SPEED_WRITTEN_AT_ONCE=6`) and `step` (`=12`), both on this branch at the same commit.
- **Flow:** the write of 30 cited paragraphs (`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=write`), the cell these bars and the 2026-11-05 result were set on, on the timing's own Library.
- **Cells,** 6 in all:
  - Claude Haiku 5.5 and Claude Sonnet 5.5 on a direct Anthropic key, each in English and in Chinese;
  - GPT-6.1 Sol on OpenAI's API, in English and in Chinese.
- **Runs:** three valid runs an arm in every cell. Each is one process for one arm, run and language, with the arms alternating today, step, today, step within each cell.
- **The load rule:** a run is valid only when the 1-minute load is 18 or under and the 15-minute load 24 or under, both at its start and at its end. A run that crosses it is kept, struck out, and the cell is run again until it has three valid runs an arm.
- **The key's headroom:**
  - Before each run on an Anthropic key, one smallest-possible request (Claude Haiku 5.5, at most 1 token) reads the `anthropic-ratelimit-*` headers. The run starts only when the remaining input tokens are at least 90% of the limit; otherwise it waits and looks again.
  - The Sol cells do the same on OpenAI's key, with `x-ratelimit-remaining-tokens`.
  - The remaining figure is recorded beside each run's loads.
- **The Anthropic key:** the Anthropic cells run on a key that no other evaluation uses during the gate.
- **A rate limit met:** it is reported as met and counts against the "no failure" bar, on both arms alike. No run is dropped for it.
- **If the Anthropic key runs short:** both arms of a cell move to the same other route together, and this section names the route that ran. A cell is never compared across two routes. Runs already made on the first route for that cell are kept, struck, and not counted.
- **Beside the gate, reported and not gating:** the owner's case, the write of 20 cited paragraphs (`write-20`) on GPT-6.1 Sol on OpenAI's API, one valid run an arm in each language, today against the step.

### Spend

- **By #2532's comments:** $12.05 so far. That is $1.20 on 2026-11-04, $2.11 and $3.06 + $0.25 on 2026-11-07, and $5.43 on 2026-11-09.
- **Counted with the pull requests' own figures:** about $32. That is #2534 (about $12.76 at its merge), #2598 (at most $6.13, under its own $10 approval), #2695, #2708 and #2721 (about $7.6 together, under a $12 approval), and 2026-11-09's $5.43. The $15 line above was passed under those approvals.
- **This run:** $5, a hard stop, its runs again for load included. #2532's spend stops at $37 with this run, and any paid run after it needs a new yes.
- **Raised the same night, before the first Sonnet run:** a Claude Sonnet 5.5 write costs $0.15–0.29 a run, against the $0.15 planned, so the cell couldn't finish inside $5. The stop is now $5.80 for this run and $37.80 for #2532, both hard. Anything past $37.80, a run again for load included, needs the owner's yes.
  - Before each Sonnet run, what is left must cover it at its highest price so far, $0.29; otherwise the cell stops where it is, and the pull request says how many runs an arm it has.
  - A Sonnet run starts only at a quiet moment, well under the load line. Its validity is still the rule above.
