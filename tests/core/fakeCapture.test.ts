import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { AudioSink } from "../../src/core/adapters";
import { createFakeCapture, wavSamples } from "../../src/core/meetings/fakeCapture";
import { createTempDataFolder } from "../helpers/core";
import { pcmWav } from "../helpers/meetingFiles";

test("a silent WAV read from disk contains only its silent samples", async () => {
  const path = join(await createTempDataFolder(), "silence.wav");
  const silence = new Int16Array(16);
  await writeFile(path, pcmWav(silence));

  const samples = wavSamples(readFileSync(path));
  expect(samples.length).toBe(silence.length);
  expect(samples.every((sample) => sample === 0)).toBe(true);
});

test("fake capture plays only the PCM from a WAV view starting on an odd byte", async () => {
  const expected = Int16Array.of(0, 31000, 0, 0, 0, 0, -24000, 0, 0, 0, 0, 0, 0, 0, 0, -1);
  const wav = pcmWav(expected);
  const backing = Buffer.alloc(wav.length + 4, 0x7f);
  backing.set(wav, 1);
  const recording = wavSamples(backing.subarray(1, 1 + wav.length));
  const audio = vi.fn<AudioSink["audio"]>();
  const capture = createFakeCapture({ recording });
  const session = capture.start({ systemAudio: true }, { audio, state: vi.fn() });

  try {
    capture.push("system", 1);
    capture.push("system", 1);

    expect(audio.mock.calls.map(([source, samples]) => [source, samples])).toEqual([
      ["system", expected],
      ["system", new Int16Array(expected.length)],
    ]);
  } finally {
    await session.stop();
  }
});
