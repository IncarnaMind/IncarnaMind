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

## Result (2026-11-08): every guard holds on every branch run, so it ships

Main at `90012f912` against the branch at `d901a7732`, both built in test mode. The review fixes after it change a Note deleted during the pass, line keys at fractional times, a Local fill's words, a pass whose result can't be kept, and docs: none of them is a path these runs take. Claude Sonnet 5.5 and Haiku 5.5 ran on a direct Anthropic key. Seconds are from Stop. "Ready" is the end of the fill's last request. Load is 1/5/15-minute at Stop.

| Run | Load at Stop (1/5/15) | Transcript saved | Pass ends | Fill request (thinking out tokens) | Checks (requests) | Ready | Notes in | In after ready | Citations / wrong speaker / checked again | Lines renamed | Written / made again | Undo in one step | Spend |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| en-sonnet-main | 8.15 8.10 12.69 | 0.1 | 29.3 | 0.1→3.4 (472); 3.4→11.6 (999) | 11.6→26.2 (15) | 26.2 | **29.3** | 3.1 | 15 / 0 / 0 | 0 | 1 / 0 | false | $0.149 |
| en-sonnet-branch | 12.48 9.48 11.99 | 0.1 | 30.6 | 0.1→3.7 (494); 3.7→9.1 (901) | 9.1→20.0 (9) | 20.0 | **20.0** | 0.0 | 13 / 0 / 0 | 0 | 1 / 0 | false | $0.074 |
| en-sonnet-branch-2 | 18.78 15.29 15.42 | 0.1 | 34.9 | 0.1→3.9 (539); 4.0→5.1 (87); 5.1→11.2 (1083) | 11.2→24.1 (19) | 24.1 | **24.1** | 0.0 | 19 / 0 / 0 | 0 | 1 / 0 | yes | $0.174 |
| en-haiku-main | 5.28 7.24 9.53 | 0.1 | 40.2 | 0.2→32.2 (7840); 32.3→39.4 (2094) | 39.4→49.7 (27) | 49.7 | **49.7** | 0.0 | 30 / 0 / 0 | 0 | 1 / 0 | false | $0.012 |
| en-haiku-branch | 6.21 7.26 10.25 | 0.1 | 32.5 | 0.2→43.1 (11357) | 43.2→51.9 (28) | 51.9 | **51.9** | 0.0 | 35 / 0 / 0 | 0 | 1 / 0 | false | $0.016 |
| en-haiku-branch-2 | 27.63 22.22 18.24 | 0.1 | 44.4 | 0.2→25.6 (6081); 25.6→32.8 (1991) | 32.8→40.3 (32) | 40.3 | **40.3** | 0.0 | 29 / 0 / 0 | 0 | 1 / 0 | yes | $0.017 |
| zh-sonnet-main | 12.05 10.64 10.45 | 0.1 | 35.9 | 0.1→3.6 (551); 3.6→10.2 (1136) | 10.3→24.5 (18) | 24.5 | **35.9** | 11.4 | 17 / 0 / 0 | 0 | 1 / 0 | yes | $0.155 |
| zh-sonnet-branch | 26.41 24.83 17.30 | 0.4 | 89.6 | 0.6→3.4 (340); 3.5→8.0 (686) | 8.1→27.9 (17) | 27.9 | **28.0** | 0.0 | 12 / 0 / 0 | 0 | 1 / 0 | yes | $0.094 |
| zh-haiku-main | 11.82 13.26 17.51 | 0.1 | 73.8 | 0.1→54.5 (12964); 54.6→63.7 (2477) | 63.9→79.8 (48) | 79.8 | **79.8** | 0.0 | 42 / 0 / 0 | 0 | 1 / 0 | yes | $0.027 |
| zh-haiku-branch | 34.10 20.41 21.28 | 8.0 | 94.5 | 8.1→36.8 (6508); 37.0→38.5 (241) | none | 38.5 | **38.6** | 0.1 | 2 / 0 / 0 | 0 | 1 / 0 | yes | $0.006 |
| ami-sonnet-main | 16.65 15.92 17.64 | 50.7 | 91.4 | 50.8→52.9 (292); 52.9→57.7 (689); 91.5→94.5 (307); 94.5→98.6 (599) | 98.6→111.8 (6) | 111.8 | **111.8** | 0.0 | 8 / 0 / 0 | 0 | 1 / 1 | yes | $0.111 |
| ami-sonnet-branch | 15.77 17.12 17.73 | 67.9 | 128.0 | 67.9→70.5 (258); 70.5→74.6 (589) | 74.7→88.7 (9) | 88.7 | **88.7** | 0.0 | 9 / 0 / 0 | 41 | 1 / 0 | yes | $0.102 |
| ami-haiku-main | 6.18 9.42 14.05 | 0.1 | 23.0 | 0.2→14.5 (2929); 14.6→18.9 (1018); 23.0→35.8 (2779); 35.8→39.1 (787) | 18.9→41.7 (11) | 41.7 | **41.7** | 0.0 | 11 / 0 / 0 | 0 | 1 / 1 | yes | $0.008 |
| ami-haiku-branch | 6.75 12.48 16.52 | 0.1 | 20.9 | 0.1→18.2 (4410); 18.2→21.4 (847) | 21.4→27.0 (20) | 27.0 | **27.0** | 0.0 | 18 / 0 / 0 | 39 | 1 / 0 | yes | $0.012 |

- **Written once ready:** in every branch run, the notes were in within 0.1 s of the fill's last request, whether or not the pass had ended. On main, the Sonnet notes waited 3.1 s (EN) and 11.4 s (ZH) for the pass. On the renaming call, main made them again after the pass: Sonnet 111.8 s against 88.7 s, Haiku 41.7 s against 27.0 s.
- **No Citation names the wrong speaker:** none in any run.
  - On the renaming call, the branch's file kept "Them", and its Citations named Speaker 1, 2 and 3 through who's who: 41 lines renamed with Sonnet, 39 with Haiku.
  - Main's file was rewritten, and its notes were made again from the renamed lines.
- **No Citation checked again:** the Transcript's version when the notes went in was its version after the pass, in every run.
- **Made once, written once:** one `meeting.filled` in every run. `meeting.fillRedone` appeared only on main's renaming runs. Each section heading appeared once.
- **Undo in one step:** yes in every branch run.
  - The first English branch runs read Undo with a check that counted the fill's own line, which sits in the editor, as the Note's text. So they were run again with the check fixed: `en-sonnet-branch-2` and `en-haiku-branch-2`, both yes.
  - Main's English runs used the old check, which is why they show false.
- **Load:** every run's 15-minute load at Stop was at most 24. `zh-haiku-branch`'s first try, at 24.40, was run again. In `zh-sonnet-branch`, another process took the 1-minute load to 107 after Stop: its pass took 89.6 s, and its notes went in at 28.0 s.
- **Reported, not gated:**
  - On Haiku, the fill's thinking (32–55 s) often outlasts the pass, so main writes as soon as ready too. Its times differ by the model's own spread, not the change.
  - In `zh-haiku-branch`'s second try, Haiku left one item out (an invalid frame), and its notes were short: 2 Citations. #2773 saw this on main.
  - On the renaming call with Sonnet, finishing the Transcript took 51–68 s on both arms: live text fell behind on the real meeting audio.
- **Spend:** $0.98 for the gate, the replaced first try included.
