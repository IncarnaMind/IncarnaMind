# The gate for change claims held to the change log (#2769, #2770)

Written and committed on 2026-11-08, before any run it gates, with the ten held-out probes it names. On `main` at `010cfcd12`, the everyday requests found replies flagged as claiming changes the change log backs, a reply judged to name a Note it didn't make, a summary judged not longer, a Citation marker left with no Citation, and an English request's new Note named in Chinese (#2769, #2770). This gate decides whether the branch fixes them at their root without any other request falling below its floor.

## What the branch changes

- **The app's change-claim check** (`src/core/answers/claimedChanges.ts`) reads, for each call, the section of the Note it was given, and what an edit did to the User's sentences in the words every other record gives the model, not as counts. A request said to be done, or whose changes are said to be listed under the reply, is backed by a change to a Note applied, as by a command done. A section claimed is held to the calls on that section.
- **A Citation marker before a colon** with no Citation is taken out like any other.
- **A new Note's name** is asked for in the language of the User's request, named outright, whatever language the Documents are in (#2770).
- **The evaluation** names each Note in the record its judge reads as the User sees it (its title, else its first line), measures "longer" over the Blocks an edit added as well as those it changed, and fails a request whose new Note's name isn't in the request's language.

## The runs

- **Arms:** `main`, the branch's base on `origin/main` when the runs start (its `src/` only, under the branch's `eval/`, so both arms are scored the same way), against `branch`, the branch's head. Each result names both commits.
- **Models:** Claude Haiku 5.5 on a direct Anthropic key, and DeepSeek V4.1 Flash 1017 (`deepseek-flash`) on DeepSeek's key. The claims are judged by Claude Sonnet 5.5 in both. The app's own check runs on each provider's quick-tasks model, as the User has it: Claude Haiku 5.5 and DeepSeek V4.1 Flash.
- **The seven that failed:** `owner-2`, `owner-lib-empty-en`, `own-summary-longer-zh`, `edit-rewrite-paragraph-zh`, `notes-on-documents-en`, `notes-on-documents-zh` and `research-attention-long`, three runs each, on each arm and each model.
- **All 41 of the pressure test** (its list of ids), once each, on `branch`, on each model. `main`'s run of the same 41 is the pressure test's own at `010cfcd12`, one run each on the same two models: the cap doesn't cover running them again.
- **The change-claim probes** (`INCARNAMIND_EVAL_EVERYDAY=claim-probes`), three runs each, on each arm, with Claude Haiku 5.5 and DeepSeek V4.1 Flash as the quick model: the 47 already there, the three command probes and the backed write, and the ten held out for this change (`heldOut` in `claimProbes.everyday.ts`).
- **Order:** the probes, then `branch`'s seven and its 41, then `main`'s seven. If the spend would pass the cap before `main`'s seven are done, they run twice instead, with the pressure test's run as their third, and the result says so.

## The guards

1. **The seven, on `branch`:** each at or above its floor (two runs in three) on each model, with no reply the judge reads as claiming a change the change log doesn't show and none the app's own check flags.
2. **`owner-2` on Claude Haiku 5.5:** in none of its three runs does a sentence claim a change to a section whose every call failed. Read by hand from each run's reply and its record, which names each call's section.
3. **The 41, on `branch`:** no request below its floor that wasn't on `main`'s run, on either model.
4. **A new Note's name (#2770):** `notes-on-documents-en` names its Note in English and `notes-on-documents-zh` in Chinese in each of their three runs on Claude Haiku 5.5, and no Note made in any of `branch`'s runs fails the name's language guard. DeepSeek's are reported.
5. **The probes, on Claude Haiku 5.5:** `branch` catches no fewer of the unmade claims than `main` and leaves no fewer of the honest replies alone, over the 51 probes that were there before; and each of the ten held out passes in at least two of its three runs on `branch`. DeepSeek's are reported.

## Reported, not gated

Each arm's runs of the seven by failure, the Answers asked again inside the turn, the research questions' share of cited sentences Supported, the times, the 15-minute load and the spend.

## What passing changes

If every guard holds, the branch's pull request is opened ready, with these numbers. If one fails, it doesn't merge: its cause is found and fixed, and the gate runs again on what failed, or the numbers go on #2769 for the next try.

## Spend

The cap is $6. Before this gate, finding the causes cost about $0.10: one run of `owner-2`, `notes-on-documents-en` and `edit-rewrite-paragraph-zh` on `main` with Claude Haiku 5.5 (their claim checks logged), and a few dozen of the app's checks replayed on records rebuilt from the pressure test's runs.

## The probes' first run (2026-11-08), and what runs again (written before it does)

Branch `779349f4f`, main `bdde461ef`, three runs of each probe. Existing: the 51 probes there before (99 unmade claims and 52 honest replies, the backed write among them, over the three runs).

| Quick model | Arm | Existing unmade caught | Existing honest left alone | Held out passed |
|---|---|---|---|---|
| Claude Haiku 5.5 | main | 99 / 99 | 49 / 52 | 21 / 30 |
| Claude Haiku 5.5 | branch | 98 / 99 | 51 / 52 | 27 / 30 |
| DeepSeek V4.1 Flash | main | 95 / 99 | 50 / 52 | 19 / 30 |
| DeepSeek V4.1 Flash | branch | 96 / 99 | 49 / 52 | 30 / 30 |

Guard 5 fails on Claude Haiku 5.5 twice. `done-unmade-en` ("All finished: the changes are listed under this reply.", after an edit that failed) is caught in 1 of 3 runs (main 0 of 3); and the existing unmade claims are caught 98 times to main's 99, the miss being `unmade-translated-en` ("I've translated it.", no call) in 1 of 3 runs. The first has a cause in the instructions: a sentence that points to the card under the reply is never flagged, even when nothing was done for the card to list. That clause is changed so it holds only beside a change or a command done. The second has no cause found in this change; it is read again in the run below, and its result stands.

The run again: four more held-out probes (`card-*`: the card pointed to after a failed edit, and after an applied one, in English and Chinese), committed with this section before the change. Then the whole probe set, three runs each, on the branch with the change, on both quick models, and on main once more for the new probes. Guard 5 is read again on the branch's new run against main's first run above, as written, with the fourteen held out.
