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
npm run eval:meetings -- names           # two calls full of names, told and not told (#1031)
npm run eval:meetings:score -- <folder>  # any transcriber's results in <folder>
```

- **Fetching.** Every download is checked against `sources.json`, and every case built from them against `cases.json`; one that doesn't match is not kept, and the run says which. The first fetch downloads about 4 GB (about 3.4 GB of it is the AliMeeting archive, which takes a few minutes) and keeps 2.0 GB. A case already built and checked is left alone, so a second run makes no network request. The AMI and ASCEND downloads are kept in `sources/` and are checked again each time they are used; the AliMeeting files used are kept in `alimeeting/`; the cases are in `cases/<id>/`.
- **Moving a pin.** `npm run eval:meetings:fetch -- --pin [ids]` keeps what it builds and writes the new hashes to `cases.json` and `sources.json` (a changed source file's own hash and size go in `sources.json` by hand first). Read the diff.
- **Running this computer's engine.** `npm run eval:meetings -- run` feeds each track of each case to the transcription process's own code (`createSpeechHost`, Qwen3-ASR 0.6B with Silero VAD, as the app runs them) in 100 ms frames, as fast as it takes them, and labels the lines as a live Meeting does: "Me" for the microphone, "Them" for the system audio, nothing for a room. `INCARNAMIND_EVAL_CASES` picks cases; `INCARNAMIND_EVAL_UNTIL_MINUTES=4` runs and scores only the first minutes; `INCARNAMIND_EVAL_OUT` is the results folder (`eval/results/meetings-local-<date>` by default). The real-time factor is the time the whole case took over its length, partial text included but fed unpaced, on a computer that is also doing other things: the report is only as good as the machine was free.
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
- **Words to know (#1031).** `words.json` holds the words each case's transcriber is told with `INCARNAMIND_EVAL_WORDS=1`, as a Meeting tells it its Words to know and the names in its Note and Folder. They were picked from each reference by a rule fixed before any run (`npm run eval:meetings:words`, `pickWords.ts`): the terms a general speech model may not know, said at least three times. In English, words of four letters or more that aren't in the macOS word list (`/usr/share/dict/web2`), as they are or as the word they were made from; in Chinese, what the word splitter has no word for and cuts into single characters, two to four of them, none an everyday word's character and none ending in 儿. Each list also holds four terms of a case in the other language, which nobody says in it. Every run scores those words: how many of their occurrences are not written exactly (a name's error rate, as B-WER is in the contextual biasing literature), the error rate of everything else from the same alignment (U-WER), and how often a word told but never said is written (`terms.ts`, in `score.md` and `terms.json`).
- **Two calls full of names (#1031).** `npm run eval:meetings -- names` (macOS) has an English and a Chinese call (`names.json`), each side in a macOS voice as `say` speaks it at 165 words a minute, made into the cache the first time. Each call goes through the app's code four times: told nothing, told its own names, told those and the other call's, and told only the other call's.
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
