# A write's check on keys that refuse: the scripted cells

For #2532 (twelve sentence checks at once) and #2944 (a refused check request waits as long as the service says). Measured on 2026-11-12. No request is paid for: the model's replies are scripted, and the clock is the test's own.

## Decision, 2026-11-12

**Twelve at once is dropped, and a write's checked sentences stay six at a time (#2532).**

- **The rule was set before the runs:** a change that fails a bar doesn't ship, and a bar isn't moved after its result. Each of the three heads below fails at least one bar.
- **What it gives up is written down below:** where a key has room, twelve ends a median 2.9 s sooner than six.
- **Twelve can come back only as a new change with its bars written first.** It must never send more than a key takes at once before it knows the key's room, for example from what the service states in its replies. That sits with #2944.
- **#2944's stated wait is measured on these 48 cells.** It has one more bar, not for trade: on the key that counts refused requests, it lands every mark the path without it lands.

## How it runs

- **The harness** is `eval/speed/keyCells.speed.ts`, with `keyWrites` in `tests/helpers/writeChecked.ts` and the keys in `tests/helpers/scriptedKeys.ts`. Run it with `INCARNAMIND_EVAL_SPEED_KEY_CELLS=<file> npm run eval:speed -- eval/speed/keyCells.speed.ts`. It writes one JSON file.
- **It checks each write as the app does,** six at a time on a provider's service.
  - On `main` at d4bbae31e, its result is the gated head's six, request for request, in all 48 cells and both writes.
  - The heads below were each measured on their own tree, with the harness as it was then. That harness also ran each cell twelve at once, through a catalog fact `main` doesn't have.
- **A cell** is two writes, one after the other in one session. Each check request takes the cell's reply time. A request the key has no room for is refused the way a service refuses a rate limit: an HTTP 429 that the AI SDK may send again.
- **The AI SDK's own retries** wait on the test's clock too, so the numbers include them, as the app does. A check's Run is retried twice, after 2 s and 4 s, or after the stated wait when it is under 60 s.
- **The keys.** Each is pinned by `tests/eval/scriptedKeys.test.ts`.
  - **A bucket** of requests, refilled at its rate. Its refusal says, in whole seconds and at least 1, how long until a request fits, as Anthropic's `retry-after` does.
  - **So many at once.** Its refusal says nothing of how long.
  - **A counting bucket.** It is a bucket, except that a refused request takes room too. OpenAI's guide says, under "Retrying with exponential backoff": "unsuccessful requests contribute to your per-minute limit, so continuously resending a request won't work". The bucket goes below empty, and the refusal states, in whole seconds and at least 1, how long until one request fits again.
  - **A new account's published limits.** These are the lowest tier with published numbers. The first-tier numbers each service lists for a new account are not published, as the next bullet says.
    - **Anthropic, Start tier, Claude Haiku 5.5:** 4,000 requests, 2,000,000 input tokens and 400,000 output tokens a minute (platform.claude.com/docs/en/api/rate-limits).
      - The page also says new organizations "may start in the Evaluation tier, with limits below the standard limits shown on this page", and those limits aren't published.
      - Cached input tokens don't count. A request costs what the twelve gate's runs measured at the median: 934 uncached input tokens and 237 output. A write's first request costs 9,322 input tokens, since its prompt cache is written. The reply takes 1.461 s.
    - **OpenAI, Build tier, GPT-6.1 Sol.** Build is the lowest paid tier, after $5 of credit, and the page lists the model as "Astra, Sol, Terra".
      - The limits are 5,000 requests and 1,000,000 tokens a minute (developers.openai.com/api/docs/guides/rate-limits).
      - A request costs 6,389 tokens (6,316 in, 73 out). The reply takes 1.878 s.
    - **How much a bucket holds.** Either a minute of its limit, since the bucket is "continuously replenished up to your maximum limit", or a second of it, from Anthropic's own example of a limit enforced over a shorter interval.
      - The twelve gate's Haiku runs sent twelve requests of about 9,300 tokens at once on a key of 2,000,000 a minute, and met no limit.
      - So a second's bucket is the stricter reading of the two, not one we have seen.
