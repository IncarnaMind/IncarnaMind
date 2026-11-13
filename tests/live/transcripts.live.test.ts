/**
 * A Meeting transcribed by the real engine, then asked about by real models
 * (#136): FLEURS clips (eval/transcription/README.md) go through a Meeting as
 * its microphone, Qwen3-ASR and Silero VAD transcribe them into a Transcript
 * Document, and a Question to each model must cite a time whose quote the
 * check finds. Runs only with INCARNAMIND_LIVE_TRANSCRIPTS=1:
 *
 *   INCARNAMIND_EVAL_CLIPS      the folder eval/transcription/fetch-fleurs.py wrote
 *   INCARNAMIND_EVAL_MODELS     the model's files, laid out as the data folder's models/
 *   INCARNAMIND_ENV_FILE        a .env.local with INCARNAMIND_EVAL_CHAT_KEY (Anthropic) and
 *                               OPENAI_API_KEY, read in this process only, never printed
 *   INCARNAMIND_LIVE_MODELS     which to ask, e.g. "anthropic:claude-haiku-5-5,openai:gpt-6-luna,ollama:qwen3.5:4b"
 *
 * The engine's own test (#2957) needs INCARNAMIND_EVAL_MODELS alone, and asks no model: it
 * downloads the speech model and Silero VAD there, checked, when they aren't there already.
 */
import { readFileSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type {
  AudioCapture,
  AudioSink,
  ChatProviderKind,
  Core,
  TranscriberListener,
} from "../../src/core";
import { downloadModel } from "../../src/core/embedding/download";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import {
  QWEN3_ASR_0_6B,
  SILERO_VAD,
  transcriptionModelFiles,
} from "../../src/core/transcription/model";
import { createSherpaEngine } from "../../src/core/transcription/sherpa";
import { askAndFinish, citationsIn } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn } from "../helpers/minds";
import { inProcessTranscriber } from "../helpers/transcription";

const CLIPS = process.env.INCARNAMIND_EVAL_CLIPS ?? "";
const MODELS = process.env.INCARNAMIND_EVAL_MODELS ?? "";

