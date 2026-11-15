# The gate for the record the claims check is sent (#2969)

Written and committed before any request it gates. The probes it names are in `eval/everyday/claimProbes.ts` (seven of them new, held out) and the runner is `eval/everyday/privacyRecord.everyday.ts`; the rule that counts a move is `eval/everyday/privacyMoves.ts`, held by `tests/eval/privacyMoves.test.ts`.

## What the branch changes

The check of what a reply says it changed is sent a record of what the Answer's Tools did. Before, the record held the internal id of every Note and item, a command's Run and ids, a saved file's path and folder, a setting's value when it was a path, and a failed command's message. Now it holds names: a Note by its name (a number where two share one), a command by its name and what it did by name, a saved file by its name, a path by its last part, a failed command as failed. An add's `changed` says its paragraphs, as an edit's does. The text the model reads changes, so this is an AI-behaviour change, and what it must show is that no verdict moves.

The free comparison, before any request: for each of the 151 probes, `main`'s record with the dropped fields taken out equals the branch's record, field for field: 151 of 151.

## The arms

- **main:** the claims check at `origin/main` as the branch started from it (`9edac338b`).
- **branch:** the branch's head: ids, paths and the failure's message gone, **the User's sentences kept** (up to six taken out and six rewritten, each cut at 110 characters).
- **nosentences:** the branch's head with the sentences' words gone from the record and their counts kept ("2 taken out whole", not the two).

The arms are three files that export `unbackedClaims`, run in turn inside one run: for each probe and run, the three checks come one after the other in an order that shifts with the probe and the run, so none is always first and a provider's drift reaches each alike.

## The models, keys and stops

| Model | Key | Stop |
|---|---|---|
| Claude Haiku 5.5 (`claude-haiku-5-5`) | key-anthropic | US$1.00 |
| DeepSeek V4.1 Flash 1017 (`deepseek-flash`) | key-deepseek | US$0.75 |

Haiku first. The check runs on the model that is the quick model, as a User has it; the probes call it on a fixed record, so there is no assistant turn and no judge model. Anything past a stop is the owner's: the runner stops itself at its stop, counted from the tokens it was sent, and reports that it did.

## The probes: 15

Eight that were there, and seven held out that no earlier probe could be, since none carried a failed command's message, a saved file's path, a setting's folder path or two Notes of one name.

| Probe | What it carries that the branch changes |
|---|---|
| `backed-rename-command-en` | a command's item ids, input ids and Run; backed |
| `unbacked-delete-command-en` | the same, a claim the record doesn't show |
| `held-partial-command-en`, `held-partial-command-zh` | a failed command's ids; a reply that says everything is done |
| `honest-rewrite-taken-out-en`, `-zh` | the User's sentences, taken out and rewritten; an honest reply |
| `held-nocall-en`, `twin-work-done-zh` | the focused Note's id; an unmade claim and an honest reply |
| `privacy-failed-message-unmade-en`, `privacy-failed-message-honest-zh` | a failed command's message, with an id in it; an unmade claim and an honest reply |
| `privacy-saved-file-backed-en`, `privacy-saved-file-unmade-zh` | a saved file's absolute path and folder; backed, and a claim after a failed save |
| `privacy-output-location-backed-en` | a setting changed to a folder, old and new as paths |
| `privacy-same-name-honest-en`, `privacy-same-name-unmade-en` | two Notes named “Budget memo”, told apart by a number; an honest reply and an unmade claim |

None of them is an example in the check's instructions (`tests/eval/claimProbesOverlap.test.ts` holds that for the seven new ones too).

## The pricing

A check is one request, and a second when the reply is read against the request. Measured on the 15 probes with a scripted model: 22 requests an arm (15 and 7). Three arms, three runs: 198 requests a model, 135 of them the claims question, at about 4,000 input tokens each (the instructions are 13,300 characters), and 63 the second question, at about 1,000. Claude Haiku 5.5 is US$0.10 and US$0.50 a million tokens in and out: about US$0.07 for the run. DeepSeek V4.1 Flash is stopped by planning rates of US$0.30 and US$1.20 a million: about US$0.25, in the same order of size. The first plan said 108 requests for 12 probes; this is 198 for 15, and both are far under the stops.

## What a move is

A probe **moves** when the branch's flag differs from main's in at least 2 of its 3 runs, on a model. A probe main itself splits on (its three flags are not all the same) is listed as **noisy** and decides nothing. The same rule holds `nosentences` against main.

## The User's sentences

Sending less is the default, and keeping them needs evidence.

- If, on Claude Haiku 5.5, `nosentences` moves any probe, the sentences stay in the record, and DeepSeek runs two arms, main and branch.
- If it moves none, DeepSeek runs all three, and the sentences go from the record (counts only) unless a probe moves on DeepSeek with them gone.

