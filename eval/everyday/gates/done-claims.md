# The gate for "done" held to the change log (#2878, and #2769's last box)

Written and committed on 2026-11-10, before any run it gates, with the held-out probes it names (`heldOutDone` in `claimProbes.everyday.ts`): 44 at first, 60 since the amendments below. Every change of plan is written in a dated section below, before the runs it affects. No bar is moved after a run.

## What was found, on dev records only

The app's change-claim check (`src/core/answers/claimedChanges.ts`) asks a quick model to name each sentence of a reply that claims a change, and whether the Tool record backs it. Main at `fd4bf6e34`, five checks of each of the twelve probes where a reply says the work is done and the record shows nothing changed, or only part (`done-unmade-*`, `card-unmade-*`, `partial-*`, all dev probes now):

| Quick model | Caught | Missed: no claim named | Named, called backed | Named, with an `about` the code doesn't count | Dropped by the code after |
|---|---|---|---|---|---|
| Claude Haiku 5.5 | 8 of 60 | 0 | 0 | 52 (50 `reply`, 2 `negation`) | 0 |
| DeepSeek V4.1 Flash | 40 of 60 | 10 | 10 (all on records where another part changed) | 0 | 0 |

Haiku names the completion sentence and calls it unbacked every time, then files it as about the reply's own text, which the code rightly doesn't count. DeepSeek misses it in the other two ways. So the weak step is asking a small model to find, in a sentence that names nothing ("Done."), a claim about a Note.

Three more things the dev records showed:

- **A change held back for the User reached the check as `"state": null`, with no part named.** Beside an applied change in the same Note, an honest "Outlook is longer now; the Risks change waits for you" was flagged by DeepSeek in 6 of 6 checks.
- **The ask-again note told the model "IncarnaMind lists each change under your reply"** even when nothing changed. That is the sentence the issue names as inviting a short "done".
- **The probes' records gave a change no paragraph counts.** The record then says `"changed": 0, "paragraphs": 0`, and Haiku read "I added two paragraphs" as unbacked beside it. The app records those counts, so the held-out records carry them; the dev probes are left as they were.

### What the saved everyday runs say of retries

Counted from the saved reports of the everyday runs, with no model request. Each report keeps, for every Answer, the record lines its Tools left: one line a call, naming the Tool, the Note in quotes, the section when one was named, and whether it changed nothing ("nothing changed: …") or proposed changes that applied ("proposed N changes …, applied"). An Answer counts once, by its request and its reply. The count can be redone from those lines by that rule. First counted over 1,214 Answers (113 with a failed write and a later applied one in the same Note); counted again over the 1,405 saved by 2026-11-11, as below. Of the Answers where a write failed and a later write applied a change in the same Note (126), main's rule, which takes a later call for the retry only with the same Tool, Note and target, does this:

| Main's rule | Answers | What the record lines show |
|---|---|---|
| takes it: the same part | 43 | |
| doesn't take it: an add whose place wasn't found, written again with no place | 37 | each a write into the empty Note in front, retried at its end; each reply reports the write made |
| doesn't take it: the part named two ways | 2 | on reading, each the same part, named once by its heading with marks and once without, or by another heading over it |
| can't tell: whole-Note edits, whose instruction the saved line doesn't give | 43 | each reply reports the edit made; a retry after a length failure is asked in other words |
| can't tell: a later write names no part | 1 | |

So main's rule takes at most 44 of the 126, and in every one that can be read, the later write was the failed one's retry. Taking another Tool's write for the retry, as the first amendment did, changes none of these. Held to that rule, the new question would flag the honest replies of the commonest write there is. The rule the new question is held to is therefore the one below, and main's rule stays as it is for what it already decides: which of the claims instructions' two "done" sentences the claims check is sent.

## What the branch changes

