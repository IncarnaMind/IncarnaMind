# A new account's key: a write's check before and after (#2944)

Measured on 2026-11-15, with the model's replies scripted and the clock the test's own: no request is paid for. **Before** is `main` at 9182cdc73; **after** is this change. Run with `INCARNAMIND_EVAL_SPEED_LIMIT_CELLS=<file> npm run eval:speed -- eval/speed/limitCells.speed.ts` and `INCARNAMIND_EVAL_SPEED_KEY_SHAPES=<file> npm run eval:speed -- eval/speed/keyShapes.speed.ts`; the results are in `new-account-limits/`.

## The limits, looked up when this was built

- **Anthropic, Start tier, Claude Haiku 5.5** (platform.claude.com/docs/en/api/rate-limits): 4,000 requests, 2,000,000 input tokens and 400,000 output tokens a minute. Only uncached input and cache writes count against the input limit; cache reads don't. The page says "New organizations and organizations with limited usage history may start in the Evaluation tier, with limits below the standard limits shown on this page", and publishes no numbers for it. So **no number is published for a brand-new account's key**; the lowest published are Start's.
- **OpenAI, Build tier** (developers.openai.com/api/docs/guides/rate-limits; $5 in credit purchases): 5,000 requests and 1,000,000 tokens a minute for "Astra, Sol, Terra". "Unsuccessful requests contribute to your per-minute limit, so continuously resending a request won't work." `Retry-After` is "the minimum number of seconds to wait".
- **Both** are bucket limits ("continuously replenished up to your maximum limit"), which "might be enforced as 1 request per second" over a shorter interval. The cells run both readings: the bucket holds **a minute** of the limit, or **a second** of it.

## What a check needs

From the 2026-11-14 measurement on #2944: a 24-sentence Note needed 540,000 to 720,000 input tokens that count, nine tenths of them search results. The cells use its least, **22,500 a sentence**, as three requests of 1,000, 13,500 and 8,000. They are on keys of **Anthropic Start's 2,000,000**, **500,000** (the key the measurement was made on) and **50,000** (a tenth of it, "about three sentences a minute"). The two published tiers also run with the cost the written check's gate measured for a request (`key-cells.md`). A request a bucket could never hold is refused outright with no wait stated, as a service says a request is too large for its limit.

A write of 30 sentences is checked whole on `main` now, so its 30 sentences are all in these cells.

## Before and after

