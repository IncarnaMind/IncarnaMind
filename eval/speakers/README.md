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

`CLUSTER_THRESHOLD` (1.05) and `SAME_PERSON` (0.6) in `src/core/transcription/diarization.ts` were set on the first 15 minutes of the four English cases alone (`INCARNAMIND_EVAL_SPEAKER_MINUTES=15`), on 2026-10-21. Numbers are then scored on the rest. The Chinese and mixed cases, in full, are held out cleanly. The English cases from minute 15 to the end are the same meetings and speakers as the tuning, so they aren't independent.

- Thresholds from 0.5 to 1.4 were tried. Below 1.0 the engine finds 7 to 15 voices in a quarter of an hour of four people; above 1.15 it merges the room's speakers.
- Over a whole meeting the engine still splits people (9 to 16 voices for four). Joining voices whose voiceprints are at least 0.6 alike, and each voice with under 2% of the speech into the voice most like it, leaves 2 to 5. On the English online calls, the share of lines given the wrong speaker went from 16.8% to 10.8%.
- The join was added after runs over whole meetings, the held-out minutes and the Chinese cases among them. `SAME_PERSON` was then set on the English first 15 minutes; `STRAY_SHARE` (2%) and `PRINT_SECONDS` (30 s) were not swept.

## The models' licences

Checked for redistribution on 2026-10-21:

- **pyannote segmentation-3.0:** MIT, © 2022 CNRS. sherpa-onnx's authors' int8 ONNX export carries the licence.
- **3D-Speaker CAM++ (Chinese and English, `speech_campplus_sv_zh_en_16k-common_advanced`):** Apache-2.0, as its ModelScope card says. sherpa-onnx's authors exported it to ONNX.
