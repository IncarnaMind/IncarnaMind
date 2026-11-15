# The gate for a call's notes going in before their claims are checked (#2839)

Written and committed on 2026-11-15, before any run it gates.

## The change

After Stop, a call's notes are written in two steps where `main` writes them in one.

- **Step 1,** once the fill's last request has ended: everything that isn't checked against the Documents goes into the Note. That is the summary, decisions, action items, open questions, and facts that state no claim.
- **Step 2,** once the last claim's check has ended: every checked statement goes in together, under its section or under "Said in the call, not in your Documents". It changes and moves nothing step 1 placed. There is never one change per statement.
- Both steps are one Undo. Between them, the fill's line stays and says how many claims are still being checked.
- The requests are the ones `main` sends: none added, nothing more sent.
- A call with nothing to check, and a voice memo, are written in one step, as on `main`.

## Why it is gated

The change claims to move only when the notes' text appears, not what the Note holds in the end, what is asked of the model, or what one Undo takes back. On 2026-11-08 a four-minute call's claims were checked for 9–20 s after its text was ready (`notes-no-wait.md`), so that is the wait it removes from the text.

## The bars

All are free: the scripted model, no key. Each must hold; one that fails stops the change.

1. **The same Note in the end.** For the same replies and the same verdicts, the Note after step 2 is, block for block, what `main` writes in one step. The fill's existing tests (`tests/core/meetingFill*.test.ts`) pass with what they expect of the finished Note unchanged. An expectation changed on purpose is named in the pull request with its reason.
2. **Text first.** With a claim's check held open by the test: the Note holds step 1's blocks and no checked statement, the fill says how many claims are being checked, and that number is the statements still held. When the checks are let go, step 2 is one edit.
3. **Nothing placed moves or changes.** Each block step 1 placed is in the Note after step 2 with the same content, and step 1's blocks keep their order among themselves.
4. **One Undo.** After step 2, one Undo leaves the Note as it was before Stop. Between the steps, one Undo does the same; no checked statement is placed afterwards and no further check is sent.
5. **The same requests.** For one script, the requests the fill and its checks make are the ones `main` makes: the same kinds, number and contents.
6. **The edges, each with a test through the core's public interface:**
   - the User edits, moves or deletes a line between the steps: step 2 places what `main` would place into the Note as it then stands;
   - a check that fails counts as not backed, as on `main`, and its statement is listed;
   - a quit between the steps: at the next start no statement is silently missing. The fill says it stopped, as a fill stopped on `main` does, and filling again doesn't write step 1's text twice;
   - the Meeting or its Note deleted between the steps: nothing is written afterwards;
   - a model on this computer, which checks one claim at a time: the same two steps;
   - a call whose every fact is a checked claim, and one with none: no empty step is written.
7. **The built app,** with the scripted model and a check the spec holds open (waiting for states, not times): the Note shows the text while the line counts the claims; then the claims and the finished line; one Undo takes all of it back. The line is read in English and in Simplified Chinese.

## Reported, not gated

- A real model's seconds from Stop on `main`, from the four runs of 2026-11-15 on #2839 (one run a cell: a measure, not a bar).
- The same on the branch only if it is asked for and priced first.

## What passing changes

If every bar holds, the change ships. If one fails, it doesn't. Either way the result goes on #2839.

## Spend

$0.
