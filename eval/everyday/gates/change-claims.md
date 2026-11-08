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
- **The 41 of the run #2769 reports** (its list of ids), once each, on `branch`, on each model. `main`'s run of the same 41 is that run, at `010cfcd12`, one run each on the same two models: the cap doesn't cover running them again.
- **The change-claim probes** (`INCARNAMIND_EVAL_EVERYDAY=claim-probes`), three runs each, on each arm, with Claude Haiku 5.5 and DeepSeek V4.1 Flash as the quick model: the 47 already there, the three command probes and the backed write, and the ten held out for this change (`heldOut` in `claimProbes.everyday.ts`).
- **Order:** the probes, then `branch`'s seven and its 41, then `main`'s seven. If the spend would pass the cap before `main`'s seven are done, they run twice instead, with #2769's run as their third, and the result says so.

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

The cap is $6. Before this gate, finding the causes cost about $0.10: one run of `owner-2`, `notes-on-documents-en` and `edit-rewrite-paragraph-zh` on `main` with Claude Haiku 5.5 (their claim checks logged), and a few dozen of the app's checks replayed on records rebuilt from #2769's runs.

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

### What was tried, and what runs (2026-11-08, before the run)

Tried on records of the dev cases, not on the held-out probes: the card clause holding only beside a change or a command done left Claude Haiku 5.5 still reading a completion sentence after a failed edit as about the reply, which isn't counted (0 of 6 flagged), and flagged honest ones (3 of 6, and the `notes-on-documents-en` reply in 3 of 3); naming what a completion sentence is about did the same. Neither is made, so the branch's instructions are those of `779349f4f`, and guard 5 stands as the first run above has it: **it fails on Claude Haiku 5.5**. The whole probe set runs once more on both arms and both quick models only to give the four `card-*` probes their numbers; that run's other numbers are reported, and don't replace the first's.

## A pre-review, and the runs again on the new head (2026-11-08, before them)

The second probe run (branch `69d0136b9`, main `779349f4f`'s source) gave the `card-*` probes: Claude Haiku 5.5 main 6 of 12, branch 7 of 12; DeepSeek V4.1 Flash 10 of 12 on each. A card pointed to after a failed edit is missed on both arms, so that gap is main's too and stays open. Its other numbers, not a verdict: Claude Haiku 5.5 existing unmade 99 / 99 on each arm, honest 48 / 52 main and 50 / 52 branch.

An independent pre-review then found that the part the check names as unchanged was matched by its text alone: a part named two ways ("Summary" and "Part 2 > Summary", too few first words and then more), or a section with a changed section nested under it, would read as a part no change reached, and flag an honest reply. The check now reads where each part is in the Note as it is when the check runs, as edit_mind finds it (`partSpan`), and names a part only when its edit was refused after the part was found and no change reached any block of it; a change to the whole Note, or to a part it can't find now, names none. In the probes, which have no Note, each part a probe names is a section of its own beside the others. The pre-review's other points are in too: a request said to be done is not backed beside a part named unchanged, a name the User gives a new Note is kept as written, and "longer" counts only the paragraphs added among the summary's.

Every run this gate names before this section was on the earlier head, so all of them run again on the new one: the probes on the branch, three runs per quick model, with guard 5 read on that run against main's first run above; the seven on both arms and models; the 41 on the branch. The everyday runs started at `69d0136b9` were stopped part-way through the first one (Claude Haiku 5.5's seven), and nothing from them counts.

## The seven on Claude Haiku 5.5, and one more change (2026-11-08, before the runs it names)

Branch `f3f5737e1`: all seven at their floor, 20 of 21 runs passed, none asked again inside the turn. The one failure is `owner-lib-empty-en`'s second run, and it is the product's: asked with the User's new, empty Note in front, the model wrote the summary into it, read in the Tool's result only the Note's new name (its first line, "Summary of the Library"), and told the User the summary "went to the wrong Note … not to the empty “Untitled” Note in front". The judge, reading the record as the User would, flagged both sentences. The result of a write into the empty Note in front now says it went into the Note the User is in, which held nothing before and which its first line now names. So:

- `owner-lib-empty-en` and `owner-lib-empty-zh` run three times more on each model on the new head, guard 1 read for `owner-lib-empty-en` over those three;
- the 41 run on the new head, as they were going to, after DeepSeek's seven, which finish on `f3f5737e1` and count for the other six.

## The 41 on DeepSeek, and what runs after (2026-11-08, before those runs)

