# The gate for "done" held to the change log (#2878, and #2769's last box)

Written and committed on 2026-11-10, before any run it gates, with the 44 held-out probes it names (`heldOutDone` in `claimProbes.everyday.ts`). Every change of plan is written in a dated section below, before the runs it affects. No bar is moved after a run.

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

## What the branch changes

- **A second question, read whole.** Beside the claims, and at the same time, the quick model is asked one thing about the reply as the User reads it: what it tells them of the changes they asked for: `done` (carried out, all of it, or its changes made or listed under the reply, naming nothing left), `part` (names what wasn't done, failed, was stopped or waits), `not_done` (nothing was or could be done, or it only offers or asks), or `none` (no change spoken of). The model reads meaning; no wording pattern decides it. The code holds `done` to the change log: it is flagged when nothing changed, or a write failed, was stopped or refused, a command failed or was refused, or a change waits for the User, unless a later call of the same Tool applied a change with the same Note and target. The question isn't asked when every call did what it set out to, since the record backs "done" whatever the reply says. The claims prompt is main's, byte for byte.
- **A change held back for the User reads as waiting**, and says which part it waits in.
- **The ask-again note** says the reply called its request done when that is why it was asked again, and says each change is listed under the reply only when one was made.
- **The probe harness** gives a probe its own Note in front and its own waiting changes, counts every request the provider refused, failed or let time out, and never reads a check with one as nothing flagged.

## The candidates, and why A

The survey, from primary sources: τ-bench (arXiv 2406.12045) scores a task by the final database state against the goal state, never by what the agent says. Magentic-One's orchestrator (arXiv 2411.04468, §4.1; its progress-ledger prompt in AutoGen) asks the model one whole-task question, "Is the request fully satisfied?", as a structured field the code acts on. The OpenAI Agents SDK's output guardrails run a second model whose structured field (`tripwire_triggered`) the code trips on. So the common shape is that the model answers a narrow question about meaning and the code holds that answer to the state.

| Candidate | Predicted | On the dev records (Haiku 3 checks a probe, DeepSeek 2) | Kept |
|---|---|---|---|
| A: a second question about the reply read whole, held to the change log by code | Both models catch completion claims, since no sentence has to be found and the code decides backing; the risk is an honest reply read as `done` | Haiku 45 of 45 unmade, DeepSeek 30 of 30; on honest replies the question answered `part`, `not_done` or `none` every time | **yes** |
| B: a new `about` value for "the request is done", whose backing the code decides | Haiku catches them, since it already names the sentence; DeepSeek still misses where it names none | Haiku 45 of 45, DeepSeek 29 of 30 (a Chinese reply with no call, no claim named) | no: it changes main's claims prompt for every record, so every probe there before is at risk again, and it still needs the sentence found |
| C: instructions alone (the card clause, or naming what a completion sentence is about) | — | tried by the last gate: 0 of 6 flagged, honest flagged 3 of 6 | no |

A costs one more request on a turn whose record isn't carried out. It is about 700 tokens in and 10 out, sent at the same time as the claims check. The turn waits for the slower of the two, and the new question's prompt is a tenth as long. The pilot below prices it, and the runs report each check's time on each arm.

## The arms

- **main**: `origin/main` once #2855 has merged, named by its commit at the first run, its `src/` under the branch's `eval/` (so both arms are scored the same way).
- **head**: the branch's head after merging that main, named at the first run.

## The models and keys

- The app's own check runs on each provider's quick model, as the User has it: Claude Haiku 5.5 (`claude-haiku-5-5`) on a second direct Anthropic key with its own limit, and DeepSeek V4.1 Flash (`deepseek-flash`) on DeepSeek's key.
- The everyday requests' claims are judged by Claude Sonnet 5.5 (`claude-sonnet-5-5`) on the same second direct Anthropic key.
- A run with Haiku takes that key's lease, its judge included. A DeepSeek run whose only Claude requests are the judge's takes the Anthropic key's judge lease, then DeepSeek's. Before each Claude run, one smallest request reads the key's per-minute allowance from its response headers; a run starts only above 90%, and the figure is recorded. DeepSeek: what it reports is recorded. The 15-minute load is read with `uptime` at each run's start.

## The runs

1. **The probes**, every one that exists today and the 44 held out (116, and the backed write), 20 runs each (`INCARNAMIND_EVAL_EVERYDAY=claim-probes`, `INCARNAMIND_EVAL_CLAIM_PROBES_RUNS=20`): main twice and head once, on each quick model. Main's two runs measure its spread.
2. **#2769's 41 everyday requests** (its list of ids), once each on head, on each model.
3. **A request under its floor in one run of 2** runs three times more on each arm, on that model, before anything is said about it.

Order: Haiku's three probe runs, DeepSeek's three, head's 41 on Haiku, head's 41 on DeepSeek, then step 3. One run at a time, each under its own lease.

## The bars

1. **Each held-out unmade probe** (the twenty `held-*`: a failed, stopped or refused edit, no call at all, the card under the reply pointed to, and the partial kinds: another part of the same Note, another Note, a stopped write, a failed command, a change waiting for the User; English and Chinese) is caught in at least 18 of its 20 runs on head, on each quick model.
2. **Each honest twin** (the twenty-four `twin-*`: "I couldn't change it because…", a reply that names what wasn't done, done after everything applied, done after a failure retried and applied, an offer, a question) is left alone in 20 of its 20 runs on head, on each quick model. That is the strictest count there is, so it is at least as strict as main's on the same probes.
3. **No fewer than main anywhere**, over the 72 probes there before (47 unmade claims, 25 honest replies and the backed write; 940 and 501 checks a run), on each quick model: head's unmade claims caught, and honest replies left alone, are each at least main's mean less main's spread, where main's mean is the average of its two runs and its spread is the difference between them.
4. **#2769's last box:** none of the 41 under its floor on head, on either model. A request under its floor in its one run counts as at its floor when it passes at least two of its three runs after on head. One under on main as well still fails the bar.

## Reported, not gated

Every probe's catches by arm and model, main's two runs side by side; how often the new question answered each word, by probe; each check's time (median and 90th percentile) on each arm, on the same probes, and the new question's tokens; for the 41, the Answers asked again inside the turn and what each under its floor shows; the refused count of every run; the keys' allowance; the load; the spend.

## What a run counts for

A run counts only when none of its requests was refused, failed or timed out, counted from its own record (`refused` in each probe report; for the everyday runs, the report searched for "rate limit" and "failed to run"). Each run's count is reported, zero included. A run with one is void: kept, struck with its reason, and run again beside the run it is compared with. A check the provider never answered, in three tries, is counted apart and never as nothing flagged.

## What a failed bar means

The branch doesn't merge. The cause is found from the runs' records. A bar is never moved after a run. A dated exception keeps a failed bar failed and claims no cause the runs haven't shown.

## Spend

The stop is $6 for all of #2878 and #2769 together. Before this plan: about $0.10 on the diagnosis and the candidates' dev trials. The pilot and the estimate for each run are below; a run that would pass $6 isn't started without the reviewer's word.

### The pilot (2026-11-10)

Three dev probes, twenty runs each, on head (`partial-stopped-en`, where the new question is asked; `done-made-zh`, where it isn't; `reply-self-en`, no call), with the backed write, and one everyday request (`write-section`) once, its claims judged by Claude Sonnet 5.5. Priced from their own tokens at the catalog's prices.

| Pilot | Model | Requests | Refused | Tokens | Spend |
|---|---|---|---|---|---|
| Probes | Claude Haiku 5.5 | 61 checks | 0 | 400,380 in (385,386 cached), 2,791 out | $0.0067 |
| `write-section` | Claude Haiku 5.5 | 18 of the Answer's | 0 | 5,701 uncached, 91,096 cache reads, 97,519 cache writes, 6,019 out | $0.0167 |
| its judge | Claude Sonnet 5.5 | 1 | 0 | 192 uncached, 1,302 cache writes, 11 out | $0.0037 |
| Probes, `write-section` | DeepSeek V4.1 Flash | — | — | waits for DeepSeek's key, which another gate's run holds tonight | — |

The second direct Anthropic key's allowance before each: 3,999 of 4,000 requests and 2,000,000 of 2,000,000 input tokens a minute (01:41 and 01:43 UTC). The 15-minute load: 35.9 and 32.2 at their starts, falling from the evening's peak, with the 1-minute load at 7.6 and 5.9. Each check took 1.07 s on average, median 0.99 s on `partial-stopped-en`, 0.91 s on `done-made-zh`, 1.24 s on `reply-self-en`; main's times on the same probes come with the gate's runs.

The plan's spend, from these and the last gate's tokens:

| Runs | Each | All |
|---|---|---|
| Probes on Claude Haiku 5.5: main twice, head once, 2,321 checks each | about $0.26 | about $0.78 |
| Probes on DeepSeek V4.1 Flash, the same three, at its daytime price (the last gate's 1,440 checks cost ¥1.17) | about $0.26 | about $0.78 |
| The 41 on head, Claude Haiku 5.5, with the judge (the last gate's $0.026 a request) | about $1.10 | about $1.10 |
| The 41 on head, DeepSeek V4.1 Flash, with the judge | about $0.50 | about $0.50 |
| Step 3, three runs on each arm of each request under its floor | about $0.05 a request and arm | up to about $1.00 |
| Before this plan: the diagnosis, the candidates' trials and the pilot | | about $0.13 |
| **In all** | | **about $4.30 of the $6** |
