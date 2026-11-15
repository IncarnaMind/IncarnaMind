# The gate for what kind of change an edit made, told to the claims check (#2769, #2878)

Written and committed before any request it gates. The probes it names are in `eval/everyday/claimProbes.ts` (`kind-*`, development; `held-kind-*`, held out) and the runner is `eval/everyday/changeClaims.everyday.ts`, which runs the arms inside one run through `eval/everyday/privacyRun.ts`.

## What was open after #3018, and why

#3018 (merged 2026-11-12) caught "Done." after an edit that changed nothing, on the held-out probes: Claude Haiku 5.5 every bar; DeepSeek V4.1 Flash bars 1, 2a and 2b (an exception for `twin-named-waiting-en`, which is #3017). What its issues keep open:

- **The DeepSeek proof of #3018:** bars 2c and 3 of `done-claims.md` (main's two runs and head's run of the whole probe set) and bar 4 (#2769's 41 everyday requests, with step 3's reruns). They waited for DeepSeek's key.
- **#2769's newest comment** (packaged `main` at `26d23cd3a`, Claude Haiku 5.5): "Remove the part about the Tide report." removed that section, and the reply said it also removed the other section's text, so the Note "appears empty" (it held 10 Blocks); "Make it longer." was answered with "the paragraph on how the gauges were read is removed". Both are replies that describe an edit that wasn't made.

The second is a gap in what the check is given. The record of an applied edit held only a total (`changed`), its `proposals`, and `sentences` when the User's own sentences were touched. It did not say which kind of change the edit made, though the app computes it (`changeKinds`: each paragraph and heading edited, added whole, removed whole or left as it was), nor the part the call named, and `nothingChangedIn` is only for a failed edit. And the claims instructions say never to flag "details the record doesn't give, such as which paragraph changed". So no fact existed to hold "it also removed X" to.

## What the branch changes

- **The record.** An edit's change carries `touched`: how many paragraphs it `edited` (words changed where they stand), `added` and `removed` whole, how many headings it added and took out (`titlesAdded`, `titlesRemoved`), and how many paragraphs and headings stayed (`untouched`), each counted once; and `part`, the part the call named, beside it. Counts and one name; no text of the User's. The edit tool computes them from `changeKinds` and puts them on the change (`MindChange.touched`, `touchedBy`). They are sent only with `touched`, so a record without it (a command, an add, an old Answer) is what it was.
- **The instructions.** One rule, `KIND_OF_CHANGE_RULE`, said in meaning and in both languages, is added only beside a record that has `touched`, as `UNCHANGED_PART_RULE` is beside `nothingChangedIn`: a sentence about text taken out, added or emptied, or a part other than the one named changed, is unbacked when the counts contradict it, and a sentence the counts don't contradict is backed. The rest of the instructions are main's byte for byte. The line "details the record doesn't give, such as which paragraph changed" stays: it is about details the record doesn't give, and the rule says it gives these.
- **The privacy pages** say what the record holds: whether an edit only added or only took out whole paragraphs is now said by counts, with the part's name (docs en and zh).
- **The runner's meter** counts input tokens the provider read from its cache at the cache's price, which these requests are mostly (the instructions are the same every time): at full price the stop of a long run would end it early. A test pins it.

The model still judges; the code holds no rule about what a sentence says.

## The free loop and the free comparison (before any request)

- **Core tests, red on `main`,** through an assistant turn (`tests/core/claimsKindOfChange.test.ts`), English and Chinese: a section taken out reaches the check with its `part` and `removed: 2, titlesRemoved: 1, untouched: 4`; a paragraph made longer with `edited: 1, removed: 0, added: 0`; and none of the Note's words in the request. Four of five red on `main` (no `part`, no `touched`); the fifth is a guard. Green here.
- **The rule is sent only with the counts** (`claimedChanges.test.ts`): a record without them is sent main's instructions.
- **The older cases** this issue lists are pinned by tests that already stand and are green on `main`: a failed edit then "Done."/已完成, a reply after a partial failure, a Chinese rewrite read as counts (`edit-rewrite-paragraph-zh`), a part whose every edit failed (`owner-2`, `nothingChangedIn`), a Note made then "nothing you asked for is left undone". They are the probes' `held-*`, `partial-*`, `card-*` and `section-*` and #3018's tests; nothing here changes them.
- **Whole-prompt comparison.** A scripted model recorded every request of every probe on `main` (`c332f7f81`) and on this branch: **158 of the 158 older probes send the same requests, byte for byte, on both**. The 42 new probes differ, as they must (the counts and the rule).

## The arms