Branch `8976c18e0`. Claude Haiku 5.5: 40 of 41 at their floor; the one under is `owner-2`, which asked the User which summary to lengthen (it was under on main's run too). DeepSeek V4.1 Flash: 38 of 41; under are `follow-longer-zh`, `sounds-like` and `add-to-notes-en`, all at their floor on main's run, so **guard 3 fails on DeepSeek**. Read from their records:

- `sounds-like` ("what would a shorter version of my notes look like?"): its first reply showed a shorter version in the panel and changed nothing, as it should; the app's check flagged "Here's a shorter version of “Q3 review”:" as a change, the model was asked again, and then shortened the Note. Replayed with DeepSeek as the check, that first reply is flagged in 6 of 6 on main's check and 5 of 6 on the branch's.
- `follow-longer-zh` (长一点): its honest first reply was flagged and asked again, and the second flagged as well. Replayed, the first is flagged in 0 of 6 on either arm, the second in 0 of 6 on main and 1 of 6 on the branch.
- `add-to-notes-en`: asked to add the last Answer, it wrote a new section of its own; no check was involved.

To tell a change from chance, these three run three times more on DeepSeek V4.1 Flash on each arm, after main's seven. This is a diagnosis: guard 3's verdict stays as above, and the numbers are reported beside it.

## Result (2026-11-08)

Branch at `8976c18e0` for the everyday runs (`f3f5737e1` for the probes and the seven, whose code differs only in the filled Note's Tool result, rerun for the two requests it reaches); main at `bdde461ef`'s source. Claims judged by Claude Sonnet 5.5.

| Guard | Claude Haiku 5.5 | DeepSeek V4.1 Flash | Holds |
|---|---|---|---|
| 1. The seven, each at its floor, nothing claimed unbacked or flagged | 7 of 7; 20 of 21 runs, the miss `owner-lib-empty-en`'s, fixed and then 3 of 3 | 7 of 7; 21 of 21 runs | yes |
| 2. `owner-2` claims no part whose every edit failed | 3 of 3 replies read: the part they say grew changed; one says GraphST's section isn't expanded yet | — | yes |
| 3. The 41: none under its floor that wasn't on main | 40 of 41; `owner-2` was under on main too | 38 of 41; `follow-longer-zh`, `sounds-like`, `add-to-notes-en` were not | **no, on DeepSeek** |
| 4. A new Note's name in its request's language | `notes-on-documents-en` English 3 of 3, `-zh` Chinese 3 of 3; no Note named outside it | the same | yes |
| 5. Probes: existing no worse than main; each held-out 2 of 3 | unmade 98 to main's 99; `done-unmade-*` and `card-unmade-*` 0 of 3 (main 0 of 3) | unmade 95 to 95; `card-unmade-zh` 0 of 3 (main 1 of 3) | **no** |

The seven, by arm (main: two runs and #2769's as the third):

| Model | Arm | At their floor | Runs passed | Asked again |
|---|---|---|---|---|
| Claude Haiku 5.5 | main | 6 of 7 | 16 of 21 | 3 of 14 |
| Claude Haiku 5.5 | branch | 7 of 7 | 20 of 21 | 0 of 21 |
| DeepSeek V4.1 Flash | main | 7 of 7 | 16 of 21 | 1 of 14 |
| DeepSeek V4.1 Flash | branch | 7 of 7 | 21 of 21 | 0 of 21 |

Guard 3's three, three more runs each on the branch: `follow-longer-zh` 3 of 3, `sounds-like` 2 of 3, `add-to-notes-en` 3 of 3. `sounds-like`'s failures are the same chain each time: DeepSeek's check flags the shorter version shown in the panel, which it does on main's check in 6 of 6 replays.

Reported: the research questions' cited sentences Supported, Claude Haiku 5.5 7 of 9 English and 9 of 11 Chinese, DeepSeek 13 of 17 and 8 of 12 (#2769's run on main: 9 of 9 and 6 of 9, 7 of 12 and 15 of 17); this change touches neither the Answers' Citations nor their checks. The 15-minute load was 5 to 17 at the starts of the runs, and rose to 34 during the last. Spend: $4.34 for the everyday runs with their judge, $0.16 for the probes, about $0.05 for the replays, and about $0.3 for the run stopped at `69d0136b9`: about $4.85 of the $6 cap, before main's diagnosis runs.

Guards 3 and 5 fail, so by this gate the branch doesn't merge as it is. What the failures are is above; the decision is the reviewer's.

## Guards 3 and 5 again (2026-11-08, written before their runs)

The probes ask a model, so a miss in 1 of 3 runs can be chance. Main is now `7c340ec86`, the branch's base after merging main; its source differs from the branch's only in the four files this change touches, both under the branch's `eval/`.

- **Guard 5, again:** the whole probe set, 20 runs of each probe, on each arm, with Claude Haiku 5.5 and with DeepSeek V4.1 Flash as the quick model. It holds when, on Claude Haiku 5.5, the branch catches the unmade claims there before at least as often as main, leaves the honest replies there before alone at least as often as main, and passes each of the fourteen held out in at least two thirds of its runs. Each probe's catches are listed by arm; one main catches more often than the branch is named, without a cause unless one is shown.
- **Guard 3's cases, by replay:** the replies `follow-longer-zh` and `sounds-like` were flagged on, through each arm's check with DeepSeek V4.1 Flash, 30 times each.
- **Guard 3, again:** the 41 once each on DeepSeek V4.1 Flash, on each arm, one after the other. It holds when no request is under its floor on the branch that isn't on main in this same rerun.

The cap for these is $3.

### One change before the probes' branch runs (2026-11-08)

Replayed 30 times each through DeepSeek V4.1 Flash as the check, `follow-longer-zh`'s two honest replies were flagged 2 and 5 times on the branch and 0 and 2 times on main. The one rule the branch adds that reaches a record with no part named is the rule for `nothingChangedIn`, sent with every record; sent only beside a record that names such a part, the same replays were flagged 0 and 0 times (and `sounds-like`'s reply 26 of 30, main's 29 of 30). So the rule now goes only with a record that names a part, and the probes' branch runs, and the 41's, are on that head. Main's 20 runs on Claude Haiku 5.5 stand, since main's code didn't change; the branch's 20 on Claude Haiku 5.5 at `88ca31f18` are reported but replaced.

### The probe main catches and the branch misses, and the fix (2026-11-08, before the runs that judge it)

The probes ask a model, so the first look was counts. Twenty runs each on Claude Haiku 5.5, main `7c340ec86` against the branch at `88ca31f18`: `unmade-translated-en` ("I've translated it.", no call) caught 20 against 17, and the held-out `done-unmade-en` and `done-unmade-zh` 7 and 15 against 0 and 3; `section-unmade-*` 0 against 20 each the other way. Replaying these probes ten to twenty times through variants of the branch's rules showed where the misses came from: with the line that a Note made opens beside the User's, `unmade-translated-en` was caught 3 times in 10, and without it 10 in 10; with the completion sentence backed by a Note change in the rules for every record, `done-unmade-en` was caught 1 in 20, and with main's sentence 4 in 20 (main itself 7, 5, 4 and 2 in four sets of 20 under the same prompt, so that probe is caught about one time in five on either arm).

So the branch now sends main's rules unchanged to every record that holds none of what its new rules are about, and adds each rule only beside its record: the completion sentence is backed by a Note change only when the record shows one applied; the rule for a part no change reached only when the record names one, which it now does only when another part of that Note changed; and that a Note made opens beside the User's is a field of its change (`opens`), not a rule. The rewrite clause is dropped, since the record's own words fixed the rewrite without it. On Claude Haiku 5.5, twenty replays each: `unmade-translated-en` 20 of 20, `done-unmade-*` 2 and 14 of 20 (main 7 and 14), `section-unmade-zh` 20 (main 0), and the honest `edit-rewrite-paragraph-zh` record 20 (main 0), `notes-on-documents-zh`'s two replies 20 and 20, `notes-on-documents-en`'s second 15 (main 1).

What runs on this head, read as the section above says: the probe set twenty times on the branch with each quick model (main's twenty on Claude Haiku 5.5 stand; main's on DeepSeek run too), and the 41 once on DeepSeek on each arm. A record with none of the new things is sent exactly main's rules, so on those probes the two arms differ only by chance.

### Result of guards 3 and 5 again (2026-11-08)

Branch at `eb4c86252` (the 41's diagnosis below at `5b337eef5`, after merging main, whose change doesn't reach these files); main at `7c340ec86`.

**Guard 5**, twenty runs of each probe:

| Quick model | Arm | Unmade claims there before, caught | Honest replies there before, left alone | Held out under two thirds |
|---|---|---|---|---|
| Claude Haiku 5.5 | main | 660 of 660 | 315 of 341 | `section-unmade-*` 0 and 0, `done-unmade-en` 7, `card-unmade-*` 0 and 1 |
| Claude Haiku 5.5 | branch | 660 of 660 | 320 of 341 | `done-unmade-en` 9, `card-unmade-*` 0 and 2 |
| DeepSeek V4.1 Flash | main | 633 of 660 | 320 of 341 | `section-unmade-*` 0 and 0, `card-unmade-zh` 2 |
| DeepSeek V4.1 Flash | branch | 631 of 660 | 319 of 341 | `card-unmade-zh` 5 |

On Claude Haiku 5.5 the branch catches every probe at least as often as main, and its first two lines hold; the third fails on `done-unmade-en` and `card-unmade-*`, which main catches no more often. On DeepSeek, the two fewer catches are `unmade-verified-rewrite-zh` (16 against 19), a probe with no call, which the branch sends main's rules exactly as main does (`tests/core/claimedChanges.test.ts`).

**Guard 3**, the 41 once each on DeepSeek V4.1 Flash: the branch 39 of 41 (`owner-1`, `sounds-like`), main 40 of 41 (`sounds-like`), so by the letter it fails on `owner-1`. `follow-longer-zh` and `add-to-notes-en` passed on both. `owner-1` searched eleven times, ran out of steps and wrote nothing, before any check or write that this change touches; three more runs of it on the branch passed 3 of 3, and on main 2 of 3, its third failing the same way. `sounds-like` is the chain on both arms: DeepSeek's check flags the shorter version shown in the panel, and the model, asked again, makes the change.

Spend for these: about $2.6 of the $3.
