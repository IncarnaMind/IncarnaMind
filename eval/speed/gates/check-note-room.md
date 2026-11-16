# The gate for Check this Note going twelve at once where the key states its room

Written and committed on 2026-11-15, before any run it gates (#2532).

## The step

Check this Note starts six sentences at once, as today. It goes to twelve once a reply from the AI service states that the key has room for the whole Note: at least 9 requests and 30,000 input tokens for each sentence it was asked to check, in Anthropic's `anthropic-ratelimit-*-remaining` headers. A service that states nothing (OpenRouter, a model on this computer) or too little stays at six. The first refused request takes the run back to six for good. The written check, an Answer's batches, Verify and the watch keep six.

This is the way back the key-cell gate left (`key-cells.md`): twelve "must never send more than a key takes at once before it knows the key's room, for example from what the service states in its replies".

## Part 1: scripted keys, nothing paid

`INCARNAMIND_EVAL_SPEED_ROOM_CELLS=<file> npm run eval:speed -- eval/speed/roomCells.speed.ts` checks a Note on each key three ways, two Notes one after the other in one session:

- **stating:** the key's replies state what is left of its minute, as Anthropic's do. A key enforced over a second still states its minute's, the worst case for a check that trusts it;
- **silent:** the same key stating nothing;
- **before:** the same key, stating, on the commit the change sits on, which reads no such header.

The cells are the ten key shapes of `key-cells.md` at 0.1, 0.5, 1 and 2 s a reply with a Note of 12 sentences, and the measured-size keys of #2944 (2,000,000, 500,000 and 50,000 input tokens a minute, 22,500 a sentence, a bucket holding a minute or a second) with Notes of 12 and 30. A so-many-at-once key states nothing: Anthropic limits by the minute, not by requests out at once.

A scripted reply's headers come as its request is sent; a service's come with the reply's first byte. So a scripted check widens sooner than a real one, which is the harder case for a key that refuses.

**The bars, in every cell and both Notes:**

1. **Silent:** the same requests at the same times as before.
2. **Stating, where the check stayed at six:** the same requests at the same times as before.
3. **Stating, where it went to twelve and nothing was refused:** it ends no later than before, lands every mark before lands, and sends the same requests (each sentence's same turns).
4. **Stating, where it went to twelve and a request was refused:** it ends no more than 1.0 s after before and lands every mark before lands. The cells are named, with how many requests were refused in each arm.
5. **On a key whose bucket holds a minute, going to twelve brings no refusal** that before doesn't have.

A bar that fails in a cell is reported with its cell. Twelve is not built on a failed bar.

### Run 1, 2026-11-15: bar 4 failed, and the step changed

The step as first built went to twelve at the first reply that stated room. Bars 1, 2, 3 and 5 held. Bar 4 failed on the keys that state a minute's room and take a second's: with 2,000,000 input tokens a minute held by the second, a Note of 12 ended 1.9 s after before (26 requests refused against 7) and a Note of 30 ended 8.8 s after (25 against 8). Every mark still landed. Such a key refuses the check's large requests, the ones carrying a search's results, already at six at once; at twelve it refused more of them, and each refusal costs the run a pause and a place.

**The change, before run 2:** the run goes to twelve only once the service has also answered six requests carrying a search's results. A key that refuses those at six has refused before it is sent any more, and the run stays at six. Sentences whose Passages come with them, with no search, never widen the run.

**One cell added, before run 2:** 6,000,000 input tokens a minute held by the second, which takes six large requests at once and not twelve. It is the key the change can't see coming.

The bars are unchanged.

### Run 2, 2026-11-15: every bar holds

56 cells, two Notes in each, on the changed step and on the commit before it (`check-note-room/run2-after.json`, `before.json`; run 1 is `run1-after.json`). The before arm was run twice and gave the same requests at the same times in every cell.

| Bar | Result |
|---|---|
| 1. Silent | holds in all 112 Notes |
| 2. Stating, stayed at six | holds: the same requests at the same times as before |
| 3. Went to twelve, nothing refused | holds in 17 Notes |
| 4. Went to twelve, a request refused | holds in 4 Notes, all on the added key |
| 5. No new refusal on a minute's bucket | holds |

Where it went to twelve (reply 1.46 s; the two Notes of a cell gave the same times):

| Key | Note | Before ends | After ends | Refused before | Refused after |
|---|---|---|---|---|---|
| 2,000,000 or 6,000,000 a minute, bucket holds a minute | 12 sentences | 8.8 s | 5.8 s | 0 | 0 |
| the same | 30 sentences | 21.9 s | 13.1 s | 0 | 0 |
| 500,000 a minute, bucket holds a minute | 12 sentences, the first Note (the second, with less of the minute left, stayed at six) | 8.8 s | 5.8 s | 0 | 0 |
| 6,000,000 a minute, bucket holds a second (the added key) | 12 sentences | 8.8 s | 6.8 s | 0 | 3 |
| the same | 30 sentences | 21.9 s | 20.0 s | 0 | 3 |
| a key that never refuses, 1 s a reply | 12 sentences | 6.0 s | 4.0 s | 0 | 0 |

Every mark before lands, after lands, in every cell.

- **The key that failed run 1** (2,000,000 a minute held by the second) now stays at six: the same requests at the same times as before.
- **The added key** is the one case where twelve brings refusals that six doesn't have: three requests refused, the run back at six from the first, and it still ends sooner than before (2.0 s and 1.9 s). A Note of 30 on it gains little.
- **Too little room stays at six:** 500,000 a minute with a Note of 30, and 50,000 a minute.
- Waiting for six large requests costs the first part of the gain: a Note of 12 ends at 5.8 s where widening at the first reply ended at 4.4 s.

## Part 2: real models, paired (stop US$3.50)

Claude Haiku 5.5 and Claude Sonnet 5.5 on a direct Anthropic key, the timing's `note` flow (10 sentences), English and Chinese, three rounds. Each round runs before and after for each model, the arms alternating in time (before, after, before, after), never one arm in a block. Before is the commit the change sits on; after is the change.

**What counts**

- A refused or failed request in the before arm voids that run: kept, struck, not run again without a word from whoever set the stop.
- A refused request in the after arm is what is measured. It is counted and reported: how often the check went back to six, and whether any sentence was left without a mark or Not checked for the rate limit.
- Whether a run went to twelve is read from its requests: more than six sentence checks out at once.
- Spend is counted at the catalog's price from each run's own report. The series stops before a run that could pass US$3.50.

**The bars, per model and language (four cells, medians of three)**

1. **The end:** after's median is sooner than before's.
2. **The first verdict:** after's median is no later than before's by more than before's own spread (its latest minus its soonest of three), and by no more than 1.0 s.
3. **No check lost:** in the after arm every sentence lands a mark, and none is Not checked for a rate limit.
4. **Wrong Supported:** over each model's six after runs, the sentences marked Supported that the set labels otherwise are no more than in its six before runs, plus the largest difference between two of the before rounds. The width changes no request, as Part 1's bar 3 shows; this bar is there to catch what that reasoning misses.

**Added after round 1, before round 2 (2026-11-16):** round 1 ran before first for each model, and its after runs read more of their input from the service's prompt cache (the before run a minute earlier had written it): 4 to 9 requests with nothing cached against 6 to 22. The arm that runs second starts warmer, which favours it. So round 2 runs after first, and round 3 before first as written. The bars and their medians are unchanged; round 2 is also reported by itself, as the round where the order favours before.

Reported beside the bars, not bars themselves: each arm's medians against the budget (first verdict under 5 s, done under 15 s), the Not checked marks that are the model's own, and the load.

### The paired runs, 2026-11-16: two bars fail as written

Twelve runs, US$1.93 at the catalog's price from the runs' own reports. One answered request to each model came first. No request was refused or failed in either arm, so no run is void and the check never had to go back to six. Before is the branch without the step (it differs from the change by the step's six files and runs the same timing code); after is the change at `b814c039e`. Every after run went past six at once (8 to 10 sentence checks out together).

Seconds from the User's action, each round, before / after:

| Model, language | | Round 1 | Round 2 (after ran first) | Round 3 | Median |
|---|---|---|---|---|---|
| Haiku 5.5, English | first verdict | 5.8 / 5.7 | 5.5 / 5.8 | 4.6 / 4.6 | 5.5 / 5.7 |
| | done | 16.0 / 13.0 | 13.2 / 12.4 | 12.5 / 11.8 | 13.2 / 12.4 |
| Haiku 5.5, Chinese | first verdict | 5.7 / 4.2 | 5.4 / 4.8 | 4.8 / 4.8 | 5.4 / 4.8 |
| | done | 15.1 / 11.9 | 15.2 / 10.6 | 16.0 / 11.0 | 15.2 / 11.0 |
| Sonnet 5.5, English | first verdict | 11.2 / 7.7 | 7.8 / 7.6 | 7.4 / 7.6 | 7.8 / 7.6 |
| | done | 25.3 / 16.3 | 17.6 / 19.8 | 19.9 / 18.6 | 19.9 / 18.6 |
| Sonnet 5.5, Chinese | first verdict | 7.0 / 7.8 | 7.0 / 9.5 | 7.2 / 7.2 | 7.0 / 7.8 |
| | done | 17.8 / 15.4 | 16.3 / 17.3 | 18.3 / 15.8 | 17.8 / 15.8 |

| Bar | Result |
|---|---|
| 1. The end | holds in all four cells |
| 2. The first verdict | holds in three; **fails for Sonnet in Chinese**: 0.8 s later at the median, where before's three runs lay within 0.2 s |
| 3. No check lost | holds: every sentence landed a mark in all 12 after runs, none Not checked for a rate limit |
| 4. Wrong Supported | holds for Sonnet (0 and 0); **fails for Haiku**: 1 in after's six runs, 0 in before's six, and so no allowance |

What the runs show of the two failures:

- **The wrong Supported** is one sentence in one Haiku run in Chinese. Its two requests carried the same input (7,922 and 9,611 tokens) as in two other runs where the sentence came back Unsupported. Haiku's mark changed between runs on six other sentences of that Note too, in both arms.
- **Sonnet's first verdict in Chinese:** the after runs' first requests were slower from the start, before the check went wider (about 2.0 s a request against 1.8 s, in two of the three). Three runs don't tell that apart from the service's own variation. English shows no difference.

Beside the bars:

- **Against the budget** (first verdict under 5 s, done under 15 s): the first verdict stays over it in both arms, Haiku at 4.8 to 5.7 s and Sonnet at 7.0 to 7.8 s. A sentence's check is three requests in a row on Sonnet, and going wider doesn't shorten that. Done comes under 15 s for Haiku in both languages; Sonnet stays over.
- **The order of the arms** counts for about as much as the change on Sonnet: where after ran first (round 2) it ended later than before in both languages, and where it ran second it ended sooner. Haiku's after ended sooner in every round.
- **Sonnet goes wider late**, at about 7 s: six requests carrying a search's results take that long to come back.
- **The Note has 10 sentences**, so only four more can start. The scripted cells show a longer Note (30 sentences: 21.9 to 13.1 s); no paid run was made at that size.
- **The model's own Not checked marks:** Haiku 4 in before's six runs and 3 in after's; Sonnet none.
- **Load** (the one-minute average in each run's report): 4.4 to 10.3 before, 3.6 to 10.8 after.

A failed bar is not passed by this page. Whether the step ships on these numbers is for whoever set the bars.
