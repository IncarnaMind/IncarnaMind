# Telling speakers apart after the call

How well, and how fast, the speaker pass (#138) tells a Meeting's voices apart on this computer: pyannote's segmentation-3.0 and 3D-Speaker's CAM++ through sherpa-onnx-node's speaker diarization, on the CPU. It runs the pass's own code: `createSherpaSeparator` in `src/core/transcription/diarization.ts` reads the audio as a Meeting keeps it, in 10-second parts, and `labelled` in `src/core/meetings/speakerPass.ts` gives the Transcript's lines their labels.

## Running it

```sh
npm run eval:meetings:fetch            # the meeting audio set (eval/meetings, #85)
npm run eval:speakers
npm run eval:meetings:score -- eval/results/speakers-<time>/lines-<threshold>-<same person>
```

- **The set:** eval/meetings' cases, online and in a room, in English, Chinese and both. Online, the pass separates the computer's sound and the microphone's lines are "Me"; in a room it separates the room's track.
- **The lines:** cut with Silero VAD as the transcription process cuts them, then labelled by the pass's rule. That is what DER is scored on: the final labels, a line at a time. `turns-…` holds the engine's own turns, for comparison.
- **The models:** downloaded the first time into `~/.cache/incarnamind-eval/models/` (about 30 MB) and checked against the SHA-256 hashes in `src/core/transcription/speakerModel.ts`, as the app downloads them.
- **Options:** `INCARNAMIND_EVAL_SPEAKER_CASES` picks cases by id, `INCARNAMIND_EVAL_SPEAKER_THRESHOLDS` tries clustering thresholds (`CLUSTER_THRESHOLD` is the app's), `INCARNAMIND_EVAL_SPEAKER_SAME` how alike two voiceprints are to be one person (`SAME_PERSON`), `INCARNAMIND_EVAL_SPEAKER_MINUTES` keeps only the start of each case, and `INCARNAMIND_EVAL_SPEAKER_HOUR=1` adds an hour of the room cases for the real-time factor, and `INCARNAMIND_EVAL_SPEAKER_WINDOW` sets the minutes the engine clusters at once (`WINDOW_SECONDS` is the app's), to check the voiceprint join across windows on cases shorter than the app's window.
- **Reported:** each case's voices found, labels given and time over audio, with the machine's load average, in `speakers.md`. The scorer gives DER with a 0.25 s collar, overlap scored. The hypotheses carry no text, so its word error rate means nothing here.

## How the settings were chosen

`CLUSTER_THRESHOLD` (0.7), `SAME_PERSON` (0.6) and the join's rule for rough voiceprints in `src/core/transcription/diarization.ts` were set on 2026-11-18 on the English cases alone: their first 15 minutes (`INCARNAMIND_EVAL_SPEAKER_MINUTES=15`) for the two settings, their first 1, 3 and 15 minutes and whole length for the rule, with three short recordings of two voices made for #138. The Chinese and mixed cases were scored afterwards. They are not blind: an earlier form of the rule was scored on them before this one was chosen.

- **The engine's threshold doesn't carry across lengths.** At 1.05, the first setting (2026-10-21), a person stays whole over a long meeting, and two voices 0.2 alike came out as one speaker in a 40-second recording (#138). At 0.5 to 0.8 the engine keeps them apart and splits each person instead: 26 to 89 voices over a whole meeting of two to four people. So the engine is set to split, and the join puts people back together.
- **The join.** Voices whose voiceprints are at least 0.6 alike are one person, and a voice with under 2% of the speech joins the voice most like it. A voiceprint from short stretches is rough: over the English meetings one person's voices are 0.27 alike at the median when the shorter voice's longest stretch is under 2 s, 0.64 at 3 to 5 s and 0.84 from 8 s, while two people's stay at 0.14 to 0.28. So the likeness needed rises evenly from 0.3 to 0.6 as both voices' longest stretch reaches 10 s.
- **Tried and dropped:** the 0.6 join alone at 0.7 (a one-person track came out as two or three voices in its first minutes); 0.3 for any voice with under 10 s of speech (a person's short fragments joined each other into a second speaker on a 36-minute one-person track); a likeness above 0.6 for full voiceprints (it splits the English speakers, whose own voices are as little as 0.57 alike). `STRAY_SHARE` (2%) and `PRINT_SECONDS` (30 s) were not swept.

English first 15 minutes, DER:

| Engine threshold / same person | Online | Room | All | The made recordings |
|---|---|---|---|---|
| 1.05 / 0.6, the first settings | 14.3% | 30.1% | 21.8% | one voice each |
| 0.5 / 0.6 | 14.8% | 26.3% | 20.3% | two each |
| 0.7 / 0.6 | 14.3% | 26.5% | 20.1% | two each |
| 0.8 / 0.6 | 14.4% | 26.5% | 20.2% | two each |
| 0.9 / 0.6 | | | | one voice on the English one |
| 0.7 / 0.5 | 14.4% | 30.2% | 21.9% | two each |
| 0.7 / 0.7 | 15.0% | 27.3% | 20.8% | two each |

The settings as they are against the first ones, same machine and day:

| | These settings | The first settings |
|---|---|---|
| Two made voices, 24 to 37 s, English and Chinese (three recordings) | two voices, every turn right | one voice |
| Two real people's microphone tracks put in turn, 46 s, English | two voices | two voices |
| The same, Chinese | two voices, every turn right | one voice |
| One-person tracks, first 1 and 3 minutes and whole (four) | one voice | one voice |
| First minute of the ten cases, DER | 25.8% | 24.8% |
| First 3 minutes, DER | 27.9% | 31.0% |
| Whole, English online | 18.4% | 18.2% |
| Whole, English room | 25.9% | 37.4% |
| Whole, Chinese online | 18.9% | 18.9% |
| Whole, Chinese room | 49.0% | 46.4% |
| Whole, mixed conversation | 39.2% | 38.9% |
| Whole, all ten | 29.3% | 31.2% |
| The pass's time over the audio's length, the two longest cases back to back | 0.10 and 0.10 | 0.10 and 0.11 |

- **Where it is worse:** one Chinese room meeting of four (R8007_M8010, 63.4% against 58.4%) comes out as two voices where the first settings found three. Its speakers' voiceprints are up to 0.74 alike across people, more than one English speaker's own (0.57), so no likeness separates them and keeps the English speakers whole. The first minute's difference is 3 s of 304 s of speech.
- In the first minutes the first settings gave one voice to a two-person conversation's first minute and to a three-person call's first 3 minutes; these settings give three voices and two.

## The models' licences

Checked for redistribution on 2026-10-21:

- **pyannote segmentation-3.0:** MIT, © 2022 CNRS. sherpa-onnx's authors' int8 ONNX export carries the licence.
- **3D-Speaker CAM++ (Chinese and English, `speech_campplus_sv_zh_en_16k-common_advanced`):** Apache-2.0, as its ModelScope card says. sherpa-onnx's authors exported it to ONNX.
