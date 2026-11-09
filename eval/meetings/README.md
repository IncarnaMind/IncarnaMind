# Meeting audio set

Recordings of meetings in English, Chinese and both mixed, with the words and the speakers written down, and a scorer that reports how well a transcriber (and a speaker pass) does on them. Issue #85. It is the set behind the alpha's gates: transcription at most 15% WER in English and 20% CER in Chinese, in real time on an M-series Mac; speakers at most 20% DER online and 30% in a room, in both languages.

Nothing here is committed but the lists: `sources.json` pins every download by URL, size and SHA-256, and `cases.json` pins every case built from them. The audio is fetched at eval time into `~/.cache/incarnamind-eval/meetings/` (or under `INCARNAMIND_EVAL_CACHE`), about 2.0 GB, and needs no network after that.

## What is in it

| Language | Setting | Cases | Minutes | Source |
|---|---|---|---|---|
| English | online call | EN2002a, IS1009b | 69.5 | AMI, each person's headset |
| English | in a room | ES2004b, TS3003b | 75.9 | AMI, the distant microphone |
| Chinese | online call | R8007_M8011, R8008_M8013 | 68.4 | AliMeeting, each person's headset |
| Chinese | in a room | R8003_M8001, R8007_M8010 | 65.4 | AliMeeting, the eight-channel array |
| English and Chinese mixed | conversation | test sessions 1 and 3 | 37.1 | ASCEND |

The issue asks for 30 minutes of each language in each setting and 20 of mixed; `tests/eval/meetingSet.test.ts` holds the set to it. Every English and Chinese meeting has three or four speakers (the room ones, three or more as asked). A case id is `<language>-<setting>-<recording>`, e.g. `en-online-EN2002a`.

