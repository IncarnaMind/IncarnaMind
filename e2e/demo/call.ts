/**
 * The call of the recording: a test recording in synthetic voices, played into the built app's
 * capture as the packaged transcription check plays its own, so the transcript is the app's own
 * speech engine on the audio it hears. The other side comes in on the computer's sound, the User
 * on the microphone. No real person's voice is used.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";
import { wavSamples } from "../../src/core/meetings/fakeCapture";

const run = promisify(execFile);

/** What the capture's sink takes: 16 kHz, mono, signed 16-bit. */
const SAMPLE_RATE = 16_000;
/** How much audio the capture hands over at a time, in milliseconds. */
const TICK_MS = 100;

/** A line spoken by a macOS voice, as 16 kHz mono samples. */
export async function speech(folder: string, name: string, voice: string, text: string) {
  await mkdir(folder, { recursive: true });
  const spoken = join(folder, `${name}.aiff`);
  const wav = join(folder, `${name}.wav`);
  await run("say", ["-v", voice, "-r", "165", "-o", spoken, text]);
  await run("ffmpeg", [
    ...["-y", "-loglevel", "error", "-i", spoken],
    ...["-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", wav],
  ]);
  return Array.from(wavSamples(await readFile(wav)));
}

interface CallCapture {
  say(source: "microphone" | "system", samples: number[]): void;
}

/**
 * Makes the capture of the app's test build play what `say` is given, in real time, and silence
 * between: the other side on the computer's sound, the User on the microphone.
 */
export async function connectCall(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    (_electron, { tick, rate }) => {
      const holder = globalThis as unknown as {
        incarnamindFakeAudio: {
          start(
            request: { systemAudio: boolean },
            sink: {
              audio(source: string, samples: Int16Array, at: number): void;
              state(source: string, state: string): void;
            },
          ): { setMicrophone(on: boolean): void; stop(): Promise<void> };
        };
        demoCall?: CallCapture;
      };
      const queues: Record<string, number[]> = { microphone: [], system: [] };
      const per = Math.round((tick * rate) / 1000);
      holder.demoCall = {
        say(source, samples) {
          queues[source]?.push(...samples);
        },
      };
      holder.incarnamindFakeAudio.start = (request, sink) => {
        sink.state("microphone", "recording");
        if (request.systemAudio) sink.state("system", "recording");
        let microphoneOn = true;
        const timer = setInterval(() => {
          for (const source of request.systemAudio ? ["microphone", "system"] : ["microphone"]) {
            const taken = (queues[source] ?? []).splice(0, per);
            const samples = new Int16Array(per);
            samples.set(taken);
            if (source !== "microphone" || microphoneOn) sink.audio(source, samples, Date.now());
          }
        }, tick);
        return {
          setMicrophone(on) {
            microphoneOn = on;
          },
          stop: async () => clearInterval(timer),
        };
      };
    },
    { tick: TICK_MS, rate: SAMPLE_RATE },
  );
}

/** Has a side say a line, and resolves when its audio has been handed to the app. */
export async function say(
  app: ElectronApplication,
  source: "microphone" | "system",
  samples: number[],
): Promise<void> {
  await app.evaluate(
    (_electron, { side, audio }) =>
      (globalThis as unknown as { demoCall: CallCapture }).demoCall.say(side, audio),
    { side: source, audio: samples },
  );
  await new Promise((resolve) => setTimeout(resolve, (samples.length / SAMPLE_RATE) * 1000));
}