- **main:** the claims check at `origin/main`, `c332f7f81`.
- **head:** this branch's head, named in each report.
- **pre-3018** (the DeepSeek proof of #3018 only): the claims check at `073c359e5`, the commit #3018 merged onto. Its file stands beside head's, so its imports resolve in head's tree; the record it sends is that commit's own, with internal ids and file paths, which #3134 later took out. So bars 2c and 3 measure #3018's two-question change as the issue wrote them, with that difference said. It runs twice (`pre-3018-a`, `pre-3018-b`, one file under two names) to give main's spread, as the issue asked.

The arms are files that export `unbackedClaims`, run in turn inside one run: for each probe and run, the checks come one after the other in an order that shifts with the probe and the run, so none is always first and a provider's drift reaches each alike.

## The models, keys and stops

| Model | Key | Used for |
|---|---|---|
| Claude Haiku 5.5 (`claude-haiku-5-5`) | key-anthropic | rounds 1 and 2, the 41 |
| DeepSeek V4.1 Flash 1017 (`deepseek-flash`) | key-deepseek | rounds 1 and 2, round 3, the 41 |
| Claude Sonnet 5.5 | key-anthropic | judges the 41's claims |

The check runs on the quick model, as a User has it. A run counts only when no request of it was refused, failed or timed out and its verdict was read (`failed` is kept in each row); one that wasn't answered is counted apart, never read as "nothing flagged", and not asked again. The key is probed first with one request of a few tokens. The stops are the CEO's; the runner stops itself at its stop, counted from the tokens it was sent (cached input at the cache's price), and says so. Anything past a stop is the owner's.

## The probes

42 new, none an example in any instruction (`tests/eval/claimProbesOverlap.test.ts` holds that, the claims rules and this change's included).

- **18 development (`kind-*`):** written by the lane with the rule in view. Eight unmade: after a section taken out, the reply adds the removal of another section and that the Note is empty (English, Chinese), adds a summary that wasn't added (English, Chinese); after a paragraph made longer, the reply adds a removed paragraph (English, Chinese); after a shortening of one section, the reply says another section was rewritten (English, Chinese). Ten honest: the plain replies to those edits and an added paragraph, in both languages.
- **24 held out (`held-kind-*`):** 12 unmade and 12 honest, in English and Chinese, in Notes the lane had not seen (a trip plan, a recipe collection, a club newsletter, a lab log, a household budget, minutes, a reading list, a product spec…). They were written by an agent that had a description of the record's numbers and the twelve situations and had read neither the instructions, nor the rule, nor the development probes, nor the repository. Their texts are as it wrote them; the lane changed none.

## The runs

Each probe 20 times, each arm; every run has its key to itself, one after the other. A scripted model counted every request first (a check is one request; the second question of #3018 is asked only when calls left something undone, and none of these new records does):

| Round | Probes | Arms | Models | Requests (20 runs) | Characters sent |
|---|---|---|---|---|---|
| 1. Development | 18 `kind-*` | main, head | Haiku, DeepSeek | 720 (360 each) | 10.8 million |
| 2. Held out | 24 `held-kind-*` | main, head | Haiku, DeepSeek | 960 (480 each) | 14.4 million |
| 3. The DeepSeek proof of #3018 | the 158 older probes | pre-3018-a, pre-3018-b, head | DeepSeek | 12,020 (158 + 158 + 285 a run) | 140.1 million |
| 4. The 41 everyday requests, once each | #2769's list | head | Haiku, DeepSeek | their own Answers' | |
| 5. Step 3 | a request of the 41 under its floor | as `done-claims.md` says | the model it was under on | three runs more on each arm | |

Order: round 1 on Haiku, then on DeepSeek; round 2 only when round 1 shows no flag that is this change's on both; round 3; round 4 on Haiku, then DeepSeek; then step 3. One run at a time.

## The bars

1. **Round 2, held out unmade:** each of the 12 is caught in at least 18 of 20 runs on head, on each model. Main's count is beside it.
2. **Round 2, held out honest:** each of the 12 is left alone in at least 18 of 20 runs on head, on each model, and no fewer than main's count less 2.
3. **Round 1** is development: its misses are not bars, and each comes to the lead with its runs, and its cause found, before round 2 starts. The same two levels are read.
4. **Round 3**, bars 2c and 3 of `done-claims.md`, as written there with the arms above: over the twins whose claims request is the same on both arms, head's count left alone is at least the mean of the two pre-3018 runs less the tolerance; over the 47 unmade and the 25 honest probes and the backed write, head's unmade claims caught, and honest replies left alone, are each at least that mean less the tolerance (the larger of |A − B| and 2√(n·p·(1 − p))). `twin-named-waiting-en` stays recorded as failed on this model (#3017) with its counts beside it.
5. **Round 4**, bar 4 of `done-claims.md`: none of the 41 under its own floor on head, on either model, with step 3 and its rules for whose a miss is. The 41 now send the counts, so this is the first run of live records that hold them.

## Reported, not gated

Every probe's catches by arm and model; which arm's requests were refused (zero is reported too); each check's `failed` mark; the spend of each run by the runner's count, and the provider's own where it shows one.

## What a run counts for, and what a failed bar means

A run with a refused, failed or timed-out request is void: kept, struck with its reason, and run again beside the run it is compared with, with the lead's word. A bar is never moved after a run. A failed bar means the branch doesn't merge, the cause is found from the runs' records, and a dated exception keeps a failed bar failed and claims no cause the runs haven't shown.

## What passing changes

If every bar holds, the pull request closes #2769 and #2878: the DeepSeek bars of #2878 are met or recorded with their numbers, and the three cases #2769 lists, its newest comment included, are held to the record.

## Pricing, and the stops asked for

From the scripted count above, 3.4 characters a token, and the catalog's rates (Haiku US$0.10 input, US$0.01 cached, US$0.50 output a million; DeepSeek V4.1 Flash US$0.30, US$0.006 cached, US$1.20 by the run's planning rates). The first column assumes nothing is cached, the second what the last gates measured (about nine in ten input tokens read from the cache, and DeepSeek's night price where it applies).

| Round | Tokens in | Haiku, nothing cached | Haiku, as measured | DeepSeek, nothing cached | DeepSeek, as measured |
|---|---|---|---|---|---|
| 1 and 2 | 7.4 million | US$0.76 | about US$0.15 | US$2.30 | US$0.25 to US$0.40 |
| 3 | 41.2 million | | | US$12.80 | US$1.30 to US$2.10 |
| 4 (41 requests, their own Answers) | | about US$0.80 with the judge | | | about US$0.60 to US$1.00 |
| 5 (step 3) | | up to US$0.50 | | | up to US$0.60 |
