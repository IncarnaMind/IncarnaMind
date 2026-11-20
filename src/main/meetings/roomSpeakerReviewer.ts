import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RoomSpeakerReviewer, VoiceTurn } from "../../core/adapters";
import { downloadModel, isModelDownloaded } from "../../core/embedding/download";
import { meetingFolder } from "../../core/meetings/audioFiles";
import { roomEngine, roomModel } from "./roomModels";

async function execute(
  program: string,
  args: string[],
  signal: AbortSignal,
  cwd: string,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      signal,
      killSignal: "SIGKILL",
      stdio: "ignore",
      windowsHide: true,
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    // On abort, the error event may precede close. Windows needs the executable and WAV released before cleanup.
    child.once("close", (code) => {
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0)
        reject(failure ?? new Error(`Speaker check exited with code ${code}`));
      else resolve();
    });
  });
}

export function readRoomTurns(rttm: string): VoiceTurn[] {
  const voices = new Map<string, number>();
  const turns: VoiceTurn[] = [];
  for (const line of rttm.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [kind, , , start, duration, , , speaker] = line.trim().split(/\s+/);
    const startMs = Math.round(Number(start) * 1000);
    const endMs = Math.round((Number(start) + Number(duration)) * 1000);
    if (
      kind !== "SPEAKER" ||
      !speaker ||
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    ) {
      throw new Error("Invalid speaker interval");
    }
    const voice = voices.get(speaker) ?? voices.size;
    if (voice >= 4) throw new Error("Unexpected number of speakers");
    voices.set(speaker, voice);
    turns.push({ startMs, endMs, voice });
  }
  return turns;
}

export function createRoomSpeakerReviewer(dataDir: string): RoomSpeakerReviewer | undefined {
  const engine = roomEngine(process.platform, process.arch);
  const archive = engine?.files[0];
  const model = roomModel.files[0];
  if (!engine || !archive || !model) return undefined;
  const cache = join(dataDir, "models", "room-speakers");
  const assets = [
    { directory: join(cache, "sortformer-v2"), source: roomModel },
    { directory: join(cache, "nemo-0.3.0"), source: engine },
  ];
  const archivePath = join(cache, "nemo-0.3.0", archive.path);
  const modelPath = join(cache, "sortformer-v2", model.path);
  const releaseDir = archive.path.replace(/\.tar\.gz$|\.zip$/, "");
  let previous: Promise<void> = Promise.resolve();

  async function separate(meetingId: string, recording: Blob, signal: AbortSignal) {
    for (const asset of assets) {
      await downloadModel({ ...asset, signal, onProgress() {} });
    }
    await writeFile(
      join(cache, "sortformer-v2", "NOTICE.txt"),
      [
        "NVIDIA Streaming Sortformer v2, Q8_0 GGUF. Provided by NVIDIA, unmodified.",
        "https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2",
        "Creative Commons Attribution 4.0 International: https://creativecommons.org/licenses/by/4.0/",
      ].join("\n"),
    );
    signal.throwIfAborted();
    const directory = await mkdtemp(join(meetingFolder(dataDir, meetingId), ".room-review-"));
    try {
      const tar =
        process.platform === "win32"
          ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          : "/usr/bin/tar";
      await execute(tar, ["-xf", archivePath, "-C", directory], signal, directory);
      const wav = join(directory, "room.wav");
      await pipeline(recording.stream(), createWriteStream(wav, { mode: 0o600 }), { signal });
      const output = join(directory, "speakers.rttm");
      const program = join(
        directory,
        releaseDir,
        "bin",
        process.platform === "win32" ? "nemo-speech.exe" : "nemo-speech",
      );
      await execute(
        program,
        [
          "diarize",
          wav,
          "--model",
          modelPath,
          "--preset",
          "streaming",
          "--format",
          "rttm",
          "--output",
          output,
        ],
        signal,
        directory,
      );
      return readRoomTurns(await readFile(output, { encoding: "utf8", signal }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return {
    downloadBytes: () =>
      assets.reduce(
        (sum, { directory, source }) =>
          sum +
          (isModelDownloaded(directory, source.files)
            ? 0
            : source.files.reduce((total, file) => total + file.size, 0)),
        0,
      ),
    separate(meetingId, recording, signal) {
      signal.throwIfAborted();
      return new Promise<VoiceTurn[]>((resolve, reject) => {
        const cancelQueued = () => reject(signal.reason);
        signal.addEventListener("abort", cancelQueued, { once: true });
        previous = previous.then(async () => {
          signal.removeEventListener("abort", cancelQueued);
          if (signal.aborted) return;
          await separate(meetingId, recording, signal).then(resolve, reject);
        });
      });
    },
  };
}
