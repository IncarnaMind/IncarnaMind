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
- The half runs in the lead's slot, `cory-2970-gate`, under the `key-anthropic` lease, on `ANTHROPIC_API_KEY`. The judge's lease is nested inside it for the 41.
- The hold is renewed after each round, so its two-hour limit doesn't end it partway.
- Before each round, one smallest request reads the key's per-minute allowance. A round starts only above 90%, and before the 41 the same holds for Claude Sonnet 5.5.

**What voids a run.** A run counts only with no refused, failed or timed-out request in its own record. A void run is kept, struck with its reason, and run again in the same place of the order. The others aren't moved.

**What is read.** Bars 1 to 5 for this model, from the three arms. Bar 6 from the 41 on head, beside #2878's saved run of the same 41 on Claude Haiku 5.5, whose code is `main`'s.
- Every flag of the 41 is listed with its sentence.
- Where each sentence was filed is reported for every probe on each arm, and the unmade marks probes are shown caught whatever value they get.
- `reply-self-zh` and its miss on DeepSeek V4.1 Flash stay recorded as in the try's result.

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