| Key | Sentences | Before | After |
|---|--:|---|---|
| Anthropic Start, Claude Haiku 5.5 (published), request as the gate measured it, bucket holds a minute | 12 | 8.8 s, 12 checked, 36 sent, 0 refused | 8.8 s, 12 checked, 36 sent, 0 refused |
| Anthropic Start, Claude Haiku 5.5 (published), request as the gate measured it, bucket holds a second | 12 | 8.8 s, 12 checked, 36 sent, 0 refused | 8.8 s, 12 checked, 36 sent, 0 refused |
| Anthropic Start, Claude Haiku 5.5 (published), request as the gate measured it, bucket holds a minute | 30 | 21.9 s, 30 checked, 90 sent, 0 refused | 21.9 s, 30 checked, 90 sent, 0 refused |
| Anthropic Start, Claude Haiku 5.5 (published), request as the gate measured it, bucket holds a second | 30 | 21.9 s, 30 checked, 90 sent, 0 refused | 21.9 s, 30 checked, 90 sent, 0 refused |
| OpenAI Build, GPT-6.1 Sol (published), request as the gate measured it, bucket holds a minute | 12 | 11.3 s, 12 checked, 36 sent, 0 refused | 11.3 s, 12 checked, 36 sent, 0 refused |
| OpenAI Build, GPT-6.1 Sol (published), request as the gate measured it, bucket holds a second | 12 | 17.9 s, 12 checked, 36 sent, 11 refused | 17.9 s, 12 checked, 36 sent, 7 refused |
| OpenAI Build, GPT-6.1 Sol (published), request as the gate measured it, bucket holds a minute | 30 | 28.2 s, 30 checked, 90 sent, 0 refused | 28.2 s, 30 checked, 90 sent, 0 refused |
| OpenAI Build, GPT-6.1 Sol (published), request as the gate measured it, bucket holds a second | 30 | 45.1 s, 30 checked, 90 sent, 26 refused | 45.1 s, 30 checked, 90 sent, 15 refused |
| Anthropic Start's 2,000,000 input tokens a minute, 22,500 a sentence, bucket holds a minute | 12 | 8.8 s, 12 checked, 36 sent, 0 refused | 8.8 s, 12 checked, 36 sent, 0 refused |
| Anthropic Start's 2,000,000 input tokens a minute, 22,500 a sentence, bucket holds a second | 12 | 13.2 s, 12 checked, 37 sent, 8 refused | 14.1 s, 12 checked, 38 sent, 7 refused |
| Anthropic Start's 2,000,000 input tokens a minute, 22,500 a sentence, bucket holds a minute | 30 | 21.9 s, 30 checked, 90 sent, 0 refused | 21.9 s, 30 checked, 90 sent, 0 refused |
| Anthropic Start's 2,000,000 input tokens a minute, 22,500 a sentence, bucket holds a second | 30 | 26.4 s, 30 checked, 91 sent, 10 refused | 29.3 s, 30 checked, 92 sent, 11 refused |
| 500,000 (the 2026-11-14 measurement's key) input tokens a minute, 22,500 a sentence, bucket holds a minute | 12 | 8.8 s, 12 checked, 36 sent, 0 refused | 8.8 s, 12 checked, 36 sent, 0 refused |
| 500,000 (the 2026-11-14 measurement's key) input tokens a minute, 22,500 a sentence, bucket holds a second | 12 | 75.8 s, 0 checked, 12 Not checked (rate-limit), 11 sent, 33 refused | 75.8 s, 0 checked, 12 Not checked (rate-limit), 11 sent, 33 refused |
| 500,000 (the 2026-11-14 measurement's key) input tokens a minute, 22,500 a sentence, bucket holds a minute | 30 | 23.9 s, 30 checked, 90 sent, 3 refused | 26.8 s, 30 checked, 92 sent, 3 refused |
| 500,000 (the 2026-11-14 measurement's key) input tokens a minute, 22,500 a sentence, bucket holds a second | 30 | 75.8 s, 0 checked, 30 Not checked (rate-limit), 11 sent, 33 refused | 75.8 s, 0 checked, 30 Not checked (rate-limit), 11 sent, 33 refused |
| 50,000 (a tenth of it) input tokens a minute, 22,500 a sentence, bucket holds a minute | 12 | 310.7 s, 12 checked, 48 sent, 58 refused | 304.6 s, 12 checked, 43 sent, 33 refused |
| 50,000 (a tenth of it) input tokens a minute, 22,500 a sentence, bucket holds a second | 12 | 67.0 s, 0 checked, 12 Not checked (rate-limit), 0 sent, 33 refused | 67.0 s, 0 checked, 12 Not checked (rate-limit), 0 sent, 33 refused |
| 50,000 (a tenth of it) input tokens a minute, 22,500 a sentence, bucket holds a minute | 30 | 807.6 s, 30 checked, 111 sent, 129 refused | 790.5 s, 30 checked, 97 sent, 69 refused |
| 50,000 (a tenth of it) input tokens a minute, 22,500 a sentence, bucket holds a second | 30 | 67.0 s, 0 checked, 30 Not checked (rate-limit), 0 sent, 33 refused | 67.0 s, 0 checked, 30 Not checked (rate-limit), 0 sent, 33 refused |

## What it shows

- **At the published limits nothing is refused, so nothing changes**, in both writes: the same requests, in the same order, at the same times (`tests/core/checkPathIdentity.test.ts` pins it from what `main` sent). Where the stricter reading of the bucket refuses some (a second's worth), the check lands the same marks, up to 2.9 s later in three cells (one request more sent in two of them).
- **On the key a tenth of the measured one, every mark still lands,** and in the same time (12 sentences: 304.6 s against 310.7 s; 30: 790.5 s against 807.6 s), with **fewer requests sent** (43 against 48; 97 against 111) and **fewer refused** (33 against 58; 69 against 129). The saving is the whole sentence checks `main` sent again from their start when a request was refused. A check that waits tells its line, "Rate limit reached · resumes at {time}", of each wait of 5 seconds or more, and that it has ended: 45 times in the 12, 117 in the 30.
- **Where the key can never hold one request** (500,000 and 50,000 with a bucket of a second's worth) the check is Not checked for the rate limit, as it is on `main`, after the same refusals.

## The 2-minute bound: changed

No bar was written before the first run; the rule applied once it showed marks lost was that a change that lands fewer marks than `main` in any cell doesn't ship.

The issue's bound is "2 minutes in all for one request". Run that way, a request that went back to the key at each stated wait, again and again, **lost marks on a key that counts its refused requests**: in 5 of the 40 older cells below (`counting bucket refuses six`, 1 s and 2 s a reply: 4 and 2 of 12 checked against 12; `counting bucket very small`, 0.5, 1 and 2 s: none against 12), because every request that went back at its stated time was refused again and took room again, so the key never cleared. A longer-waiting variant (each refusal of one request waits 1.5 or 2 times the one before) kept those marks but lost them on the key a tenth of the measurement's (1.5 times: 11 of 12 and 13 of 30 checked; 2 times: 9 and 9). So **a request waits its stated time once**, up to two minutes, and:

- one refused again after its wait is thrown, marked not to be sent again by the AI SDK, and the run's pauses (1, 2, 4, 8 and 16 s, one place fewer at once) answer it as they answer any limit that holds on: the sentence's check goes again from its start;
- a stated wait of more than two minutes is not waited: the sentence is Not checked for the rate limit, and the ones after it aren't sent;
- a limit that doesn't say how long keeps today's steps.

## The 40 older cells

The ten key shapes of `tests/helpers/scriptedKeys.ts` at four reply times, a write of 12 sentences each (`key-shapes-*.json`): **no cell lands a mark fewer than `main`** (480 checked on `main`, 480 after), the cells' total time falls from 1010 s to 845 s, and refused requests from 875 to 578 (requests sent: 1486 to 1475). Later by more than a second in 2 cells: at-once very small at 500 ms, 21.0 s to 22.5 s; at-once very small at 1000 ms, 37.0 s to 39.0 s.

## Not shown here

- A real service's wait: these keys state the wait as Anthropic does, in whole seconds and at least 1.
- What a User sees of the line: `tests/renderer/rateLimitWaits.test.ts` and `tests/renderer/selfChecks.test.ts` hold the words in English and Chinese.