- **The sizes:** "never" (no limit met), "fits six" (6), "refuses six" (4) and "very small" (1), each at 0.1, 0.5, 1 and 2 s a reply. A bucket holds that many requests and refills that many a reply's time. A so-many-at-once key lets that many out at a time.
- **A write of 30** checks its first 12 sentences, as `SENTENCES_CHECKED_AT_MOST` says. The other 18 land Not checked, "too many". So its rows send what the write of 12 sends.

## The bars, in every cell and both writes

They were written before the runs. The counting bucket was added later, also before its run, with bars 2 and 3 (49b41e0bd), and all four now apply to all 48 cells.

1. Twelve ends no more than 1.0 s after six, on the same key and head.
2. Twelve lands every mark six lands.
3. Six on the head is never later, and never lands fewer marks, than six on the gated head.
4. With no limit met, nothing moves: the same requests, as many at once, sent at the same times as on the gated head.

## The heads

The gated head and the stated wait are on the closed pull request #2955. The other two were built locally and not published.

- **The gated head,** 142eb8985: twelve at once as its gate passed it. Its result is `key-cells/gated-142eb8985.json`, and every bar is held against it.
- **The stated wait,** b70025ce2: a refused request waits the service's stated time inside its check (#2944). Its result is `key-cells/request-level-wait.json`.
- **Twelve on `main`'s handling of a refusal,** da00ee923. This is the gated head's check code with `main` merged at 26d23cd3a. Its result came out byte for byte the gated head's file, so it isn't saved twice.
- **The candidate,** b357a9e0d: twelve until the run's first refused request, then six. It is da00ee923 with the change in `key-cells/six-after-refusal-b357a9e0d.diff`. Its result is `key-cells/six-after-refusal-b357a9e0d.json`.

| Head | Bar 1 | Bar 2 | Bar 3 | Bar 4 |
|---|---|---|---|---|
| The stated wait | fails in 2 | holds, but only because six and twelve both land nothing in 5 counting cells | fails in 9 | holds |
| Twelve on `main`'s handling of a refusal | fails in 12 | fails in 1 | holds | holds |
| The candidate | fails in 1 | holds | holds | holds |

In each table, a row is the first write. The second write of a session came out the same as the first in every cell on every head, except five counting cells on the stated wait, named there. The bars are held on both writes. "Refused" counts the key's refusals.

## What twelve buys where the key has room

These are the 14 cells where no request was refused, at six or at twelve, in either write. They are the same on every head:

| Key · sentences · reply | Six | Twelve | Twelve sooner by |
|---|--:|--:|--:|
| bucket never · 12 · 0.1 s | 0.6 s | 0.4 s | 0.2 s |
| bucket never · 12 · 0.5 s | 3.0 s | 2.0 s | 1.0 s |
| bucket never · 12 · 1 s | 6.0 s | 4.0 s | 2.0 s |
| bucket never · 12 · 2 s | 12.0 s | 8.0 s | 4.0 s |
| at-once never · 12 · 0.1 s | 0.6 s | 0.4 s | 0.2 s |
| at-once never · 12 · 0.5 s | 3.0 s | 2.0 s | 1.0 s |
| at-once never · 12 · 1 s | 6.0 s | 4.0 s | 2.0 s |
| at-once never · 12 · 2 s | 12.0 s | 8.0 s | 4.0 s |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 12 · 1.461 s | 8.8 s | 5.8 s | 2.9 s |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 12 · 1.461 s | 8.8 s | 5.8 s | 2.9 s |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 30 · 1.461 s | 8.8 s | 5.8 s | 2.9 s |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 30 · 1.461 s | 8.8 s | 5.8 s | 2.9 s |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 12 · 1.878 s | 11.3 s | 7.5 s | 3.8 s |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 30 · 1.878 s | 11.3 s | 7.5 s | 3.8 s |

**Over those 14 cells,** twelve ends 2.9 s sooner than six at the median, and 33.6 s sooner in all.

## Twelve on `main`'s handling of a refusal (da00ee923): bar 1 fails in 12 cells and bar 2 in 1, the gated head's own

