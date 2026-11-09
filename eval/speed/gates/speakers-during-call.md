# The gate for telling a call's speakers apart during it (#2839)

Written and committed on 2026-11-09, before any run it gates.

## The change

- While a Meeting records, what is saved of the side whose voices the speaker pass tells apart (the computer's sound in a call, the room otherwise) is clustered during the call, in the speaker process at low priority, one run at a time, in memory only:
  - all of it again, once what isn't clustered yet reaches max(60 s, a quarter of what was);
  - between those runs, everything saved after the last of them, once it grows by max(20 s, half of what that run took);
  - a run over everything takes at most an hour of audio, as the engine clusters a long recording in windows of an hour, and the next goes on after it.
- At Stop, a run still going stops. Only what was saved after the last finished runs is clustered, and the stretches' voices are joined by voiceprint, as a long recording's windows already were. A call with no finished run of everything, a Try again, and a pass after a restart cluster the whole recording at once, as on main.
- A pass after Stop comes first: a run during a call stops for it and starts again after it.
- Nothing is shown during the call. The labels the pass gives after Stop are the only ones, written once into the Transcript's who's who, as since #2851.
- The separator now returns each stretch's voices with their voiceprints, and the core joins them. A recording clustered whole gives the turns it gave on main.

## Why it is gated

#2839 measured the pass after Stop at 22 s for four minutes of audio alone on a quiet Mac, 63–83 s for fifteen, and 100–152 s in the app on a busy one. The change claims to cut that to a few seconds, with labels no worse than today's and no slower live text or call help.

## The runs

### Speed after Stop, in the app

- **Arms:** main at the branch's merge base against the branch, each built in test mode from its own worktree, both on the template data folder of #2851's gate (speech, speaker and reranker models; an Anthropic provider). Temporary home and data folder for every run.
- **Calls:** each played as the computer's sound and Stopped in the window 3 s after it has played:
  - four minutes of AMI EN2002a's computer-sound track (1890–2130 s, three people on the other side), the call #2851's pass renamed;
  - `zh-sum` from #2851's gate, voiced in Chinese with macOS `say`, 4:08;
  - the first fifteen minutes of EN2002a's computer-sound track.
- **Model:** Claude Haiku 5.5 on a direct Anthropic key fills the notes, as a User's would. The notes aren't gated here.
- **Measured:** "Telling the speakers apart…": from the Transcript saved to the pass's end, from the app's log, and the line sampled every 200 ms.
- One run a side per call. The arms alternate which goes first. Every run is taken with the 15-minute load at Stop at or below 24; a run above that is run again.

### Labels, on the app's own code

- A script runs the branch's own clusterer, join and labelling, at low priority with the app's two threads, on the case's track cut into the 10-second parts a Meeting keeps. The lines are the human reference's segments on that track, each labelled by the pass's rule.
- **Today's:** the whole cut clustered at once. Main's own pass on the same parts is run beside it, to show that today's is unchanged.
- **The branch's:** the schedule above followed in the call's time, each run executed when the code would start it and taking its measured time, Stop 3 s after the end cancelling a run still going, then the rest clustered and every stretch joined.
- **Cases:** the five cases of #2839's Phase 2 measurement, their first fifteen minutes: en-online-EN2002a, en-online-IS1009b, zh-online-R8007_M8011, en-room-ES2004b and zh-room-R8003_M8001; and the four-minute cut of EN2002a above.
- **Scores:** purity (the share of lines whose label's most common reference speaker is theirs), coverage (the share of lines under the label that holds most of their reference speaker's lines), the number of voices, and agreement with today's labels, line by line.
- **The spread:** today's pass on each case cut at 870, 900 and 930 s. For each score, the spread is the largest range one case shows across its three cuts, over the five cases.

### During the call, in the app

- The same arms, on eight minutes of EN2002a's computer-sound track (1650–2130 s), with call help asked three times (at 70, 130 and 190 s) on Claude Haiku 5.5.
- **Quiet:** two runs a side, started with the 15-minute load at or below 21.
- **Busy:** two runs a side, each beside three copies of the full speaker pass on another case at normal priority, started 60 s before the call.
- **Measured:** each live line's lag (from the end of its audio to its line appearing in the Transcript's file, read every 200 ms), as median and 90th percentile, and call help's first words for each action.

## The bars

Each must hold. One that fails stops the change.

- **Speed after Stop:**
  - In each branch run of a four-minute call, "Telling the speakers apart…" takes at most 2.4 s: 2 s to the nearest second.
  - In the branch's fifteen-minute run, it takes at most a third of main's on the same call.
- **Labels:**
  - On each of the five cases, the branch's purity and coverage are each at least today's less the spread.
  - On the four-minute cut, the branch finds as many voices as today's, and its purity and coverage are each at least today's.
  - Main's pass and today's give the same label on every line.
- **During the call:** in each of quiet and busy, every branch run's lag median and 90th percentile are at most the largest of main's runs in that condition, and every first-words time of call help is at most the largest of main's in that condition.

## Reported, not gated

- How often the branch finds more voices than today's, on which case, and why.
- The runs during the call: how many, how much audio each took, and how long.
- How much is left to cluster at Stop, and how long that takes, in the app and in the bench.
- Where live text fell more than 30 s behind, in either arm (#2902).
- The step on the eight-minute call, and the notes' timing.
- Local mode: one four-minute run of the branch with Local mode on.
- Load and spend.

## What passing changes

If every bar holds, the change ships. If one fails, it doesn't, and the numbers go on #2839.

## Spend

Within this phase's $3, counted from each run's timing records.
