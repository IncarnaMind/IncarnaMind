# The gate for asking for a scope's unread files only when they could have changed (#2772)

Written and committed on 2026-11-08, before any run it gates. It follows `big-library.md` (#2781) and is run the same way.

## The change

Each Answer shown, the Library and the getting-started steps ask the core for their scope's unread files. They ask again when what could be unread changes: a Document that failed, has no text or was read in part, or a Linked folder's count of files in a format not read. Until now the count of all Documents was part of that too, so every new Document made every shown Answer ask again. During a 2,000-Document import that was 2,622 calls on the main process on `main`, and 2,200 in one Note showing ten Answers. The count is left out: a Document that becomes ready changes nothing an unread line shows. The core's answer, and what is sent to a model, don't change.

## Measured before this gate (`big-library.md`'s runs on b2ae19bf8, and this branch's base)

- During the import: unread files asked 2,622 times over two runs, 2.7 ms of the main thread each; 336 times on #2781's branch, where the import ended four times sooner.
- In a Note showing ten Answers during the import: 2,200 calls and 4.8 s of the main thread on `main`; 680 calls and 1.1 s on #2781's branch.

## The runs

- **Arms:** `main` is the packaged build of f3d837b99 (#2781 merged); `ask` is the packaged build of this branch's commit with the change. Both built the same way.
- **Order:** `main`, `ask`, `main`, `ask`, one run each on a fresh profile (keys saved through the app's own forms, Claude Haiku 5.5 for Answers on a direct Anthropic key), at a 15-minute load of 24 or less.
- **Each run** does `big-library.md`'s three steps on its files, with two more in the first folder so that each Answer has an unread line: a damaged PDF (a Document that fails) and a `.doc` (a format not read). Then a fourth step on a fresh profile of the same arm:
  4. **At once,** after the pressure test: a Note of 300 Blocks is open in its own tab; the Note to check has its 8 sentences, a check already run, and three Answers in its conversation. The 2,000 are linked; at once a Question on Claude Sonnet 5.5 is asked in that Note, Check this Note is pressed while it runs, and the User types at the end of the Note meanwhile.
- **Times** as in `big-library.md`; and for each Answer, the unread line it shows once done.

## The bars

**What it must show:** fewer calls for unread files during the import on `ask` than on `main`, in each run's pair, in step 2 and in step 4; and their main-thread time lower.

**No later:** `big-library.md`'s bars, unchanged: Check this Note's and the Questions' medians on `ask` no later than `main`'s by more than `main`'s spread (and the sign never by more than 0.5 s), on each Library and during the import.

**What the User sees doesn't change:** every Answer's unread line names the same files on both arms (the damaged PDF and the `.doc`), from its first showing.

**Quality** (#1624's gate), over both runs of each arm, as in `big-library.md`: no new false Supported; judged right no lower than `main` by more than one in 30, rounded down; every Answer's Citations' quotes found and Answers judged right no lower than `main` by more than one in 30; no Answer claims a change; no request fails on `ask` that didn't on `main`.

## Reported, not gated: #2772's two remaining criteria

On both arms, from these runs:
- Check this Note's first sign while the 2,000 import (step 2, and step 4 with a Sonnet Question and typing at the same time): within 0.5 s?
- Claude Haiku 5.5's first words on the 2,629 Documents against the 28, in English and in Chinese: within 1.5×?

## What decides

`ask` ships if every bar holds. If one fails, the change ships no further and the numbers go on #2772.

**Cost:** about $0.25 a run and $0.25 for each step 4, about $1.50 for all; within the $6 approved for this work.

## Amended on 2026-11-08, before any run of the arm it describes

- **The change, as pre-review found it short:** a Folder of the Library names the files in a format not read from the folders on disk its Documents are in. With the count of all Documents left out, an Answer asked in a Folder could miss such a file, or keep naming one, when a Document beside it was added or deleted. The change now keeps the count of the Documents in Linked folders that hold such files, and watches a Document whose unread parts can't be read. A Document added anywhere else still changes nothing the line shows. `tests/core/unreadAsk.test.ts` holds both sides through the core.
- **`ask` is now commit 5eea30e32.** One run of the earlier commit (698d6ae29; steps 1 to 3) was stopped and is not used. `main`'s first run (f3d837b99), made before this, is kept. The order goes on: `ask`, `main`, `ask`.
- **Corrections to the text above,** which stays as written:
  - The 2,622 and 2,200 calls were measured on b2ae19bf8, before #2781; on f3d837b99 the import ends within 8 s, and #2781's branch made 336 and 680 calls.
  - The runs read each Answer's unread line once it is done, not from its first showing.
  - In these runs every Question is asked in a new Note outside any Folder, so the unread-line bar covers Answers over all Documents. Folder scopes are covered by the core test above.
  - Four runs and four step 4s at about $0.25 each come to about $2.00.

## Amended again on 2026-11-08, before any run of the arm it describes

- **What the second review found:** the key above still asks again at each Document imported into a Linked folder that holds a file in a format not read, such as a `.doc` or `.xls`, from every Answer shown. The runs' 2,000 hold no such file, so they couldn't show it.
- **The change now also shares one request** among the Answers that ask over the same scope at the same moment. Such an import asks once for each change and scope, not once for each Answer. An import into any other folder asks nothing again. `tests/core/unreadAsk.test.ts` now files the added Documents into the Folder, so its core half can fail.
- **`ask` is now commit 135486889.** The runs of 5eea30e32 (steps 1 to 3 of one, whose step 4 couldn't start when the profile's setup timed out, and steps 1 and 2 of the next, stopped) are kept apart and not used. `main`'s second run timed out the same way in its setup and is run again. `main`'s first run is kept; the order goes on: `ask`, `main`, `ask`.
- **What the bar on calls covers:** in step 2 the 2,000 hold no file not read, so it shows the key; in step 4 the Answers in the Note share a scope, so it shows both. Spent on this gate so far, with the runs set aside and a check of step 4's harness, about $0.95; the three runs left add about $1.10.
- **Step 4, a run priced above $1** (later on 2026-11-08, before `main`'s second step 4): Check this Note asks first in its card when its price is above $1 (#2313). It did in `ask`'s first step 4, after the 2,000 were ready and the contradiction watch had them to check, so its check never started. From here the harness presses the card's Check when it asks: the card is then the first sign of the press, and the check is timed again from the card's Check. `ask`'s first step 4 runs again after the others; the one that never started is kept apart. `main`'s first step 4 didn't ask, and is kept.

## Result (added after the runs, 2026-11-08)

`main` f3d837b99 against `ask` 135486889 (the commits after it change only tests, comments and this file), two runs each, at a 15-minute load of 3.3 to 6.0. Spent on this gate, with the runs set aside, about $2.10. **Two bars are not met**, so by "What decides" the change ships no further unless that is accepted.

| Bar | `main` | `ask` | Met |
|---|---|---|---|
| Unread-files calls while the 2,000 import, step 2 (two runs) | 228 calls, 570 ms of the main thread | 12 calls, 37 ms | yes |
| The same, step 4 (each run) | 322 and 191 calls | 2 and 2 | yes |
| Check this Note, sign / first verdict / end, 29 Documents (median, `main`'s spread) | 0.23 / 6.3 / 16.4 s (0.02 / 1.8 / 4.4) | 0.23 / 5.6 / 15.5 s | yes |
| the same, during the import | 0.26 / 5.9 / 15.2 s (0.01 / 1.3 / 0.9) | 0.27 / 5.2 / 15.2 s | yes |
| the same, 2,630 Documents | 0.30 / 5.3 / 14.2 s (0.02 / 0.8 / 1.6) | 0.29 / **6.7** / **16.6** s | **no**: first verdict 1.4 s and end 2.4 s later, past `main`'s spread |
| Questions, first words / end, 29 / during the import / 2,630 | 5.0 / 6.2, 4.7 / 6.7, 4.5 / 5.7 s | 5.0 / 6.2, 4.6 / 6.1, 4.3 / 5.6 s | yes |
| Each Answer's unread line, of 36 an arm | "2 files couldn't be read" in 36 | the same in 36 | yes |
| False Supported (the four sentences not stated, 12 checks an arm) | 0 | 0 | yes |
| Judged right in the checks, of 96 | 79 | 78 | yes (one in 96) |
| Answers with every Citation's quote found, of 36 | 35 | **30** | **no**: 5 fewer |
| Failed requests | 0 | 0 | yes |

What was measured beside the two bars, without claiming a cause:
- **Check this Note on 2,630 Documents.** During those checks the window asked for unread files 12 times in each arm, at 5.0 to 5.2 ms of the main thread each, and the checks' own calls took the same time (planning 23 to 24 ms, start 23 to 24 ms). The event loop's delay was the same (p99 13.4 ms in each). In `ask`'s second run the model's slowest first byte was 3.0 s in English and 3.8 s in Chinese, against 1.3 to 2.1 s in `main`'s runs. `ask`'s first verdicts were 6.2, 6.7, 8.5 and 6.7 s; `main`'s were 5.2, 5.3, 6.0 and 5.4 s.
- **Quotes not found.** All six of `ask`'s are on one Question, the Chinese contract one, asked three times in each run. In each run its first Answer cited one long sentence of the payment terms, and its later Answers in the same conversation repeated it. `main`'s Answers to that Question cited the terms clause by clause. `main`'s one miss is on another Question. The Answers' content was right in all 36 of `ask`'s.
- **#2772's remaining criteria**, on both arms: Check this Note's first sign while the 2,000 import was 0.25 to 0.28 s in step 2. In step 4, with a Claude Sonnet 5.5 Question and typing at the same time and a 300-Block Note open, it was 0.20 to 0.25 s, and no check asked first. Claude Haiku 5.5's first words on 2,630 Documents against 29, by median: English 5.1 against 4.9 s on `main` (1.03×) and 4.2 against 5.1 s on `ask`; Chinese 4.3 against 6.5 s on `main` and 4.3 against 4.7 s on `ask`.