| Key · sentences · reply | Gated head, six | Gated head, twelve | Head, six | Head, twelve | 1 | 2 | 3 | 4 |
|---|---|---|---|---|:-:|:-:|:-:|:-:|
| bucket never · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket never · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket never · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket never · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| bucket fits six · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 1.3 s, 12 ✓, 6 refused | 0.6 s, 12 ✓, 0 refused | 1.3 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| bucket fits six · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 12 refused | 3.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 12 refused | ✓ | ✓ | ✓ | – |
| bucket fits six · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 24 refused | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 24 refused | ✓ | ✓ | ✓ | – |
| bucket fits six · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 17.0 s, 12 ✓, 39 refused | 12.0 s, 12 ✓, 0 refused | 17.0 s, 12 ✓, 39 refused | **+5.0 s** | ✓ | ✓ | – |
| bucket refuses six · 12 · 0.1 s | 1.3 s, 12 ✓, 2 refused | 1.3 s, 12 ✓, 2 refused | 1.3 s, 12 ✓, 2 refused | 1.3 s, 12 ✓, 2 refused | ✓ | ✓ | ✓ | – |
| bucket refuses six · 12 · 0.5 s | 5.0 s, 12 ✓, 8 refused | 5.0 s, 12 ✓, 14 refused | 5.0 s, 12 ✓, 8 refused | 5.0 s, 12 ✓, 14 refused | ✓ | ✓ | ✓ | – |
| bucket refuses six · 12 · 1 s | 9.0 s, 12 ✓, 14 refused | 11.0 s, 12 ✓, 34 refused | 9.0 s, 12 ✓, 14 refused | 11.0 s, 12 ✓, 34 refused | **+2.0 s** | ✓ | ✓ | – |
| bucket refuses six · 12 · 2 s | 18.0 s, 12 ✓, 30 refused | 24.0 s, 12 ✓, 36 refused | 18.0 s, 12 ✓, 30 refused | 24.0 s, 12 ✓, 36 refused | **+6.0 s** | ✓ | ✓ | – |
| bucket very small · 12 · 0.1 s | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | ✓ | ✓ | ✓ | – |
| bucket very small · 12 · 0.5 s | 19.0 s, 12 ✓, 57 refused | 22.5 s, 12 ✓, 54 refused | 19.0 s, 12 ✓, 57 refused | 22.5 s, 12 ✓, 54 refused | **+3.5 s** | ✓ | ✓ | – |
| bucket very small · 12 · 1 s | 36.0 s, 12 ✓, 84 refused | 58.0 s, 12 ✓, 77 refused | 36.0 s, 12 ✓, 84 refused | 58.0 s, 12 ✓, 77 refused | **+22.0 s** | ✓ | ✓ | – |
| bucket very small · 12 · 2 s | 72.0 s, 12 ✓, 84 refused | 80.0 s, 11 ✓, 1 Not checked (rate-limit), 71 refused | 72.0 s, 12 ✓, 84 refused | 80.0 s, 11 ✓, 1 Not checked (rate-limit), 71 refused | **+8.0 s** | **✗** | ✓ | – |
| at-once never · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | 0.6 s, 12 ✓, 0 refused | 0.4 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once never · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | 3.0 s, 12 ✓, 0 refused | 2.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once never · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 0 refused | 4.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once never · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 0 refused | 8.0 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| at-once fits six · 12 · 0.1 s | 0.6 s, 12 ✓, 0 refused | 2.3 s, 12 ✓, 6 refused | 0.6 s, 12 ✓, 0 refused | 2.3 s, 12 ✓, 6 refused | **+1.7 s** | ✓ | ✓ | – |
| at-once fits six · 12 · 0.5 s | 3.0 s, 12 ✓, 0 refused | 3.5 s, 12 ✓, 6 refused | 3.0 s, 12 ✓, 0 refused | 3.5 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| at-once fits six · 12 · 1 s | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 12 refused | 6.0 s, 12 ✓, 0 refused | 6.0 s, 12 ✓, 12 refused | ✓ | ✓ | ✓ | – |
| at-once fits six · 12 · 2 s | 12.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 24 refused | 12.0 s, 12 ✓, 0 refused | 12.0 s, 12 ✓, 24 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 0.1 s | 2.3 s, 12 ✓, 2 refused | 2.3 s, 12 ✓, 2 refused | 2.3 s, 12 ✓, 2 refused | 2.3 s, 12 ✓, 2 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 0.5 s | 5.0 s, 12 ✓, 4 refused | 5.5 s, 12 ✓, 6 refused | 5.0 s, 12 ✓, 4 refused | 5.5 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 1 s | 10.0 s, 12 ✓, 8 refused | 10.0 s, 12 ✓, 14 refused | 10.0 s, 12 ✓, 8 refused | 10.0 s, 12 ✓, 14 refused | ✓ | ✓ | ✓ | – |
| at-once refuses six · 12 · 2 s | 18.0 s, 12 ✓, 14 refused | 22.0 s, 12 ✓, 32 refused | 18.0 s, 12 ✓, 14 refused | 22.0 s, 12 ✓, 32 refused | **+4.0 s** | ✓ | ✓ | – |
| at-once very small · 12 · 0.1 s | 13.3 s, 12 ✓, 16 refused | 13.3 s, 12 ✓, 16 refused | 13.3 s, 12 ✓, 16 refused | 13.3 s, 12 ✓, 16 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 0.5 s | 21.0 s, 12 ✓, 25 refused | 19.5 s, 12 ✓, 28 refused | 21.0 s, 12 ✓, 25 refused | 19.5 s, 12 ✓, 28 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 1 s | 37.0 s, 12 ✓, 43 refused | 38.0 s, 12 ✓, 47 refused | 37.0 s, 12 ✓, 43 refused | 38.0 s, 12 ✓, 47 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 2 s | 73.0 s, 12 ✓, 70 refused | 72.0 s, 12 ✓, 71 refused | 73.0 s, 12 ✓, 70 refused | 72.0 s, 12 ✓, 71 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 0.1 s | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 0.5 s | 8.0 s, 12 ✓, 28 refused | 14.0 s, 12 ✓, 40 refused | 8.0 s, 12 ✓, 28 refused | 14.0 s, 12 ✓, 40 refused | **+6.0 s** | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 1 s | 21.0 s, 12 ✓, 20 refused | 26.0 s, 12 ✓, 39 refused | 21.0 s, 12 ✓, 20 refused | 26.0 s, 12 ✓, 39 refused | **+5.0 s** | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 2 s | 41.0 s, 12 ✓, 20 refused | 43.0 s, 12 ✓, 23 refused | 41.0 s, 12 ✓, 20 refused | 43.0 s, 12 ✓, 23 refused | **+2.0 s** | ✓ | ✓ | – |
| counting bucket very small · 12 · 0.1 s | 26.5 s, 12 ✓, 79 refused | 26.3 s, 12 ✓, 75 refused | 26.5 s, 12 ✓, 79 refused | 26.3 s, 12 ✓, 75 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 0.5 s | 81.5 s, 12 ✓, 79 refused | 82.0 s, 12 ✓, 80 refused | 81.5 s, 12 ✓, 79 refused | 82.0 s, 12 ✓, 80 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 1 s | 134.0 s, 12 ✓, 79 refused | 135.0 s, 12 ✓, 80 refused | 134.0 s, 12 ✓, 79 refused | 135.0 s, 12 ✓, 80 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 2 s | 264.0 s, 12 ✓, 85 refused | 266.0 s, 12 ✓, 86 refused | 264.0 s, 12 ✓, 85 refused | 266.0 s, 12 ✓, 86 refused | **+2.0 s** | ✓ | ✓ | – |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 12 · 1.878 s | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 12 · 1.878 s | 17.9 s, 12 ✓, 11 refused | 17.3 s, 12 ✓, 12 refused | 17.9 s, 12 ✓, 11 refused | 17.3 s, 12 ✓, 12 refused | ✓ | ✓ | ✓ | – |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 30 · 1.878 s | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 30 · 1.878 s | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | 17.3 s, 12 ✓, 18 Not checked (too-many), 12 refused | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | 17.3 s, 12 ✓, 18 Not checked (too-many), 12 refused | ✓ | ✓ | ✓ | – |

