/**
 * A Meeting's notes filled in after Stop by a real model (#142, #2305): calls heard through the
 * fake capture and transcriber, in Chinese with the interface in Simplified Chinese and in English
 * with it in English, with no notes taken and with a few lines. Chinese notes name who spoke as the
 * Transcript does in Chinese (我, 对方), never Me, Them or 用户; English notes never call the User
 * "the User". Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL,
 * Haiku 5.5 by default), INCARNAMIND_LIVE_RUNS times each; INCARNAMIND_LIVE_REPORT keeps each
 * note and what it cost.
 */
import { appendFile } from "node:fs/promises";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting } from "../../src/core";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { note, readMind, shownWithAiText, writeMind } from "../helpers/minds";
import { transcribingCore, until } from "../helpers/transcription";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1);
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;
type Usage = Extract<StreamPart, { type: "finish" }>["usage"];

/** Every request's tokens, as the provider reported them, for the report's cost. */
const tokens = { requests: 0, input: 0, cachedInput: 0, output: 0 };
const count = (usage: Usage) => {
  tokens.requests++;
  tokens.input += usage.inputTokens.total ?? 0;
  tokens.cachedInput += usage.inputTokens.cacheRead ?? 0;
  tokens.output += usage.outputTokens.total ?? 0;
};
const counted: ChatModelFactory = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        count(result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const stream = result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") count(part.usage);
              controller.enqueue(part);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });

interface Call {
  name: string;
  language: "en" | "zh-CN";
  me: string[];
  them: string[];
  /** The User's lines, for notes filled in under them. */
  notes: string[];
}

const CALLS: Call[] = [
  {
    name: "a supplier, in Chinese",
    language: "zh-CN",
    me: ["我们这周要定下供应商。", "交货能不能提前到十二月一号？", "我周四之前把采购单发给你。"],
    them: [
      "我们的报价是每件三十二元。",
      "十二月一号可以，但要加百分之五的加急费。",
      "收到采购单后，我们三天内发货。",
    ],
    notes: ["交货日期", "采购单"],
  },
  {
    name: "staffing, in Chinese",
    language: "zh-CN",
    me: ["今天主要谈新项目的人手。", "我们需要两个后端工程师。", "我明天把职位描述发给你们。"],
    them: ["我们这边可以先派一个人过来。", "第二个人要等到一月中旬。", "李华会负责安排面试。"],
    notes: ["人手", "面试"],
  },
  {
    name: "a lease, in English",
    language: "en",
    me: [
      "Let's go over the lease renewal today.",
      "We need the third floor from February.",
      "I'll send the signed draft by Tuesday.",
    ],
    them: [
      "The rent goes up to nine thousand a month.",
      "The third floor is free from mid-February.",
      "Our agent, Tom Becker, will book a viewing next week.",
    ],
    notes: ["third floor", "signed draft"],
  },
  {
    name: "a rollout, in English",
    language: "en",
    me: [
      "Thanks for joining the rollout check-in.",
      "Can we move the training to the eighth?",
      "I will confirm the user list on Monday.",
    ],
    them: [
      "The pilot finished with twelve open bugs.",
      "The eighth works for our trainers.",
      "Priya will fix the login bug by Friday.",
    ],
    notes: ["training", "login bug"],
  },
];

/** The Note's lines as shown, AI text in «». */
function shown(client: MindClient): string[] {
  const lines: string[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      lines.push(shownWithAiText(node));
      return false;
    }
    return true;
  });
  return lines;
}

const aiText = (lines: readonly string[]) =>
  lines.flatMap((line) => [...line.matchAll(/«([^»]*)»/g)].map((match) => match[1])).join("\n");

/** What the notes do wrong, for the call's language. */
function problems(call: Call, lines: readonly string[]): string[] {
  const text = aiText(lines);
  const found: string[] = [];
  if (text.trim() === "") found.push("no notes");
  if (lines[0]?.trim() === "") found.push("a blank line first");
  if (/用户/.test(text)) found.push("用户");
  if (/\bthe User\b/.test(text)) found.push('"the User"');
  if (call.language === "zh-CN" && /\b(?:Me|Them|Speaker)\b/.test(text))
    found.push("English labels");
  return found;
}

async function filled(call: Call, withNotes: boolean) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, {
    engine: { lines: call.me, theirLines: call.them },
    createChatModel: counted,
  });
  await core.updateSettings({ user: { language: call.language } });
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, withNotes ? call.notes.map((line) => note(line)) : [note("")]);
  await client.settled();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(6_000);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  await core.stopMeeting(meeting.id);
  await settled(core, meeting);
  const lines = shown(client);
  const cost = (await core.getCostSummary()).spent;
  core.close();
  return { lines, cost };
}

async function settled(core: Core, meeting: Meeting) {
  await vi.waitFor(
    async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling")
        throw new Error("Not yet.");
      expect(fill.state).toBe("filled");
    },
    { timeout: 240_000, interval: 250 },
  );
}

describe.skipIf(!KEY)("A Meeting's notes, on a real model", { timeout: 1_800_000 }, () => {
  test("Chinese notes name who spoke in Chinese, with no 用户 and no blank line first; English ones never say the User", async () => {
    const failed: string[] = [];
    let spent = 0;
    for (let run = 1; run <= RUNS; run++) {
      for (const call of CALLS) {
        for (const withNotes of [false, true]) {
          const { lines, cost } = await filled(call, withNotes);
          spent += cost.reduce((sum, each) => sum + (each.currency === "USD" ? each.amount : 0), 0);
          const wrong = problems(call, lines);
          if (wrong.length > 0)
            failed.push(`${call.name}, ${withNotes ? "notes" : "sections"}: ${wrong.join(", ")}`);
          if (REPORT) {
            await appendFile(
              REPORT,
              `## ${MODEL}, run ${run}: ${call.name}, ${withNotes ? "under the User's lines" : "sections"}: ${wrong.join(", ") || "ok"}\n\n${lines.join("\n")}\n\n`,
            );
          }
        }
      }
    }
    if (REPORT) {
      await appendFile(
        REPORT,
        `# ${MODEL}: ${failed.length} of ${RUNS * CALLS.length * 2} notes wrong, $${spent.toFixed(4)}; ${tokens.requests} requests, ${tokens.input} input tokens (${tokens.cachedInput} from the cache), ${tokens.output} output tokens\n\n${failed.join("\n")}\n\n`,
      );
    }
    expect(failed).toEqual([]);
  });
});
