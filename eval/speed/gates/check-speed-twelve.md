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

### Result, 2026-11-10: GPT-6.1 Sol and Claude Haiku 5.5 hold every bar; Claude Sonnet 5.5 fails one, so it keeps six

The runs were made with the step's code at 8b5f4ffd2, on `main` at 36800b60c; the commits after it change only this text, the README and the catalog facts this result sets. They were made one at a time, each with its key to itself from before the load and the headroom were read, so a wait for the key is never inside a time. Sol's cells ran on OpenAI's own API; Haiku's and Sonnet's on a second direct Anthropic key with its own limit, which no other evaluation used during a run.

| Cell | First verdict, today → step | Today's spread | Done, today → step | Holds | Valid runs, today / step |
|---|---|--:|---|---|--:|
| GPT-6.1 Sol, English | 5.1 → 5.1 s | 0.0 s | 21.5 → 17.6 s | yes | 3 / 3 |
| GPT-6.1 Sol, Chinese | 5.3 → 5.2 s | 0.3 s | 30.0 → 27.7 s | yes | 3 / 3 |
| Claude Haiku 5.5, English | 2.8 → 2.8 s | 0.1 s | 13.9 → 10.1 s | yes | 3 / 3 |
| Claude Haiku 5.5, Chinese | 2.8 → 2.6 s | 0.8 s | 14.0 → 10.9 s | yes | 3 / 3 |
| Claude Sonnet 5.5, English | 4.5 → 4.3 s | 0.3 s | 20.0 → 21.2 s | **no:** the step's median end is not before today's | 2 / 3 |
| Claude Sonnet 5.5, Chinese | 6.4 → 6.7 s | 2.2 s | 25.3 → 20.6 s | yes | 3 / 3 |

- **No failure:** no request failed and no rate limit was met in any run, on either arm. Every Anthropic run started with 2,000,000 of the key's 2,000,000 input tokens a minute left, and every Sol run with 40,000,000 of 40,000,000 tokens.
- **Sonnet in English:** the step's runs ended at 17.9, 25.6 and 21.2 s (median 21.2 s); today's two valid runs at 19.7 and 20.2 s. Today's third run is struck: its end load was 19.2. A fourth wasn't made: today's median could be at most 20.2 s, against the step's 21.2 s, so no result of it could change the verdict. A new gate for Sonnet is new spend that needs the owner's yes.
- **Sonnet in Chinese** holds, but a model takes twelve only when both its cells hold, so Sonnet keeps six.
- **Haiku's first verdict,** pair by pair: the step's came later in two of the six pairs (English 2.9 → 3.3 s, Chinese 2.3 → 3.2 s). Up to the moment the other six start, the arms send the same requests at the same times. After it, the first six sentences' later requests took this long, which shows no slowdown at twelve:

  | Haiku | First six's later requests at six, whole / to first byte | At twelve | Today's own runs, whole / to first byte |
  |---|--:|--:|---|
  | English (19 requests an arm) | 1.09 / 0.65 s | 1.08 / 0.60 s | 1.06–1.26 s / 0.60–0.75 s |
  | Chinese (11 and 21 requests) | 1.07 / 0.77 s | 1.15 / 0.87 s | 0.93–2.09 s / 0.61–1.34 s |

  In the Chinese pair, the step's first verdict came from another sentence, one that needed a second request; in the English pair, from the same sentence after the same two requests, 0.4 s later.