- **The head is the gated head, request for request.** In all 48 cells and both writes, at six and at twelve, it sent the same requests at the same times and landed the same marks. So every bar it fails, the gated head fails too.
- **Bar 2: the very small bucket, at 2 s a reply.** Six lands all 12 marks at 72.0 s. Twelve lands 11 and leaves the 6th sentence Not checked for the rate limit at 80.0 s, in both writes.
  - The 6th sentence's check sent 24 requests and got 3 through.
  - Its second request was refused at 48, 50 and 52 s, the AI SDK's two retries included. So the check failed whole, and the run tried it again after its pauses.
  - It was refused again until its tries ran out, the last at 68, 70 and 72 s.
- **Bar 1: twelve ends more than 1.0 s after six.** The same in both writes:

  | Cell | Six | Twelve | Later by |
  |---|--:|--:|--:|
  | bucket fits six · 2 s | 12.0 s | 17.0 s | 5.0 s |
  | bucket refuses six · 1 s | 9.0 s | 11.0 s | 2.0 s |
  | bucket refuses six · 2 s | 18.0 s | 24.0 s | 6.0 s |
  | bucket very small · 0.5 s | 19.0 s | 22.5 s | 3.5 s |
  | bucket very small · 1 s | 36.0 s | 58.0 s | 22.0 s |
  | bucket very small · 2 s | 72.0 s | 80.0 s | 8.0 s |
  | at-once fits six · 0.1 s | 0.6 s | 2.3 s | 1.7 s |
  | at-once refuses six · 2 s | 18.0 s | 22.0 s | 4.0 s |
  | counting bucket refuses six · 0.5 s | 8.0 s | 14.0 s | 6.0 s |
  | counting bucket refuses six · 1 s | 21.0 s | 26.0 s | 5.0 s |
  | counting bucket refuses six · 2 s | 41.0 s | 43.0 s | 2.0 s |
  | counting bucket very small · 2 s | 264.0 s | 266.0 s | 2.0 s |

