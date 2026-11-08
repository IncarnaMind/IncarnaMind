# The gate for a call's notes going in without waiting for the speaker pass (#2839)

Written and committed on 2026-11-08, before any run it gates.

## The change

- A call's notes start once its Transcript is saved, as since #2773. They now go into the Note as soon as they and their claims' checks are ready, while its speakers are still told apart.
- The speaker pass no longer rewrites the Transcript's file. Who it found spoke each line goes into the Transcript's who's who, where the User's own names and moves are kept. So the file and its version stay, nothing is checked again, and every Citation of a line names who said it from then on, a call's notes' among them.
- The notes are no longer made again when the pass renames a line.
- A recording of a room, and a model on this computer, still wait for the pass, as on main.
- After Stop, the note's line says each step while it runs, and how many claims are being checked.

## Why it is gated

#2839 measured a 3:50 call on Claude Sonnet 5.5 in the built app on main: its notes and their checks were ready 92 s after Stop, and then waited another 126 s for the speaker pass. The change claims to remove that wait and nothing else, and that no Citation then names the wrong speaker.

## The runs

- **Arms:** main at the branch's merge base against the branch, each built in test mode from its own worktree. Both run on one seeded data folder template: an Anthropic provider, "chat" and "checks" allowed, the call set's made-up Documents in English and Chinese, and the speech, speaker and reranker models (the GPU file included, as an install has once it has downloaded it).
- **The calls:** each recorded in the window with a WAV played as the computer's sound, then Stopped in the window 3 s after it has played.
  - English: the call set's `en-sum`, 28 turns, voiced with macOS `say` (Daniel and Samantha) with 0.8 s between turns, 4:01.
  - Chinese: `zh-sum`, voiced the same way (Eddy and Flo, Chinese mainland), about 4 minutes.
  - A call whose pass renames: four minutes of the AMI meeting EN2002a's computer-sound track (1890–2130 s, three people on the other side), from eval/meetings.
- **Models:** Claude Sonnet 5.5 and Claude Haiku 5.5 as the Answers model, on a direct Anthropic key.
- **Pairs:** one run a side for each model on each call: 6 pairs, 12 runs. The arms alternate which goes first.
- **Load:** every run is taken with the 15-minute load at Stop at or below 24. A run above that is run again.

## The guards

Each must hold in every run of the branch. One that fails stops the change.
- **Written once ready.** The notes are in the page within 1.0 s of the end of the fill's last request (its last claim check, or its text where it has no claims), whether or not the speaker pass has ended. On main the same holds only where the pass ended first.
- **No Citation names the wrong speaker.** Once the pass has ended, every Citation of the Transcript in the exported Note names the Speaker the Transcript's line at its time is by now (its who's who over its file's label). On the renaming call, at least one line is renamed.
- **No Citation checked again.** The Transcript's version when the notes go in is its version after the pass.
- **Made once, written once.** One fill request after Stop, one `meeting.filled`, no `meeting.fillRedone`, and each section heading once in the Note.
- **Undo in one step.** Once the pass has ended, one press of the line's Undo leaves the Note as it was before Stop.

## Reported, not gated

- **Notes in, from Stop**, per arm and pair, with each phase: the Transcript saved, the pass, the fill's requests and their thinking, and the claims' checks. It isn't gated on a single pair, since one fill's thinking spreads by more than the pass on Haiku. The structural guard above holds the change to what it claims.
- **The notes' text on the renaming call.** Main makes them again from the renamed Transcript, so its model reads "Speaker 1, 2…". The branch keeps the notes made while the lines read "Them". Both sets of notes and their Citations are listed side by side.
- **What the line said**, sampled every 200 ms from Stop.
- Load and spend.

## What passing changes

If every guard holds, the change ships. If one fails, it doesn't. Either way, the numbers go on #2839.

## Spend

Within this phase's $4, counted from each run's timing records.