function keyFor(name: string): string | null {
  const file = process.env.INCARNAMIND_ENV_FILE;
  if (!file) return process.env[name] ?? null;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((each) => each.startsWith(`${name}=`));
  return (
    line
      ?.slice(name.length + 1)
      .trim()
      .replace(/^["']|["']$/g, "") || null
  );
}

/** A FLEURS clip as 16-bit samples: FLEURS keeps 32-bit float. */
async function clip(path: string): Promise<Int16Array> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = view.getUint32(at + 4, true);
    if (id === "data") {
      const out = new Int16Array(size / 4);
      for (let i = 0; i < out.length; i++) {
        out[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(view.getFloat32(at + 8 + i * 4, true) * 32767)),
        );
      }
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no audio.`);
}

/** A microphone that plays what the test gives it, never a device. */
function playingCapture() {
  let sink: AudioSink | null = null;
  const capture: AudioCapture = {
    systemAudio: false,
    start(_request, given) {
      sink = given;
      given.state("microphone", "recording");
      return {
        setMicrophone: () => {},
        stop: async () => {
          sink = null;
        },
      };
    },
    openSettings: async () => {},
  };
  return { capture, play: (samples: Int16Array) => sink?.audio("microphone", samples) };
}

const QUESTIONS = [
  {
    language: "en",
    question:
      "What do some festivals offer families with young children? Cite the meeting transcript.",
    expect: /camping areas/i,
  },
  {
    language: "zh",
    question: "亚马逊河有些河段有多宽？请引用会议转写稿。",
    expect: /宽度可达/,
  },
];

describe.runIf(process.env.INCARNAMIND_LIVE_TRANSCRIPTS === "1")(
  "A Meeting transcribed by the real engine, asked about by real models",
  { timeout: 30 * 60_000 },
  () => {
    test("each model cites a time in the Transcript, and the check finds its quote", async () => {
      const dataDir = await createTempDataFolder();
      await symlink(MODELS, join(dataDir, "models"));
      const clock = manualClock();
      const { capture, play } = playingCapture();
      const engine = inProcessTranscriber({}, createSherpaEngine);
      const core: Core = startCore(dataDir, {
        audioCapture: capture,
        transcriber: engine.transcriber,
        now: clock.now,
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.updateSettings({
        device: { meetingNoticeAccepted: true, meetingSystemAudio: false },
      });
      await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id, systemAudio: false });

      // Each language's clips, with pauses between, at twice the pace they were spoken.
      const pause = new Int16Array(16_000 * 1.5);
      for (const language of ["en", "zh"]) {
        const rows = (await readFile(join(CLIPS, language, "clips.tsv"), "utf8"))
          .trim()
          .split("\n");
        for (const row of rows) {
          const samples = await clip(join(CLIPS, language, row.split("\t")[0] as string));
          for (const audio of [pause, samples]) {
            for (let at = 0; at < audio.length; at += 1600) {
              clock.advance(100);
              play(audio.subarray(at, at + 1600));
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
        }
      }
      await core.stopMeeting(meeting.id);
      const transcript = await vi.waitFor(
        async () => {
          const found = (await core.listMeetings())[0]?.transcript;
          if (found?.state !== "saved") throw new Error(`Not saved yet: ${found?.state}`);
          return found;
        },
        { timeout: 20 * 60_000, interval: 500 },
      );
      console.log(`Transcript: ${transcript.lines} lines, saved at ${transcript.savedPath}`);
      console.log(readFileSync(transcript.savedPath as string, "utf8"));

      const asked = (process.env.INCARNAMIND_LIVE_MODELS ?? "anthropic:claude-haiku-5-5")
        .split(",")
        .map((each) => {
          const [kind, ...model] = each.split(":");
          return { kind: kind as ChatProviderKind, modelId: model.join(":") };
        });
      const mind = await core.createMind({ title: "Festivals" });
      const client = await connectToMind(core, mind.id);
      const results: string[] = [];
      for (const { kind, modelId } of asked) {
        const apiKey =
          kind === "anthropic"
            ? keyFor("INCARNAMIND_EVAL_CHAT_KEY")
            : kind === "openai"
              ? keyFor("OPENAI_API_KEY")
              : null;
        await core.saveChatProvider({ kind, modelId, ...(apiKey && { apiKey }) });
        for (const { question, expect: quoted } of QUESTIONS) {
          const { answerId } = await askAndFinish(core, client, mind.id, question);
          const cited = citationsIn(client, answerId).filter(
            (citation) => citation.documentId === transcript.documentId,
          );
          const line = `${kind}:${modelId} — "${question}": ${cited
            .map(
              (citation) =>
                `${JSON.stringify(citation.location)} ${citation.check} "${citation.quote}"`,
            )
            .join("; ")}`;
          results.push(line);
          console.log(line);
          console.log(`  Answer: ${answerIn(client, answerId).textContent}`);
          expect.soft(cited.length, line).toBeGreaterThan(0);
          expect
            .soft(
              cited.some(
                (citation) =>
                  citation.location?.kind === "time" &&
                  citation.check === "found" &&
                  quoted.test(citation.quote ?? ""),
              ),
              line,
            )
            .toBe(true);
        }
      }
    });
  },
);

/** A 16-bit WAV's samples, as the fixtures keep them. */
async function wavSamples(path: string): Promise<Int16Array> {
  const bytes = await readFile(path);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString("ascii", at, at + 4) === "data") {
      const body = bytes.subarray(at + 8, at + 8 + size);
      return new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no audio.`);
}

/**
 * The speech model's files in a new data folder, downloaded and checked when they aren't there
 * yet: no streaming model, and one thread, as the run shares the computer.
 */