## The candidate (b357a9e0d): bar 1 fails in 1 cell

- **What it changes:** twelve at once lasts only until the run's first refused request, the AI SDK's own retries included. From then on, the run is at most six wide for the rest of that run, and a later sentence still waiting its turn goes back to the run untried.
- **What it keeps:**
  - Below six, the run narrows as on `main`: one place fewer, and a pause, each time a check fails for the rate limit.
  - A write checked six at a time takes `main`'s path, unchanged.
- **The rule, set before its run:** if the candidate also failed a bar, twelve at once would be dropped.

| Key · sentences · reply | Gated head, six | Gated head, twelve | Candidate, six | Candidate, twelve | 1 | 2 | 3 | 4 |
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
| bucket very small · 12 · 0.1 s | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | 5.3 s, 12 ✓, 18 refused | ✓ | ✓ | ✓ | – |
| bucket very small · 12 · 0.5 s | 19.0 s, 12 ✓, 57 refused | 22.5 s, 12 ✓, 54 refused | 19.0 s, 12 ✓, 57 refused | 19.0 s, 12 ✓, 57 refused | ✓ | ✓ | ✓ | – |
| bucket very small · 12 · 1 s | 36.0 s, 12 ✓, 84 refused | 58.0 s, 12 ✓, 77 refused | 36.0 s, 12 ✓, 84 refused | 36.0 s, 12 ✓, 84 refused | ✓ | ✓ | ✓ | – |
| bucket very small · 12 · 2 s | 72.0 s, 12 ✓, 84 refused | 80.0 s, 11 ✓, 1 Not checked (rate-limit), 71 refused | 72.0 s, 12 ✓, 84 refused | 72.0 s, 12 ✓, 84 refused | ✓ | ✓ | ✓ | – |
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
| at-once very small · 12 · 0.5 s | 21.0 s, 12 ✓, 25 refused | 19.5 s, 12 ✓, 28 refused | 21.0 s, 12 ✓, 25 refused | 21.0 s, 12 ✓, 25 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 1 s | 37.0 s, 12 ✓, 43 refused | 38.0 s, 12 ✓, 47 refused | 37.0 s, 12 ✓, 43 refused | 37.0 s, 12 ✓, 43 refused | ✓ | ✓ | ✓ | – |
| at-once very small · 12 · 2 s | 73.0 s, 12 ✓, 70 refused | 72.0 s, 12 ✓, 71 refused | 73.0 s, 12 ✓, 70 refused | 73.0 s, 12 ✓, 70 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 0.1 s | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 0.5 s | 8.0 s, 12 ✓, 28 refused | 14.0 s, 12 ✓, 40 refused | 8.0 s, 12 ✓, 28 refused | 8.0 s, 12 ✓, 28 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 1 s | 21.0 s, 12 ✓, 20 refused | 26.0 s, 12 ✓, 39 refused | 21.0 s, 12 ✓, 20 refused | 21.0 s, 12 ✓, 20 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 2 s | 41.0 s, 12 ✓, 20 refused | 43.0 s, 12 ✓, 23 refused | 41.0 s, 12 ✓, 20 refused | 41.0 s, 12 ✓, 20 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 0.1 s | 26.5 s, 12 ✓, 79 refused | 26.3 s, 12 ✓, 75 refused | 26.5 s, 12 ✓, 79 refused | 26.5 s, 12 ✓, 79 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 0.5 s | 81.5 s, 12 ✓, 79 refused | 82.0 s, 12 ✓, 80 refused | 81.5 s, 12 ✓, 79 refused | 81.5 s, 12 ✓, 79 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 1 s | 134.0 s, 12 ✓, 79 refused | 135.0 s, 12 ✓, 80 refused | 134.0 s, 12 ✓, 79 refused | 134.0 s, 12 ✓, 79 refused | ✓ | ✓ | ✓ | – |
| counting bucket very small · 12 · 2 s | 264.0 s, 12 ✓, 85 refused | 266.0 s, 12 ✓, 86 refused | 264.0 s, 12 ✓, 85 refused | 264.0 s, 12 ✓, 85 refused | ✓ | ✓ | ✓ | – |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 12 · 1.878 s | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 12 · 1.878 s | 17.9 s, 12 ✓, 11 refused | 17.3 s, 12 ✓, 12 refused | 17.9 s, 12 ✓, 11 refused | 17.9 s, 12 ✓, 11 refused | ✓ | ✓ | ✓ | – |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 30 · 1.878 s | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 30 · 1.878 s | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | 17.3 s, 12 ✓, 18 Not checked (too-many), 12 refused | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | ✓ | ✓ | ✓ | – |

