The packaged app's transcription check (`e2e/packaged/transcription.packaged.ts`) plays `gettysburg.wav` through Chromium's fake microphone. It is the opening sentence of the Gettysburg Address from John Greenman's LibriVox reading, which LibriVox dedicates to the public domain: https://archive.org/details/gettysburg_johng_librivox (`gettysburg_address.mp3`).

What is said: "Four score and seven years ago our fathers brought forth on this continent a new nation, conceived in liberty, and dedicated to the proposition that all men are created equal."

Changed from the recording: seconds 23.0 to 37.6 only, written as 16 kHz mono 16-bit WAV.

`short-first-words-zh.wav` is synthetic Mandarin speech for the check that a line keeps its first word (#2305). It was made with Kokoro-82M v1.1-zh (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh), as sherpa-onnx packages it (`kokoro-int8-multi-lang-v1_1`), speaker 60, at normal speed. No real person's voice is in it.

What is said, three lines, each a short word said on its own, 0.4 s of silence, then the rest of the line:

- "对。" then "总价是八十万元。"
- "行。" then "周五之前给你答复。"
- "是。" then "合同已经寄出去了。"

Each word and sentence was trimmed to its sound. The file starts with 1 s of silence, and 1.6 s follow each line; it is 16 kHz mono 16-bit WAV.