- **Verdicts,** over every run of each cell, struck ones included: no sentence was Supported in more of the step's runs than of today's.
  - **The only false Supported** were Haiku's, on "The Member answers for any damage a guest causes.", which the rules limit to corporate members' guests: in English once on today's arm and never on the step's, in Chinese twice on each arm.
  - **Judged right, today → step:** Sol 48 of 48 → 36 of 36 in English (today's struck run included) and 36 → 36 of 36 in Chinese; Haiku 34 → 36 and 33 → 33 of 36; Sonnet 36 → 36 of 36 in both languages.
  - **Not checked, today → step:** Haiku 1 → 0 and 4 → 3; Sol 0 → 0 and 3 → 3 (a cut sentence that lands asking to be checked again); Sonnet 0 → 0 and 1 → 0.
- **So:** a write's checked sentences go twelve at once on GPT-6.1 Sol on OpenAI's own API and on Claude Haiku 5.5 on Anthropic's own API, as a per-model fact in the catalog. Claude Sonnet 5.5 and every other model keep six.

Beside the gate, reported and not gating, the owner's case (a write of 20 cited paragraphs on GPT-6.1 Sol, one valid run an arm in each language): English 23.4 → 20.1 s to the end, first verdict 4.8 → 5.0 s; Chinese 28.6 → 19.2 s, first verdict 5.2 → 5.1 s.

Every run, in the order it was made:

| Cell | Arm | First verdict | Done | Load at start → end (1 / 15 min) | Key's input headroom at start | Wait for the key | Failed requests | Rate limits met | Spent |
|---|---|--:|--:|---|--:|--:|--:|--:|--:|
| GPT-6.1 Sol, write of 30, en | today (6) | ~~5.8 s~~ | ~~26.1 s~~ | ~~17.7 / 23.1 → 18.2 / 22.9~~ | ~~40M of 40M~~ | ~~0 s~~ | ~~0~~ | ~~0~~ | ~~$0.12~~ (struck: load) |
| GPT-6.1 Sol, write of 30, en | today (6) | 5.1 s | 22.3 s | 13.2 / 21.8 → 12.2 / 21.5 | 40M of 40M | 0 s | 0 | 0 | $0.13 |
| GPT-6.1 Sol, write of 30, en | step (12) | 5.2 s | 17.6 s | 12.4 / 21.1 → 13.8 / 21.0 | 40M of 40M | 0 s | 0 | 0 | $0.11 |
| GPT-6.1 Sol, write of 30, en | today (6) | 5.2 s | 21.5 s | 16.1 / 20.5 → 14.4 / 20.3 | 40M of 40M | 0 s | 0 | 0 | $0.12 |
| GPT-6.1 Sol, write of 30, en | step (12) | 5.1 s | 22.1 s | 12.8 / 19.8 → 13.8 / 19.8 | 40M of 40M | 0 s | 0 | 0 | $0.13 |
| GPT-6.1 Sol, write of 30, en | today (6) | 5.1 s | 21.0 s | 11.8 / 18.6 → 10.1 / 18.3 | 40M of 40M | 0 s | 0 | 0 | $0.16 |
| GPT-6.1 Sol, write of 30, en | step (12) | 5.0 s | 16.4 s | 11.3 / 18.3 → 11.3 / 18.2 | 40M of 40M | 0 s | 0 | 0 | $0.13 |
| GPT-6.1 Sol, write of 30, zh-CN | today (6) | 5.1 s | 39.9 s | 15.3 / 21.1 → 14.8 / 20.8 | 40M of 40M | 0 s | 0 | 0 | $0.16 |
| GPT-6.1 Sol, write of 30, zh-CN | step (12) | 5.3 s | 27.7 s | 17.4 / 20.8 → 17.5 / 20.7 | 40M of 40M | 0 s | 0 | 0 | $0.16 |
| GPT-6.1 Sol, write of 30, zh-CN | today (6) | 5.3 s | 30.0 s | 16.5 / 19.8 → 14.1 / 19.5 | 40M of 40M | 0 s | 0 | 0 | $0.13 |
| GPT-6.1 Sol, write of 30, zh-CN | step (12) | 5.2 s | 24.5 s | 13.7 / 19.3 → 11.6 / 18.9 | 40M of 40M | 0 s | 0 | 0 | $0.12 |
| GPT-6.1 Sol, write of 30, zh-CN | today (6) | 5.4 s | 28.6 s | 10.6 / 18.0 → 9.8 / 17.7 | 40M of 40M | 0 s | 0 | 0 | $0.14 |
| GPT-6.1 Sol, write of 30, zh-CN | step (12) | 5.2 s | 30.9 s | 9.8 / 17.4 → 8.3 / 17.0 | 40M of 40M | 0 s | 0 | 0 | $0.14 |
| Claude Haiku 5.5, write of 30, en | today (6) | 2.9 s | 14.8 s | 8.5 / 14.7 → 7.9 / 14.5 | 2M of 2M | 0 s | 0 | 0 | $0.02 |
| Claude Haiku 5.5, write of 30, en | step (12) | 3.3 s | 11.3 s | 7.6 / 14.4 → 7.5 / 14.3 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, en | today (6) | 2.8 s | 12.8 s | 6.6 / 11.1 → 6.7 / 11.1 | 2M of 2M | 150 s | 0 | 0 | $0.02 |
| Claude Haiku 5.5, write of 30, en | step (12) | 2.4 s | 10.1 s | 7.3 / 11.0 → 7.4 / 11.0 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, en | today (6) | 2.8 s | 13.9 s | 11.6 / 11.1 → 10.9 / 11.1 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, en | step (12) | 2.8 s | 9.8 s | 9.8 / 11.0 → 8.8 / 10.9 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, zh-CN | today (6) | 2.3 s | 12.0 s | 8.4 / 14.2 → 8.0 / 14.1 | 2M of 2M | 0 s | 0 | 0 | $0.02 |
| Claude Haiku 5.5, write of 30, zh-CN | step (12) | 3.2 s | 12.1 s | 7.7 / 13.9 → 7.5 / 13.8 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, zh-CN | today (6) | 2.8 s | 14.0 s | 8.1 / 11.0 → 8.1 / 10.9 | 2M of 2M | 0 s | 0 | 0 | $0.02 |
| Claude Haiku 5.5, write of 30, zh-CN | step (12) | 2.6 s | 9.9 s | 8.7 / 10.9 → 12.8 / 11.2 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, zh-CN | today (6) | 3.1 s | 14.3 s | 7.9 / 10.8 → 7.6 / 10.7 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Haiku 5.5, write of 30, zh-CN | step (12) | 2.3 s | 10.9 s | 8.6 / 10.7 → 8.3 / 10.7 | 2M of 2M | 0 s | 0 | 0 | $0.01 |
| Claude Sonnet 5.5, write of 30, en | today (6) | 4.6 s | 19.7 s | 9.1 / 13.8 → 9.7 / 13.8 | 2M of 2M | 0 s | 0 | 0 | $0.27 |
| Claude Sonnet 5.5, write of 30, en | step (12) | 4.5 s | 17.9 s | 9.3 / 13.7 → 9.2 / 13.6 | 2M of 2M | 0 s | 0 | 0 | $0.18 |
| Claude Sonnet 5.5, write of 30, en | today (6) | ~~4.9 s~~ | ~~19.6 s~~ | ~~15.6 / 11.1 → 19.2 / 11.6~~ | ~~2M of 2M~~ | ~~0 s~~ | ~~0~~ | ~~0~~ | ~~$0.27~~ (struck: load) |
| Claude Sonnet 5.5, write of 30, en | step (12) | 4.3 s | 25.6 s | 13.0 / 11.8 → 12.1 / 11.7 | 2M of 2M | 0 s | 0 | 0 | $0.14 |
| Claude Sonnet 5.5, write of 30, en | today (6) | 4.3 s | 20.2 s | 8.2 / 11.1 → 7.6 / 11.0 | 2M of 2M | 0 s | 0 | 0 | $0.15 |
| Claude Sonnet 5.5, write of 30, en | step (12) | 4.3 s | 21.2 s | 7.3 / 10.9 → 6.9 / 10.8 | 2M of 2M | 0 s | 0 | 0 | $0.18 |
| Claude Sonnet 5.5, write of 30, zh-CN | today (6) | 6.4 s | 25.3 s | 8.9 / 13.5 → 8.0 / 13.3 | 2M of 2M | 0 s | 0 | 0 | $0.29 |
| Claude Sonnet 5.5, write of 30, zh-CN | step (12) | 6.7 s | 17.0 s | 7.1 / 13.0 → 6.5 / 12.8 | 2M of 2M | 0 s | 0 | 0 | $0.15 |
| Claude Sonnet 5.5, write of 30, zh-CN | today (6) | 6.9 s | 37.0 s | 9.5 / 11.5 → 7.8 / 11.3 | 2M of 2M | 0 s | 0 | 0 | $0.27 |
| Claude Sonnet 5.5, write of 30, zh-CN | step (12) | 7.1 s | 25.2 s | 10.4 / 11.4 → 9.9 / 11.3 | 2M of 2M | 0 s | 0 | 0 | $0.14 |
| Claude Sonnet 5.5, write of 30, zh-CN | today (6) | 4.7 s | 23.0 s | 6.9 / 10.8 → 6.4 / 10.6 | 2M of 2M | 0 s | 0 | 0 | $0.15 |
| Claude Sonnet 5.5, write of 30, zh-CN | step (12) | 6.5 s | 20.6 s | 8.8 / 11.0 → 7.9 / 10.9 | 2M of 2M | 80 s | 0 | 0 | $0.16 |
| GPT-6.1 Sol, write of 20, en | today (6) | 4.8 s | 23.4 s | 7.3 / 16.6 → 7.5 / 16.4 | 40M of 40M | 0 s | 0 | 0 | $0.15 |
| GPT-6.1 Sol, write of 20, en | step (12) | 5.0 s | 20.1 s | 8.5 / 16.1 → 7.5 / 15.9 | 40M of 40M | 0 s | 0 | 0 | $0.13 |
| GPT-6.1 Sol, write of 20, zh-CN | today (6) | 5.2 s | 28.6 s | 7.2 / 15.4 → 6.0 / 15.1 | 40M of 40M | 0 s | 0 | 0 | $0.15 |
| GPT-6.1 Sol, write of 20, zh-CN | step (12) | 5.1 s | 19.2 s | 6.8 / 14.8 → 8.3 / 14.7 | 40M of 40M | 0 s | 0 | 0 | $0.15 |

**Spend:** $4.91 of this run's $5.80, $4.86 by the runs' own counts and the rest a margin for the headroom reads.

| Cells | Planned | Spent |
|---|--:|--:|
| GPT-6.1 Sol, both languages, and the owner's case | about $2.10 | $2.36 |
| Claude Haiku 5.5, both languages | about $0.20 | $0.14 |
| Claude Sonnet 5.5, both languages | about $1.00 | $2.36 |

A Sonnet write cost $0.14–0.29 a run; it was planned at $0.15. #2532 has now spent $16.96 by its comments and about $36.8 counted with the pull requests' own figures, against the $37.80 stop. Any further paid run on #2532 needs the owner's yes.