- **Bar 1 fails in 1 cell: the so-many-at-once key that fits six, at 0.1 s a reply.** Six ends at 0.6 s, twelve at 2.3 s (+1.7 s), as on the gated head, in both writes.
  - The first refusal comes only after all twelve have started. The other six start at 100 ms, as the first six's first replies come back, and take the six places the first six's next turns need.
  - Going six wide then can't take back the six already sent, and the AI SDK sends the refused turns again after 2 s. Twelve's timeline (ms, sentence:turn):

    | ms | Requests |
    |--:|---|
    | 0 | 1:0 … 6:0 |
    | 100 | 7:0 … 12:0 |
    | 100 | 1:1 … 6:1, refused |
    | 200 | 7:1 … 12:1 |
    | 300 | 7:2 … 12:2 |
    | 2100 | 1:1 … 6:1 |
    | 2200 | 1:2 … 6:2 (ends 2.3 s) |

- **Bars 2, 3 and 4 hold in all 48.**
  - In the 14 cells with no limit met, the candidate changes no request, at six or at twelve.
  - The 11 other cells where twelve on `main`'s handling failed bar 1 end at six's time, and the very small bucket at 2 s lands all 12 marks.
  - Where a request is refused (34 cells), twelve ends later than six in 3 cells, past the bar only in the one above. Those are so many at once fitting six, +1.7 s at 0.1 s and +0.5 s at 0.5 s, and the bucket fitting six, +0.7 s at 0.1 s.

## The stated wait (b70025ce2), for #2944

- **What it does.** A check request refused with a stated wait waits that long inside its check, never sooner, and goes again, for two minutes in all at most. A refusal with no stated wait is left to the AI SDK's retries and then the run's pauses, as before.
- **How the width comes back is not as before.** A check whose request met any limit counts toward no calm round.
- **It was accepted on 2026-11-12 with five cells failed.** It was withdrawn the same day, once the counting bucket ran.
- **Its code** is in 26208544f and b70025ce2, on #2955. It also moved Tags' reading of a stated wait into a shared module, and named the wait in the write's row ("Rate limit reached · resumes at {time}") for waits of 5 s or more.

