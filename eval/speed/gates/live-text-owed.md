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
