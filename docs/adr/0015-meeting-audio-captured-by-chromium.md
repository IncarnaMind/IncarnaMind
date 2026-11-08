# Meeting audio: Chromium captures it in a hidden window, the core writes it in 10-second parts

A Meeting (#135) records the microphone and the computer's own sound, which carries the other people in the Meeting. The audio has to reach the disk as it is recorded, so a crash, sleep or device change loses at most the last few seconds. Live transcription (#136) reads the same audio later. The core owns the recording's state and its files, and never imports Electron (ADR-0004, ADR-0006), so the Electron shell passes capture in as an adapter (`AudioCapture` in `src/core/adapters.ts`).

We use what Electron 44 and its Chromium 152 give us, with no native addon:

- **A hidden capture window.** `src/main/meetings/` opens a hidden window only while a Meeting records. It has its own in-memory session and a preload with three calls: start, stop, and sending audio back. The app's window doesn't capture, for two reasons. A reload or crash of the interface, or closing the window (#189 keeps the app in the tray), must not stop a recording. And only this one session is given the microphone.
- **The microphone.** The window calls `getUserMedia`.
  - On macOS the main process first asks for access with `systemPreferences.askForMediaAccess("microphone")`.
  - When the default input changes (`devicechange`), or the track ends, the window opens the microphone again on the new default. Chromium doesn't follow the default input device by itself.
- **The computer's sound.** The window calls `getDisplayMedia`. Our `setDisplayMediaRequestHandler` answers it with `audio: "loopback"`. Chromium won't grant audio without a video track, so the video is the capture window's own blank page, and the window stops it at once. No screen is captured, so Screen Recording isn't asked for on macOS 14.2 or later. Chromium then does the work:
  - **macOS 14.2 or later:** a Core Audio process tap. `MacCatapLoopbackAudioForScreenShare` is on by default since Chromium 142. It needs the "System Audio Recording Only" permission and the `NSAudioCaptureUsageDescription` key.
  - **macOS 13 to 14.1:** ScreenCaptureKit, which needs Screen Recording.
  - **Windows:** WASAPI loopback of the default output, with no permission prompt. We use `loopback`, never `loopbackWithMute`, which mutes the speakers and would leave the User unable to hear the Meeting.
  - **Linux:** the microphone only, for now. Chromium's PulseAudio loopback, which also serves PipeWire through pipewire-pulse, probably works. But the video Chromium needs goes through the desktop portal's screen picker, a second dialog at every recording.
- **What is written.** The audio is 16 kHz, mono, 16-bit PCM, which is what speech-to-text reads.
  - Chromium resamples each track into an `AudioContext` at 16 kHz. An AudioWorklet mixes the track to mono and sends it to the main process in frames of about 100 ms.
  - The core writes each source as WAV files of 10 seconds. Each file is flushed, then renamed into place, so a crash leaves only whole files. Its name gives its source and where it starts in the Meeting's time.
  - Recovery reads only the files. The database holds the Meeting's state and its stretches of recording.

macOS has no public way to ask whether the computer's sound may be recorded. A denied Core Audio tap gives a track that has ended, or silence, never an error. So the window reports a track that ends before any sound as denied, and the core reports a minute of pure digital silence as "silent". Either way a line in the meeting bar says so and links to System Settings, while the microphone goes on recording.

## Considered options

- **A screen from `desktopCapturer` as the video.** This is the common pattern. Rejected: on macOS it needs Screen Recording, a stronger permission than the audio one, which macOS 15 also asks the User to confirm again from time to time.
- **`useSystemPicker`.** Rejected. It works on macOS 15 and later only, and asks the User to pick a screen at every recording.
- **The `electron-audio-loopback` package.** Rejected. It only turns on Chromium flags, which are gone or on by default in Electron 44. Its README says Electron 39 and later don't need it.
- **A native Core Audio tap.** Either the MIT `audiotee` command-line tool, which writes PCM to its output, or our own N-API addon. Not now: either is one more binary to build, sign and ship for each architecture. It would become necessary to check the audio permission before recording, to record one app's sound only (just the meeting app), or if Electron's open report is confirmed on the macOS versions people use. That report, electron/electron#52738, says a loopback track granted with an app-chosen source ends at once on macOS 26.5. If so, a helper of this kind replaces the system half of the capture behind the same adapter.
- **MediaRecorder, writing WebM/Opus in 10-second slices.** About a tenth of the size. Rejected: the recording spec says the slices "need not be playable" on their own, so a crash could leave parts that can't be read.

## Consequences

- `electron-builder.yml` gives the macOS app our own `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`.
- `build/entitlements.mac.plist` adds `com.apple.security.device.audio-input` to electron-builder's default entitlements. Without it, a hardened-runtime build can't open the microphone.
- macOS keeps the microphone and audio permissions across updates only for a build signed with the same identity (#46). It ties each permission to the app's code signature. In development it gives them to the terminal or editor that started the app.
- Pure digital silence can't be told apart from a Meeting where no one speaks. So the "silent" line says what may be wrong rather than saying the permission was refused.
- Audio takes about 115 MB per source per hour. It is deleted 24 hours after the last stretch the Meeting recorded, whatever happens to its notes (#687). The User can keep one Meeting's audio (Keep audio), or every new Meeting's ("Keep a meeting's audio" in Settings › Meetings, off by default), until they delete it, and can delete it at any time.
- Tests never open a device. The core's tests and the smoke tests use a fake `AudioCapture` that makes a tone or silence (`src/core/meetings/fakeCapture.ts`). Capture with real audio is checked by hand on each OS.

## Sources

- Electron 44 `session.setDisplayMediaRequestHandler` and `desktopCapturer`: https://github.com/electron/electron/blob/v44.5.1/docs/api/session.md, https://github.com/electron/electron/blob/v44.5.1/docs/api/desktop-capturer.md
- Chromium 152 feature defaults and the macOS loopback choice: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/media/base/media_switches.cc, https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/media/audio/mac/audio_manager_mac.cc
- Apple, capturing system audio with Core Audio taps: https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
- Apple TN3127, code signing requirements and privacy permissions: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
- Windows loopback recording: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
- MediaStream Recording, slices need not be playable: https://w3c.github.io/mediacapture-record/

## Amendment: transcribing on this computer (2026-10-11, #136)

- **One track for transcription** (two tracks since 2026-10-16, #941; see the last amendment). The core mixes the microphone and the computer's sound into one track, in the Meeting's time (`src/core/meetings/mixer.ts`), and streams it to the `Transcriber` adapter. What the User says and what the others say are transcribed once, and the microphone picking up the speakers doesn't give each line twice. The two sources stay apart on disk, for telling speakers apart later (#138, #140).
- **A utility process of its own.** The desktop app runs the engine, Qwen3-ASR-0.6B int8 with Silero VAD through sherpa-onnx-node (Apache-2.0), in an Electron utility process (`src/main/transcriber.ts`), as it runs the embedding and reranking models. sherpa-onnx-node bundles its own ONNX Runtime; the process keeps it apart from onnxruntime-node's, and `tests/core/onnxRuntimes.test.ts` shows both run even in one process, in either order. A process that crashes is started again, and the stretch it lost is marked as a gap in the Transcript.
- **The files are the record, here too.** What is needed to pick a Transcript up after a crash is in files in the data folder's `Transcripts/`, beside nothing else: its lines and gaps in `<meeting>.vtt`, and in `<meeting>.json` its Document, how far live text got and the stretches still to transcribe. No database column: a Meeting's audio and its Transcript's working state belong to this computer, as the audio's parts do.
- **The audio stays the source.** Live text that falls behind, audio that came while the model downloaded or started, and a stretch a crash lost are transcribed from the parts on disk once the Meeting stops, as long as its audio is kept (at most a day).

## Amendment: the microphone's echo is taken out before the mix (2026-10-14, #846)

- **Why.** On laptop speakers the microphone hears the others a second time, 20 to 80 ms late, quieter and coloured by the room. The capture window keeps Chromium's echo cancellation off, because it only removes sound the page itself plays, not the meeting app's. One mixed track still gives each line once, since the echo lands on its source; but the microphone on its own carries the others' words too, so the "Me" and "Them" labels by source (#140, #138) would give the User words they never said.
- **What.** The mixer takes the echo out of the microphone, with the computer's sound as the reference, before it adds the two (`src/core/meetings/echo.ts`). The canceller is Speex's MDF written again in TypeScript, so derived from libspeexdsp's `mdf.c` (BSD-3-Clause), whose notice ships with the app in `resources/notices/speexdsp.txt`: a partitioned-block frequency-domain adaptive filter that slows its learning while both sides talk. Because the two sources are stamped apart, it looks ahead of the microphone as well as behind it, moves its window when the echo nears an end, and reads the reference later or earlier when the two clocks drift. A microphone opened again (a new default device) starts a new run where its audio arrives, so it stays in step with the computer's sound.
- **The files keep what was recorded.** The microphone's parts on disk are as captured. Everything that turns them into words goes through the mixer: live text, stretches transcribed from disk after Stop, and the labels by source to come.
- **Considered.** A WASM build of WebRTC's AEC3 (`@ennuicastr/webrtcaec3.js`, BSD, not released since January 2024) or of SpeexDSP (none on npm with the echo canceller); a native module, rebuilt for every Electron; dropping microphone stretches that match the computer's sound, which loses the User's words whenever both sides talk.

## Amendment: two tracks for transcription, "Me" and "Them" (2026-10-16, #941)

- **What.** The microphone, with the computer's echo taken out as above, and the computer's sound go to the `Transcriber` as two streams, not one mix (`src/core/meetings/tracks.ts`, which replaces `mixer.ts`). A line from the microphone is "Me" and one from the computer's sound "Them". With no computer sound (a meeting in a room, or the sound denied) the microphone's lines are "Speaker ?", since nothing tells the User from the others. The words are kept in the Transcript's voice spans (`<v Me>`), and the window words them in the interface's language.
- **Why.** The mix lost who spoke, and the echo canceller had already made the microphone's track the User's alone, which is what the labels by source (#140, #138) needed. Answers during a call and "Answer their question" can then tell what the other side said from what the User said.
- **Cost.** A stream is decoded only while someone on it speaks, and one decode runs at a time, so the engine's work stays about what it was, except where both sides talk at once: that speech is decoded twice. Each stream is levelled and has its speech found on its own. The pull request has the measure.
- **Leftover echo.** On laptop speakers what the canceller leaves can still be read as words. A line from the microphone that repeats a line of the computer's sound said at the same time is dropped (`src/core/meetings/echoLines.ts`): at least 0.6 of its letter pairs are in what they said, or, for a short line, 0.8 alike a whole line of theirs; the User saying the words after the other side finished is kept.
- **The files are unchanged.** The two sources stay apart on disk as before; stretches transcribed from disk after Stop go through the same two tracks.