async function engineFiles() {
  for (const { folder, source } of [QWEN3_ASR_0_6B, SILERO_VAD]) {
    await downloadModel({
      directory: join(MODELS, folder),
      source,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
  }
  const dataDir = await createTempDataFolder();
  await symlink(MODELS, join(dataDir, "models"));
  const all = transcriptionModelFiles(dataDir, QWEN3_ASR_0_6B);
  return { engine: all.engine, files: all.files, vad: all.vad, threads: 1 };
}

/** A listener that keeps each stream's final lines. */
function finalLines() {
  const heard = new Map<string, string[]>();
  const listener: TranscriberListener = {
    segment: (segment) => {
      if (segment.final)
        heard.set(segment.stream, [...(heard.get(segment.stream) ?? []), segment.text]);
    },
    progress: () => {},
    failed: () => {},
    stopped: () => {},
    unloaded: () => {},
    switched: () => {},
    lost: () => {},
    opened: () => {},
  };
  return { heard, listener };
}

describe.runIf(process.env.INCARNAMIND_LIVE_TRANSCRIPTS === "1")(
  "The real engine behind the app's channel",
  { timeout: 15 * 60_000 },
  () => {
    // protects=the real engine, served as the app's process serves it, closed with a finish out: that finish fails as closed on purpose, and loading again starts the engine afresh and transcribes (#2957); fails_when=the finish waits for ever, or the engine can't load again after a close; no_claim=the utility process's own stop, which needs Electron.
    test("closed with a finish out, the finish fails as closed, and the engine loads again and transcribes", async () => {
      const files = await engineFiles();
      const speechSamples = await wavSamples(
        join(import.meta.dirname, "../fixtures/speech/gettysburg.wav"),
      );
      const { heard, listener } = finalLines();
      const host = inProcessTranscriber({}, createSherpaEngine);
      const { transcriber } = host;
      transcriber.listen(listener);
      const said = async (stream: string) => {
        transcriber.push(stream, speechSamples);
        await transcriber.finish(stream);
        return (heard.get(stream) ?? []).join(" ");
      };

      await transcriber.load(files);
      expect(await said("before")).toMatch(/fathers/i);
      transcriber.push("cut", speechSamples);
      const cut = transcriber.finish("cut");
      transcriber.close();
      await expect(cut).rejects.toThrow("The transcription model was stopped.");

      await transcriber.load(files);
      expect(host.started).toBe(2);
      expect(await said("after")).toMatch(/fathers/i);
      transcriber.close();
    });

    // protects=the real engine, served as the app's process serves it, reads a stretch that reaches its token limit again in two parts and keeps both parts' words, in English and Chinese, with none of its words in the log (#1031); fails_when=the words past the limit are lost, the parts aren't read, or a word shows in the log; no_claim=the limit of 128, which these fixtures don't reach: one value lowers the model's own limit and the check together, and the one stretch of the meeting set seen to reach 128 is a local proof.
    // At these limits one reading of a stretch stops in its first half, before "liberty" or "万元".
    test.each([
      ["en", "gettysburg.wav", 12, /^Four score.*liberty/i],
      ["zh-CN", "short-first-words-zh.wav", 8, /总价.*万元.*寄出去了/],
    ])(
      "%s: a stretch that reaches the token limit is read again in two parts, and keeps their words",
      async (_language, fixture, newTokens, both) => {
        const files = await engineFiles();
        const speechSamples = await wavSamples(
          join(import.meta.dirname, "../fixtures/speech", fixture),
        );
        const { heard, listener } = finalLines();
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        const host = inProcessTranscriber({}, (model) => createSherpaEngine(model, { newTokens }));
        host.transcriber.listen(listener);
        await host.transcriber.load(files);
        host.transcriber.push("limited", speechSamples);
        await host.transcriber.finish("limited");
        host.transcriber.close();
        const text = (heard.get("limited") ?? []).join(" ");
        const messages = warned.mock.calls.map(([message]) => message);
        const logged = JSON.stringify(warned.mock.calls);
        warned.mockRestore();

        expect(messages).toContain("The stretch was read again in two parts.");
        expect(text).toMatch(both);
        for (const word of text.match(/\p{Script=Han}|\p{L}{6,}/gu) ?? []) {
          expect(logged).not.toContain(word);
        }
      },
    );
  },
);
