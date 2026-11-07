# Transcription on this computer

How well, and how fast, the first speech-to-text engine (#136) transcribes: Qwen3-ASR-0.6B int8 with Silero VAD, through sherpa-onnx-node, on the CPU. It runs the transcription process's own code (`createSpeechHost` in `src/core/transcription/speech.ts`, `createSherpaEngine` in `src/core/transcription/sherpa.ts`) on a stream made of read clips, fed in 100 ms frames at the pace it was spoken, as a Meeting's audio is.

This is the quick check, on read speech. The meeting audio set and its scorer are in [`eval/meetings`](../meetings/README.md) (#85); #137 runs the bake-off on that set, on three machines, and sets the gate.

## Running it

```sh
python3 -I eval/transcription/fetch-fleurs.py ~/.cache/incarnamind-eval/fleurs 8
INCARNAMIND_EVAL_CLIPS=~/.cache/incarnamind-eval/fleurs npm run eval:transcription
```

- **Clips:** the first clips of Google's FLEURS dev split, in English (`en_us`) and Mandarin Chinese (`cmn_hans_cn`), with their reference transcripts, from a pinned revision on Hugging Face. FLEURS is under CC BY 4.0 (Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech", 2022). `fetch-fleurs.py` reads only the start of each audio archive and stops once it has the clips. Nothing is committed.
- **The model:** downloaded the first time into `~/.cache/incarnamind-eval/models/` (about 985 MB), checked against the SHA-256 hashes pinned in `src/core/transcription/model.ts`, as the app downloads it; `INCARNAMIND_EVAL_MODELS` points at another folder laid out the same way.
- **The stream:** each language's clips in order, with 1.5 s of silence before each and after the last, as pauses between speakers.
- **Reported:** WER for English, CER for Chinese, after the normalisation below; how long decoding the final text took for the speech it decoded; how long all decoding took, partial text included, for the stream; how many partials there were; and how far after the audio ended the last line came. Also the machine's load average while it ran: the times are only as good as the machine was free. The report is written to `eval/results/`.

## Normalisation

The rules are in `scoring.ts` and tested in `tests/eval/transcriptionScoring.test.ts`. They are the meeting set's too, and are written out in [`eval/meetings/README.md`](../meetings/README.md#normalisation): case is folded; tags and hesitations ("uh", "呃") are dropped; punctuation and symbols are dropped; Traditional characters become simplified; numbers are digits ("6", "六" and "six" are the same); English is compared by word, Chinese by character with each run of Latin letters or digits as one unit.

## Results

The tables below were scored with the rules of their day, which left numbers as written and kept hesitations. A run now scores a little differently: "六英里" for "6 英里" below is no longer an error.

2026-10-11, Apple M2 Max (12 cores, 32 GB), 4 threads, while the machine ran other work (load average 28 to 35 over the run):

| Language | Clips | Audio | Error | Decoding / speech decoded | All decoding / stream | Last line after the audio ended |
|---|---|---|---|---|---|---|
| English | 8 | 74.7 s | WER 12.8% (18 of 141 words) | 0.15× | 0.22× | 0.0 s |
| Chinese | 8 | 113.9 s | CER 1.7% (4 of 231 characters) | 0.23× | 0.17× | 0.0 s |

- Of the 4 Chinese errors, one is a number written as a word ("六英里" for "6 英里"), two are names written in other characters ("科龙" for "科隆", "加南" for "迦南"), and one a character said twice ("主主要").
- Most English errors are names (Javanese, archipelago, Lakkha Singh, bhajans, Mahayana) and one clip read badly.
- FLEURS is read speech, one speaker at a time, recorded close: easier than a meeting.
- Load matters. Earlier the same day, with the machine far busier (load average 124 to 183), decoding single clips took 1.3 to 1.7 times their length: slower than real time. Live text then falls behind, the meeting bar says "Recording…", and the rest is transcribed after Stop (#136).
- The FLEURS clips are recorded quietly (a peak of 0.5% to 2.4% of full scale for most English ones). Before the speech host raised quiet audio (up to 30 dB), Silero VAD missed four of the eight English clips: WER 48.2%.

## Each route: this computer, OpenAI, Soniox and Qwen (#141, #463)

`routes.transcription.ts` sends the same clips to each place meeting audio can be transcribed. It runs three streams per route: the English clips, the Chinese clips, and the two taking turns. A route runs only with its key in the environment, and `INCARNAMIND_EVAL_ROUTES` picks some of them. The cloud streams go through the app's own adapters (`src/core/transcription/cloud`). The mixed stream counts each Han character and each English word as one unit. `INCARNAMIND_EVAL_RECORD` writes what each service sent back, which is how the adapters' contract-test fixtures were made.

```sh
set -a; . ./.env.local; set +a   # OPENAI_API_KEY, SONIOX_API_KEY, QWEN_API_KEY (and QWEN_REGION: cn or intl)
INCARNAMIND_EVAL_CLIPS=~/.cache/incarnamind-eval/fleurs npx vitest run --config eval/transcription/vitest.config.ts eval/transcription/routes.transcription.ts
```

It checks that each route works in both languages, not which is best: 8 clips per language is 141 English words and 231 Chinese characters, errors cluster by clip, OpenAI varies from run to run, its lead-in was tuned on these clips, and the results above were scored before numbers and Traditional characters were folded. A ranking waits for the meeting set (`eval/meetings`).

2026-10-19, Apple M2 Max, the three routes at once (load average about 40):

| Route | English (WER) | Chinese (CER) | Both taking turns |
|---|---|---|---|
| This computer, Qwen3-ASR 0.6B | 12.8% (18 of 141) | 1.7% (4 of 231) | 4.3% (16 of 372) |
| OpenAI `gpt-live-transcribe` | 7.1% (10 of 141) | 6.9% (16 of 231) | 7.0% (26 of 372) |
| Soniox `stt-rt-v5` | 9.9% (14 of 141) | 1.3% (3 of 231) | 3.5% (13 of 372) |

- OpenAI varies most from run to run. Another run of the same code gave 6.4%, 4.8% and 6.7%.
- Before its turns started 1.2 s ahead of the detector, OpenAI cut first words, and Chinese was 7.8%.

2026-10-25, the refreshed Qwen branch's local-only control on the same clips:

| Route | English (WER) | Chinese (CER) | Both taking turns |
|---|---|---|---|
| This computer, Qwen3-ASR 0.6B | 12.8% (18 of 141) | 1.3% (3 of 231) | 4.0% (15 of 372) |

The Qwen rows remain pending until a real key is available; no cloud result is inferred from the fixtures.

## Live words on this computer (#2662)

`live.transcription.ts` measures how soon the live words come and how often they change, at the pace speech is said, through the transcription process's own code. It runs the English clips, the Chinese clips and the two taking turns, one stream after the other. It runs with the streaming model, or with `INCARNAMIND_EVAL_LIVE=off` without it, as before ADR-0027: then the speech so far is decoded again every 2.5 s. Run each in a process of its own, so its memory is its own:

```sh
INCARNAMIND_EVAL_LIVE=off INCARNAMIND_EVAL_CLIPS=~/.cache/incarnamind-eval/fleurs npx vitest run --config eval/transcription/vitest.config.ts eval/transcription/live.transcription.ts
INCARNAMIND_EVAL_CLIPS=~/.cache/incarnamind-eval/fleurs npx vitest run --config eval/transcription/vitest.config.ts eval/transcription/live.transcription.ts
```

Each clip's speech starts at its first 10 ms louder than a tenth of its peak, and ends at its last such 10 ms. The run reports:

- **First words:** when the clip's first live words are reported, after its speech starts. With no live words yet, its first line counts instead.
- **Updates:** how often the clip's live words change while it is said.
- **Finished:** when its line is final, after its last sound.
- **Errors:** the error of the finished lines, and of the streaming model's own words for each stretch, which is what streaming alone would give.
- **Cost:** the process's CPU time over the audio's length, and its largest memory.

The times are where the transcription process reports the words. The window then shows unfinished words at most every 0.5 s (`PARTIAL_EVERY_MS` in `src/core/meetings/transcript.ts`).

2026-11-07, Apple M2 Max (12 cores, 32 GB). Qwen3-ASR has 4 threads and the streaming model 1. The machine was busy: load average 16–18 for the run before and 10–14 for the run after. Medians of 8 clips are the upper middle one.

| Language | | First words (median, p90) | Live words change every (median, p90) | Line finished after its last sound (median, p90) | Finished lines | Live words alone | CPU s per audio s |
|---|---|---|---|---|---|---|---|
| English | before | 3.68 s, 6.18 s | 3.62 s, 3.62 s | 2.94 s, 4.71 s | WER 11.3% (16 of 141) | – | 1.19 |
| English | after | 1.79 s, 6.60 s | 0.30 s, 0.40 s | 1.43 s, 2.23 s | WER 11.3% (16 of 141) | WER 42.6% | 0.37 |
| Chinese | before | 3.13 s, 3.33 s | 6.13 s, 6.13 s | 1.44 s, 4.84 s | CER 2.6% (6 of 231) | – | 0.59 |
| Chinese | after | 0.51 s, 0.80 s | 0.30 s, 0.60 s | 1.39 s, 2.03 s | CER 2.6% (6 of 231) | CER 5.2% | 0.28 |
| Both taking turns | before | 3.34 s, 4.21 s | 3.07 s, 7.08 s | 1.76 s, 3.66 s | 4.6% (17 of 372) | – | 0.82 |
| Both taking turns | after | 0.75 s, 2.35 s | 0.30 s, 0.60 s | 1.32 s, 1.90 s | 4.6% (17 of 372) | 16.1% | 0.30 |

- **English first words**, clip by clip, after: 0.47, 0.50, 0.78, 0.98, 1.79, 2.09, 4.0 and 6.6 s.
  - The streaming model writes nothing for the first words of some English sentences.
  - Fed alone, the same clips start their words at times that depend on how much audio comes before the speech, by up to 1 s either way. It is the model's English, not the pipeline.
  - Every Chinese clip had words within 0.8 s.
- **Finished lines:** the same, word for word, here and on the first 4 minutes of each case of the meeting set (`npm run eval:meetings` with and without `INCARNAMIND_EVAL_LIVE=off`: 383 lines, WER 25.7% and 36.0%, CER 14.4% and 38.5%, MER 25.5%).
- **Memory:** the process had 1.11 GB before and 1.49 GB after once loaded, and at most 2.27 GB before and 2.65 GB after.