| Key · sentences · reply | Gated head, six | Gated head, twelve | Stated wait, six | Stated wait, twelve | 1 | 2 | 3 | 4 |
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
| counting bucket refuses six · 12 · 0.1 s | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | 2.3 s, 12 ✓, 6 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 0.5 s | 8.0 s, 12 ✓, 28 refused | 14.0 s, 12 ✓, 40 refused | 8.0 s, 12 ✓, 28 refused | 8.0 s, 12 ✓, 28 refused | ✓ | ✓ | ✓ | – |
| counting bucket refuses six · 12 · 1 s | 21.0 s, 12 ✓, 20 refused | 26.0 s, 12 ✓, 39 refused | 122.0 s, 0 ✓, 12 Not checked (rate-limit), 489 refused | 122.0 s, 0 ✓, 12 Not checked (rate-limit), 489 refused | ✓ | ✓ | **+101.0 s** | – |
| counting bucket refuses six · 12 · 2 s | 41.0 s, 12 ✓, 20 refused | 43.0 s, 12 ✓, 23 refused | 124.0 s, 0 ✓, 12 Not checked (rate-limit), 249 refused | 124.0 s, 0 ✓, 12 Not checked (rate-limit), 249 refused | ✓ | ✓ | **+83.0 s** | – |
| counting bucket very small · 12 · 0.1 s | 26.5 s, 12 ✓, 79 refused | 26.3 s, 12 ✓, 75 refused | 30.6 s, 12 ✓, 165 refused | 30.6 s, 12 ✓, 165 refused | ✓ | ✓ | **+4.1 s** | – |
| counting bucket very small · 12 · 0.5 s | 81.5 s, 12 ✓, 79 refused | 82.0 s, 12 ✓, 80 refused | 120.5 s, 0 ✓, 12 Not checked (rate-limit), 246 refused | 120.5 s, 0 ✓, 12 Not checked (rate-limit), 246 refused | ✓ | ✓ | **+39.0 s** | – |
| counting bucket very small · 12 · 1 s | 134.0 s, 12 ✓, 79 refused | 135.0 s, 12 ✓, 80 refused | 121.0 s, 0 ✓, 12 Not checked (rate-limit), 126 refused | 121.0 s, 0 ✓, 12 Not checked (rate-limit), 126 refused | ✓ | ✓ | **✗** | – |
| counting bucket very small · 12 · 2 s | 264.0 s, 12 ✓, 85 refused | 266.0 s, 12 ✓, 86 refused | 122.0 s, 0 ✓, 12 Not checked (rate-limit), 66 refused | 122.0 s, 0 ✓, 12 Not checked (rate-limit), 66 refused | ✓ | ✓ | **✗** | – |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 12 · 1.461 s | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | 8.8 s, 12 ✓, 0 refused | 5.8 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a minute · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| Anthropic Start, Claude Haiku 5.5, bucket holds a second · 30 · 1.461 s | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 8.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | 5.8 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 12 · 1.878 s | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | 11.3 s, 12 ✓, 0 refused | 7.5 s, 12 ✓, 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 12 · 1.878 s | 17.9 s, 12 ✓, 11 refused | 17.3 s, 12 ✓, 12 refused | 16.9 s, 12 ✓, 19 refused | 16.9 s, 12 ✓, 19 refused | ✓ | ✓ | ✓ | – |
| OpenAI Build, GPT-6.1 Sol, bucket holds a minute · 30 · 1.878 s | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | 11.3 s, 12 ✓, 18 Not checked (too-many), 0 refused | 7.5 s, 12 ✓, 18 Not checked (too-many), 0 refused | ✓ | ✓ | ✓ | ✓ |
| OpenAI Build, GPT-6.1 Sol, bucket holds a second · 30 · 1.878 s | 17.9 s, 12 ✓, 18 Not checked (too-many), 11 refused | 17.3 s, 12 ✓, 18 Not checked (too-many), 12 refused | 16.9 s, 12 ✓, 18 Not checked (too-many), 19 refused | 16.9 s, 12 ✓, 18 Not checked (too-many), 19 refused | ✓ | ✓ | ✓ | – |

- **Bar 1 fails in 2 cells.**
  - **So many at once fitting six, at 0.1 s:** the same as on the gated head.
  - **The very small bucket, at 0.5 s:** six 18.0 s, twelve 19.5 s.
