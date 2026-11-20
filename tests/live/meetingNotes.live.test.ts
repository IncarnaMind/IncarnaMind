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
import {
  replaySummaryRetention,
  summaryRetentionHistoryProblems,
  summaryRetentionItemProblems,
  summaryRetentionOverviewProblems,
} from "../../eval/speed/meetingSummaryCases";
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
const tokens = { requests: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
const count = (usage: Usage) => {
  tokens.requests++;
  tokens.input += usage.inputTokens.total ?? 0;
  tokens.cachedInput += usage.inputTokens.cacheRead ?? 0;
  tokens.cacheWrite += usage.inputTokens.cacheWrite ?? 0;
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

/** The Chinese titles the notes give their generated sections, in order. */
const SECTION_TITLES = ["摘要", "决定", "待办事项", "待定问题", "会上说了、你的文档里没有的"];

/** What the notes do wrong, for the call's language. */
function problems(call: Call, lines: readonly string[], withNotes: boolean): string[] {
  const text = aiText(lines);
  const found: string[] = [];
  if (text.trim() === "") found.push("no notes");
  if (lines[0]?.trim() === "") found.push("a blank line first");
  if (/用户/.test(text)) found.push("用户");
  if (/\bthe User\b/.test(text)) found.push('"the User"');
  if (call.language === "zh-CN") {
    if (/\b(?:Me|Them|Speaker)\b/.test(text)) found.push("English labels");
    // In the sections written when the User took no notes, each action names who it is for.
    const title = (line: string) => aiText([line]).trim();
    const at = withNotes ? -1 : lines.findIndex((line) => title(line) === "待办事项");
    if (at >= 0) {
      const rest = lines.slice(at + 1);
      const next = rest.findIndex((line) => SECTION_TITLES.includes(title(line)));
      const actions = (next < 0 ? rest : rest.slice(0, next)).filter((line) => title(line) !== "");
      if (actions.some((line) => !/我|对方/.test(title(line))))
        found.push("an action without an owner");
    }
  }
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
          const wrong = problems(call, lines, withNotes);
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
        `# ${MODEL}: ${failed.length} of ${RUNS * CALLS.length * 2} notes wrong, $${spent.toFixed(4)}; ${tokens.requests} requests, ${tokens.input} input tokens (${tokens.cachedInput} from the cache, ${tokens.cacheWrite} written to it), ${tokens.output} output tokens\n\n${failed.join("\n")}\n\n`,
      );
    }
    expect(failed).toEqual([]);
  });
});

function summaryTiming() {
  const timing = process.env.INCARNAMIND_LIVE_SUMMARY_RETENTION_TIMING ?? "after-stop";
  if (timing !== "before-stop" && timing !== "in-flight-at-stop" && timing !== "after-stop") {
    throw new Error(
      "Set INCARNAMIND_LIVE_SUMMARY_RETENTION_TIMING to before-stop, in-flight-at-stop, or after-stop.",
    );
  }
  return timing;
}

const summaryModel: ChatModelFactory = (spec) =>
  wrapLanguageModel({
    model: counted(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        if (
          !params.prompt.some(
            (message) =>
              message.role === "system" &&
              message.content.includes("standalone summary of the meeting"),
          )
        ) {
          throw new Error("This eval sends only Quick AI summary requests.");
        }
        return doGenerate();
      },
      wrapStream() {
        throw new Error("The full Note is outside this eval.");
      },
    },
  });

