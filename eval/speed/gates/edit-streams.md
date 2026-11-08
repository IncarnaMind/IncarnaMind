# The gate for edit_mind's new text coming in as it is written (#1635)

Written and committed on 2026-11-07, before any run it gates.

## The step

When `edit_mind` gives the whole new text of the assistant's own text (`content`, its `part` named before it), each paragraph the model has finished takes the place of the next paragraph of the old text, as the model writes it. Before, nothing changed in the Note until the call had all of its input. The call ends exactly as the same call made whole, in one step with what came in; a call refused once whole, Stop, or a failed model takes back what came in.

## The runs

- **Arms:** `main`, the commit this step is built on, unchanged; and `step`, the head of the pull request. Both run `npm run eval:speed`, flows only, the flow `assistant-longer` (a summary added with Add to note, then "Make the summary longer.").
- **Order:** one process per arm, model, language and run, alternating `main`, `step`, `main`, `step`, so neither always meets a warm cache or a quieter machine.
- **Cells**, each a model and a language, three runs per arm:
  - Claude Sonnet 5.5 (`claude-sonnet-5-5`), direct Anthropic route, English and Chinese.
  - Claude Haiku 5.5 (`claude-haiku-5-5`), direct Anthropic route, English and Chinese.
  - DeepSeek V4.1 Flash 1017 (`deepseek-flash`), English and Chinese.
- **Kept:** each run's data folder (`INCARNAMIND_EVAL_KEEP_DATA=1`), to read what the calls did.
- **Load:** a run starts only while the 15-minute load is at most 24.
- **Cost:** about $1.20 for Sonnet, $0.50 for Haiku and $0.30 for DeepSeek.

## The bars, per cell

1. **The page changes sooner:** the step's median first change in the page is earlier than `main`'s, over the runs whose page changed, and the step's page changes in at least as many runs as `main`'s.
2. **No later by much:** no single run's Done on the step is later than `main`'s slowest run in the cell by more than `main`'s own spread (its slowest minus its fastest).
3. **No worse outcome:** on the step, no fewer runs end with the summary written over by `edit_mind` than on `main`, and no more `edit_mind` calls are refused, read from the kept data folders.
4. **The same end:** the tests of a whole call's new text in `tests/core/assistantOwnChanges.test.ts` pass unchanged, and the new tests hold that the call that came in ends as the same call made whole.

## Reported, not bars

- How much sooner the first change comes, each cell: the target is 2 to 3 seconds sooner on Sonnet.
- For each arm, how many runs' `edit_mind` call gave `content` with its `part` named first, so its text could come in.

## What decides

The step ships if every cell holds every bar. If a cell fails one, the pull request names it with its numbers, and what ships is decided in a dated note below, not by reading these bars again.

## Result, 2026-11-07

All 36 runs ran on one route per model: Claude Haiku 5.5 and Claude Sonnet 5.5 on the direct Anthropic route, DeepSeek V4.1 Flash 1017 on DeepSeek's API; `main` at 84d621707, the step at f43c66763 (the later commits change only a take-back's report, tests and the feel check). Seconds; medians of three runs, over the runs whose page changed for the first change.

| Cell | First change, `main` → step (runs that changed the page) | Done, `main` → step | Runs written over by `edit_mind` | Refused `edit_mind` calls | Bars it fails |
|---|---|---|---|---|---|
| Haiku, English | – → – (0 → 0) | 17.6 → 14.3 | 0 → 0 | 0 → 0 | 1 can't be read: no run in either arm called `edit_mind` |
| Haiku, Chinese | 24.1 → 16.3 (1 → 3) | 18.1 → 28.5 | 1 → 3 | 1 → 5 | 3 |
| Sonnet, English | 14.9 → 14.0 (3 → 3) | 23.9 → 27.9 | 2 → 1 | 4 → 3 | 3 |
| Sonnet, Chinese | 13.2 → 14.0 (3 → 3) | 27.2 → 24.3 | 1 → 2 | 3 → 3 | 1 |
| DeepSeek, English | – → 22.8 (0 → 1) | 49.9 → 58.1 | 3 → 3 | 2 → 2 | 2 (a 77.9 s run against 73.0) |
| DeepSeek, Chinese | 35.5 → 30.9 (3 → 3) | 49.4 → 46.5 | 3 → 3 | 3 → 2 | none |

