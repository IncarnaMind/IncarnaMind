# A write's check on keys that refuse: the scripted cells

For #2532 (twelve sentence checks at once) and #2944 (a refused check request waits as long as the AI service says). Measured on 2026-11-12. No request is paid for: the model's replies are scripted and the clock is the test's own.

## How it runs

- **The harness** is `eval/speed/keyCells.speed.ts`, with `keyWrites` in `tests/helpers/writeChecked.ts`. Run it with `INCARNAMIND_EVAL_SPEED_KEY_CELLS=<file> npm run eval:speed -- eval/speed/keyCells.speed.ts`. It writes one JSON file.
- **A cell** is two writes, one after the other in one session, checked at six and at twelve at once. Each check request takes the cell's reply time. A request the key has no room for is refused the way a service refuses a rate limit: an HTTP 429 that the AI SDK may send again.
- **The AI SDK's own retries** (two for a check's Run, after 2 s and 4 s, or after the stated wait when it is under 60 s) wait on the test's clock too. So the gated head's numbers include them, as the app does.
- **Both heads ran the same harness.**
  - **The gated head:** 142eb8985, from its own tree with the harness copied in. Its result is `key-cells/gated-142eb8985.json`.
  - **This head:** `key-cells/request-level-wait.json`.
- **The keys:**
  - **A bucket** of requests, refilled at its rate. Its refusal says, in whole seconds and at least 1, how long until a request fits, as Anthropic's `retry-after` does.
  - **So many at once.** Its refusal says nothing of how long.
  - **A new account's published limits.** These are the lowest tier with published numbers. The first-tier numbers each service lists for a new account are not published, as the next bullet says.
    - **Anthropic, Start tier, Claude Haiku 5.5:** 4,000 requests, 2,000,000 input tokens and 400,000 output tokens a minute (platform.claude.com/docs/en/api/rate-limits).
      - The page also says new organizations "may start in the Evaluation tier, with limits below the standard limits shown on this page", and those limits aren't published.
      - Cached input tokens don't count. A request costs what the gate's runs measured at the median: 934 uncached input tokens (9,322 for a write's first request, whose prompt cache is written) and 237 output. The reply takes 1.461 s.
    - **OpenAI, Build tier (the lowest paid tier, after $5 of credit), GPT-6.1 Sol** (listed as "Astra, Sol, Terra"): 5,000 requests and 1,000,000 tokens a minute (developers.openai.com/api/docs/guides/rate-limits). A request costs 6,389 tokens (6,316 in, 73 out). The reply takes 1.878 s.
    - **How much a bucket holds.** Either a minute of its limit, since the bucket is "continuously replenished up to your maximum limit", or a second of it, from Anthropic's own example of a limit enforced over a shorter interval. The gate's Haiku runs sent twelve requests of about 9,300 tokens at once on a key of 2,000,000 a minute and met no limit, so the second reading is the stricter of the two, not one we have seen.
- **A write of 30** checks its first 12 sentences on both heads, as `SENTENCES_CHECKED_AT_MOST` says. The other 18 land Not checked, "too many". So its rows send what the write of 12 sends.

## The bars, in every cell and both writes

1. Twelve ends no more than 1.0 s after six, on the same key and head.
2. Twelve lands every mark six lands.
3. Six on this head is never later, and never lands fewer marks, than six on the gated head.
4. With no limit met, nothing moves: the same requests, as many at once, sent at the same times as on the gated head.

## Result

The second write of each session came out the same as the first in every cell, on both heads, so each row stands for both writes. "Refused" counts the key's refusals.

| Key · sentences · reply | Gated head, six | Gated head, twelve | This head, six | This head, twelve | 1 | 2 | 3 | 4 |
|---|---|---|---|---|:-:|:-:|:-:|:-:|
| bucket never · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket never · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket never · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket never · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket fits six · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 1.3 s, 12 ✓, 6 refused | 0.6 s, 12 ✓, 0 refused | 1.3 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| bucket fits six · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 12 refused | 3.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 12 refused | ✓ | ✓ | ✓ | – |
| bucket fits six · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 24 refused | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 24 refused | ✓ | ✓ | ✓ | – |
| bucket fits six · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 17.0 s, 12 ✓, 39 refused | 12.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 42 refused | ✓ | ✓ | ✓ | – |
| bucket refuses six · 12 · 0.1 s | 1.3 s, 12 ✓, 2 refused | 1.3 s, 12 ✓, 2 refused | 1.3 s, 12 ✓, 2 refused | 1.3 s, 12 ✓, 2 refused | ✓ | ✓ | ✓ | – |
| bucket refuses six · 12 · 0.5 s | 5.0 s, 12 ✓, 8 refused | 5.0 s, 12 ✓, 14 refused | 5.0 s, 12 ✓, 8 refused | 5.0 s, 12 ✓, 8 refused | ✓ | ✓ | ✓ | – |
| bucket refuses six · 12 · 1 s | 9.0 s, 12 ✓, 14 refused | 11.0 s, 12 ✓, 34 refused | 9.0 s, 12 ✓, 14 refused | 9.0 s, 12 ✓, 14 refused | ✓ | ✓ | ✓ | – |
| bucket refuses six · 12 · 2 s | 18.0 s, 12 ✓, 30 refused | 24.0 s, 12 ✓, 36 refused | 18.0 s, 12 ✓, 30 refused | 18.0 s, 12 ✓, 30 refused | ✓ | ✓ | ✓ | – |
| bucket very small · 12 · 0.1 s | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | 7.2 s, 12 ✓, 25 refused | 7.3 s, 12 ✓, 25 refused | ✓ | ✓ | **+1.9 s** | – |
| bucket very small · 12 · 0.5 s | 19.0 s, 12 ✓, 57 refused | 22.5 s, 12 ✓, 54 refused | 18.0 s, 12 ✓, 75 refused | 19.5 s, 12 ✓, 85 refused | **+1.5 s** | ✓ | ✓ | – |
| bucket very small · 12 · 1 s | 36.0 s, 12 ✓, 84 refused | 58.0 s, 12 ✓, 77 refused | 36.0 s, 12 ✓, 165 refused | 36.0 s, 12 ✓, 165 refused | ✓ | ✓ | ✓ | – |
| bucket very small · 12 · 2 s | 72.0 s, 12 ✓, 84 refused | 80.0 s, 11 ✓, 1 Not checked (rate-limit), 71 refused | 72.0 s, 12 ✓, 165 refused | 72.0 s, 12 ✓, 165 refused | ✓ | ✓ | ✓ | – |
| at-once never · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once never · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once never · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once never · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once fits six · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 2.3 s, 12 ✓, 6 refused | 0.6 s, 12 ✓, 0 refused | 2.3 s, 12 ✓, 6 refused | **+1.7 s** | ✓ | ✓ | – |
| at-once fits six · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 3.5 s, 12 ✓, 6 refused | 3.0 s, 12 ✓, 0 refused | 3.5 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| at-once fits six · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 12 refused | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 12 refused | ✓ | ✓ | ✓ | – |
| at-once fits six · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 24 refused | 12.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 24 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 0.1 s | 2.3 s, 12 ✓, 2 refused | 2.3 s, 12 ✓, 2 refused | 2.3 s, 12 ✓, 2 refused | 2.3 s, 12 ✓, 2 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 0.5 s | 5.0 s, 12 ✓, 4 refused | 5.5 s, 12 ✓, 6 refused | 5.0 s, 12 ✓, 4 refused | 5.0 s, 12 ✓, 4 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 1 s | 10.0 s, 12 ✓, 8 refused | 10.0 s, 12 ✓, 14 refused | 10.0 s, 12 ✓, 8 refused | 10.0 s, 12 ✓, 8 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 2 s | 18.0 s, 12 ✓, 14 refused | 22.0 s, 12 ✓, 32 refused | 18.0 s, 12 ✓, 14 refused | 18.0 s, 12 ✓, 14 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 0.1 s | 13.3 s, 12 ✓, 16 refused | 13.3 s, 12 ✓, 16 refused | 13.3 s, 12 ✓, 16 refused | 13.3 s, 12 ✓, 16 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 0.5 s | 21.0 s, 12 ✓, 25 refused | 19.5 s, 12 ✓, 28 refused | 22.5 s, 12 ✓, 24 refused | 19.0 s, 12 ✓, 21 refused | ✓ | ✓ | **+1.5 s** | – |
| at-once very small · 12 · 1 s | 37.0 s, 12 ✓, 43 refused | 38.0 s, 12 ✓, 47 refused | 39.0 s, 12 ✓, 36 refused | 37.0 s, 12 ✓, 32 refused | ✓ | ✓ | **+2.0 s** | – |
| at-once very small · 12 · 2 s | 73.0 s, 12 ✓, 70 refused | 72.0 s, 12 ✓, 71 refused | 72.0 s, 12 ✓, 61 refused | 72.0 s, 12 ✓, 52 refused | ✓ | ✓ | ✓ | – |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 12 · 1.878 s | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 12 · 1.878 s | 17.9 s, 12 ✓, 11 refused | 17.3 s, 12 ✓, 12 refused | 16.9 s, 12 ✓, 19 refused | 16.9 s, 12 ✓, 19 refused | ✓ | ✓ | ✓ | – |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 30 · 1.878 s | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 30 · 1.878 s | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | 17.3 s, 12 ✓, 18 Not checked (too-many), 12 refused | 16.9 s, 12 ✓, 18 Not checked (too-many), 19 refused | 16.9 s, 12 ✓, 18 Not checked (too-many), 19 refused | ✓ | ✓ | ✓ | – |

**In short:**

- **Bar 4 holds** in all 16 cells with no limit met: the same requests at the same times, at six and at twelve.
- **Bar 2 holds everywhere.** Twelve lands every mark six lands, and every mark lands in every cell on this head. On the gated head, twelve left one sentence Not checked for the rate limit on the very small bucket at 2 s a reply.
- **Six on the gated head loses no mark in any cell.** So there is no six-on-main bug here to file.
- **Bar 1 fails in two cells, bar 3 in three,** each by 2.0 s or less, with every mark landed. They are below.

## Where a bar fails

- **The so-many-at-once key that fits six, at 0.1 s a reply (bar 1, +1.7 s).** It is the same on the gated head. The other six start once the first six's first replies are back, and they take the six places the first six's next turns need. Those turns are refused, with no stated wait, so the AI SDK sends them again after 2 s. The first rows of twelve's timeline (ms, sentence:turn), the same on both heads:

  | Gated head | This head |
  |---|---|
  | 0 1:0 … 6:0 | 0 1:0 … 6:0 |
  | 100 7:0 … 12:0 | 100 7:0 … 12:0 |
  | 100 1:1 … 6:1 refused | 100 1:1 … 6:1 refused |
  | 200 7:1 … 12:1 | 200 7:1 … 12:1 |
  | 300 7:2 … 12:2 | 300 7:2 … 12:2 |
  | 2100 1:1 … 6:1 | 2100 1:1 … 6:1 |

- **The very small bucket (one request a reply's time), at 0.1 s (bar 3, +1.9 s) and at 0.5 s (bar 1, +1.5 s).** The key has room for one request at each whole second, and several requests wait for it. The heads differ in which one gets it.
  - On the gated head, sentences 4 and 5 had failed whole after the AI SDK's two retries, and were waiting for the run's pause. On this head they waited their stated second and went again, and took the room 9 and 12 then lost.
  - Six's timeline at 0.1 s, from where the two first differ (ms, sentence:turn):

  | Gated head | This head |
  |---|---|
  | 3000 9:1 | 3000 4:0 |
  | 3000 12:1 refused | 3000 5:0 refused |
  | 3000 6:0 refused | 3000 6:0 refused |
  | 3100 9:2 | 3000 9:1 refused |
  | 3200 5:0 | 3000 12:1 refused |
  | 3300 5:1 | 3100 4:1 |
  | 3400 5:2 | 3200 4:2 |
  | 3500 4:0 | 4000 5:0 |
  | 3600 4:1 | 4000 6:0 refused |
  | 3700 4:2 | 4000 9:1 refused |
  | 4000 12:1 | 4000 12:1 refused |
  | 4000 6:0 refused | 4100 5:1 |
  | 4100 12:2 | 4200 5:2 |
  | 5000 6:0 | 5000 6:0 |
  | 5100 6:1 | 5000 9:1 refused |
  | 5200 6:2 | 5000 12:1 refused |
  | (ends 5.3 s) | 5100 6:1, 5200 6:2, 6000 9:1, 6000 12:1 refused, 6100 9:2, 7000 12:1, 7100 12:2 (ends 7.2 s) |

- **The so-many-at-once key that takes one, at 0.5 s and 1 s (bar 3, +1.5 s and +2.0 s).** No wait is stated, so both heads use the AI SDK's own retries. They differ in how the run gets its places back.
  - **What the logs show:** both heads drop to three places at 6 s, when three checks fail whole after the AI SDK's retries.
    - **The gated head** gets a fourth place back after a calm round: at 10 s at 0.5 s a reply, and at 15 s at 1 s. It gets a fifth at 17.5 s and 26 s.
    - **This head** stays at three to the end. A check whose request met a limit counts toward no calm round, even when the AI SDK's own retry then got it through (`send` sets `met` and `calm = 0` before it throws the limit on).
  - **Every mark lands on both heads.**
  - **The timelines** (ms, sentence:turn, with the places allowed in brackets; the places were logged for this reading and the logging taken out again), from where the heads first differ:

  **0.5 s a reply** (the gated head ends at 21.0 s, this head at 22.5 s):

  | Gated head | This head |
  |---|---|
  | 9000 5:1 (3) | 9000 5:1 (3) |
  | 9500 5:2 (3) | 9500 5:2 (3) |
  | 10000 8:1 (4) | 10000 8:1 (3) |
  | 10000 6:1 refused (4) | 10000 6:1 refused (3) |
  | 10000 4:0 refused (4) | 10000 4:0 refused (3) |
  | 10000 10:0 refused (4) | 10500 8:2 (3) |
  | 10500 8:2 (4) | 11000 10:0 (3) |
  | 11000 11:0 (4) | 11500 10:1 (3) |
  | 11500 11:1 (4) | 12000 4:0 (3) |
  | 12000 4:0 (4) | 12000 10:2 refused (3) |
  | 12000 10:0 refused (4) | 12500 4:1 (3) |
  | 12000 11:2 refused (4) | 13000 4:2 (3) |
  | 12500 4:1 (4) | 13500 11:0 (3) |
  | 13000 4:2 (4) | 14000 6:1 (3) |

  **1 s a reply** (the gated head ends at 37.0 s, this head at 39.0 s):

  | Gated head | This head |
  |---|---|
  | 14000 5:1 refused (3) | 14000 5:1 refused (3) |
  | 14000 6:2 refused (3) | 14000 6:2 refused (3) |
  | 15000 4:0 (4) | 15000 4:0 (3) |
  | 15000 8:0 refused (4) | 16000 6:2 (3) |
  | 16000 6:2 (4) | 16000 4:1 refused (3) |
  | 16000 4:1 refused (4) | 17000 8:0 (3) |
  | 17000 8:0 (4) | 18000 5:1 (3) |
  | 17000 9:0 refused (4) | 18000 4:1 refused (3) |
  | 18000 5:1 (4) | 18000 8:1 refused (3) |
  | 18000 4:1 refused (4) | 19000 5:2 (3) |
  | 18000 8:1 refused (4) | 20000 8:1 (3) |
  | 19000 9:0 (4) | 20000 9:0 refused (3) |

## What was built, and the variants measured first

Every variant was measured with the same harness against the same gated-head file. The counts are of the 40 cells' first writes.

| Variant | Bar 1 fails | Bar 2 fails | Bar 3 fails | Bar 4 fails | Not checked for the rate limit |
|---|--:|--:|--:|--:|--:|
| A: the design as first written. One run-wide pause every request waits on; steps of 1, 2, 4, 8 and 16 s for each request; one place fewer for each limit, counted once per burst | 5 | 0 | 16 | 0 | 14 |
| B: each refused request waits only its own wait; the steps go on at 16 s until the 2-minute bound | 1 | 0 | 15 | 0 | 0 |
| C: B, with steps of 1, 2, 4 and then 8 s, and a limit at or below six taking no place away | 1 | 0 | 12 | 0 | 0 |
| D: C, with the run's pause for new checks taken away for a request's own refusal | 3 | 0 | 6 | 0 | 0 |
| E: D, with steps of 1, 2 and then 4 s | 2 | 0 | 6 | 0 | 0 |
| **G (built):** a stated wait is waited inside the check; a refusal with none is left to the AI SDK's retries and then the run's pauses, as before | 2 | 0 | 3 | 0 | 0 |
| The gated head itself, twelve against six | 8 | 1 | – | – | 1 |

- **Why A failed:** one refusal paused every request of the run, and each refusal moved that pause by its own request's next step. On a key that refuses often, the steps reached 16 s and held every check. Six on the so-many-at-once key that takes one went from 13.3 s to 233.9 s. At 2 s a reply, 7 of 12 sentences ran out of waits and landed Not checked.
- **Why G:** where the service states a wait, waiting it inside the check is never worse in these 40 cells than the gated head's, and it keeps the check's earlier turns. Where it states none, our own steps were worse than the AI SDK's 2 and 4 s retries followed by the run's pauses (C, D, E).
  - **So G keeps today's retries and pauses for that path. How the width comes back is not today's:** a check whose request met any limit counts toward no calm round, as the one-at-a-time cells above show.

## Accepted on 2026-11-12

The built design (G) goes ahead with these five cells failed, accepted as misses and not passed. The four bars stay as written for the next change to width, retries or how a run narrows.

| Cell | Bar | Numbers |
|---|---|---|
| So-many-at-once, fits six, 0.1 s a reply | 1 | six 0.6 s, twelve 2.3 s (+1.7 s); the same on the gated head |
| Very small bucket, 0.5 s | 1 | six 18.0 s, twelve 19.5 s (+1.5 s); the gated head 19.0 s and 22.5 s |
| Very small bucket, 0.1 s | 3 | six 5.3 s on the gated head, 7.2 s here (+1.9 s); refused 18, then 25 |
| So-many-at-once, takes one, 0.5 s | 3 | six 21.0 s on the gated head, 22.5 s here (+1.5 s); refused 25, then 24 |
| So-many-at-once, takes one, 1 s | 3 | six 37.0 s on the gated head, 39.0 s here (+2.0 s); refused 43, then 36 |

## Added 2026-11-12, before its run: a key that counts a refused request

OpenAI's guide says, under "Retrying with exponential backoff": "unsuccessful requests contribute to your per-minute limit, so continuously resending a request won't work". On the very small bucket, this head sends about twice the gated head's refused requests for the same end: 165 against 84 at 1 s and at 2 s. A key that charges for them is where a cost could hide.

- **The key.** A bucket, as above, except that a refused request takes room too. The bucket goes below empty, and the refusal states, in whole seconds and at least 1, how long until one request fits again.
- **Sizes.** "Refuses six" (holds 4, refilled 4 a reply's time) and "very small" (holds 1, refilled 1 a reply's time), each at 0.1, 0.5, 1 and 2 s a reply.
- **The runs.** Both heads, at six and at twelve, two writes a session, with the same harness as above.
- **The bars, set now, before the run:**
  - **2.** Twelve lands every mark six lands.
  - **3.** Six on this head is never later, and never lands fewer marks, than six on the gated head.
- **What a miss would mean.** A cell this head misses is the cell that a place taken away below six would be built on.

### Result, 2026-11-12: bar 3 fails in 6 of 8 cells; in 5 of them this head lands no mark at six

| Key · reply | Gated head, six | Gated head, twelve | This head, six | This head, twelve | Bar 2 | Bar 3 |
|---|---|---|---|---|:-:|:-:|
| refuses six · 0.1 s | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | ✓ | ✓ |
| refuses six · 0.5 s | 8.0 s, 12 ✓, 28 refused | 14.0 s, 12 ✓, 40 refused | 8.0 s, 12 ✓, 28 refused | 8.0 s, 12 ✓, 28 refused | ✓ | ✓ |
| refuses six · 1 s | 21.0 s, 12 ✓, 20 refused | 26.0 s, 12 ✓, 39 refused | 122.0 s, **0 ✓, 12 Not checked** (rate limit), 489 refused | the same | ✓ | **✗** |
| refuses six · 2 s | 41.0 s, 12 ✓, 20 refused | 43.0 s, 12 ✓, 23 refused | 124.0 s, **0 ✓, 12 Not checked**, 249 refused | the same | ✓ | **✗** |
| very small · 0.1 s | 26.5 s, 12 ✓, 79 refused | 26.3 s, 12 ✓, 75 refused | 30.6 s, 12 ✓, 165 refused | the same | ✓ | **✗ (+4.1 s)** |
| very small · 0.5 s | 81.5 s, 12 ✓, 79 refused | 82.0 s, 12 ✓, 80 refused | 120.5 s, **0 ✓, 12 Not checked**, 246 refused | the same | ✓ | **✗** |
| very small · 1 s | 134.0 s, 12 ✓, 79 refused | 135.0 s, 12 ✓, 80 refused | 121.0 s, **0 ✓, 12 Not checked**, 126 refused | the same | ✓ | **✗** |
| very small · 2 s | 264.0 s, 12 ✓, 85 refused | 266.0 s, 12 ✓, 86 refused | 122.0 s, **0 ✓, 12 Not checked**, 66 refused | the same | ✓ | **✗** |

- **Bar 2 holds,** but only because six and twelve are the same on this head: in five cells both land nothing.
- **What the timeline shows** (refuses six, 1 s a reply, six):
  - Four requests go at 0 s, and two are refused with a stated wait of 1 s. From then on, every request is refused, each at its own stated second, to the 2-minute bound.
  - Each second the key refills four requests' room, and the four to six refused requests that come back then take it all, since a refusal takes room too. No request gets through again: 489 refusals, and all 12 sentences land Not checked for the rate limit at 122 s.
- **On the gated head,** the same key is survived. A request is retried twice by the AI SDK, then its check fails whole, the run pauses new checks and gives up a place, and the restarted checks come back spread out.
- **Measured, not built (the same harness, no paid request):**
  - **H: a place taken away below six for each limit, and new checks paused for the stated wait.** It doesn't help: the same 5 cells lose all 12 marks, since the checks already running keep sending. Across the 40 cells it also fails bar 3 in 10 (G: 3).
  - **I: a stated wait is waited inside the check at most twice; a third refusal goes to today's path** (the check fails whole, the run's pause, a place given up, the check restarted). Every mark lands in all 8 counting cells, and bar 3 fails in one (refuses six, 2 s: 47.0 s against 41.0 s). Across the 40 cells it fails bar 1 in 5 (G: 2) and bar 3 in 2 (G: 3).
- **What a miss here would mean:** this is the cell a place taken away below six would have been built on. H shows that a place taken away doesn't save the marks here; what does is fewer retries of a refused request (I).