// Set INCARNAMIND_LIVE_SUMMARY_RETENTION=1 and select -t "Quick AI summary retention" to run
// this case with the usual live key. The nightly notes run keeps its existing request budget.
test.skipIf(!KEY || process.env.INCARNAMIND_LIVE_SUMMARY_RETENTION !== "1")(
  "Quick AI summary retention through topic shifts and a correction at Stop",
  { timeout: 1_800_000 },
  async () => {
    const timing = summaryTiming();
    const apiKey = KEY ?? "";
    const judge = counted({
      kind: "anthropic",
      apiKey,
      modelId: MODEL,
      baseUrl: null,
      thinking: "off",
    });
    const failures: string[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const { checkpoints, warm, final } = await replaySummaryRetention({
        apiKey,
        modelId: MODEL,
        timing,
        createChatModel: summaryModel,
      });
      const reviews = {
        warmOverview: await summaryRetentionOverviewProblems(judge, "warm", warm.text),
        warmItems: summaryRetentionItemProblems("warm", warm.items ?? []),
        finalOverview: await summaryRetentionOverviewProblems(judge, "final", final.text),
        finalItems: [
          ...summaryRetentionItemProblems("final", final.items ?? []),
          ...summaryRetentionHistoryProblems(warm.items ?? [], final.items ?? []),
        ],
      };
      const problems = Object.entries(reviews).flatMap(([area, issues]) =>
        issues.map((issue) => `${area}: ${issue}`),
      );
      failures.push(...problems.map((problem) => `Run ${run}: ${problem}`));
      const grade = (issues: readonly string[]) => (issues.length ? "wrong" : "right");
      if (REPORT) {
        const snapshots = [...checkpoints, final].map(
          ({ text, throughMs, items }) =>
            `### Through ${throughMs} ms\n\n${text}\n\n${items?.map((item) => `- #${item.id} ${item.kind}, ${item.status}: ${item.text}`).join("\n") ?? ""}`,
        );
        await appendFile(
          REPORT,
          `## Quick AI summary retention, ${MODEL}, ${timing}, run ${run}\n\nBefore correction: overview ${grade(reviews.warmOverview)}, list ${grade(reviews.warmItems)}. Finished: overview ${grade(reviews.finalOverview)}, list ${grade(reviews.finalItems)}.\n\n${problems.map((problem) => `- ${problem}\n`).join("")}\n${snapshots.join("\n\n")}\n\n`,
        );
      }
    }
    expect(failures).toEqual([]);
  },
);

// Use INCARNAMIND_LIVE_SUMMARY_RETENTION=zh-agenda for the compound correction from #3472.
test.skipIf(!KEY || process.env.INCARNAMIND_LIVE_SUMMARY_RETENTION !== "zh-agenda")(
  "Quick AI summary retention keeps the original Mandarin booking and separates the withdrawn agenda from the notification",
  { timeout: 120_000 },
  async () => {
    const timing = summaryTiming();
    const { warm, final } = await replaySummaryRetention({
      apiKey: KEY ?? "",
      modelId: MODEL,
      createChatModel: summaryModel,
      timing,
      language: "zh-CN",
      utterances: [
        "北桥项目的内审定于周二。由陈琳发出议程。唐敏周五清点门卡。",
        "取消周二的北桥项目内审和原议程。北桥项目内审最终改到周四，周二不举行。由陈琳向所有参会人确认这一改动。",
      ],
    });
    if (REPORT) {
      await appendFile(REPORT, `${JSON.stringify({ model: MODEL, timing, warm, final })}\n`);
    }
    const prior = warm.items ?? [];
    const booking = prior.find((item) => item.kind === "decision" && item.text.includes("内审"));
    const agenda = prior.find((item) => item.kind === "action" && item.text.includes("议程"));
    const cards = prior.find((item) => item.kind === "action" && item.text.includes("门卡"));
    expect(prior).toHaveLength(3);
    for (const item of [booking, agenda, cards]) expect(item?.status).toBe("active");

    const after = final.items ?? [];
    expect(after.find((item) => item.id === booking?.id)).toMatchObject({
      kind: "decision",
      status: "active",
      text: expect.stringMatching(/(?:周|星期|礼拜)四/u),
    });
    expect(after.find((item) => item.id === agenda?.id)).toMatchObject({
      kind: "action",
      status: "cancelled",
      text: expect.stringContaining("议程"),
    });
    expect(after.find((item) => item.id === cards?.id)).toEqual(cards);
    const added = after.filter((item) => !prior.some((old) => old.id === item.id));
    expect(added).toEqual([
      expect.objectContaining({
        kind: "action",
        status: "active",
        text: expect.stringContaining("陈琳"),
      }),
    ]);
    expect(added[0]?.text).toMatch(/确认|通知|告知|知会|传达|通报|沟通/u);
    expect(added[0]?.text).toMatch(/参会|与会|出席|参加|参与|大家|全体|所有人/u);
  },
);