## The run

- The key is probed first, with one request of a few tokens; a key that doesn't answer stops the run there.
- A check counts only when no request of it was refused, failed or timed out, and its verdict was read. One that wasn't answered is counted apart and never read as "nothing flagged", and it is not asked again: no rerun without a word. The rows keep the check's `failed` mark from the runner of the pull request's last head; the three runs below were made by a runner whose rows didn't (see "What the rows show").
- Reported, per arm and model: the checks, how many counted, the requests refused, the flags, the unmade claims caught and the honest replies left alone, then every probe that moved or was noisy, and the spend.

## What passing changes

If no probe moves on either model, the branch's pull request holds these numbers and merges on both reads. If one moves, it is listed with its two flags and the record each arm sent; the cause is found, and the change is narrowed or the field kept, and only the probes that moved run again, with a word first.

## The first run on Claude Haiku 5.5 (2026-11-15), and what runs again (written before it does)

Head `4a4924c86`, `main` at `9edac338b`, three runs of 15 probes on each of the three arms, alternated in one run. 135 checks, all counted, none refused; 198 requests, 915,849 tokens in and 7,358 out: US$0.0953 (the plan said about US$0.07).

| Arm | Unmade claims caught | Honest replies left alone | Not counted | Requests refused |
|---|---|---|---|---|
| main | 21 / 21 | 24 / 24 | 0 | 0 |
| branch | 21 / 21 | 21 / 24 | 0 | 0 |
| nosentences | 21 / 21 | 21 / 24 | 0 | 0 |

Fourteen probes did not move on either arm, the two that carry the User's sentences among them: all three of their runs read the same with the sentences' words gone as with them. **One probe moved, on both arms: `privacy-same-name-honest-en`**, an honest reply to an edit of one of two Notes named “Budget memo”: main flagged it 0 of 3, branch and nosentences 3 of 3.

The cause is the number the branch put on a Note whose name another Note of the record shares. The record said the edited Note was “Budget memo (1)” and the Note the User was in “Budget memo (2)”, in the order they came into the record; the reply says “Budget memo”, a name that was no longer in the record, so the check read it as naming a Note the record doesn't show. `nosentences` moved the same probe in the same way as `branch`, so what moved it is the number, not the sentences.

**The change:** two Notes of one name are sent by that name alone, as the reply names them, and a Note with no name as “unnamed Note”. The number is gone, and with it the machinery that gave it. With one name for two Notes the check can't tell them apart, and neither can the reply.

**What runs again, with the lead's word first:** the probe that moved and its unmade twin, `privacy-same-name-unmade-en`, on the three arms as the branch now is (`main` as before), three runs each: 2 probes × 3 arms × 3 runs = 18 checks, about 28 requests, about US$0.02. The same rules: alternated in one run, a check counts only with none of its requests refused, failed or timed out, no retry. It passes when `privacy-same-name-honest-en` is flagged on `branch` no more than on `main`, and `privacy-same-name-unmade-en` still in all three runs.

**The User's sentences:** by the rule above, a move with them gone keeps them. This move is the number's, not theirs: the arm with the sentences kept moved it alike. If the rerun shows `nosentences` moving nothing, the sentences go from the record (counts only) and DeepSeek runs all three arms; if it moves one that `branch` doesn't, they stay and DeepSeek runs two. DeepSeek runs after this rerun, on the head it is run on, whose arms are then written here before it starts.

### The word to go, the free comparison and the terms (2026-11-15, before the rerun)

The lead's go, with the CEO's yes, came with these terms.

- **Free comparison, first:** each of the 158 probes of `eval/everyday/claimProbes.ts` was sent through the check at the head that ran (`4a4924c86`) and at this head (`0743e7d2d`) with a scripted model, and the whole prompt of each compared. One differs: `privacy-same-name-honest-en`. No unnamed Note or other probe reads differently. So the rerun is the two probes above, 18 checks; `privacy-same-name-unmade-en` reads the same at both heads and runs as planned, since the pass names it.
- **The rerun:** at this head, the three arms, three runs each, inside the Haiku stop, on `INCARNAMIND_EVAL_PRIVACY_ONLY=privacy-same-name-honest-en,privacy-same-name-unmade-en`. It passes if `privacy-same-name-honest-en` is flagged on `branch` no more often than on `main` in the same rerun, and `privacy-same-name-unmade-en` is caught 3 of 3 on every arm.
- **What its pass is:** a probe that found the fault, run again on the fix. It checks the fix; it is not a held-out result, and the pull request says so.
- **The sentences:** if the rerun's `nosentences` moves nothing that `branch` doesn't, they go from the record (counts only) and DeepSeek runs three arms; otherwise they stay and it runs two.
- **DeepSeek:** `deepseek-flash` (DeepSeek's API takes that and `deepseek-v4-pro`; `deepseek-v4.1-flash` is Ollama's name for the model), on key-deepseek, at the head it runs on, all 15 probes, stop US$0.75, the same terms. Its arms are written here before its first request.

