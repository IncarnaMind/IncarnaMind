# The gate for live text that is behind only by what the engine owes (#2902)

Written and committed on 2026-11-09, before any run it gates.

## The change

For an engine that reads long speech in parts (`SpeechEngine.longestMs`, Qwen3-ASR's 15 s since #2908), the speech host's progress also says how far each stream was heard with nothing owed before it but the final readings queued: where the stream had got when its oldest final reading still due was queued, or all it received when none is. The core already takes `heardMs` for cloud routes, and its test for falling behind (pushed − max(heard, done) > 30 s) is unchanged. `doneMs`, what is final, is unchanged, so what is read again after Stop or after a crash is unchanged. An engine that reads each stretch whole keeps `heardMs` = `doneMs`.

So a turn still being said no longer counts as lateness. Today up to 15 s of it does, plus its own decode and the queue ahead of it.

## Measured before this gate (reported on #2902)

- In #2839's gate runs, live text fell behind in 8 of 10 calls of eight or fifteen minutes, each time at one long turn. The turn's own length (18.2–22.8 s) took 60–76% of the 30 s, and the rest went to its own decode.
- Since #2908, on main, the 8-minute EN2002a call (computer sound only, and both tracks) and 8 minutes of R8007_M8011 kept up when quiet. Their worst moments were 19.4, 17.9 and 17.4 s.
- Replayed slower, main's rule falls behind from an average 0.84 s of decode per s of audio with both tracks, 0.98 with one track and 0.94 on the Chinese call.

## The bars

**1. Nothing in decoding changes.** On the real engine (Qwen3-ASR 0.6B), each window is read as fast as it goes, with the host's own cut. For EN2002a's computer sound 1650–2130 s and 0–480 s, and R8007_M8011's 0–480 s and 480–900 s, the branch gives the same lines as main: the same count, and each with the same start, end and text. Line lag medians and 90th percentiles from the runs in bar 4 are reported for both arms, not gated: two quiet runs of one call on main differed by 0.4 s and 2.3 s.

**2. The difference, shown deterministically.**
- **Replays.** The recorded quiet runs' lines are put through the speech host's own code (`createSpeechHost`). A detector hears speech where each line was, and each decode takes that line's recorded decode time × k in the call's own time. The runs are main's 8-minute call with the computer sound only, with both tracks, and 8 minutes of R8007_M8011. Both rules are read from the host's own reports: main's (pushed − the oldest `doneMs`) and the change's (pushed − the oldest `heardMs`).
  - At average speeds of 0.56, 0.70 and 0.84 s per s, one track and both tracks: the change never falls behind.
  - Both sides talking densely at once (the one-track run's lines on two tracks at the same moments): the change never falls behind at 0.56.
  - Expected contrast, stated now: main's rule falls behind at 0.84 with both tracks.
- **A test through the core's public interface,** with the scripted engine and literal numbers (`tests/core/liveTextBehind.test.ts`). Both sides talk for 15 s and then one goes on, each decode taking 0.85 of the audio's time. Live text stays up with the change. The same call on an engine that reads each stretch whole falls behind between 30 and 32 s. This test fails without the change.

**3. A computer that can't keep up still falls behind.** With the scripted engine at 1.5 times real time and both sides talking, live text is behind within 60 s, and the Transcript after Stop holds both sides from the first second to at least 59 s.

**4. The built app, on the real engine.** These are test builds of main and the branch. A call is the recording played as the computer's sound (and the microphone's, for both tracks), Stop is pressed 3 s after it ends, and no chat model is set. The calls:
- EN2002a 1650–2130 s;
- EN2002a 0–900 s;
- R8007_M8011 0–480 s;
- EN2002a 1650–2130 s with both tracks.

Each run is quiet: the 1-minute load at most 18 and the 15-minute load at most 24, at the start, at any fall and at Stop. A run that crosses either limit is run again. They run one at a time, never chained, with no synthetic load. The branch must never fall behind, and the Transcript must be saved within 5 s of Stop. Main's arm of the same calls is reported beside it.

**5. Unit tests with literal numbers.**
- A 15 s turn whose line takes 25 s isn't behind; with 31 s it is, from 46 s.
- The host reports what each stream owes: nothing while speech is said, and from the cut (15.7 s here) until its line comes.
- A stream with nothing queued owes nothing.
- An engine that doesn't cut reports `heardMs` = `doneMs`.
- Paused and resumed while a line is owed, the engine restarting, Stopped, and IncarnaMind closing: no line is lost, and the kept `doneMs` doesn't pass the owed line.

**Reported, not gated:** for each run in bar 4, the lines that came more than 20 s and more than 30 s after their speech ended.

## What decides

The change ships if every bar holds. If one fails, it ships no further and the numbers go on #2902. No model is called: $0.

## Result, 2026-11-09

The change is at 5036b400b; no model was called.

| Bar | Outcome |
|---|---|
| 1. Nothing in decoding changes | **Holds.** Main (d57bb7d07) and the branch give identical lines, each with the same start, end and text: EN2002a 1650–2130 s 85 and 85, 0–480 s 65 and 65; R8007_M8011 0–480 s 57 and 57, 480–900 s 50 and 50. |
| 2. Replays | **One line fails** (below). Everything else holds: at 0.56, 0.70 and 0.84 s per s the change never falls behind, with one track (EN 11.9 / 14.9 / 17.9 s at worst, ZH 9.0 / 11.3 / 14.8 s) or both tracks (9.1 / 12.2 / 17.2 s). |
| 2. Scripted test through the core | **Holds.** Both sides talk for 15 s, then one goes on for 75 s more. At 0.85 of real time, live text stays up. At 1.2 it falls behind between 45 and 47 s. An engine that reads each stretch whole falls behind between 30 and 32 s. The 0.85 test fails without the change. |
| 3. A computer that can't keep up | **Holds.** At 1.5 times real time, live text is behind within 60 s. The Transcript after Stop holds both sides from the first second to at least 59 s, with no stretch missing between. |
| 4. The built app, on the real engine | Not yet run: the load stayed over the limits. Its results are added here when taken. |
| 5. Unit tests | **Hold** (`tests/core/liveTextBehind.test.ts`). They also cover a stretch whose piece starts at the same cut as a piece still owed, which keeps the older one owed from when it was queued. |

The replays, worst moment against the 30 s rule or where live text falls behind:

| Call | Speed (s per s) | Main's rule | The change |
|---|---|---|---|
| EN, computer sound | measured 0.28 | 17.4 s | 5.9 s |
| | 0.56 / 0.70 / 0.84 | 23.0 / 26.0 / 29.0 s | 11.9 / 14.9 / 17.9 s |
| | 0.98 | falls behind at 300.9 s | 21.0 s |
| | 1.12 | falls behind at 193.5 s | 29.2 s |
| EN, both tracks | measured 0.17 | 15.4 s | 2.5 s |
| | 0.56 / 0.70 / 0.84 | 20.7 / 22.9 / 27.8 s | 9.1 / 12.2 / 17.2 s |
| | 0.98 | falls behind at 224.8 s | falls behind at 324.1 s |
| ZH, computer sound | measured 0.15 | 17.0 s | 2.2 s |
| | 0.56 / 0.70 / 0.84 | 23.8 / 26.1 / 28.4 s | 9.0 / 11.3 / 14.8 s |
| | 0.98 | falls behind at 109.4 s | 19.1 s |
| Both sides densely at once | measured 0.28 / 0.42 | 23.1 / 29.1 s | 12.0 / 18.0 s |
| | 0.56 | falls behind at 193.5 s | falls behind at 324.1 s |
| | 0.70 | falls behind at 178.9 s | falls behind at 209.3 s |

Exception, 2026-11-09: bar 2's line "both sides talking densely at once: never at 0.56" failed (the change falls behind at 324.1 s, 30.1 s at worst) and stays failed. Main fails the same line earlier, at 193.5 s. The change falls behind later than main, or not at all, in every replay.

- **Cause, shown after the result, by a separate replay.** The replay ends each decode only at the next 0.1 s of audio, and two tracks have twice the decodes. The same total work on one track (1.12 s per s) holds at 29.2 s. With decodes ending every 20 ms instead, the same case holds at 28.4 s, while main's rule still falls behind at 193.4 s.
- **Correction to an earlier draft.** An earlier draft of this note gave the cause as "in 240–330 s that case needs 1.03–1.04 s of decoding per second of call, so the computer can't keep up there". One track under the same load holds, so that was wrong.

- **The stated contrast didn't appear.** Main's rule held at 0.84 with both tracks (27.8 s at worst). It falls behind from 0.98, on both tracks, one track and the Chinese call.
- **Why the replays favour main's rule.** The replay's detector ends each line exactly where it was, so each line is queued at its end. The app queues a part cut from longer speech only at the cut, up to 4 s after the part's end, and a stretch the detector ends 0.5 s after its last speech. So in the replays decodes start earlier, which lowers main's measure (counted from a line's start) and raises the change's (counted from the queueing).
- **Checked at no cost:** at every moment of every replay above (95,880 moments, a tenth of a second apart, over 20 replays), the change's measure is no larger than main's. It can't be, since `heardMs` is never short of `doneMs`. The replay asserts this, and so does a unit test: over three turns and six held decodes, no progress report has `heardMs` below `doneMs`. The bench and replay scripts aren't in this repository; their input is the quiet runs' line timings.

## Result of bar 4, 2026-11-12

The built app, on the real engine (Qwen3-ASR 0.6B with its streaming model), in Local mode.
- **Recording:** the recording played as the computer's sound, and the microphone's for both tracks; Stop 3 s after it ended.
- **Branch arm:** the test build at 7fbd9c5c0.
- **Main arm:** the test build of the branch's merge base, d57bb7d07, with only the test build's microphone recording added, so the two-track call can be played. Nothing else of this change is in it.
- **Loads** (1-minute / 15-minute) are read at the start and at Stop; no run fell behind, so no load at a fall exists.
- **Counting:** a run counts when both limits (18 and 24) hold at each of those points.
- **Scheduling:** the runs went one at a time, each waiting for three readings a minute apart of at most 14 and 22. A run that didn't count was taken again, up to four tries.

| Call | Arm | Try | Load at start (1 / 15 min) | Load at Stop (1 / 15 min) | Fell behind | Stop to saved | Live lines | Lag median / p90 | Lines over 20 s / 30 s | Counts |
|---|---|---|---|---|---|---|---|---|---|---|
| EN2002a 1650–2130 s | branch | by hand | 14.80 / 20.90 | 24.68 / 20.67 | no | 0.008 s | 86 | 1.34 / 3.06 s | 0 / 0 | no (limits crossed) |
| EN2002a 1650–2130 s | branch | 1 | 10.61 / 18.07 | 9.34 / 13.68 | no | 0.009 s | 83 | 1.33 / 2.37 s | 0 / 0 | **yes** |
| EN2002a 1650–2130 s | main | 1 | 7.10 / 12.54 | 19.86 / 11.72 | no | 0.009 s | 83 | 1.35 / 2.55 s | 0 / 0 | no (limits crossed) |
| EN2002a 1650–2130 s | main | 2 | 10.31 / 11.37 | 7.63 / 10.74 | no | 0.010 s | 84 | 1.36 / 2.59 s | 0 / 0 | **yes** |
| EN2002a 0–900 s | branch | 1 | 8.28 / 10.36 | 90.93 / 34.37 | no | 0.009 s | 124 | 1.33 / 2.62 s | 0 / 0 | no (limits crossed) |
| EN2002a 0–900 s | branch | 2 | 10.62 / 16.23 | 10.06 / 12.27 | no | 0.008 s | 125 | 1.51 / 3.44 s | 0 / 0 | **yes** |
| EN2002a 0–900 s | main | 1 | 8.56 / 14.41 | 7.54 / 10.27 | no | 0.008 s | 125 | 1.37 / 2.7 s | 0 / 0 | **yes** |
| R8007_M8011 0–480 s | branch | 1 | 8.67 / 10.03 | 8.11 / 9.63 | no | 0.007 s | 57 | 1.42 / 3.68 s | 0 / 0 | **yes** |
| R8007_M8011 0–480 s | main | 1 | 4.95 / 8.98 | 3.80 / 6.79 | no | 0.005 s | 57 | 1.31 / 3.13 s | 0 / 0 | **yes** |
| EN2002a 1650–2130 s, both tracks | branch | 1 | 3.72 / 6.40 | 4.34 / 5.78 | no | 0.021 s | 151 | 1.25 / 2.07 s | 0 / 0 | **yes** |
| EN2002a 1650–2130 s, both tracks | main | 1 | 3.74 / 5.48 | 3.86 / 5.01 | no | 0.007 s | 155 | 1.23 / 2.06 s | 0 / 0 | **yes** |
| EN2002a 1650–2130 s, retake at the merged head | branch | 1 | 7.97 / 6.07 | 6.41 / 6.23 | no | 0.006 s | 86 | 1.33 / 2.38 s | 0 / 0 | **yes** |

**Bar 4 holds.** Every counted branch run kept up: it never fell behind, no line came more than 20 s after its speech, and the Transcript was saved 0.006–0.021 s after Stop. Main's arm kept up on every call too, as expected: since #2908 these calls keep up on main, and this change is the margin beyond them.

**The runs that didn't count:**
- the branch's 8-minute call taken by hand, with a 1-minute load of 24.68 at Stop;
- main's first 8-minute try, at 19.86 at Stop;
- the branch's first 15-minute try, at 90.93 at Stop.

All three kept up all the same: they are reported, not counted.

**The retake after #2960.** The eight runs were taken before #2960, which changed what happens when the transcription process is closed and after Stop. The branch was then merged with main (at caaa9a985, merge commit dd922b419), and the 8-minute call was taken again on a fresh test build of the merged head. It counted at the first try: it never fell behind, and the Transcript was saved 0.006 s after Stop. That run ended at 02:01:05 UTC.

**Why the earlier runs' live numbers stand.** Between 7fbd9c5c0 and the merged head, main changed:
- in `adapters.ts`, comment lines only;
- in `transcript.ts`, `channel.ts` and `model.ts`, only what happens at close and after Stop: a stretch still being finished is kept for the next start, and what is still asked of a closed process fails;
- in `spokenNumbers.ts`, how a number in a line's text is written.

Nothing changed in what is sent to the engine during a call, in its queue, or in the progress it reports, which is all that the live numbers depend on.
