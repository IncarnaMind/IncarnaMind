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
