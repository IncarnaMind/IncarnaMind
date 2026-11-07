---
status: accepted (2026-11-07)
---

# Live words on this computer come from a small streaming model; Qwen3-ASR still writes each finished line

A Meeting transcribed on this computer (#136) shows its words twice. First come the live words, which are unfinished and change as the speaker goes on. Then comes the finished line, which is saved in the Transcript and can be cited. The engine is Qwen3-ASR 0.6B with Silero VAD, through sherpa-onnx-node. Qwen3-ASR is not a streaming model. For live words, the speech host decoded the whole stretch heard so far again every 2.5 s, one decode at a time, after any finished line waiting. On 2026-11-07 the first words came 4.3 s (English) and 8.1 s (Chinese) after speech started, and the live words then changed every 3 to 6 s. The cloud routes change them every 0.2 s (#2662).

Strong products all show provisional words at once and replace them in place when a better result is ready. They differ in where the provisional words come from:

- **A streaming model's own partial results, then its final result.** Apple's SpeechTranscriber calls them volatile and finalized results. Handy uses Nemotron Streaming. Superwhisper's realtime mode uses Parakeet.
- **Two passes.** A streaming model gives the draft, and a stronger model reads each segment again once it ends. Google's on-device RNN-T + LAS works this way, as does FunASR's "2pass" runtime.
- **Decoding a non-streaming model again over a growing window.** WhisperKit does this, and it is what this computer did.

Sources, checked 2026-11-07:

- Apple SpeechTranscriber's volatile and finalized results: https://developer.apple.com/videos/play/wwdc2025/277/ and https://developer.apple.com/documentation/speech/speechtranscriber/reportingoption/volatileresults
- Handy 0.9.0's streaming models through transcribe.cpp: https://github.com/cjpais/Handy/blob/main/src/content/release-notes/0.9.0.md and https://github.com/handy-computer/transcribe.cpp
- Superwhisper's realtime mode, streaming models only: https://superwhisper.com/docs/common-issues/realtime
- Google's two-pass RNN-T + LAS, and on device: https://arxiv.org/abs/1908.10992 and https://arxiv.org/abs/2003.12710
- FunASR's "2pass" runtime: https://github.com/modelscope/FunASR/blob/main/runtime/docs/SDK_advanced_guide_online.md
- WhisperKit's re-decoding with confirmed prefixes: https://arxiv.org/abs/2507.10860
- The streaming models sherpa-onnx runs: https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html, https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html and https://k2-fsa.github.io/sherpa/onnx/nemo/nemotron-streaming.html
- Nemotron 3.5 ASR streaming and its licence: https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b and https://openmdw.ai/license/1-1/
- FunASR's model licence: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE

## Decision

**Two passes, in the transcription process.**

- **The live words.** A streaming Zipformer transducer for Chinese and English reads each stretch of speech as it is said: `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`, int8, Apache-2.0, 199 MB.
  - It runs through sherpa-onnx-node's `OnlineRecognizer`, which the app already ships.
  - A reading starts when Silero VAD hears speech. It is fed from 0.4 s before that, then every 100 ms frame as it comes.
  - The words it has so far are the stretch's partial text (`SpeechSegment.final: false`), reported whenever they change.
  - The stretch is never decoded again while it goes on.
- **The finished line.** Once the speaker pauses, Qwen3-ASR decodes the whole stretch, as before, and its text is the final line. Its Words to know (#1031) are unchanged, so finished lines are the same as before on the same audio.
- **Live words stay until their line comes.** A stretch's live words stay shown until its final text arrives.
  - If the next stretch starts first, one partial carries both stretches' words. It has the first stretch's id, so the final text replaces it.
  - The partial is then reported again for what is still unfinished.
  - The core and the window are unchanged: they already show one partial for each stream and drop it when the final with its id comes.
- **One thread, on the process's own thread.** sherpa-onnx has no asynchronous call for a streaming model.
  - One thread read the FLEURS clips at 0.044 of their length. Two threads took 0.039, for nearly three times the CPU.
  - Qwen3-ASR keeps decoding on sherpa's own threads (`decodeAsync`), so the two passes overlap.
- **English in capitals.** The model writes English in capitals, so its live words are shown in lower case.
- **A slow computer.** The streaming model's reading time is measured against the audio's time, every stream counted, over the last minute.
  - If it takes more than half, live words go back to decoding the speech again until no stream is open, so the next Meeting starts with them again. The app's log records this.
  - The same happens if the model fails while reading. If it can't load at all, the engine loads without it, and live words are decoded again as before.
  - Falling behind is still said as before (#462): when finished lines fall 30 s behind, the meeting bar says "Recording…" and the rest is transcribed after Stop.
- **The download.**
  - The streaming model is part of the speech model's download: a pinned revision, each file's size and SHA-256 checked, and the same fallback sources (#1578).
  - Its size is in the total the meeting bar shows. The first-recording sheet now says the speech models are about 1.2 GB.
  - On an installation that already has the speech model, the streaming model downloads on its own when a Meeting starts. Transcription goes on meanwhile without it, and the next Meeting uses it.
  - Its part of a first download is optional: if it fails, the speech model is still ready, the log says why, and the next Meeting asks for it again.
  - Its licence, with Qwen3-ASR's and Silero VAD's, ships in `notices/speech-models.txt`.
- **Memory.** Both models stay loaded until IncarnaMind quits, as Qwen3-ASR already did, so the process keeps its extra memory after the first Meeting transcribed here. Unloading them when idle is a follow-up.

## The licence and where the model comes from

- **The weights are Apache-2.0.**
  - The model card's front matter says `license: apache-2.0` on the upstream, https://huggingface.co/pfluo/k2fsa-zipformer-chinese-english-mixed.
  - It says the same on sherpa-onnx's export the app downloads, https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.
  - It was trained with icefall (`pruned_transducer_stateless7_streaming`), which is Apache-2.0: https://github.com/k2-fsa/icefall/blob/master/LICENSE.
  - Neither model repository has a LICENSE file of its own. The app ships the Apache-2.0 text in `notices/speech-models.txt`.
- **Caveat: where its training data came from isn't documented.** The upstream says only that it was trained on "tens of thousands hours of some internal dataset", and its training configuration names the subset `12k_hour`. Its published scores are on WenetSpeech, which is licensed CC BY 4.0 for non-commercial use only.
  - That is a risk about the data's provenance, not a limit on the weights' licence, which is Apache-2.0 as stated.
  - If a model with documented training data and the same quality appears, it should replace this one. The speech host takes any streaming reader.

## The numbers it rests on

These were measured on an Apple M2 Max (12 cores, 32 GB) on the FLEURS dev clips: 8 in English and 8 in Mandarin. Each was fed in 100 ms frames at the pace it was spoken, through the app's own code (`eval/transcription/live.transcription.ts`; the candidates below with a probe of the same shape).

**Candidates, the streaming model alone** (one decoder, two threads unless noted; load average 8 to 19):

| Model | Licence | Download | English WER | Chinese CER | First words (median, en / zh) | Updates (median) | Reading time / audio | CPU s per audio s | Memory |
|---|---|---|---|---|---|---|---|---|---|
| Zipformer bilingual zh-en, 1 thread | Apache-2.0 | 199 MB | 34.0% | 7.4% | 1.2 s / 0.64 s | 0.3 s | 0.044 | 0.045 | +214 MB |
| Zipformer bilingual zh-en | Apache-2.0 | 199 MB | 33.3% | 7.4% | 1.4 s / 0.64 s | 0.3 s | 0.039 | 0.12 | +224 MB |
| Paraformer bilingual zh-en | FunASR model licence | 237 MB | 36.9% | 7.4% | 0.89 s / 0.69 s | 0.6 s | 0.037–0.05 | 0.09–0.11 | +473 MB |
| Nemotron 3.5 ASR streaming 0.6B, 160 ms, language found by itself | OpenMDW-1.1 | 682 MB | 12.1% | 17.7% | 0.91 s / 0.70 s | 0.2 s | 0.28–0.34 | 0.65–0.69 | +880 MB |
| The same, told the language | OpenMDW-1.1 | 682 MB | 12.8% | 16.0% | 0.91 s / 0.70 s | 0.2 s | 0.33–0.38 | 0.69–0.72 | +1.2 GB |

Qwen3-ASR 0.6B, which writes the finished lines, scores 12.8% WER and 1.3–1.7% CER on the same clips (`eval/transcription/README.md`).

**Before and after, the whole pipeline at speaking pace.** Four threads for Qwen3-ASR, one for the streaming model. The machine was busy: load average 16–18 before and 10–14 after.

- *Before* is the speech so far decoded again every 2.5 s.
- *After* is two passes.
- Times are from where each clip's speech starts, or from its last sound, to when the transcription process reports the words.
- Medians of 8 clips are the upper middle one.

| Language | | First words (median, p90) | Live words change every (median, p90) | Line finished after its last sound (median, p90) | Finished lines | Live words alone | CPU s per audio s |
|---|---|---|---|---|---|---|---|
| English | before | 3.68 s, 6.18 s | 3.62 s, 3.62 s | 2.94 s, 4.71 s | WER 11.3% (16 of 141) | – | 1.19 |
| English | after | 1.79 s, 6.60 s | 0.30 s, 0.40 s | 1.43 s, 2.23 s | WER 11.3% (16 of 141) | WER 42.6% | 0.37 |
| Chinese | before | 3.13 s, 3.33 s | 6.13 s, 6.13 s | 1.44 s, 4.84 s | CER 2.6% (6 of 231) | – | 0.59 |
| Chinese | after | 0.51 s, 0.80 s | 0.30 s, 0.60 s | 1.39 s, 2.03 s | CER 2.6% (6 of 231) | CER 5.2% | 0.28 |
| Both taking turns | before | 3.34 s, 4.21 s | 3.07 s, 7.08 s | 1.76 s, 3.66 s | 4.6% (17 of 372) | – | 0.82 |
| Both taking turns | after | 0.75 s, 2.35 s | 0.30 s, 0.60 s | 1.32 s, 1.90 s | 4.6% (17 of 372) | 16.1% | 0.30 |

What the table shows:

- **English first words**, clip by clip, after: 0.47, 0.50, 0.78, 0.98, 1.79, 2.09, 4.0 and 6.6 s. The model writes nothing for the first words of some English sentences ("The major religion in Moldova is…", "The East African islands are in…"). Fed the same clips on their own, how late depends on how the stream starts, so it is the model, not the pipeline.
- **Memory:** the process had 1.11 GB before and 1.49 GB after once loaded, and at most 2.27 GB before and 2.65 GB after.
- **Finished lines:** the same lines, word for word, before and after.
- **Before's updates:** few, since a stretch gets a partial only after 1.5 s and then every 2.5 s, and a busy computer delays them.

**Finished lines on the meeting set (#85).** The first 4 minutes of each of its 10 cases (`npm run eval:meetings`, with and without `INCARNAMIND_EVAL_LIVE=off`) gave the same 383 lines, word for word:

- English: WER 25.7% online and 36.0% in a room;
- Chinese: CER 14.4% online and 38.5% in a room;
- mixed: 25.5%.

## Considered options

- **One streaming model for everything, with no second pass.** The finished lines would be the streaming model's.
  - The Zipformer's own words in the pipeline score 42.6% WER (English), 5.2% CER (Chinese) and 16.1% (both), against 11.3%, 2.6% and 4.6% for Qwen3-ASR's finished lines.
  - Nemotron's Chinese is 16–18% CER, with stray tokens from other scripts ("ออออ").
  - Finished lines are what the User cites and what checks read, so they must not get worse.
- **Nemotron 3.5 ASR streaming as the live model.**
  - Its English is far better than the Zipformer's, and its licence (OpenMDW-1.1) is permissive.
  - But it is a 682 MB download, against 199 MB, and takes about 0.3 of the audio's time on two threads. That is 6 to 15 times the Zipformer's CPU, beside Qwen3-ASR's.
  - Its Chinese is worse.
  - The CPU it takes is what makes a slower computer fall behind (#462). It is the one to measure again if a lighter export comes, or once GPU routes are measured (#137).
- **The streaming Paraformer.** Its Chinese and memory are no better, it updates every 0.6 s, and the FunASR model licence that covers the upstream weights says they are "provided for reference and learning purposes only". It also has a non-disparagement clause and terms that change by themselves. That conflicts with the Apache-2.0 tag on ModelScope.
- **The multilingual streaming Zipformer (2025-02-10, eight languages).** It needs one language for each stream, so it can't follow speech that mixes Chinese and English. Its upstream repository has no licence file.
- **Decoding Qwen3-ASR again more often.** Each decode reads the whole stretch so far, so the cost grows with the stretch. At 0.15–0.23 of the audio's time on four threads, decoding it every 0.5 s can't keep up on a busy computer.
- **A native engine (transcribe-cpp, Metal, Core ML).** It needs a binding we would build and sign on every platform. The bake-off in #137 weighs that.

## Consequences

- **Quality of the live words.**
  - Chinese live words are close to the final text, about 5–7% CER.
  - English live words are rough: about two words in five are wrong on FLEURS, and they have no capitals or punctuation. The model sometimes writes nothing for a sentence's first words, so English first words come within 1.5 s for most sentences, not all.
  - The finished line replaces them about 1 to 2 s after the speaker pauses.
- **CPU.** The streaming model reads only while someone speaks, on one thread. Decoding the speech again while it went on cost more than that, and it no longer runs. The process's CPU time fell by half or more on the clips: 0.28–0.37 CPU-seconds per second of audio, against 0.59–1.19.
- **Memory.** The process takes about 380 MB more (the model is about 220 MB of it).
- **Disk.** The first download is 199 MB larger.
- **Tests.**
  - The fake engine has an optional streaming model (`live`), and the core's tests show live words, then the line.
  - The engine check finds `OnlineRecognizer` in the real module, loaded as the built app loads it.
  - The packaged app's transcription spec waits for live words from the real model.
