import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Node imports the engine module itself, as the transcription process does once built (#1233): no
// bundler's interop gives a CommonJS package's exports their names, so they must be found on `default`.
const LOAD = `
  const { loadSherpa } = await import("./src/core/transcription/sherpa.ts");
  const { createSherpaSeparator } = await import("./src/core/transcription/diarization.ts");
  const sherpa = await loadSherpa();
  console.log(JSON.stringify({
    createAsync: typeof sherpa.OfflineRecognizer?.createAsync,
    vad: typeof sherpa.Vad,
    diarization: typeof sherpa.OfflineSpeakerDiarization?.prototype.process,
    voiceprint: typeof sherpa.SpeakerEmbeddingExtractor?.prototype.compute,
    separator: typeof (await createSherpaSeparator()),
  }));
`;

test("the engine modules find sherpa-onnx-node's recognizer, voice detector and speaker diarization when Node imports them", {
  timeout: 60_000,
}, () => {
  const output = execFileSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      "./scripts/tsResolve.mjs",
      "--input-type=module",
      "-e",
      LOAD,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
    createAsync: "function",
    vad: "function",
    diarization: "function",
    voiceprint: "function",
    separator: "function",
  });
});