- Every refusal, in either arm, was one the call makes of the model's input as before: off the length asked for, sentences added without a Citation, a part that names no heading, content over the User's text, changes waiting. None was "changed" (the User's text changed meanwhile) or a take-back. No request failed or met a rate limit.
- Bar 4 holds: the whole-call tests pass unchanged, and the new tests hold the end equal to the whole call's.
- Calls whose text could come in, `content` with its `part` named first and no `instruction` before it, over the assistant's own text: on the step, 1 of Sonnet's 10 calls, none of Haiku's 8, and 5 of DeepSeek's 12 (two of which were refused once whole and taken back). Sonnet and Haiku mostly name `part` after `content`, give `instruction` beside it, or give content over the User's text, which is refused. So the step rarely acted on Claude, and the target of 2 to 3 s sooner on Sonnet isn't met: 14.9 → 14.0 s in English, 13.2 → 14.0 s in Chinese.

The gate fails: bar 1 in one cell and unreadable in another, bar 2 in one, bar 3 in two. What ships is the decision below. Spent: $2.56 (Sonnet $2.12, Haiku $0.15, DeepSeek $0.29).

## Second try, 2026-11-07: the new text comes in whatever order the fields come in

Written and committed on 2026-11-07, after the result above and before any run it gates. The runs above stay as they are.

### The step

The first try streamed only a call whose `part` came before its content with no `instruction` beside it: 1 of Sonnet's 10 calls, none of Haiku's 8. Now the content waits for `part`, and for the Note's name when one is given, in whatever order they come; once they are whole, what has come of the content goes in at once and the rest as it is written. An `instruction` beside the content no longer stops it, since the call writes the content. Everything else is as in the first try: the call ends as the same call made whole, in one step; a call refused once whole, Stop or a failed model takes back what came in. A call that never names `part` goes in once the call has all of it, as before.

### The runs

- **Arms:** `main` at bcb1f6b51, unchanged; `step` at 4cf7a1c61, this branch with that `main` merged and the change above (the commit of this section changes only this file).
- **Flow:** `assistant-longer`, as in the first try, through a probe that runs the flow as `npm run eval:speed` does (the same signs and timing records) and also records the page after each change as the window draws it (every Proposal accepted, Citation marks ignored), each Tool call's start and end with the order of its input's fields, the Checkpoints the Answer took, and the page with the Answer's change requests rejected. The probe is the same file on both arms and isn't committed.
- **Order:** one process per arm, model, language and run, alternating `main`, `step`, `main`, `step`.
- **Cells**, three runs per arm, 36 runs:
  - Claude Sonnet 5.5 (`claude-sonnet-5-5`), direct Anthropic route, English and Chinese.
  - Claude Haiku 5.5 (`claude-haiku-5-5`), direct Anthropic route, English and Chinese.
  - DeepSeek V4.1 Flash 1017 (`deepseek-flash`), English and Chinese.
  - If the direct key runs out of credit, the second direct key carries on with the same model, noted below with the time; no cell mixes models.
- **Stop runs:** on `step`, one run per model and language with Stop pressed at the page's first change while an `edit_mind` call is open: 6 runs.
- **Kept:** each run's data folder. **Load:** a run starts only while the 15-minute load is at most 24.
- **Cost:** about $2.60 for the 36 runs, as the first try's, and $0.40 for the Stop runs, within this work's cap of $6.

### The bars

Bars 1 to 4 are the first try's, per cell, read the same way. Bar 1 must hold on the first change as the first try read it (the first change of any kind in the page) and on the first new text that stays (the first line of the page's end that wasn't there before the Answer and stays in every later state), so text that comes in and is taken back doesn't count as sooner.

5. **Quality**, on every run of the step, whatever the cell:
   - **Text in its place:** in every state of the page, the User's note stays its first line, unchanged; and while an `edit_mind` call's text comes in, the page never has more lines than the more of its lines at the call's start and at its end, so new text never shows beside the old text it replaces.
   - **No claimed-but-unmade edit:** no more runs than on `main` whose reply says the summary changed while no change landed, read from the app's own record of claims no call made (`unbackedClaims`), and, for each run whose page didn't change, from its reply read in full.
   - **Undo in one step:** in every run whose Answer changed the page, rejecting the Answer's change requests, as its Undo does, gives back exactly the page before the Answer; and no Checkpoint more per landed `edit_mind` call than on `main`, but the one each call that came in and was taken back saved.
   - **Stop keeps what landed:** in each Stop run, a call stopped while its text was still coming in leaves the page exactly as it was at the call's start and claims no change, and a call that had run before Stop keeps what it wrote: never part of a call's text. The unit tests of Stop and a failed model pass.
   - **Checks unchanged:** every landed `edit_mind` write of cited text has its written check (`selfCheck`), and over each model's runs the share of those writes' cited sentences checked is no lower than on `main`.

### Reported, not bars

- **The share of calls that streamed:** of the `edit_mind` calls with content, how many showed text in the page before the call had all of its input (a state of the page inside the call's window other than its first and last), per arm and cell, with the order of their fields.
- The first change, the first new text that stays, and Done: medians, `main` → step, per cell; the target is 2 to 3 seconds sooner on Sonnet.
- Calls whose text came in and was taken back.

### What decides

The step ships if every cell holds bars 1 to 4 and every quality line holds. If a quality line fails, it doesn't ship. If the quality lines hold and the first change on Sonnet doesn't move, the result says so plainly and recommends closing the pull request. Either way, what ships is decided in a dated note below, not by reading these bars again.

### Result, 2026-11-07 and 08

All 36 runs ran on one route per model: Claude Sonnet 5.5 and Claude Haiku 5.5 on the direct Anthropic route, DeepSeek V4.1 Flash 1017 on DeepSeek's API; `main` at bcb1f6b51, the step at 179d60867 (the change above and this file). 15-minute load 5.4 to 8.0. Seconds; medians of three runs, over the runs whose page changed.

| Cell | First change, `main` → step (runs that changed the page) | First new text that stays | Done | Content calls that streamed, `main` → step | Bars it fails |
|---|---|---|---|---|---|
| Sonnet, English | 15.4 → 10.8 (3 → 3) | 15.4 → 12.3 | 32.1 → 26.5 | 0 of 6 → 4 of 5 | none |
| Sonnet, Chinese | 15.1 → 14.4 (3 → 2) | 15.1 → 14.4 | 27.7 → 29.4 | 0 of 3 → 1 of 2 | 1 and 3: one step run answered in the panel and wrote nothing |
| Haiku, English | – → 12.9 (0 → 3) | – → 16.1 | 26.8 → 30.2 | 0 of 3 → 0 of 5 | none (`main` never changed the page) |
| Haiku, Chinese | 20.4 → 22.4 (2 → 3) | 20.4 → 22.4 | 34.1 → 37.5 | 0 of 3 → 2 of 7 | 1, and 3 (refused calls 2 → 4) |
| DeepSeek, English | 47.7 → – (1 → 0) | 47.7 → – | 65.1 → 56.3 | 0 of 7 → 0 of 9 | 1 and 3: DeepSeek wrote its summary into a new Note of its own and lengthened that, in 2 of 3 `main` runs and all 3 step runs |
| DeepSeek, Chinese | 34.6 → 35.8 (3 → 3) | 34.6 → 48.2 | 60.0 → 66.3 | 0 of 6 → 4 of 5 | 1 |

- **Calls that streamed:** of the `edit_mind` calls with content, 5 of Sonnet's 7, 2 of Haiku's 12 and 4 of DeepSeek's 14 on the step (the first try: 1 of 10, 0 of 8, 5 of 12). Most of those that didn't gave no `part` and were refused for content over the whole Note, or gave content of one paragraph: Haiku's summary is mostly one paragraph, which can't come in before the call ends.
- **Sooner where it streamed:** Sonnet in English, 4.6 s sooner to the first change and 3.1 s to the first new text that stays, the 2 to 3 s the issue asks. Not in Chinese, and not on Haiku or DeepSeek.
- **Text that came in and went:** 5 calls on the step (Sonnet English 2, Haiku Chinese 1, DeepSeek Chinese 2) came in and were refused once whole (off the length asked for, or sentences added without a Citation), so the new text showed and then went back to the old. That is why DeepSeek's first new text that stays came later in Chinese (34.6 → 48.2 s).
- **Bar 2** holds in every cell. **Bar 4** holds: the whole-call tests pass unchanged.

Quality, on every step run:

- **Text in its place:** the User's note stayed the page's first line in every state of every run, and no state showed new text beside the old text it replaces (new lines always sat together where old ones went). The line as written, that the page never has more lines than at the call's start or end, fails on 4 calls: each was refused once whole and taken back, and its new text had more paragraphs than the old, so while it came in the page was longer than at either end.
- **No claimed-but-unmade edit:** none on the step; one on `main` (Sonnet, Chinese, run 1), which the app flagged. Every step run whose Briefing didn't change replied truthfully: Sonnet's Chinese run 3 wrote the longer summary in the panel and claimed no change to the Note, and DeepSeek's English runs lengthened the Note DeepSeek had made itself and said so.
- **Undo in one step:** in all 14 step runs whose page changed, rejecting the Answer's change requests gave back exactly the page before the Answer. Checkpoints: one per landed call, plus one for each call that came in and was taken back (7, two of them Haiku calls that came in only as far as their heading). On `main`, one run (DeepSeek, Chinese, run 1) didn't come back exactly: a sentence stayed after rejecting; it has nothing of the step in it.
- **Checks unchanged:** every landed `edit_mind` write of cited text had its written check, with every cited sentence sent, on both arms. The share checked: Sonnet 23 of 26 → 19 of 21, Haiku 9 of 11 → 24 of 33, DeepSeek 31 of 34 → 28 of 34. So the line fails on Haiku and DeepSeek. The sentences not checked were the check's own verdicts on the text written (no evidence found, an unreadable reply, the read limit), on both arms; no request failed.

The gate fails: bar 1 in four cells, bar 3 in three, and two quality lines as written. Spent: $3.00 (Sonnet $2.47, Haiku $0.22, DeepSeek $0.31).

After the 36 runs, an independent review of the step found five things, fixed in 329dc1adb: text showed in the Note in focus when the Note's name came after the content; two `edit_mind` calls in one step took back each other's text and both reported a stop; a streamed call that never ran still counted as a change when the Answer then replied with nothing; with `part` after the content, the content's last paragraph waited for the call; and no test held the wait for a Note the User is asked about first. Now the engine tells a Tool when a streamed call's input is over (`inputEnded`), and only a call that never ran is taken back.

- **The pull request's head, one run per model and language** (9121768a0, with those fixes and `main` at bf75bd5fe merged): Sonnet English 14.5 s to the first change, Chinese 14.8; Haiku Chinese 17.6 (23.9 to text that stays, 3 of 4 content calls streamed, 2 of them taken back); DeepSeek Chinese 27.5; Haiku and DeepSeek in English changed no Briefing. Sonnet's calls there gave one paragraph, or no `part`, so nothing came in before the call ended. Every quality line held but one: on one of Haiku's two taken-back calls the page grew past both ends, as above. The app flagged one DeepSeek reply ("the sentence … has gone from the Note") as claiming a removal no call made; the call had replaced that paragraph, so the reply was true.
- **Stop runs, first set** (9121768a0, Stop pressed inside the Note's change event at the page's first change while an `edit_mind` call was open; Haiku in English made no `edit_mind` call, so 5 runs stopped): in 3, Stop came while a call's text was still coming in, and the paragraph going in stayed in the Note, because the take-back on Stop ran before that paragraph was recorded. In the other 2 the call had run, and Stop kept what it wrote. **The quality line fails there.** Fixed in 121392bae, with a test that presses Stop the same way and goes red without the fix.
- **Stop runs, second set** (121392bae, the same way): all 5 hold. In 2 (Haiku Chinese, Sonnet English) Stop came while the text was coming in, and the Note was exactly as at the call's start, with no change on the card; in 3 the call had run, and what it wrote stayed.
- The engine's word that a streamed input is over comes only at its step's end (bc8e5ef98): a word at a refused call's failure came after the step's other calls had run, so it changed nothing. So a streamed call whose input is refused and another call over the same text in the same step leave that second call refused as waiting; it goes in when the model calls it again in the next step.
- Spent after the 36 runs: $0.63 on the head's runs and $0.49 on the Stop runs; $4.11 in all, within the $6 cap.

By this gate's own rule the step doesn't ship: quality lines fail as written, and the first change moved only for Sonnet in English. The recommendation is to close the pull request and keep its branch for a next try that keeps refused text from showing (each paragraph held to the length and Citation checks as it comes) and shows a one-paragraph text a sentence at a time. What ships is the dated decision below.