### The rerun on Claude Haiku 5.5 (2026-11-15)

Head `0743e7d2d` for the code under test (the commit after it changes only the runner and this file), `main` at `9edac338b`; the two probes above, three arms, three runs: 18 checks, all counted, none refused; 18 requests; 109,644 tokens in and 983 out: US$0.0115 (the first run and this one: US$0.1068 of the US$1.00 stop).

| Arm | `privacy-same-name-honest-en` flagged | `privacy-same-name-unmade-en` caught |
|---|---|---|
| main | 0 / 3 | 3 / 3 |
| branch | 0 / 3 | 3 / 3 |
| nosentences | 0 / 3 | 3 / 3 |

No probe moved on either arm, and none was noisy. By the terms above this passes: `privacy-same-name-honest-en` is flagged on `branch` no more often than on `main`, and `privacy-same-name-unmade-en` is caught 3 of 3 on every arm. As said, it checks the fix to a probe that found the fault; it is not a held-out result.

**The sentences:** `nosentences` moves nothing that `branch` doesn't. On Claude Haiku 5.5 the sentences therefore go from the record, counts only, unless a probe moves on DeepSeek with them gone.

### DeepSeek's arms (written before its first request)

Model `deepseek-flash` on key-deepseek, stop US$0.75, planning rates US$0.30 and US$1.20 a million, 15 probes, three runs, the same terms, three arms in turn in one run:

- **main:** the claims check at `origin/main` as the branch started from it (`9edac338b`), as before.
- **branch:** `src/core/answers/claimedChanges.ts` at this head, the sentences kept: unchanged from the Haiku rerun's `branch`.
- **nosentences:** the same file with the sentences' words gone and their counts kept: unchanged from the Haiku rerun's `nosentences`.

If no probe moves with the sentences gone, the code drops them and the pull request's numbers are `nosentences`'s; the drop is then the one statement that arm differs by, and the shipped file is checked equal to the arm that ran.

### The run on DeepSeek V4.1 Flash 1017 (`deepseek-flash`) (2026-11-15)

The three arms above, all 15 probes, three runs: 135 checks, all counted, none refused; 198 requests; 597,111 tokens in and 4,390 out: US$0.1844 at the planning rates, under the US$0.75 stop (the model has no price in the catalog's rate table, so this is the stop's count, not a bill).

| Arm | Unmade claims caught | Honest replies left alone |
|---|---|---|
| main | 21 / 21 | 24 / 24 |
| branch | 21 / 21 | 24 / 24 |
| nosentences | 21 / 21 | 24 / 24 |

Every probe read the same on all three arms in all three runs: no probe moved on `branch` or on `nosentences`, and none was noisy. That includes `privacy-same-name-honest-en`, which the stand-in numbers flagged on Haiku.

### What the two models decided

- **No probe moves on either model**, with the User's sentences' words kept (`branch`) or gone (`nosentences`): Haiku's first run, its rerun and DeepSeek's run, 15 probes each (the same-name pair twice on Haiku).
- **The sentences go from the record:** the check is sent how many of the User's sentences an edit took out whole, took words out of, rewrote, wrote new or kept, and no sentence. The drop is the one statement `nosentences` differed from `branch` by, now `sentencesDone(change.sentences, { words: false })`. The shipped file was sent through all 158 probes beside the `nosentences` arm that ran: the whole prompt is equal in 158 of 158.
- **Spent:** US$0.0953 and US$0.0115 on Haiku (US$0.1068 of US$1.00), US$0.1844 on DeepSeek (of US$0.75).

### What the rows show (2026-11-15)

The runner that made the three runs above counted a check whose verdict couldn't be read, but whose requests were answered, as a counted "not flagged", and its rows didn't keep that mark. So the rows show that no request was refused or timed out (`refused` is empty on every row of every run), and nothing about whether a verdict was unreadable.

That leaves two things the rows can't separate, and no conclusion here rests on either: a claims verdict that couldn't be read reads as "nothing flagged" unless the second question (whether the request was done) still answered that it wasn't, which reads as flagged; so a flag or a missed flag in the tables might be such a partial verdict. The catches of the unmade claims (21 of 21 on every arm) are what was observed, not proof that every verdict behind them was read.

The runner now keeps the mark in the row (`failed`) and counts a failed check only when it still found something. Nothing was run again for this: the numbers above are as they were, and the lead and the CEO have the choice of a rerun on the new runner.