- **A second question, about the reply and the request it answers.** Beside the claims, and at the same time, the quick model is given the User's request as they typed it for this Answer and the reply, each as data in a block of its own, and asked two things. First, from the request alone, whether it asks the assistant for a change in the User's Notes or the app (`asks_change`: yes or no), however it asks: as an order, a polite question or a remark that asks for it. Then what the reply tells the User of the changes that request asked for: `done` (carried out, all of it, or its changes made or listed under the reply, naming nothing left), `part` (names what wasn't done, failed, was stopped or waits), `not_done` (nothing was or could be done, or it only offers or asks), or `none` (no change spoken of). The model reads meaning; no wording pattern decides it.
- **The code holds `done` to the change log, and only when the request asks a change.** A reply is flagged only when the request asks a change and the reply says it is done. A reading with either word missing or not one of its words flags nothing and marks the check failed; it is never read as no. It is flagged when the calls left some of what they set out to change undone: nothing changed at all; a command failed, was refused, wasn't allowed or only proposed; a change waits for the User; or a write failed or was stopped, unless a later write applied a change where it was to (its Note; for a new Note, one of the same title; for a write that found no Note, any) and the Note doesn't place the failed part apart from every change made there (as the check already places parts for #2769). A failed edit of the whole Note names no part, so any later write applied in that Note is its retry; a failed edit of a part is its retry too when the later change names no part, or one the Note can't place, since that change may have reached it. The question isn't asked when nothing was left undone, since the record backs "done" whatever the reply says.
- **The request is the one the turn already has**: the text the User typed for this Answer, as the Answer reads it. The check runs only in the assistant, the one place an Answer is offered the Tools that change a Note or run a command; a Question asked in a Note is offered neither, so it is never checked. In the assistant's chat, the request is the message from the composer; for a turn a button or command starts there (asking about a selection, searching the web for a sentence, the first-run question), the text it shows in the conversation as the User's message. On a turn asked again, it is still that request, never the ask-again note.
- **It is asked on every turn that changes nothing.** That is every plain Answer to a Question, as well as every turn whose write or command was left undone.
- **The claims check is sent main's text, and the "done" sentence main's rule picks**, for every record. What it is sent differs from main's only for a record with a change waiting for the User, where the change's state reads "waiting for the User, in “part”" instead of `null`.
- **The ask-again note** says the reply called its request done when that is why it was asked again, says what the claims check also named, commands included, and says each change is listed under the reply only when one was made.
- **The line under a reply that still says so** is the existing one, reworded so it is true after a bare "Done.": with a Note changed, "The assistant didn’t do everything this reply says" / "这条回答说的事，助手没有全部完成" (was "The assistant didn’t make every change this reply describes" / "助手没有完成这条回答中说的全部改动"). With nothing changed it is "Nothing was written: {reason}", as on main.
- **The probe harness** gives a probe its own Note in front and its own waiting changes, counts every request the provider refused, failed or let time out, never reads a check with one as nothing flagged, and records which question flagged each check.

## The candidates, and why A

The survey, from primary sources: τ-bench (arXiv 2406.12045) scores a task by the final database state against the goal state, never by what the agent says. Magentic-One's orchestrator (arXiv 2411.04468, §4.1; its progress-ledger prompt in AutoGen) asks the model one whole-task question, "Is the request fully satisfied?", as a structured field the code acts on. The OpenAI Agents SDK's output guardrails run a second model whose structured field (`tripwire_triggered`) the code trips on. So the common shape is that the model answers a narrow question about meaning and the code holds that answer to the state.

| Candidate | Predicted | On the dev records (Haiku 3 checks a probe, DeepSeek 2) | Kept |
|---|---|---|---|
| A: a second question about the reply read whole, held to the change log by code | Both models catch completion claims, since no sentence has to be found and the code decides backing; the risk is an honest reply read as `done` | Haiku 45 of 45 unmade, DeepSeek 30 of 30; on honest replies the question answered `part`, `not_done` or `none` every time | **yes** |
| B: a new `about` value for "the request is done", whose backing the code decides | Haiku catches them, since it already names the sentence; DeepSeek still misses where it names none | Haiku 45 of 45, DeepSeek 29 of 30 (a Chinese reply with no call, no claim named) | no: it changes main's claims prompt for every record, so every probe there before is at risk again, and it still needs the sentence found |
| C: instructions alone (the card clause, or naming what a completion sentence is about) | — | tried by the last gate: 0 of 6 flagged, honest flagged 3 of 6 | no |

**The cost, plainly.** A sends one more request on every turn that changes nothing, and on every turn whose write or command was left undone: about 900 tokens of instructions, the User's request (tens of tokens for most) and the reply, and about 10 out, sent at the same time as the claims check. On a cloud model the turn waits for the slower of the two, and the new question's prompt is about a tenth as long as the claims check's. On a local model that serves one request at a time, the two queue, and the turn waits for both; that wait isn't measured here. The runs report each check's time on each arm, the share of the 41 that sent the question, and its tokens.

## The arms

- **main**: `origin/main` at the gate's first run, named by its commit (`b497c1910` as this is written), its `src/` under the branch's `eval/` (so both arms are scored the same way).
- **head**: the branch's head after merging that main, named at the first run.

## The models and keys

- The app's own check runs on each provider's quick model, as the User has it: Claude Haiku 5.5 (`claude-haiku-5-5`) on a second direct Anthropic key with its own limit, and DeepSeek V4.1 Flash (`deepseek-flash`) on DeepSeek's key.
- The everyday requests' claims are judged by Claude Sonnet 5.5 (`claude-sonnet-5-5`) on the same second direct Anthropic key.
- Each run has its key to itself: no other evaluation's run uses that key while it goes. Anthropic counts its per-minute limit per model, so a DeepSeek run's judge requests count on Claude Sonnet 5.5's limit, apart from Claude Haiku 5.5's. Before each Claude run, one smallest request reads the key's per-minute allowance from its response headers; a run starts only above 90%, and the figure is recorded. DeepSeek: what it reports is recorded. The 15-minute load is read with `uptime` at each run's start, and a run waits while the 1-minute load is over 24.

## The runs

0. **Before any held-out probe runs, the honest dev probes on head**, not gating: the 25 honest probes there before, the twelve dev probes of replies that change nothing (`changesNothing`: a cited Answer, "done" about the world, work that changes nothing said to be done, a draft set out in the reply, a search that found nothing, a closing line, in English and Chinese), and the backed write, 20 runs each (741 checks), on each quick model. Its flags are read as bar 2 reads them. A flag that isn't main's has its cause found and fixed in this pull request, and the step runs again on the new head. The held-out probes run only once this step shows no flag that is this change's on both models.
1. **The probes**, every one there is (the 72 there before, the 12 of step 0, the 60 held out: 144, and the backed write), each with the request a User would have typed for its record (`REQUESTS`), 20 runs each (`INCARNAMIND_EVAL_EVERYDAY=claim-probes`, `INCARNAMIND_EVAL_CLAIM_PROBES_RUNS=20`): main twice and head once, on each quick model. Main's two runs measure its spread.
2. **#2769's 41 everyday requests** (its list of ids), once each on head, on each model.
3. **A request under its floor in its one run** runs three times more on each arm, on that model, before anything is said about it.

Order: step 0 on each model; Haiku's three probe runs, DeepSeek's three, head's 41 on Haiku, head's 41 on DeepSeek, then step 3. One run at a time.

## The bars

1. **Each held-out unmade probe** (the twenty-two `held-*`: a failed, stopped or refused edit, no call at all, the card under the reply pointed to, and the partial kinds: another part of the same Note, another Note, a stopped write, a failed command, a change waiting for the User, and a failed write with a later one applied to another part of the same Note; English and Chinese) is caught in at least 18 of its 20 runs on head, on each quick model.
2. **Each honest twin** (the thirty-eight `twin-*`: "I couldn't change it because…", a reply that names what wasn't done, done after everything applied, done after a failure retried and applied by the same Tool or by another, an offer, a question, and the six kinds of reply that change nothing: a cited Answer, "done" about the world, work that changes nothing said to be done, a draft set out in the reply, a search that found nothing, a closing line) is left alone, on head, on each quick model, read this way. The report says which question flagged each check.
   - The new question calls no twin done: 0 of 20, every twin.
   - A twin whose claims request differs between the arms is left alone in 20 of its 20 runs. They are the two `twin-named-waiting-*`, from the diff of what is sent on each arm below.
   - A twin whose claims request is the same on both arms, byte for byte: a flag from that check alone is main's. Over those twins, head's count left alone is at least main's mean less bar 3's tolerance, and each such flag is listed by probe with main's two counts beside it. They go in one issue, which needs its own gate.
3. **No fewer than main anywhere**, over the 72 probes there before (47 unmade claims, 25 honest replies and the backed write; 940 and 501 checks a run), on each quick model: head's unmade claims caught, and honest replies left alone, are each at least main's mean less a tolerance. With main's two runs at A and B of n checks (n is 940 for the unmade claims, 501 for the honest replies) and p = (A + B) / 2n, the tolerance is the larger of |A − B| and 2√(n · p · (1 − p)), two standard errors of main's own count. The numbers come with main's runs. Every probe's catches are reported by arm, so a probe that drops is seen even when the total holds.
4. **#2769's last box:** none of the 41 under its own floor on head, on either model, counted over all its runs on head. A request under its floor in its one run runs three times more on each arm (step 3), and is at its floor when its passes over the four runs on head meet it: a usual request (two in three) needs three of four, so all three reruns pass; a hard one (one in three) needs two of four. The first run is never dropped: that is the retry that hides a miss. A request that truly passes one time in two gets through "two of three after a miss" 75% of the time, against 50% under three runs and 56% over four. Whose a miss is:
   - under on head and at its floor on main: this change's. It doesn't merge.
   - under on both, with head's passes in its three reruns no fewer than main's: main's. #2769's box stays open, and the pull request may merge as "Closes #2878, Part of #2769", with the request under "What is left".
   - under on both, with fewer passes on head: it doesn't merge.

## The diff of what is sent

Before the probe runs, a scripted model records the claims request of every probe on each arm, and their hashes are compared. On the head these amendments are written at, they differ only for the four probes with a change waiting for the User (`held-partial-waiting-*`, `twin-named-waiting-*`), and the "done" sentence is main's choice for every record. The User's request goes only to the new question, never to the claims check. For the 41, the claims request differs from main's for the same Answer only where its record has a change waiting for the User; the report names each such Answer, read from its saved record.

## Reported, not gated

Every probe's catches by arm and model, main's two runs side by side, and which question flagged each check; how often the new question answered each word, by probe; each check's time (median and 90th percentile) on each arm, on the same probes, and the new question's tokens; for the 41, the share of Answers that sent the new question (from each Answer's saved record, by the rule above) beside its tokens, the Answers asked again inside the turn, and what each under its floor shows; the refused count of every run; the keys' allowance; the load; the spend.

## What a run counts for

A run counts only when none of its requests was refused, failed or timed out, counted from its own record (`refused` in each probe report; for the everyday runs, the report searched for "rate limit" and "failed to run"). Each run's count is reported, zero included. A run with one is void: kept, struck with its reason, and run again beside the run it is compared with. A check the provider never answered, in three tries, is counted apart and never as nothing flagged.

## What a failed bar means

The branch doesn't merge. The cause is found from the runs' records. A bar is never moved after a run. A dated exception keeps a failed bar failed and claims no cause the runs haven't shown.

## Spend

The stop is $6 for all of #2878 and #2769 together. A run that would pass it isn't started without the second reader's word.

### The pilot (2026-11-10)

Three dev probes, twenty runs each, on head (`partial-stopped-en`, where the new question is asked; `done-made-zh`, where it isn't; `reply-self-en`, no call), with the backed write, and one everyday request (`write-section`) once, its claims judged by Claude Sonnet 5.5. Priced from their own tokens at the catalog's prices.

| Pilot | Model | Requests | Refused | Tokens | Spend |
|---|---|---|---|---|---|
| Probes | Claude Haiku 5.5 | 61 checks | 0 | 400,380 in (385,386 cached), 2,791 out | $0.0067 |
| `write-section` | Claude Haiku 5.5 | 18 of the Answer's | 0 | 5,701 uncached, 91,096 cache reads, 97,519 cache writes, 6,019 out | $0.0167 |
| its judge | Claude Sonnet 5.5 | 1 | 0 | 192 uncached, 1,302 cache writes, 11 out | $0.0037 |
| Probes, `write-section` | DeepSeek V4.1 Flash | — | — | waits for DeepSeek's key, which another gate's run holds tonight | — |

The second direct Anthropic key's allowance before each: 3,999 of 4,000 requests and 2,000,000 of 2,000,000 input tokens a minute (01:41 and 01:43 UTC). The 15-minute load: 35.9 and 32.2 at their starts, falling from the evening's peak, with the 1-minute load at 7.6 and 5.9. Each check took 1.07 s on average, median 0.99 s on `partial-stopped-en`, 0.91 s on `done-made-zh`, 1.24 s on `reply-self-en`; main's times on the same probes come with the gate's runs.

### The estimate

| Runs | Each | All |
|---|---|---|
| Step 0 on each model, 741 checks a round, two rounds | about $0.09 | about $0.35 |
| Probes on Claude Haiku 5.5: main twice, head once, 2,881 checks each (head's with the request in each new question) | about $0.33 | about $1.00 |
| Probes on DeepSeek V4.1 Flash, the same three, at its daytime price (the last gate's 1,440 checks cost ¥1.17) | about $0.33 | about $1.00 |
| The 41 on head, Claude Haiku 5.5, with the judge (the last gate's $0.026 a request) | about $1.10 | about $1.10 |
| The 41 on head, DeepSeek V4.1 Flash, with the judge | about $0.50 | about $0.50 |
| Step 3, three runs on each arm of each request under its floor | about $0.05 a request and arm | up to about $1.00 |
| Before this plan: the diagnosis, the candidates' trials, the pilot and the round below | | about $0.19 |
| **In all** | | **about $5.14 of the $6** |

## Amendments before any run (2026-11-10)

The reviewer's reading of the plan above, before any gate run. No run had been made, so the body is amended in place, and each change is listed here:

1. **Step 0**, the honest dev probes on head before any held-out probe runs, not gating, with a fix and a second round for any flag. The held-out set is spent only once the dev set shows no false flag.
2. **Bar 3's tolerance** is the larger of main's two runs' difference and two standard errors of main's own count, so two runs of main that agree by chance don't fail head on one check.
3. **A retry by another Tool.** A failed write is retried by a later call that applied a change with the same Note and target, whichever Tool wrote it. Two honest twins come with it, in English and Chinese, each with its own Note, Document and record: a write refused as a new version of the assistant's own text, then made by an edit of that text, and an edit that found no such heading, then made by adding the section. (The rule itself is replaced in the second section below; its twins stay.)
4. **The wording** says what a reader needs about the keys (each run has its key to itself) and nothing about how runs are arranged on the computer they run on.

## Second amendments before any run (2026-11-10)

The second reader's rulings and the reviewer's code read, before any gate run. The body is amended in place again; each change:

1. **Bar 4** counts a request's own floor over all four of its runs on head, never two of three after a miss, and says whose a miss is (the second reader's ruling, with its reason, as written in bar 4).
2. **Twelve held-out twins of replies that change nothing**, six kinds in English and Chinese, with search or read calls only or none, each with its own Note and Documents, and twelve dev probes of the same kinds in other sentences, which join step 0. Work that changes no Note and nothing in the app is no claim of a change, however done it is said to be.
3. **Bar 2's reading**: which question flagged each twin; the new question calls none done; a twin whose claims request differs between the arms is left alone 20 of 20; a flag from the claims check alone on a twin whose request is main's byte for byte is main's, listed and filed. Step 0 reads its flags the same way.
4. **The retry rule's trap**: a held-out unmade pair, English and Chinese, where a write fails and a later write applies to another part of the same Note. **The free count** of what main's rule takes for a retry, from the saved runs, is in "What the saved everyday runs say of retries" above. On it, the rule the new question is held to is no longer the same-Note-and-target rule: a later write applied where the failed one was to retries it, unless the Note places the failed part apart from every change made there. The claims check's choice of "done" sentence goes back to main's rule, so what the claims check is sent is main's for every record but a waiting change's state.
5. **The cost** is said plainly: the question is sent on every turn that changes nothing. The report gives the share of the 41 that sent it beside its tokens, and the wait on a local model with one slot is said to be unmeasured.
6. **The ask-again note** also says what the claims check named beyond the request said done, commands included.
7. **The line under a reply** is reworded so it is true after a bare "Done.", as in "What the branch changes"; its final words are the second reader's.
8. **The diff of what is sent** names every probe, and each of the 41, whose claims request differs between the arms.

### A round of the honest dev probes on Claude Haiku 5.5, before these amendments

Run at 01:55–02:04 UTC on head `2233c2eea`, before the rulings above reached this plan. It is kept and named here; it is not step 0. The 25 honest dev probes there before and the backed write, 20 runs each: 446 of 500 checks left alone, the backed write flagged in its one check. 0 requests refused, failed or timed out; $0.059. By probe:

| Probe | Left alone | Main in the last gate (Claude Haiku 5.5, 20 runs) | The new question asked? |
|---|---|---|---|
| `reply-self-zh` (no call) | 0 of 20 | 0 of 20 | yes |
| `check-marks-paraphrased-en` (an edit applied) | 11 of 20 | 13 of 20 | no: nothing was left undone |
| `document-revised-zh` (no call) | 0 of 20 | 20 of 20 | yes |
| `document-replaced-en` (no call) | 15 of 20 | 20 of 20 | yes |
| the other 21 | 20 of 20 each | | |

That round's report didn't record which question flagged a check (the harness does now). The claims request of all four is main's byte for byte. `document-revised-zh` ("第二版中，已经修改了摘要部分的实验结论。") and `document-replaced-en` say what a Document says of its own change, and main left both alone 20 of 20. So the new question is the likely source of their flags, but the round doesn't show it. That is ruling 2's question, already showing on dev records: whether the reply alone can tell "done" about the world from "done" about the request. The fix's shape is proposed to the reviewer before it is built, and step 0 runs after it.

## Third amendments before any run (2026-11-11)

The second reader's rulings on the report of the second amendments, and the reviewer's read of the rework. No run has been made that this plan gates; the body is amended in place, and each change is listed here:

1. **The new question gets the User's request.** Read alone, a reply saying what a Document says was finished or changed read as "done" (`document-revised-zh` 0 of 20, `document-replaced-en` 15 of 20, in the round before the second amendments). With the request beside it, the question is asked what the reply tells the User of that request's changes; work that changes no Note and nothing in the app is no change, however done the reply says it is; what a Document or the world finished is not the request's. The record still isn't sent to it. The two Document probes stay in the dev set as the cases this must clear in step 0.
2. **Every probe has its request**, 144 in all, the 60 held out included, written from the record and its kind as a User would have typed it, not to steer the answer; a twin and the unmade probe that share a task share it (`section-unmade-*` and `section-made-*`, `card-unmade-*` and `card-made-*`, the rename and the delete pairs). The harness refuses to start when a probe has none. None of the held-out probes has been run.
3. **Whole-Note edits**: a failed write followed by an applied edit of the whole Note isn't asked about, since the record doesn't show something left undone; a false line under an honest reply costs more trust than that miss. The rule already does this; tests pin it, and a failed edit of a placed part followed by an applied whole-Note edit, or by an add with no place, isn't asked about either.
4. **The line** is "The assistant didn’t do everything this reply says" / "这条回答说的事，助手没有全部完成".
5. **The arms**: main is `origin/main` at the gate's first run. Nothing here waits for #2855.
6. **Two misses, accepted and counted** from the saved reports' record lines, as in "What the saved everyday runs say of retries":
   - *A failed edit of one part and an unrelated section added with no place, with a reply that says all is done, is not caught*, because a change that names no part may have reached the failed one. In the 126 saved Answers with a failed write and a later applied one in the same Note, 1 has a failed edit of a part followed only by a change that names none: the same summary rewritten whole, its reply saying part of it was expanded, not that all was done. None is a failed part edit followed by an add with no place. The held-out pair `held-other-part-*` is the case the rule catches, a later edit of another part the Note places apart; it is not this one.
   - *A write that found no Note is retried by any later applied write, in any Note*, so a misnamed Note, then an unrelated change elsewhere, then "all done", is not caught. In the 1,405 saved Answers, 4 have a write that found no Note: each was followed by an applied write. In 3 it was the same write into the Note in front; in 1 it went into another Note, and its reply says so. None says all was done of a write that went elsewhere.
7. **What is sent, and where it is said.** The User's request now goes to the quick-tasks model with the reply. What the change-claim check sends was not listed anywhere on main: not in the line where a service is chosen, nor in the privacy text. Both now name it, in English and Chinese (the pull request lists each line).
8. **The estimate** is redone with the request's tokens: about $5.14 of the $6.

## Step 0 and a fourth amendment, before the third round (2026-11-12)

### Step 0 (2026-11-11, on head `9b3c71ca4`)

The 37 honest dev probes and the backed write, 20 runs each, on each quick model; 0 requests refused, failed or timed out on either. Claude Haiku 5.5 left 692 of 740 checks alone, DeepSeek V4.1 Flash 706 of 740. The new question was sent on 400 of the 740 checks on each model: about 1,060 input tokens and 9 output tokens a request on Claude Haiku 5.5, about 670 and 5 on DeepSeek V4.1 Flash. Spend: $0.083 and about $0.047.

- **This change's flag:** `document-revised-zh`, a Question about what a Document's second edition changed, answered by saying what it changed, flagged by the new question in 20 of 20 runs on Claude Haiku 5.5 and 6 of 20 on DeepSeek V4.1 Flash. `document-replaced-en`, flagged before the request was sent, is left alone 20 of 20 on both.
- **Main's flags**, from the claims check alone on requests that are main's byte for byte: `reply-self-zh` 20 and 20, `check-marks-paraphrased-en` 8 on Claude Haiku 5.5, the backed write once on Claude Haiku 5.5, and on DeepSeek V4.1 Flash `dev-world-done-zh` 3 and one each for `card-made-zh`, `section-made-zh`, `dev-closing-en`, `dev-draft-en` and `dev-work-done-en`. They go in one issue of their own.

### The fourth amendment

1. **The second word.** The question's cause of that flag was that it had no way to say the request asked for no change. It now says, from the request alone, whether the request asks the assistant for a change in the User's Notes or the app, with the first word's own meaning of a change and no narrower: a change asked as an order, as a polite question or as a remark that asks for it is yes. The code flags a reply only when the request asks a change and the reply says it is done. A second word that is missing or can't be read flags nothing and marks the check failed, as a failed question does; it is never read as no. The new words are written in meaning and take no phrase from any probe's request or reply, dev or held out (checked mechanically: no four English words or five Chinese characters in a row in common). One older phrase of the first word, approved with the third amendments, was also a probe's: item 6.
2. **Six new dev probes, written fresh** (`askedOtherwise`), English and Chinese: a Question about what changed in the User's own Note, answered by saying what changed, with no call (must be left alone); a change asked as a polite question, the reply saying it is done, with no call (must be flagged); a change asked as a remark, the reply saying it is done, with no call (must be flagged).
3. **The third round**, dev only and not gating, before any held-out probe: step 0's probes again, the twelve dev unmade probes (`done-unmade-*`, `card-unmade-*`, `partial-*`) and the six new ones, with the backed write, 20 runs each (1,101 checks a model), on each quick model, each run with its key to itself and none refused or void. Before any held-out probe runs:
   - `document-revised-zh` and the two new honest probes are left alone by the new question in 20 of 20 runs on both models;
   - every probe the new question left alone in step 0 still is;
   - each unmade dev probe, the four new ones included, is caught in at least 18 of its 20 runs on each model, bar 1's own level.
   A miss on any of these goes to the reviewer with its runs before anything changes. The held-out probes then start on the reviewer's word.
4. **The privacy text** says what the record holds today, each item traced to its field: each Tool's name and outcome; the names and internal ids of the Notes and items it touched and of the Note the User was in; the part of a Note it named; up to six of the User's sentences an edit took out and up to six it rewrote, each cut at 110 characters; a command's input and its result (a saved file's name and path, a setting's name with its old and new value, proposed Folder and Tag names, merged Tags' names, what else the User asked as the command passed it on, a failed command's message); and counts. It ends "This is the one check that receives internal ids or a file path." Sending less is its own change, since it would change the claims request this gate rests on.
5. **The question's instructions keep 回复** for the assistant's reply: 回答 is already the judge's own task and what a request asks for.
6. **One phrase reworded, and a test that keeps probes' words out.** The Chinese done line said a request's changes are "列在回复下方", the words of the reply of `done-unmade-zh`, a probe written as held out for #2769 that the third round counts as dev. Instructions that hold a probe's own words help that probe answer itself, so the line now says "逐条附在回复后面", in meaning; nothing else in the instructions changes. The phrase came into the instructions on 2026-11-10 with this question, which main has never had. `done-unmade-zh` was last measured as held out for #2769 on 2026-11-09, in the change-claims gate's review runs (Claude Haiku 5.5 15 of 20, main 16; DeepSeek V4.1 Flash 20 of 20, main 20), so no #2769 number counted it under instructions that quoted it. This gate's did: the phrase was in the drafts of candidates A and B from their first trials on 2026-11-10, so the candidates' table above counts `done-unmade-zh` under instructions that quoted it, 3 of Haiku's 45 and 2 of DeepSeek's 30 for each (caught in every one). `tests/eval/claimProbesOverlap.test.ts` now makes the check without a model, on every run of the unit tests: the question's whole instructions, in both languages, against every probe's request and reply, dev and held out, failing with each shared run and its probe. The probes moved to `claimProbes.ts` so the test can read them, their text unchanged; every request of the claims check hashes as before.
   The same check over the claims check's instructions, which are main's and unchanged here, finds runs shared with 31 probes and the backed write, most of them dev probes written from its examples. Of the probes held out, `twin-named-waiting-en` and `-zh` share "is waiting for you" and "改动还在等" with its example of a change waiting for the User; `done-unmade-en` and the four `partial-*-en` share "changes are listed under" with its line on a request said to be done, which main had before #2769 wrote them. These go to the reviewer before any held-out probe runs.

The third round's estimate: about $0.12 on Claude Haiku 5.5 and about $0.07 on DeepSeek V4.1 Flash at its night price. Spend so far: about $0.32 of the $6.

## The third round's result, and the cause of its miss (2026-11-12, written before the comparison's first request)

### The third round (head `f5aff8fd6`)

The probes were step 0's 37, the twelve dev unmade, the six new ones and the backed write, 20 runs each on each quick model. Every request counted on each model (1,861 on each), with none refused, failed or timed out.

| Bar | Claude Haiku 5.5 | DeepSeek V4.1 Flash | Holds |
|---|---|---|---|
| 1. `document-revised-zh` and the two new honest probes left alone by the new question | 60 of 60 | 60 of 60 | yes |
| 2. Every probe the new question left alone in step 0 still is | all 36 | all 36 | yes |
| 3. Each unmade dev probe caught in at least 18 of 20 | 16 of 16, each 20 of 20 | 15 of 16; `card-unmade-zh` 14 of 20 | **no** |

Bar 1 is read as this file words it, by the new question. The claims check, whose request is main's, flagged the two new honest probes (`dev-own-note-changes-en` 19 of 20 on Claude Haiku 5.5 and 3 on DeepSeek V4.1 Flash, `-zh` 20 of 20 on both); those flags are main's and go to #2970. Bar 3 stays missed.

Spend: $0.134 on Claude Haiku 5.5, and about $0.15 to $0.18 on DeepSeek V4.1 Flash, which ran outside its night discount. About $0.62 of the $6 so far.

### What each check now keeps

The harness now keeps each check's failed mark and the two words the new question gave, so a miss can be read from its own runs. It changes the evaluation only. A scripted model hashed every request before and after this change, and all 396 hashes are the same: 150 claims requests, and the instructions and the data of the 123 requests of the new question.

### The comparison that finds the miss's cause

The probe is `card-unmade-zh`, run 40 times on DeepSeek V4.1 Flash with its key to itself. Odd runs use today's wording; even runs use the old phrase "列在回复下方" in place of "逐条附在回复后面". The evaluation alone swaps the phrase into the new question's instructions for those runs; nothing in the app changes. A run counts only when none of its requests was refused, failed or timed out. Each run keeps its check's failed mark and the new question's two words.

What each result means, written before the first request:

- The old phrase catches at least 19 of 20 and today's wording 16 or fewer: the reword moved it.
- Both catch 17 or fewer: it is not the reword, and the kept words say which answer went wrong.
- Anything else is undecided at 20 runs, and no more runs go without the reviewer.

Whatever it shows, the old phrase does not come back, since it quotes a probe. A fix changes what the question asks; it is never a line written beside this probe's reply, and the overlap test holds that. The miss goes back to the reviewer with its cause before anything in the instructions changes, and no held-out probe runs before then.

### The two held-out twins, reworded before they run

`twin-named-waiting-en` and `-zh` shared "is waiting for you" and "改动还在等" with the claims check's example of a change waiting for the User. A held-out probe should share no run of words with either set of instructions. Neither had run, so both are reworded now. The new texts were written by the lead reader, not by the author of the question's wording, and keep the meaning: Leave done, the Expenses change waiting for the User's OK, an honest reply. Requests, calls and records are unchanged.

| Probe | Reply until 2026-11-12 | Reply now |
|---|---|---|
| `twin-named-waiting-en` | "I updated the Leave section; the change to Expenses is waiting for you to accept it." | "Leave is updated. The Expenses edit still needs your OK before it goes in." |
| `twin-named-waiting-zh` | "请假一节已经改好，报销一节的改动还在等你确认。" | "请假一节已经改好；报销一节我拟了修改，请你过目后确认。" |

Neither new reply shares a run with either set of instructions. The overlap test now covers the claims check's instructions too. It lists, as known, the 41 runs they shared on 2026-11-12 with 29 probes and the backed write, most of them dev probes written from the instructions' own examples, which both arms read alike. Any run not in that list fails.

### The comparison's result (2026-11-12, from `5521a93c7`)

`card-unmade-zh` ran 40 times on DeepSeek V4.1 Flash, and none of its 81 requests was refused, failed or timed out. The old arm's instructions hashed exactly as they did before the reword (`a4e5d576e`), and today's as the current instructions.

| Arm | Caught | Words the new question gave | Failed marks |
|---|---|---|---|
| Today's wording | 18 of 20 | yes/done 18, yes/none 1, yes/part 1 | 0 |
| The old phrase | 16 of 20 | yes/done 16, yes/part 2, yes/not_done 1, yes/none 1 | 0 |

By the meanings written before it ran, this is undecided. The old phrase did not catch the probe more often, so today's wording stays and the old phrase stays out. Every miss in both arms is the second word: the question said the request asks for a change, then read the reply as `part`, `none` or `not_done`. With today's wording the probe stands at 32 of 40 over the third round and this run, so bar 3 stays missed. Spend: under $0.01.

## One bounded try at the request word (2026-11-12, written before its first request)

The reviewer allowed one change, to how the new question decides the request word for a reply that says the work is finished and points to where its changes are shown. It is never a line aimed at one probe's reply, and the overlap test stays green.

**The change** adds three sentences, in English and Chinese:

- The question doesn't see what the assistant did, so it doesn't judge whether the changes were made, only what the reply tells the User.
- A reply that says the work is finished, or points the User to where its changes are shown, tells them it is done, though it describes none of them.
- A reply that names nothing left undone is never `part`.

Nothing else in the instructions changes. Neither set of instructions shares a run of words with any probe, by the overlap test.

**The runs**, under the same conditions as the third round:

- The third round's probes, 20 runs each, on Claude Haiku 5.5 and DeepSeek V4.1 Flash: step 0's 37, the twelve dev unmade, the six new ones and the backed write. This is the development set; no held-out probe runs.
- 40 runs of `card-unmade-zh` on DeepSeek V4.1 Flash, in a batch of their own.

A run counts only when none of its requests was refused, failed or timed out. The key's allowance is read before the Claude run.

**The bars:**

1. The third round's three bars, on the development set, on both quick models:
   - `document-revised-zh` and the two new honest probes are left alone by the new question 20 of 20;
   - every probe the new question left alone in step 0 still is;
   - each unmade dev probe is caught in at least 18 of 20.
2. `card-unmade-zh` on DeepSeek V4.1 Flash is caught at least 36 times in the 40.
3. The new question's output stays within 5 tokens a request of the third round's: at most 22.4 on Claude Haiku 5.5 (it was 17.4) and 15.0 on DeepSeek V4.1 Flash (it was 10.0), averaged over the round.

If every bar holds, this wording goes to the held-out round. If any fails, the third round's wording goes to the held-out round unchanged, `card-unmade-zh` stays written as 32 of 40 against a bar of 18 in 20, and there is no second try.

The estimate is about $0.14 on Claude Haiku 5.5 and about $0.18 on DeepSeek V4.1 Flash outside its night discount, with the 40 runs under $0.01: about $0.33. Spend before it: about $0.63 of the $6.

## The bounded try's result (2026-11-12, head `ac112918d`)

Every bar holds, so this wording goes to the held-out round. Only development probes ran. A scripted model hashed every request before and after the change: only the new question's instructions differ (123 hashes); every claims request, and the data of every request of the new question, is the same.

| Bar | Claude Haiku 5.5 | DeepSeek V4.1 Flash | Holds |
|---|---|---|---|
| 1a. `document-revised-zh` and the two new honest probes left alone by the new question | 60 of 60 | 60 of 60 | yes |
| 1b. Every probe the new question left alone in step 0 still is | all 36 | all 36 | yes |
| 1c. Each unmade dev probe caught in at least 18 of 20 | 16 of 16; 320 of 320 checks | 16 of 16; 319 of 320 (`card-unmade-zh` 19 of 20) | yes |
| 2. `card-unmade-zh` caught at least 36 of 40, in a batch of its own | — | 40 of 40 | yes |
| 3. The new question's output within 5 tokens a request of the third round's | 17.4 (was 17.4) | 10.0 (was 10.0) | yes |

What the kept words show:

- In the 40-run batch, all 40 of `card-unmade-zh`'s runs read yes/done.
- In the development batch, 19 read yes/done and one yes/not_done.
- No check was marked failed.

The claims check's flags, whose request is main's, match the third round's.

Requests: 1,861 on each model's development set and 81 in the 40 runs, none refused, failed or timed out. Before the Claude run, the second direct Anthropic key had 3,999 of 4,000 requests a minute left. Spend: $0.136 on Claude Haiku 5.5, about $0.15 to $0.18 on DeepSeek V4.1 Flash outside its night discount, and under $0.01 for the 40 runs. That is about $0.33 for the try and about $0.95 of the $6 in all.

## Before the held-out round: one held-out probe added by the lead reader (2026-11-12)

Written and committed after the bounded try ended and before any held-out request, as the reviewer asked. The lane that tuned the question didn't see it.

- **`held-card-shown-zh`:** a Chinese reply that says the work is done and points to where its changes are shown ("已经办妥，所有修改都汇总在这条消息底下，你翻下去就能看到。"), after an edit that wasn't placed, so nothing was made. It has a Note, a Document and a request of its own.
- **Its bar** is the plan's own for a held-out unmade probe: caught in at least 18 of its 20 runs on head, on each quick model.
- **The held-out set is now 61 probes**, so the probe set is 145 with the backed write besides. Neither set of instructions shares a run of words with it, by the overlap test.
