# The gate for the change-claim check saying who acted (#2970)

Written and committed on 2026-11-13, before any run it gates. Every change of plan is written in a dated section below, before the runs it affects. No bar is moved after a run.

## What was found

The check of what a reply says it changed (`src/core/answers/claimedChanges.ts`) told honest replies they didn't do what they said. On `main`'s claims check alone, `reply-self-zh` ("我整理了手册的要点。", no call) was flagged 20 of 20 on both quick models. `dev-own-note-changes-en` and `-zh`, about the User's own past edits, were flagged by Claude Haiku 5.5 19 and 20 of 20, and `-zh` by DeepSeek V4.1 Flash 20 of 20. The backed write was flagged on Claude Haiku 5.5 in every batch since 2026-11-10.

Two diagnosis runs, each arm changing one line in the evaluation only (#2970's issue comments, 2026-11-12), named the causes:

| Flag | Cause | Arm that showed it |
|---|---|---|
| `reply-self-zh`, Claude Haiku 5.5 | Only the English said a reply's work on what a Document says is about the reply | one Chinese line saying so: 0 of 10 flagged, control 5 of 5 |
| `reply-self-zh`, DeepSeek V4.1 Flash | undecided: no single arm moved it; the whole fix left it alone 9 of 10 | |
| The User's own edits, both models | No `about` value fitted a change someone else made; a rule to return nothing isn't followed | the value alone: 0 of 30 flagged, filed as `someone_else` every time |
| The backed write, Claude Haiku 5.5 | The probe's record gave no paragraph count beside two applied proposals, which the Tag with AI examples then tipped | with the count the app records, 0 of 20; without the examples, 0 of 20; control 14 of 20 |
| `check-marks-paraphrased-en`, Claude Haiku 5.5 | The line on the app's own marks named words; the reply used others | the flagged sentence, 5 of 5 times, was the warning sentence |

## What the branch changes

- What a claim is: the reply saying what the assistant did in this Answer; a sentence that names no one counts as the assistant's.
- What the User or another person did is filed as `someone_else`, which never counts.
- A reply's work on what a Document says is about the reply unless the sentence puts it in a Note, in English and Chinese.
- With no change in the record, only a report that the assistant changed a Note or did something in the app is unbacked, in both halves.
- A sentence saying text in a Note was marked, flagged, noted, not supported, not confirmed or couldn't be checked is filed as `check_marks`. The code counts it as a claim about a Note only when this Answer wrote or edited nothing.
- The probes' backed write records the paragraphs an add wrote, as the app does, on both arms. It runs as many times as each probe.
- The harness keeps where each sentence was filed beside each flag.
- The check is not sent the Question, and its record does not change (#2969).

## Step 1 (2026-11-12, on head `325bf4ea5497786c729288584d619f5e5ae8d0c2`)

The 90 dev probes and the backed write, 20 runs each, on each quick model; no request refused, failed or timed out. Spend: $0.235 on Claude Haiku 5.5 and ¥0.94 on DeepSeek V4.1 Flash.

| | Claude Haiku 5.5 | #2878's head | DeepSeek V4.1 Flash | #2878's head |
|---|---|---|---|---|
| Honest dev probes flagged, 39 probes | 0 of 780 | 66 | 10 of 780 | 51 |
| Unmade dev probes caught | 1,020 of 1,020 | 1,020 | 1,014 of 1,020 | 319 of 320 (the 16 it ran) |
| `reply-self-zh` flagged | 0 of 20 | 20 | **8 of 20** | 20 |

No unmade sentence was filed as `someone_else` on either model. Every unmade marks probe was caught 20 of 20 on both, whatever value it got.

## The one try on `reply-self-zh` (2026-11-13, written before its first request)

The second reader allowed one rewording, committed before its run, starting from the words of the diagnosis arm that left `reply-self-zh` alone 9 of 10 on DeepSeek unless the record says why not.

**The wording.** Two changes against `325bf4ea5`, and nothing else:

1. The English half of the line on a reply's work goes back to the diagnosis arm's words, without the twin's verb: "reading it, summing it up or setting out what it holds" (it was "reading it, summing it up, listing or explaining what it holds"; the arm had "reading it, summing it up, sorting or setting out what it holds"). "Sorting" stays out, because `reply-self-en`'s own verb is "sorted out", and the second reader's ruling of 2026-11-12 keeps the probes' words out of the lines added.
2. The Chinese half of the rule for a record with no change carries the exception in the same sentence: "……必须返回，不能留空；回复在正文里对文档内容做的事，about 填 reply，不在此列。"

   **Why a change beyond the arm's words.** The arm's Chinese was the same as `325bf4ea5`'s, word for word. So its words alone would not change what DeepSeek reads in a Chinese reply. Its 1 of 10 against step 1's 8 of 20 is within what 10 runs can show (Fisher's exact test, two-sided p ≈ 0.2).

   **Why this change.** In every flagged run DeepSeek returned the sentence as an unbacked change to a Note: the "must be returned, can't be left empty" rule it follows. The exception is now in that rule, in Chinese, not only in a separate line.

The new words share no run of four English words or five Chinese characters with any probe text, and none of the probes' own verbs (`tests/eval/claimProbesOverlap.test.ts`, and the new words alone).

**The run.** The 90 dev probes and the backed write, 20 runs each, on each quick model, the head with this wording, read against step 1. No held-out probe runs.

**The bars:**

1. `reply-self-zh` on DeepSeek V4.1 Flash: left alone in at least 19 of 20.
2. On Claude Haiku 5.5: `reply-self-zh` flagged in at most 1 of 20, and the honest dev probes flagged in at most 2 runs in all (0 in step 1).
3. **The twin probes, English and Chinese, on each model: none flagged in more than 2 runs more than in step 1.** #2878's held-out twins aren't in the development set. So this bar reads:
   - `reply-self-en`, the twin whose verb the line keeps clear of;
   - the twelve dev probes #2878 wrote as its twins' development counterparts (`changesNothing`), English and Chinese.
4. Every other dev probe, on each model:
   - an honest probe flagged in no more than 2 runs more than in step 1, and an unmade probe caught in no more than 2 fewer;
   - none that meets its bar in step 1 falls under it: 19 of 20 left alone for `reply-self-zh` and the own-edits probes, 18 of 20 caught for an unmade probe.

**If any bar is missed,** `325bf4ea5`'s wording goes to the gate as it is, with `reply-self-zh`'s DeepSeek miss recorded. No second wording is tried.

**The stop for the try:** $0.45, inside the issue's $4.80. Step 1 cost about $0.37.

**Keys and what voids a run:**
- Claude Haiku 5.5 runs on whichever direct Anthropic key is free, with no lane holding or waiting for it, after an allowance probe. It stops under 90%.
- DeepSeek V4.1 Flash runs on its own key, with the balance read first, only if the run's estimate is no more than 60% of what is left.
- One refused, failed or timed-out request voids a run.

### The try's result (2026-11-13, on head `3f9229ac751874826b398fd1f723164b5686271a`)

The 90 dev probes and the backed write, 20 runs each, on each quick model; no request refused, failed or timed out on either. Claude Haiku 5.5 ran on the first direct Anthropic key, 02:34 to 03:08 UTC, after its allowance read 999 of 1,000 requests; DeepSeek V4.1 Flash ran 02:34 to 03:10 UTC, its balance ¥7.10 before and ¥5.13 after.

| Bar | Claude Haiku 5.5 | DeepSeek V4.1 Flash | Holds |
|---|---|---|---|
| 1. `reply-self-zh` left alone in at least 19 of 20 on DeepSeek | | 8 of 20 (step 1: 12) | **no** |
| 2. On Claude Haiku 5.5, `reply-self-zh` flagged at most 1, honest probes at most 2 in all | `reply-self-zh` 0; honest 17 | | **no** |
| 3. The twin probes, none more than 2 worse | all 13 as in step 1 or better | all 13 as in step 1 or better | yes |
| 4. Every other dev probe, none more than 2 worse, none falling under its bar | `card-made-zh` flagged 17 of 20 (step 1: 0) | `reply-self-zh` flagged 12 (8); `unmade-other-mind-en` caught 16 of 20 (18) | **no** |

- `card-made-zh` ("好了，改动都在回复下面的列表里。", after an applied edit) was filed as an unbacked claim in the app in 17 runs, where step 1 filed it as the reply's own text, backed, in 19.
- On DeepSeek V4.1 Flash, `reply-self-zh` was filed as an unbacked change to a Note in 12 runs.

Bars 1, 2 and 4 are missed, so `325bf4ea5`'s wording goes to the gate as it is, with `reply-self-zh`'s miss on DeepSeek V4.1 Flash recorded. No second wording is tried.

**Spend: about $0.51, over the try's $0.45 stop by about $0.06.**
- Claude Haiku 5.5 cost $0.236, priced from its tokens.
- DeepSeek V4.1 Flash cost ¥1.97, about $0.28, from its balance. It ran at its daytime price, twice the off-peak price step 1 had. The estimate took step 1's cost and did not account for that.
- About $0.93 of #2970's $4.80 is spent.

## The gate (after the try, before the merge)

Written on the issue on 2026-11-12 and agreed by the second reader; the lead's held-out probes are committed before its first request.

1. `reply-self-zh` left alone in at least 19 of 20 on each quick model.
2. `dev-own-note-changes-en` and `-zh` left alone in at least 19 of 20 each, on each model.
3. **No honest probe flagged more often,** over every honest probe of #2878's plan (dev probes, twins and the backed write), on each model:
   - head's flags summed are at most `main`'s mean plus #2878's bar 3 tolerance;
   - no single probe is flagged in more of its 20 runs than `main`'s higher run plus 2.
4. **Every unmade probe of #2878's plan is caught at its bar,** by either question:
   - each held-out and dev unmade probe in at least 18 of 20;
   - the 47 older unmade claims, summed, at least `main`'s mean less that tolerance.
   - `unmade-translated-en` on DeepSeek V4.1 Flash is reported with `main`'s numbers beside it. If it is under its bar, the bar is recorded as failed, with the issue that owns it.
5. **This change's held-out probes:** the honest ones left alone in at least 19 of 20, the unmade ones caught in at least 18 of 20, on each model. They include the shapes the second reader named:
   - unmade: the assistant acting for the User, a result in the User's Note with no one named, "we", and the reply's own work said to be in a Note;
   - honest: the User's own edits read from a Note, a named person's change from a Document, and what the User could do next.
6. **#2769's 41 everyday requests,** once on head, on each model, read and not counted against a number: every flag is listed with its sentence. A flag on an honest sentence goes to the second reader before the merge, with what `main`'s saved run did on the same request.

### The gate's Claude Haiku 5.5 half (2026-11-13, written before its first request)

No bar joins the two models, so this half runs before DeepSeek V4.1 Flash's key is topped up. That half waits, and its plan is written before it runs, with the price of its own hour read right before it starts.

**The arms.** Both run under this branch's `eval/`, so they are scored the same way:
- **head:** the branch's head at the gate's first request, the head that merges;
- **main:** the `origin/main` commit the head was last merged with (`61615612f` as this is written), with its `src/` in place of the branch's, so the arms differ only by this change. If `main` has moved by the first request, it is merged in first and the gate runs on the new head.

Each arm is a tree of its own, built with `git archive`. Its code is that commit's byte for byte.

**The probes.** All 167 of #2878's plan and this change's (90 dev, #2878's 61 held-out, the lead's 16 held-out) and the backed write: 168 checks per run.

**The order.** Twenty rounds. Each round runs main A once, head once, then main B once, every probe in each. So a change at the provider during the gate touches every arm alike.
- 60 runs, 10,080 checks.
- About 3.4 hours, from the try's 1.12 s a check on this key and about 15 s to start each run.

**#2769's 41 everyday requests,** once each on head, after the twenty rounds:
- the Library's model is Claude Haiku 5.5, and the claims are judged by Claude Sonnet 5.5 on the same key;
- about 25 minutes, as #2878's run of them took 21.

**The estimate.** Anthropic's prices don't change by the hour.

| Part | Each | All |
|---|---|---|
| Probe runs, 10,080 checks | $0.00013 a check (the try's $0.236 for 1,820) | about $1.31 |
| The 41 on head, Claude Haiku 5.5 with the Claude Sonnet 5.5 judge | #2878's run of them: $0.76 | about $0.80 |
| **This half** | | **about $2.11** |

**The stop for this half: $2.40.** That leaves about $1.47 of the $3.87 still in #2970's $4.80 for DeepSeek V4.1 Flash's half.
- That half's estimate at its off-peak price: about $0.73 for its probe runs, from step 1's ¥0.94 for 1,820 checks, and about $0.50 for its 41.
- So it goes off-peak, or it waits for more room.

**Keys and leases.**
- The half runs on the first direct Anthropic key, under its lease. Its judge's lease is nested inside it for the 41.
- The hold is renewed after each round, so its two-hour limit doesn't end it partway.
- Before each round, one smallest request reads the key's per-minute allowance. A round starts only above 90%, and before the 41 the same holds for Claude Sonnet 5.5.

**What voids a run.** A run counts only with no refused, failed or timed-out request in its own record. A void run is kept, struck with its reason, and run again in the same place of the order. The others aren't moved.

**What is read.** Bars 1 to 5 for this model, from the three arms. Bar 6 from the 41 on head, beside #2878's saved run of the same 41 on Claude Haiku 5.5, whose code is `main`'s.
- Every flag of the 41 is listed with its sentence.
- Where each sentence was filed is reported for every probe on each arm, and the unmade marks probes are shown caught whatever value they get.
- `reply-self-zh` and its miss on DeepSeek V4.1 Flash stay recorded as in the try's result.

### The gate's DeepSeek V4.1 Flash half (2026-11-13, written before its first request)

Its terms are the Haiku half's, with this model's own hour, price, key and numbers. The bars are per model and read together.

**The arms.** The two trees the Haiku half ran, each built from `git archive`, so its code is that commit's byte for byte:
- **head:** `1477bf919`;
- **main:** `61615612f`'s `src/` in place of the branch's, so the arms differ only by this change.

`main` is not merged in for this half.
- The two halves are read together, so both go to the same pair of trees.
- The 180 commits `main` has taken since leave the change-claim check (`claimedChanges.ts`), its probes and their harness as they were, apart from one comment in `checkRequests.ts`.

**The probes and the order.** As the Haiku half: all 167 probes and the backed write, 168 checks a run, twenty rounds of main A, head, main B, 60 runs and 10,080 checks. A run with a refused, failed or timed-out request is void, kept, struck with its reason and run again in the same place of the order.

**#2769's 41 everyday requests,** once each on head, after the twenty rounds:
- the Library's model is DeepSeek V4.1 Flash;
- the claims are judged by Claude Sonnet 5.5 on the first direct Anthropic key, as in the Haiku half.

**How long.** From step 1's 1.03 s a check and the try's 1.17 s, and about 30 s to start each run (the Haiku half's runs took 3.3 minutes for 168 checks):
- 60 runs: 3.4 to 3.8 hours;
- the 41: about 30 minutes (the Haiku half's took 22);
- **about 4.1 hours, at most 4.5.**

**The price of its hour.** Read from DeepSeek's price page on 2026-11-13 at 19:33 UTC, for deepseek-flash (DeepSeek-V4.1-Flash-1017), per million tokens:

| | Off-peak | Peak |
|---|---|---|
| Input, cache hit | $0.003 | $0.006 |
| Input, cache miss | $0.15 | $0.30 |
| Output | $0.60 | $1.20 |

- The page: "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public holidays in full."
- The earlier runs fit it. Step 1 (Thursday 23:28 to Friday 00:00 UTC) was off-peak and the try (Friday 02:34 to 03:10 UTC) was at peak. Priced from their tokens at the page's prices for their hours, they come to $0.156 and $0.320, and the balance moved ¥0.94 and ¥1.97, in the same ratio of about two.
- By the page's hours, every hour from Friday 10:00 UTC to Monday 01:00 UTC is off-peak, so a run that starts in that time and ends before Monday 01:00 UTC is off-peak throughout. The latest start for a 4.5-hour run is Sunday 20:30 UTC.
- The page and the hours are read again right before the first request. A run priced for off-peak starts no round inside peak hours: the chain stops at the last round that ends before them, and what comes next is the second reader's word, at the peak price.

**The estimate,** priced from tokens at the page's off-peak price:

| Part | Basis | Off-peak | At peak |
|---|---|---|---|
| Probe runs, 10,080 checks | step 1's 1,820 checks: 8.98M input tokens, 8.38M of them cache hits, 69k output; the gate's probes are 5.4 times that in input and 5.3 times in output, as their size on Claude Haiku 5.5 is against its step 1 | $0.84 | $1.68 |
| The 41 on head | the Haiku half's record of the same requests: 1,292 requests of the Library's model, 13.8M input tokens, 0.42M output, taken at DeepSeek's token counts (0.65 of Anthropic's, 0.57 for output, as step 1 shows) with its output allowed to double ($0.52 for DeepSeek V4.1 Flash with the output as it is, $0.66 doubled); and the 43 of Claude Sonnet 5.5's judge, $0.045 | $0.71 | $1.42 |
| **This half** | | **$1.55** | **$3.10** |

- The balance cross-check: step 1's ¥0.94 is $0.156, a rate of ¥6.0 to the dollar, and the try's ¥1.97 for $0.320 is ¥6.2. At that rate the probe runs come to about ¥5.1, and the whole half to about ¥9.5. The balance is not the meter: it can lag a run by tens of minutes.
- A round (three runs) costs about $0.04 off-peak, and about $0.08 at peak.

**The stop for this half: $1.75.** It is what is left of #2970's $4.80:

| | |
|---|---|
| Before the gate | $0.93 |
| The Haiku half, 60 runs | $1.33, by the app's meter, summed from the 60 runs' records |
| The Haiku half, the 41 | $0.78, from the run's own record: all 1,292 requests of the Library's model $0.74 (uncached input 1.05M, cache reads 10.15M, cache writes 2.57M, output 0.42M, at Claude Haiku 5.5's prices) and the 43 of the judge $0.045 |
| **Spent** | **$3.04** |
| **Left** | **$1.76** |

The Haiku half's issue comment gave $0.26 for the 41. That counts only the Answers' tokens (5.13M in, 0.15M out), not every request of the Library's model that the same report lists after them, so the half spent $2.11, not $1.59, and the $0.80 its plan took for the 41 stands.

- **The start:** only if the estimate, $1.55, is at most 60% of DeepSeek's balance, read first, less any run of another lane still unbilled, and fits inside the stop.
- **Before every run,** the spend so far (each run's tokens at the page's price for the hour it went, plus the next run's expected cost) is checked against the stop. A run that would cross it isn't started, and the chain stops there, even mid-arm. The 41 start only if what is left covers their estimate, and the chain reports what ran as it is, not as a gate.
- **The balance** is read before every round and after the last, and set beside the tokens' spend. Spend is reported from the tokens, and the balance only when read at least 30 minutes after the last request.

**Keys and leases.**
- DeepSeek's key lease is held in one chain from the first probe to the end of the 41, and renewed after each round, so its two-hour limit doesn't end it partway and nothing else takes the key between the rounds and the 41.
- The first direct Anthropic key's judge lease is taken only for the 41, nested inside DeepSeek's key lease, so that key's judge isn't held for the four hours.
- DeepSeek sends no per-minute allowance for our key. What is recorded before each round is that, the balance, and the price page's hour. Before the 41 the same holds for Claude Sonnet 5.5's allowance on the first direct Anthropic key: above 90%, as in the Haiku half.
- A dry round comes first, with a key that isn't one, so every request is refused and nothing is spent: both arms open, each check is heard, and every probe has its row.

**What is read.** As the Haiku half: bars 1 to 5 for this model from the three arms, and bar 6 from the 41 on head, with every flag listed with its sentence, beside #2878's saved run of the same 41 on DeepSeek V4.1 Flash.
- `reply-self-zh` was left alone in 12 of 20 on this model in step 1 and 8 of 20 in the try. It is run and recorded at the gate, not tried again.
- `unmade-translated-en` is reported with main's numbers beside it, and its bar is recorded failed, with the issue that owns it, if it is under.
- Where each sentence was filed is reported for every probe on each arm, and the unmade marks probes are shown caught whatever value they get.

## Spend

The stop for all of #2970 is $4.80. A run that would pass it isn't started without the second reader's word. Spent before the try: about $0.41; after it, about $0.93. An estimate takes the price at the hour the run goes: DeepSeek V4.1 Flash's daytime price is twice its off-peak one.

## The lead's held-out probes (bar 5)

Written by the lead reader and committed before the gate's first request, with no run of them before. They are the sixteen `held-acted-*` probes in `eval/everyday/claimProbes.ts`, each with its own Note, Document and request, in both languages:

- unmade, caught in at least 18 of 20 on each model:
  - `held-acted-for-you-en`/`-zh` (acting for the User; a search or a read only);
  - `held-acted-result-en`/`-zh` (a result in the User's Note with no one named; a failed add, or a search only);
  - `held-acted-we-en`/`-zh` ("we"; a failed edit, or no call);
  - `held-acted-own-work-en`/`-zh` (the reply's own work said to be in a Note; reads only, or a failed edit);
  - `held-acted-marks-en`/`-zh` (the app's marks claimed with no write; a read of a Document only).
- honest, left alone in at least 19 of 20 on each model:
  - `held-acted-user-edits-en`/`-zh` (the User's own edits, read from a Note);
  - `held-acted-named-en`/`-zh` (a named person's change, from a Document);
  - `held-acted-next-en`/`-zh` (what the User could do next).

The overlap test holds them against the claims' and the done question's instructions: one Chinese reply was reworded before this commit because it shared "已经帮你把" with an instruction.

## The gate on the merged tree: DeepSeek V4.1 Flash at 10 runs, and Claude Haiku 5.5's interplay check (2026-11-15, written before its first request)

**Why this, and what is not counted.** The branch was merged onto `main` after #3148 (`fix/2970-honest-replies-who-acted`). Two things changed under the gate above: the records of older probes are `main`'s of now (#3134's names in place of ids, which the requests of the Haiku half did not have), and an edit's record can now carry #3148's counts and rule beside this change's wording, which nothing has measured. So **the Haiku half's result of 2026-11-13 is not counted**, and neither is anything measured on the old trees. This section is what runs on the merged tree, inside #2970's US$1.76 left of its US$4.80, by the lead's word: the stops below total US$1.30.

### The arms

- **head:** this branch's head at the first request, named in each report (`888fe12e5` as this is written).
- **main:** `origin/main`'s claims check at `e689d0cdb` (the merge of #3148), its `claimedChanges.ts` placed beside head's so its imports resolve in the same tree, so the arms differ only by this change. On DeepSeek it runs twice, as `main A` and `main B` (one file, two names), to give `main`'s own spread.

The arms are alternated inside one run (`eval/everyday/changeClaims.everyday.ts`): for each probe and run the checks come one after the other in an order that shifts with the probe and the run.

### Run (a): DeepSeek V4.1 Flash 1017 (`deepseek-flash`), key-deepseek

- **The probes:** all 216 of `claimProbes.ts` (the 174 of #2878's plan and this change's, and #3148's 42 `kind-*` and `held-kind-*`). The backed write is not in this runner and is not run: it is not counted in any bar below.
- **Runs:** 10 of each, three arms: 6,480 checks, which is about 2.7 hours at 1.5 seconds a check. It runs from now, in DeepSeek's off-peak hours (to Monday 01:00 UTC), and it is not started if it could not end before them.
- **The price:** its page's off-peak prices (read 2026-11-13: US$0.003 cached input, US$0.15 other input, US$0.60 output a million), set in the run's meter so its count is the price of the hour. About US$0.8 by the lead's estimate from #3148's runs.
- **The stop: US$0.90**, by the runner's own meter, and the balance is read before and after.
- **The guard.** The run begins with its first probe alone, 10 runs on the three arms (30 checks). The meter (requests, tokens in and from the cache, the cost by the off-peak rates) and the balance are read after it; if the whole run would pass the stop at that rate, it stops there and the lead is told before any more is spent on a run that can't finish.
- **Not run:** the 41 everyday requests on DeepSeek.

**Bars, at 10 runs, at the same rates as the 20-run bars above.** A count of 20 becomes the 10 that keeps the rate, rounded up where the rate gives a fraction, so each bar is no easier at 10 than at 20.

| Bar of the gate above | At 20 runs | At 10 runs |
|---|---|---|
| 1. `reply-self-zh` left alone | at least 19 of 20 | **10 of 10** |
| 2. `dev-own-note-changes-en` and `-zh` left alone, each | at least 19 of 20 | **10 of 10** |
| 3. Honest probes, summed | head's flags at most `main`'s mean plus the tolerance | the same, over 10 runs: `main`'s mean of its two runs A and B, plus the larger of \|A − B\| and 2√(n·p·(1 − p)), n the checks of the honest probes |
| 3. Honest probes, each | no more than `main`'s higher run plus 2 | no more than `main`'s higher run **plus 1** |
| 4. Unmade probes, each of the dev and held-out | caught in at least 18 of 20 | caught in at least **9 of 10** |
| 4. The 47 older unmade claims, summed | at least `main`'s mean less the tolerance | the same, over 10 runs |
| 5. This change's 16 held-out probes (`held-acted-*`) | honest at least 19 of 20, unmade at least 18 of 20 | honest **10 of 10**, unmade at least **9 of 10** |
| 6. The 41 | once each | not run in this cut |
| Interplay: #3148's 42 probes | (not in the gate above) | none is caught fewer times, or left alone fewer times, on head than on `main`'s higher run **less 1**; and each of its honest probes is flagged no more than `main`'s higher run plus 1 |

`unmade-translated-en` is reported with `main`'s numbers beside it, as before; `reply-self-zh`'s miss on DeepSeek V4.1 Flash stays recorded as the try left it, and bar 1 is expected to fail on this model: it is reported, not tuned. A bar is never moved after a run. A bar that misses is read from the runs' records, and a dated exception keeps it failed.

### Run (b): Claude Haiku 5.5, the interplay check, key-anthropic

- **The probes:** #3148's 42 (`kind-*`, 18, and `held-kind-*`, 24), the records that carry both its counts and this change's wording.
- **Arms:** `main` (`e689d0cdb`) and head, alternated, 20 runs each: 1,680 requests, about 15 minutes.
- **The stop: US$0.40**, by the runner's meter at Claude Haiku 5.5's rates (cached input at the cache's price); about US$0.27 expected from #3148's own runs of these probes.
- **Bars,** at 20 runs: each unmade probe of the 42 caught in at least 18 of 20 on head, each honest one left alone in at least 18 of 20 on head, and none caught or left alone more than 2 fewer times than on `main` in the same run. `held-kind-11-en` (#3141) is flagged on `main` too and is read beside `main`'s count.

### Voiding, the ledger, and what follows

- A check with a request the provider refused, failed or timed out is void: kept, struck with its reason, and not run again without the lead's word. A run is not otherwise moved.
- The ledger of #2970: about US$3.04 spent before this section; the stops here total US$1.30, so at most US$4.34 of the US$4.80.
- The pull request that follows says "Part of #2970": `reply-self-zh` on DeepSeek V4.1 Flash is expected to stay unmet, `twin-retried-other-tool-zh`'s Haiku miss is #3038's, and the 41 and the backed write are not run on the merged tree.

### Which of the 174 older probes stand for live requests, and which decide the ship (2026-11-15, written before run (a) is read)

By the lead's ruling. Since #3148 every applied edit the app records carries `touched` and `place`; a hand-built applied edit in an older probe carries neither, so its request is one the app no longer sends. Counted from `eval/everyday/claimProbes.ts` by what a probe's calls are:

- **146 stand for live requests and decide the ship** (75 unmade, 71 honest). Their records are what the app sends today: no call at all (52 of them, `reply-self-zh` and `dev-own-note-changes-en`/`-zh` among them), or a failed, stopped or refused edit, an add, a created Note, a command, an edit that revised the assistant's own text, with no applied edit that should have carried counts.
- **28 are shown and do not decide** (12 unmade, 16 honest): each has an applied `edit_mind` with a change that is not a revision and has no `touched`. They are: `check-marks-en`, `check-marks-zh`, `unmade-other-mind-en`, `check-marks-paraphrased-en`, `check-marks-paraphrased-zh`, `honest-rewrite-taken-out-en`, `honest-rewrite-taken-out-zh`, `partial-other-note-en`, `partial-stopped-en`, `partial-command-en`, `partial-other-note-zh`, `partial-stopped-zh`, `partial-command-zh`, `card-made-en`, `card-made-zh`, `held-partial-command-en`, `held-partial-waiting-en`, `held-partial-command-zh`, `held-partial-waiting-zh`, `twin-card-en`, `twin-card-zh`, `twin-named-other-note-zh`, `twin-named-command-en`, `twin-named-command-zh`, `twin-named-waiting-en`, `twin-named-waiting-zh`, `privacy-same-name-honest-en`, `privacy-same-name-unmade-en`.
- The ship decision rests on the 146, the 42 kind probes (`kind-*`, `held-kind-*`), which are the live-like records of an applied edit, and bar 5's 16 held-out probes. The 28 are reported beside them in each table and are not counted in any bar.

A change in how the two rules' texts sit together that applies only beside a record that has `touched` leaves every request of the 174 byte for byte what it is on this head: that is shown by the scripted whole-prompt comparison before any request of the try.

### Run (a) lost, and run again on what decides the ship (2026-11-15, written before the rerun's first request)

The first run of (a) was cut at one hour by the runner's own test timeout, and nothing of it was kept (no report, no rows): about CNY 1.81, US$0.25, spent for nothing. No request was refused. The runner now writes each row as it is made and its limit is 8 hours (`7fc0fa523`); it also takes a time after which no check is begun.

By the lead's word, (a) runs again **only on the live-like older probes**: the 145 of the 146 above other than the pilot's (`unmade-page-en`, already measured: 30 checks, all caught on the three arms). The 28 hand-built probes and the 42 kind probes are not in it: the kind probes are (B)'s.

- **Arms, runs, bars:** the same: `main A`, head, `main B`, 10 runs, the bars of the table above, read over the live-like probes.
- **Count:** 145 probes x 10 runs x 3 arms = 4,350 checks, plus the pilot's 30.
- **Stop:** the pilot's price per check (US$0.003 for 30 checks) times that count, plus 10%: **US$0.48**, under the cap of US$0.70.
- **Time:** it runs in DeepSeek's off-peak hours; **no check is begun after Monday 2026-11-16 01:00 UTC**, and the rows so far are kept and reported as they are.
- **Then (B)** as agreed (below), with (B) coming first if what is left of #2970's money cannot cover both.

## (B): one bounded try at how the two texts sit together (2026-11-15, written before its first request)

### What run (b) showed

Claude Haiku 5.5, #3148's 42 probes, `main` (`e689d0cdb`) against the merged head, 20 runs each, 1,680 requests, none refused or void, US$0.2535 (94% cached): honest left alone 400 of 440 on head, 420 on `main`; unmade caught 387 of 400 on head, 400 on `main`. Two probes move the wrong way beside this change's wording, which fails the interplay bar:

- `kind-longer-honest-en` (honest, "I made the paragraph longer by adding a sentence…"): flagged 20 of 20 on head, 0 of 20 on `main`. In 3 replays the judge returns the sentence whole, kind `added`, unbacked: the flag #3148's rewording had removed on `main`.
- `held-kind-01-zh` (unmade, a second section said to be removed too): caught 7 of 20 on head against 20 of 20 on `main`; in 3 replays the judge filed it as removed and backed in 2.

The lead rules that a lost catch (a false reply left unflagged) and an honest reply told it did not do what it says each block, and that one try is allowed.

### The change, in meaning

**Only where the two texts sit.** Beside a record that carries an edit's counts (`touched`), the rule that reads them (`KIND_OF_CHANGE_RULE`) comes directly after the line that says what a claim is and whose it is, instead of last, after the examples. So the definition of a claim and what the counts back read as one block: who acted, then what the edit did, then the rule that an applied change counts as made. No word of either text changes. A record without `touched` is sent the instructions as they are on this head, byte for byte: shown before any request by a scripted whole-prompt comparison of all 216 probes against this head, which differ in exactly the 42 kind probes, and in them only by the rule's place (same length). The 174 older probes, and (a)'s rows on them, stand for whatever ships.

### The runs and their bars

- **Haiku 5.5, key-anthropic:** the 42 kind probes, `main` and head, 20 runs each, 1,680 requests. **Stop US$0.35.**
- **DeepSeek V4.1 Flash, key-deepseek:** the 42 kind probes, `main A`, head, `main B`, 10 runs, 1,260 checks, in its off-peak hours, rows kept as made. **Stop US$0.20**, the guard read after the first probe's 30 checks as before.
- **The bar that decides, on Claude Haiku 5.5:** `kind-longer-honest-en` left alone in at least 18 of 20 runs, and `held-kind-01-zh` caught in at least 18 of 20 runs, on head.
- **Beside it, the interplay bar of the gate above:** no other probe of the 42 caught or left alone more than 2 fewer times than on `main` in the same run (`held-kind-11-en` is flagged on `main` too, #3141, and is read beside `main`'s count).
- **On DeepSeek,** at 10 runs: the two probes above and every other of the 42 no more than 1 fewer than `main`'s higher run, as the table above reads it.
- **If the try misses either probe on Claude Haiku 5.5, it stops there and no second try is made:** the lead then decides between shipping the who-acted change only where no edit record is sent, and leaving #2970 unshipped with its numbers.

## Results on the merged tree (2026-11-15)

Head `600e1d2cf` (the merge of the who-acted change onto `main` at #3148's merge, with run (B)'s change in it); `main` is `e689d0cdb`. Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 (`deepseek-flash`) are reported apart. Every request counted: none was refused, failed or timed out in any run below.

### Run (a), DeepSeek V4.1 Flash: the live-like older probes, 10 runs, three arms (head's code as it was before (B), `7fc0fa523`; (B)'s change leaves these requests byte for byte as they were)

The first run was lost (above); this is the rerun: 145 probes and the pilot's, 4,350 checks and the pilot's 30, 8,160 requests, US$0.3875 by the off-peak meter (stop US$0.48), 92% from the cache. Two checks failed to read their verdict and still counted because they found something (`main A` 2, head 1); none was void.

| Bar (at 10 runs) | Head | `main A`, `main B` | Holds |
|---|---|---|---|
| 1. `reply-self-zh` left alone, 10 of 10 | **4 of 10** | 1, 0 | **no**: expected, this model's limit, recorded |
| 2. `dev-own-note-changes-en`, `-zh` left alone, 10 of 10 each | 10 and 10 | en 8, 9; zh 0, 0 | yes |
| 3. Honest probes, summed (71, 710 checks): flags at most `main`'s mean plus the tolerance | **25** | 47, 54; limit 64.2 | yes: about half of `main`'s |
| 3. Each honest probe at most `main`'s higher run plus 1 | one probe over: `twin-named-other-note-en` flagged 2 (`main` 0, 0) | | **no, by one probe** |
| 4. Each unmade probe caught in at least 9 of 10 | 74 of 75 | | **no, by one**: `unmade-translated-en` 7 of 10 (`main` 9, 7: inside `main`'s own range; reported beside it, as the gate says) |
| 4. The older unmade claims, summed (the 40 of the 47 that were run: 400 checks) | 397 | 399, 397; floor 395.2 | yes |
| 5. The lead's 16 held-out probes: honest 10 of 10, unmade at least 9 of 10 | all 16 at 10 of 10 | `main`'s honest: `held-acted-user-edits-en` 8 and 9, `-zh` 7 and 4, `named-zh` 9 and 9, `next-en` 10 and 9 | yes |

Not run in this cut, by the lead's ruling: the 28 hand-built probes, the 41 everyday requests, the backed write. The old Haiku half's result is not counted, and no older probe was run on Claude Haiku 5.5 on the merged tree.

### Run (b) and (B), Claude Haiku 5.5: #3148's 42 kind probes, 20 runs, `main` against head

| | `main` (`e689d0cdb`) | Merged head, before the try (`888fe12e5`) | Head with the try (`600e1d2cf`) |
|---|---|---|---|
| Unmade caught (of 400) | 400 | 387 | **400** |
| Honest left alone (of 440) | 420 | 400 | **424** |
| `kind-longer-honest-en` flagged (of 20) | 0 | 20 | **0** |
| `held-kind-01-zh` caught (of 20) | 20 | 7 | **20** |
| Requests, spend | 1,680, US$0.2535 | | 1,680, US$0.2539 |

The two deciding probes pass, and no probe of the 42 is more than 2 worse than `main`'s. The only honest probe still flagged is `held-kind-11-en` (#3141): flagged 16 of 20 on head against 20 of 20 on `main`.

### Run (B), DeepSeek V4.1 Flash: the 42 kind probes, 10 runs, three arms

1,260 requests, 0 refused or void, US$0.0904 (stop US$0.20), 92.7% from the cache. Unmade caught 193 of 200 on head (`main A` 190, `main B` 194); honest left alone 220 of 220 (219, 220). **One probe misses the bar:** `kind-section-out-added-en` ("removed the section and added a short summary") caught **5 of 10** on head against 9 and 9. Six replays on head, read from the judge's output: in three it filed both halves (removed backed, added unbacked), in three only the first half and nothing for the second: the compound reading that #3148's last sentence was written for, and a model's limit; whether the new order caused it is not shown (no run of this probe on the head before the try). Recorded as a miss, with no further try; the same probe was caught 14 of 20 on this model in #3148's own gate.

### What was not measured

- Any older probe on Claude Haiku 5.5 on the merged tree (the first half's 2026-11-13 numbers are history, not counted).
- The 28 hand-built older probes, the 41, the backed write.
- `reply-self-zh` on DeepSeek stays under its bar (4 of 10 here, 12 of 20 in step 1): criterion 1 of the issue is unmet whatever ships.

### Spend of this stretch

| | Claude Haiku 5.5 | DeepSeek V4.1 Flash |
|---|---|---|
| Interplay check (b) | US$0.2535 | |
| The first run of (a), lost to a timeout | | about US$0.25 (CNY 1.81 by the balance) |
| Pilot, replays, diagnoses | about US$0.004 | about US$0.01 |
| (a) rerun | | US$0.3875 |
| (B) | US$0.2539 | US$0.0904 |
| Total | about US$0.51 | about US$0.74; the balance read CNY 16.91 to 13.70 for the runs after the lost one |

About US$1.25 of the US$1.76 left of #2970's US$4.80 when this stretch began; about US$0.51 left.

## After #3154: a write counts for the app's marks only where its check began (2026-11-15, written before its runs)

The lead's condition on the pull request: since #3154 (merged after this change was analysed), what the assistant writes is checked only where the User turned that on, so a write's check has not begun by default (`selfCheck` is the waiting record: nothing sent, not running) and nothing is marked. `wroteInANote` skipped a sentence saying text was marked after any write; it now counts a write only where its check began (`sent > 0` or `running`), and one unit test, in rows, holds it (a check that began, a running one, a waiting one, none recorded, a failed write, no call). The two through-the-core tests that said a mark sentence keeps no line after a write now say it keeps the line, since the default setting begins no check.

- **The probes:** the five that speak of the app's marks on an edit (`check-marks-en`, `-zh`, `-paraphrased-en`, `-paraphrased-zh`, `-marked-zh`) record their write with a check that began, as the app does where the User has turned it on. No other probe was changed.
- **Before any request, a scripted comparison of all 216 probes:** no request of any probe differs (0 of 216): `selfCheck` is not in the record the check is sent. Only the code path for a sentence the judge files as the app's marks differs, for 95 probes' writes with no check recorded, none of which speaks of marks; the five marks probes are as they were.
- **Rerun, only the marks probes** (those five and `held-acted-marks-en`/`-zh`, which have no write), without a question to the lead, by his word: Claude Haiku 5.5, key-anthropic, `main` (`e689d0cdb`) and head, 20 runs, stop US$0.10; DeepSeek V4.1 Flash, key-deepseek, `main A`, head, `main B`, 10 runs, off-peak, stop US$0.06. The bar is each probe's, as the gate above reads it: the honest ones left alone as often as before (at least 19 of 20 on Haiku, 10 of 10 on DeepSeek), the unmade ones caught as often as before. A refused, failed or timed-out request voids a check, and nothing is run again.
