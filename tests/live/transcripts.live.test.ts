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
 */
import { readFileSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AudioCapture, AudioSink, ChatProviderKind, Core } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
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