| Corpus | Licence | Where it is read from |
|---|---|---|
| [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) (Carletta et al., 2005) | CC BY 4.0 | Hugging Face: the University of Edinburgh's copy [`edinburghcstr/ami`](https://huggingface.co/datasets/edinburghcstr/ami) (Kaldi's text of the eval meetings, and each meeting's segments cut from the participants' headsets), and [`diarizers-community/ami`](https://huggingface.co/datasets/diarizers-community/ami) (the whole recordings of the single distant microphone, Array1-01), both at pinned revisions |
| [AliMeeting](https://www.openslr.org/119/) (Yu et al., ICASSP 2022, the M2MeT challenge) | CC BY-SA 4.0 | OpenSLR's link to the Eval set, `Eval_Ali.tar.gz` (3.7 GB, gzipped, so it can only be read from its start), read until the files wanted are out: the array recordings of the two room sessions (first channel kept), the four TextGrids, and the headsets of the two online sessions. The rest of it is not downloaded, and none of it is kept but those files. |
| [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) (Lovenia et al., LREC 2022) | CC BY-SA 4.0 | Hugging Face `CAiRE/ASCEND`, the test split (106 MB), at a pinned revision |

**Licences, checked 2026-10-21.**

- AMI: the AMI site states that all its signals and transcriptions, and some of its annotations, are under CC BY 4.0. The set uses only the signals and the transcriptions, and both Hugging Face cards say CC BY 4.0. OpenSLR's older copy of AMI (SLR16) is labelled CC BY-NC-SA 2.0 (modified), so it is not used.
- AliMeeting says CC BY-SA 4.0 on OpenSLR; ASCEND says it on its Hugging Face card.
- Attribution: cite the papers above in anything that publishes results. Share-alike: the cases are built on the machine that runs the evaluation and never published; a published copy would be CC BY-SA 4.0 and need the same attribution.
- **Consent:** no recording of the project's own is in the set, so no one's consent is needed. If one is ever added, every participant's written consent goes in this README first.
- AISHELL-4 (CC BY-SA 4.0) was considered and not used. It has only the room array, with no headsets for online cases, in FLAC (which no module in the repository reads), and its files are 250 to 290 MB each.

## How each case is made

Every case is mono 16 kHz 16-bit WAV files and a `reference.json`: `{ format: 1, segments: [{ start, end, speaker, text, track }] }`, in seconds, in time order. The segments are the speaker turns and what was said in each.

- **Online call (`mic.wav`, `system.wav`).** One person's own recording is the microphone; everyone else's, mixed, is the system audio. They stay separate files. The microphone person ("Me") is whoever speaks most in the meeting, named in `cases.json`. In `reference.json` their segments are on the `mic` track and the others' on `system`. The mix is turned down only if it would clip.
  - AMI: each person's headset segments are put back where they were said; between them the track is silent. No voice reaches another person's track.
  - AliMeeting: the whole headset recordings, each cut to its speaker's annotated turns, 0.25 s either side, with 10 ms fades, so that the others' voices that leak into a headset don't reach the system audio as well. Between turns the track is silent.
- **In a room (`room.wav`).** AMI: the whole meeting as the distant microphone heard it, with the room's noise. AliMeeting: the first channel of the eight-channel array, whole. The reference is on the `room` track.
- **Conversation (`conversation.wav`).** ASCEND is a corpus of utterances, each named with its session, speaker and start. A session is laid out again as the conversation it was: each utterance at its start, where utterances overlap they add up, and between them the track is silent. Two speakers.

What this does not capture, so the numbers are not the whole story:

- The silences between speech in the online AMI and AliMeeting tracks, and in the ASCEND conversations, are digital zero. A voice detector has an easier time there than on a call with background noise. The room cases are real, noisy audio.
- AMI's text is the transcription of what each participant said in the meeting proper. Speech nobody transcribed (set-up talk before the meeting starts, for instance) is in the room audio and not in the reference, so a transcriber that hears it is charged for insertions.
- AMI's references come in Kaldi's form: upper case, no punctuation, hesitations kept ("UM"). The scorer's normalisation below deals with that.

## Running it

```sh
npm run eval:meetings:fetch              # all cases; or: ... -- en-online-EN2002a zh-room-R8003_M8001
npm run eval:meetings -- run             # this computer's engine on the cases, then the scores
INCARNAMIND_EVAL_WORDS=1 npm run eval:meetings -- run   # the same, each case told its words (#1031)
npm run eval:meetings -- names           # four calls full of names, told and not told (#1031)
INCARNAMIND_EVAL_ROUTES=soniox,openai npm run eval:meetings -- names   # the same on cloud routes
INCARNAMIND_EVAL_ROUTE=soniox INCARNAMIND_EVAL_UNTIL_MINUTES=10 npm run eval:meetings -- run   # a cloud route on the cases
npm run eval:meetings:score -- <folder>  # any transcriber's results in <folder>
```

- **Fetching.** Every download is checked against `sources.json`, and every case built from them against `cases.json`; one that doesn't match is not kept, and the run says which. The first fetch downloads about 4 GB (about 3.4 GB of it is the AliMeeting archive, which takes a few minutes) and keeps 2.0 GB. A case already built and checked is left alone, so a second run makes no network request. The AMI and ASCEND downloads are kept in `sources/` and are checked again each time they are used; the AliMeeting files used are kept in `alimeeting/`; the cases are in `cases/<id>/`.
- **Moving a pin.** `npm run eval:meetings:fetch -- --pin [ids]` keeps what it builds and writes the new hashes to `cases.json` and `sources.json` (a changed source file's own hash and size go in `sources.json` by hand first). Read the diff.
- **Running this computer's engine.** `npm run eval:meetings -- run` feeds each track of each case to the transcription process's own code (`createSpeechHost`, Qwen3-ASR 0.6B with Silero VAD, as the app runs them) in 100 ms frames, as fast as it takes them, and labels the lines as a live Meeting does: "Me" for the microphone, "Them" for the system audio, nothing for a room. `INCARNAMIND_EVAL_CASES` picks cases; `INCARNAMIND_EVAL_UNTIL_MINUTES=4` runs and scores only the first minutes; `INCARNAMIND_EVAL_OUT` is the results folder (`eval/results/meetings-local-<date>` by default). The real-time factor is the time the whole case took over its length, partial text included but fed unpaced, on a computer that is also doing other things: the report is only as good as the machine was free. Each case's line also gives how many lines it wrote and the process's CPU time per minute of audio, which a busy machine changes less.
- **Scoring another transcriber.** Put one JSON file per case in a folder, named `<case id>.json`:

  ```json
  {
    "case": "en-online-EN2002a",
    "transcriber": "what it is, for the report",
    "processingSeconds": 412.8,
    "segments": [{ "start": 12.4, "end": 15.1, "text": "Okay, let's begin.", "speaker": "Me" }]
  }
  ```

  `processingSeconds` (optional) is how long the transcriber took for the whole case. `speaker` (optional) is any label; without it on any segment the case gets no DER. The score is written next to the results as `score.md` and `score.json`. A case with no file is left out. `--collar <seconds>` and `--until-minutes <n>` change how it scores.
- **Words to know (#1031).** `words.json` holds the words each case's transcriber is told with `INCARNAMIND_EVAL_WORDS=1`, as a Meeting tells it its Words to know and the names in its Note and Folder. They were picked from each reference by a rule fixed before any run (`npm run eval:meetings:words`, `pickWords.ts`): the terms a general speech model may not know, said at least three times. In English, words of four letters or more that aren't in the macOS word list (`/usr/share/dict/web2`), as they are or as the word they were made from; in Chinese, what the word splitter has no word for and cuts into single characters, two to four of them, none an everyday word's character and none ending in 儿. Each list also holds four terms of a case in the other language and four of the next case in its own language, none of which anybody says in it. Every run scores those words: how many of their occurrences are not written exactly (a name's error rate, as B-WER is in the contextual biasing literature), the error rate of everything else from the same alignment (U-WER), and how often a word told but never said is written (`terms.ts`, in `score.md` and `terms.json`).
- **Calls full of names (#1031).** `npm run eval:meetings -- names` (macOS) has two English and two Chinese calls (`names.json`), each side in a macOS voice as `say` speaks it at 165 words a minute, made into the cache the first time. `en-orchard` and `zh-coldstore` are the end-to-end walk's calls of 2026-11-07, with sums said in pounds; their "own" names start with the User's, as a Meeting's words do. Each call goes through the app's code seven times: told nothing, told its own names, told those and the other call's, told only the other call's, told twenty names in its own language that sound like its own and are never said (`decoys`), told names that sound the same as its own but are other people's (`sameSounding`: Danielle West, Markus…), and told names that are also everyday words (`commonWords`: Will, Hope, Grace…, some said as the word). Besides the names' and other words' error rates, it counts the told names never said that were written, the lines that differ, case and all, from the run told nothing, the stretches the engine reads twice (on this computer): those whose plain reading holds a told name misheard, and the sums said and written in pounds, dollars and euros. `INCARNAMIND_EVAL_ROUTES` runs it on cloud routes too (`soniox`, `openai`, with `SONIOX_API_KEY` and `OPENAI_API_KEY`), through the app's adapters, each side a stream at the pace it was spoken and the words in the route's own field as the app fits them (`cloud.ts`); `INCARNAMIND_EVAL_ARMS` and `INCARNAMIND_EVAL_CALLS` pick some, and `INCARNAMIND_EVAL_SONIOX_MODEL` another Soniox model.
- **A cloud route on the cases (#1031).** `INCARNAMIND_EVAL_ROUTE=soniox` (or `openai`) sends each case's tracks to that route instead of this computer's engine, at the pace they were spoken, `INCARNAMIND_EVAL_PARALLEL` cases at once; it is billed by the audio sent, so `INCARNAMIND_EVAL_UNTIL_MINUTES` keeps it short.
- **Tests.** `npm test` checks the scorer and the builders on small files made in the tests, and the pins; it needs neither the network nor the cache. Two tests that read the cached Parquet files run only when `INCARNAMIND_EVAL_CACHE` points at a cache that has them.

## What the scorer reports

For each case, and added up for each language and setting (errors over the reference's units, speech time over speech time):

- **WER** for English: edits (substitutions, deletions, insertions) over the words in the reference.
- **CER** for Chinese: the same over characters. **MER** for the mixed cases: the same, each Han character and each run of Latin letters or digits one unit.
- **Real-time factor:** processing time over the length of the recording, when the transcriber says its time.
- **DER:** the time of speech missed, of non-speech given to a speaker, and of speech given to the wrong speaker, over the time the reference has speech (`der.ts`). Like NIST's md-eval: overlapped speech is scored, two speakers in the reference where two talk; **no time within a collar of 0.25 s of a reference turn's start or end is scored** (`--collar` changes it; the report always states it); speakers are matched one to one for the whole recording so that the most time agrees (the Hungarian method), so a transcriber's names for speakers mean nothing; time is in 10 ms frames. For an online call the microphone and the system audio are one timeline, so labelling every microphone line "Me" and every system line "Them" is a valid answer that scores the confusion among the others.

Everything said is compared in time order, whatever the track or the speaker (a transcript is its segments sorted by start). Where people talk at once, the order two transcripts put them in can differ: it costs both of them alike.

### Normalisation

Both sides go through the same rules (`eval/transcription/scoring.ts`, tested in `tests/eval/transcriptionScoring.test.ts`), in this order:

1. Case is folded, and full-width letters and digits become ASCII (Unicode NFKC).
2. Tags such as `[laughter]`, `[unk]` and `<unk>` are dropped.
3. Traditional Chinese characters become the simplified ones (`src/shared/hanVariants.ts`).
4. The hesitations "uh", "um", "er", "erm", "hm", "hmm", "mm", "mmm", "mhm", "呃" and "嗯" are dropped: references keep them and engines leave them out.
5. Apostrophes inside a word are dropped ("you're" is "youre"), and the commas inside a number ("1,000"). Every other punctuation mark and symbol becomes a space, so "%" and "$" are not words.
6. Numbers are digits. English number words in a run become one number ("twenty five" is 25, "two thousand and ten" is 2010, "one hundred and five" is 105). Chinese numerals in a run become one number ("二十五" is 25, "二零二六" is 2026, "三万五千" is 35000). A numeral next to an ASCII digit ("2万"), and 百 千 万 亿 alone, are left. A number is one unit.
7. English is compared word by word; Chinese character by character, with each run of Latin letters or digits as one unit; whitespace is dropped.

What this leaves different, on purpose or for want of a rule: a Chinese numeral inside an ordinary word is a number too ("一起" is 1起, "十分" is 10分, "万一" is 10001), the same on both sides; years said in two parts ("nineteen ninety" is 19 90, "1990" is one number), ordinals ("second"), decimals ("2.5" is 2 5, "two point five" is 2 point 5), "okay" and "ok", spelled-out letters ("e c e" and "ece"), and British and American spelling. They cost every transcriber alike.

## Results

**This computer, Qwen3-ASR 0.6B int8 with Silero VAD** (the app's first engine, #136) on the whole set. 2026-10-21, Apple M2 Max, `npm run eval:meetings`, while the machine ran other work (load average 21 to 23, so the real-time factors are on the slow side):

| Language | Setting | Cases | Minutes | Error rate | DER ("Me" and "Them" labels only, collar 0.25 s) | Real-time factor |
|---|---|---|---|---|---|---|
| English | online | 2 | 69.5 | WER 27.4% (3,617 of 13,206 words) | 45.2% | 0.20× |
| English | room | 2 | 75.9 | WER 23.8% (2,626 of 11,020 words) | not scored | 0.14× |
| Chinese | online | 2 | 68.4 | CER 17.3% (3,403 of 19,681 characters) | 30.8% | 0.22× |
| Chinese | room | 2 | 65.4 | CER 38.8% (9,303 of 23,961 characters) | not scored | 0.20× |
| Mixed | conversation | 2 | 37.1 | MER 33.5% (2,513 of 7,507 units) | not scored | 0.16× |

- The DER here is the baseline before any speaker pass: every microphone line is "Me" and every system line "Them", so it is the confusion among the other participants. #138 is measured against this.
- The worst case, `zh-room-R8007_M8010` (CER 49.4%), is four people talking over each other in a room: the reference has 1,181 turns, the engine returns 117 lines with 10,121 characters against the reference's 17,028, and the engine's log reports a line cut at its 128-token limit three times in the run.
- Per-case scores are in the report that `npm run eval:meetings:score` writes (`score.md` and `score.json`).
- Numbers from one run on one busy machine: a check that the set works and a baseline to beat, not a ranking. #137's bake-off runs the whole set on three machines.

**Long stretches read in parts (#1031),** the same engine on the whole set, 2026-11-09, Apple M2 Max (load average 9 to 35). Before, a stretch was read whole, and Qwen3-ASR stopped at 128 written tokens or at 512 in all with its prompt and audio, which a stretch past about 27 s reached with nothing in sherpa-onnx's log. Now no reading takes more than 15 s of speech, cut at its quietest moment (`src/core/transcription/speech.ts`, ADR-0027):

| Language | Setting | Error rate, before | Now | Lines in the room cases, before | Now | Reference turns |
|---|---|---|---|---|---|---|
| English | online | WER 28.1% | WER 26.6% | | | |
| English | room | WER 23.6% | WER 23.6% | 319, 553 | 345, 556 | 688, 659 |
| Chinese | online | CER 16.9% | CER 16.3% | | | |
| Chinese | room | CER 38.3% | CER 38.0% | 250, 119 | 286, 190 | 674, 1,181 |
| Mixed | conversation | MER 34.2% | MER 33.3% | | | |

- Readings that reached a limit: 8 before (1 at 128 written, the only one sherpa-onnx logs, and 7 at 512 in all), none now. The longest line went from 36.0 s to 15.0 s.
- Read at most 12 s at a time, the set had more lines but read worse in Chinese online (CER 17.7%), where shorter readings lost context.
- The CPU time per minute of audio is the same, measured with both versions running at once on the same cases, since the machine's load changed it more than the change did.

**Words to know (#1031),** the same engine on the whole set, 2026-11-01, Apple M2 Max (load average 5 to 16), told nothing and told each case's words in `words.json`. Told, a final stretch is read as before, and again told the words only where that reading holds a told name misheard; it keeps the first reading but for those names (`src/core/transcription/context.ts`). A Chinese told name mends nothing:

| Language | Told words said | Not written exactly, told nothing | Told | Other units' errors, told nothing | Told | Error rate, told nothing | Told |
|---|---|---|---|---|---|---|---|
| English | 74 | 46 (62.2%) | 45 (60.8%) | 7,213 of 24,152 | 7,213 | WER 26.1% (6,322 of 24,226) | WER 26.1% (6,321) |
| Chinese | 241 | 87 (36.1%) | 87 (36.1%) | 14,327 of 43,152 | 14,327 | CER 28.7% (12,504 of 43,642) | CER 28.7% (12,504) |
| Mixed | 3 | 2 | 2 | 2,620 of 7,504 | 2,620 | MER 34.2% (2,571 of 7,507) | MER 34.2% (2,571) |

- Told, 2 of the set's 3,440 stretches with text were read twice (0.06%): 1.0006 readings a stretch, and the real-time factor stayed at 0.08–0.17×. One line changed: "Speak Characterization" became "Speak Characterisation", a word said there. No word changed only its case.
- The words told and never said (eight a case: four of another language, four of the next case in the same one) were written once told nothing and once told, the same word the engine writes unprompted.
- The words this rule picks are mostly terms rather than names (Characterisation, Disfluencies, 抖音, 主播), which the engine writes in lower case or as everyday words; a told name mends only a word written as a name that sounds like it, so they gain little. The names are what it is for: on the two calls full of names (`npm run eval:meetings -- names`), told their own names, English names not written exactly went from 4 of 14 to 0 with every other word's error rate the same, reading 3 of the call's 17 stretches twice. Told twenty unsaid names that sound like the call's, or names that are everyday words (Will, Hope, Grace), no unsaid name was written and no word changed its case. Told a name that sounds the same as one said but is someone else's, the engine's "Marcus" became "Markus": sound can't tell them apart.

**Cloud routes told the words (#1031),** 2026-11-09, Apple M2 Max: the four calls full of names on this computer, Soniox (`stt-rt-v5` and `stt-rt-v6`) and OpenAI (`gpt-live-transcribe`, two runs), told nothing, the call's own names (the User's first, as a Meeting's words are) and twenty unsaid names that sound like them (`decoys`). Names not written exactly, of 31 said (21 in English, 10 in Chinese), and told names never said that were written:

| Route | Told nothing | Own names | Decoys | Decoys written |
|---|---|---|---|---|
| This computer | 13 (English 8, Chinese 5) | 6 (English 1, Chinese 5) | 12 | 1 |
| Soniox `stt-rt-v5` | 7 | 3 | 9 | 2 |
| Soniox `stt-rt-v6` | 5 | 0 | 11 | 1 |
| OpenAI, run 1 | 14 | 1 | 15 | 12 |
| OpenAI, run 2 | 14 | 1 | 12 | 10 |

- Every other word's error rate moves little, told or not: by at most 2.7 points on Soniox (down, on `zh-coldstore` told its own names on `stt-rt-v5`) and 2.0 on OpenAI, whose own two runs told nothing differ by up to 4.4 points (`zh-office`, 23.4% and 19.0%).
- A Chinese name told to this computer mends nothing (above), so its Chinese stays at 5 of 10.
- Decoys are the risk: told a name that sounds like one said, a cloud route writes the told one. On `stt-rt-v6`, told Marin Okafor and Danielle Brooks, "Hi Daniel, I'm Maren Okafor" became "Hi Danielle, I'm Marin Okafor"; OpenAI wrote two or three decoys on every call. This computer's one is what it writes told nothing too (林小文 for 林晓雯).
- **Sums.** Said: 4 in dollars (`en-renewal`), 2 in pounds (`en-orchard`), 2 in 英镑 (`zh-coldstore`). `stt-rt-v5` wrote both pounds as dollars ("$42,500") in every arm, told or not, and "eighty-five dollars" as "£85" in two of three. This computer, `stt-rt-v6` and OpenAI wrote each sum in the currency said. OpenAI misheard one 英镑 line throughout in 3 of its 4 told runs (两万税先invoice for 两万四千英镑): a word lost, not another currency.

**Soniox `stt-rt-v5` and `stt-rt-v6` on the cases,** the first 10 minutes of each, told nothing, `INCARNAMIND_EVAL_ROUTE=soniox INCARNAMIND_EVAL_UNTIL_MINUTES=10`, the same day:

| Language | Setting | `stt-rt-v5` | `stt-rt-v6` |
|---|---|---|---|
| English | online | WER 19.2% (713 of 3,719) | WER 17.7% (659) |
| English | room | WER 17.0% (398 of 2,343) | WER 17.1% (400) |
| Chinese | online | CER 15.1% (867 of 5,742) | CER 13.4% (769) |
| Chinese | room | CER 33.4% (2,412 of 7,231) | CER 34.3% (2,481) |
| Mixed | conversation | MER 31.0% (1,223 of 3,947) | MER 31.8% (1,255) |
| English, all | | WER 18.3% (1,111 of 6,062) | WER 17.5% (1,059) |
| Chinese, all | | CER 25.3% (3,279 of 12,973) | CER 25.1% (3,250) |

- A second run of the Chinese room and mixed cases gave the same gap: CER 33.3% and 34.2%, MER 31.4% and 31.9%.