- **Bar 3 fails in 3 of the first 40 cells.**
  - **The very small bucket, at 0.1 s (+1.9 s).** The key has room for one request at each whole second, and the heads differ in which request gets it.
    - On the gated head, sentences 4 and 5 had failed whole after the AI SDK's two retries, and were waiting for the run's pause.
    - With the stated wait, they waited their stated second and went again, and took the room that sentences 9 and 12 then lost.
  - **The so-many-at-once key that takes one, at 0.5 s and 1 s (+1.5 s and +2.0 s).** Both heads drop to three places at 6 s.
    - The gated head gets a fourth place back after a calm round: at 10 s at 0.5 s a reply, and at 15 s at 1 s.
    - The stated wait stays at three to the end, since a check whose request met a limit, even one the AI SDK's own retry then got through, counts toward no calm round.
    - Every mark lands on both heads.
    - From where the heads first differ (ms, sentence:turn, the places allowed in brackets), at 0.5 s a reply the gated head ends at 21.0 s and the stated wait at 22.5 s:

    | Gated head | Stated wait |
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

    At 1 s a reply, the gated head ends at 37.0 s and the stated wait at 39.0 s:

    | Gated head | Stated wait |
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

- **Bar 3 fails in 6 of the 8 counting cells.** In 5 of them, the stated wait lands no mark at six or at twelve: all 12 sentences are Not checked for the rate limit at about 2 minutes.
  - Those five cells are counting bucket refuses six at 1 s and 2 s, and counting bucket very small at 0.5, 1 and 2 s. In them, the second write differs from the first, and both are counted.
  - **Why** (refuses six, 1 s a reply, six): four requests go at 0 s, and two are refused with a stated wait of 1 s. From then on, every request is refused, each at its own stated second, to the 2-minute bound. Each second the key refills four requests' room, and the four to six refused requests that come back then take it all. No request gets through again: 489 refusals.
  - **On the gated head, the same key is survived.** A request is retried twice by the AI SDK, then its check fails whole, the run pauses new checks and gives up a place, and the restarted checks come back spread out.
- **Two more variants were measured, and not built:**
  - **H: a place taken away below six for each limit, with new checks paused for the stated wait.**
    - It doesn't help: the same 5 cells lose all 12 marks, since the checks already running keep sending.
    - Across the first 40 cells, it also fails bar 3 in 10 (the stated wait: 3).
  - **I: a stated wait is waited inside the check at most twice.** A third refusal goes to today's path: the check fails whole, the run pauses, a place is given up, and the check restarts.
    - Every mark lands in all 8 counting cells, and bar 3 fails in one (refuses six, 2 s: 47.0 s against 41.0 s).
    - Across the first 40 cells, it fails bar 1 in 5 (the stated wait: 2) and bar 3 in 2 (the stated wait: 3).
- **The variants measured before it** (counts over the first 40 cells' first writes):

  | Variant | Bar 1 fails | Bar 2 fails | Bar 3 fails | Bar 4 fails | Not checked for the rate limit |
  |---|--:|--:|--:|--:|--:|
  | A: the design as first written. One run-wide pause every request waits on; steps of 1, 2, 4, 8 and 16 s for each request; one place fewer for each limit, counted once per burst | 5 | 0 | 16 | 0 | 14 |
  | B: each refused request waits only its own wait; the steps go on at 16 s until the 2-minute bound | 1 | 0 | 15 | 0 | 0 |
  | C: B, with steps of 1, 2, 4 and then 8 s, and a limit at or below six taking no place away | 1 | 0 | 12 | 0 | 0 |
  | D: C, with the run's pause for new checks taken away for a request's own refusal | 3 | 0 | 6 | 0 | 0 |
  | E: D, with steps of 1, 2 and then 4 s | 2 | 0 | 6 | 0 | 0 |
  | G (the stated wait above): a stated wait is waited inside the check; a refusal with none is left to the AI SDK's retries and then the run's pauses | 2 | 0 | 3 | 0 | 0 |

- **What the next design has to answer:** every request waiting on a stated time comes back at once, at the same second. Letting one request through first after a stated wait, or spreading the returns, are the kinds of answer to measure beside "at most twice, then today's path".
