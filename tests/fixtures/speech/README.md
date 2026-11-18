The packaged app's transcription check (`e2e/packaged/transcription.packaged.ts`) plays `gettysburg.wav` through Chromium's fake microphone. It is the opening sentence of the Gettysburg Address from John Greenman's LibriVox reading, which LibriVox dedicates to the public domain: https://archive.org/details/gettysburg_johng_librivox (`gettysburg_address.mp3`).

What is said: "Four score and seven years ago our fathers brought forth on this continent a new nation, conceived in liberty, and dedicated to the proposition that all men are created equal."

Changed from the recording: seconds 23.0 to 37.6 only, written as 16 kHz mono 16-bit WAV.

`short-first-words-zh.wav` is synthetic Mandarin speech for the check that a line keeps its first word (#2305). It was made with Kokoro-82M v1.1-zh (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh), as sherpa-onnx packages it (`kokoro-int8-multi-lang-v1_1`), speaker 60, at normal speed. No real person's voice is in it.

What is said, three lines, each a short word said on its own, 0.4 s of silence, then the rest of the line:

- "对。" then "总价是八十万元。"
- "行。" then "周五之前给你答复。"
- "是。" then "合同已经寄出去了。"

Each word and sentence was trimmed to its sound. The file starts with 1 s of silence, and 1.6 s follow each line; it is 16 kHz mono 16-bit WAV.

`two-voices.wav` is two clearly different voices, one after the other, for the packaged app's check that the speaker pass tells them apart (#138): `gettysburg.wav` as above, 0.8 s of silence, then a synthetic English line, then 1.2 s of silence; 16 kHz mono 16-bit WAV. The second line was made with the same Kokoro-82M v1.1-zh (Apache-2.0) package as the Mandarin file, speaker 0, at normal speed, and trimmed to its sound. No real person's voice is in the second line.

What the second voice says: "Thank you. Our next meeting is on Thursday morning, and I will send the agenda tonight. Please read both reports before then, and bring your questions."

`close-voices.wav` joins seconds 8.20–14.57 and 15.40–21.50 of `two-voices.wav`, with 0.8 s of silence before and 1.8 s after. The first voice ends with “all men are created equal”. The next starts “Thank you. Our next meeting is on Thursday morning”. The local transcriber puts those two voices in one line because the change comes without a pause.
