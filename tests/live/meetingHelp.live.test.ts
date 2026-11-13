/**
 * One-click help during a call against a real model: a sales call heard through the fake
 * capture and transcriber (no microphone), and a price sheet in the Library. Each button must
 * answer in its shape, "Answer their question" citing the price sheet, "What do they want?"
 * the transcript; and how long each took to its first words and its first whole option is
 * written to INCARNAMIND_LIVE_REPORT when set. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY
 * (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Sonnet by default).
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core, Meeting, MeetingHelpKind } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { readHelpReply, shownItems } from "../../src/shared/helpReplyRead";
import { HELP_SHAPE } from "../../src/shared/meetingHelp";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { transcribingCore, until } from "../helpers/transcription";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

const ME = [
  "Thanks for joining, let's go through the proposal.",
  "Our Team plan is twenty-five dollars a seat a month.",
  "The pilot runs for thirty days.",
];
const THEM = [
  "We like it, but the budget is tight this quarter.",
  "Can you do thirty-five dollars a seat for Enterprise?",
  "Does Enterprise include single sign-on, and what would forty seats cost?",
];
const ME_ZH = ["谢谢大家，我们来过一下方案。", "团队版每个席位每月二十五美元。", "试用期三十天。"];
const THEM_ZH = [
  "方案不错，但这个季度预算很紧。",
  "企业版能做到每个席位三十五美元吗？",
  "企业版包含单点登录吗？四十个席位一共多少钱？",
];
const PRICES = [
  "# Price sheet 2026",
  "",
  "- Team plan: $25 per seat a month.",
  "- Enterprise plan: $45 per seat a month, single sign-on included.",
  "- Volume: 10% off Enterprise from 40 seats.",
  "- Pilot: 30 days, free; can be extended once by 30 days.",
].join("\n");

async function press(core: Core, meeting: Meeting, kind: MeetingHelpKind) {
  const started = performance.now();
  let text = "";
  let firstWords: number | null = null;
  let firstOption: number | null = null;
  const result = await core.askMeetingHelp({ meetingId: meeting.id, kind });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const stop = core.on("answer.delta", (delta) => {
    if (delta.answerId !== result.answerId) return;
    text += delta.text;
    firstWords ??= performance.now() - started;
    if (firstOption === null && /\n(?:→|->)[^\n]*\n/.test(text)) {
      firstOption = performance.now() - started;
    }
  });
  const ended = await answerEnded(core, result.answerId);
  stop();
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const done = performance.now() - started;
  if (REPORT) {
    await appendFile(
      REPORT,
      `## ${kind}: first words ${Math.round(firstWords ?? -1)} ms, first option ${Math.round(firstOption ?? -1)} ms, done ${Math.round(done)} ms (${ended.event === "failed" ? `failed: ${ended.payload.error.kind} ${ended.payload.error.message}` : ended.event})\n\n${answer.text}\n\nSteps: thought ${answer.steps?.reasoning?.ms ?? 0} ms, phases ${answer.steps?.phases.map((each) => each.phase).join(" > ") ?? ""}, Tools ${answer.toolCalls.map((each) => each.tool).join(", ")}\n\nCitations: ${answer.citations.map((each) => `${each.marker} ${each.documentName} ${each.check} "${each.quote}"`).join("; ")}\n\n`,
    );
  }
  return { answer, ended };
}

describe.skipIf(!KEY)("Help during the call, on a real model", { timeout: 300_000 }, () => {
  test("each button answers in its shape, from the transcript and the price sheet", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { lines: ME, theirLines: THEM, maxSpeechMs: 1500 },
      createChatModel: createAiSdkChatModel,
    });
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const sources = await createSourceFolder();
    await addAndProcess(core, [await writeSourceFile(sources, "Price sheet.md", PRICES)]);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(12_000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 6);
    if (REPORT) await appendFile(REPORT, `# ${MODEL}\n\n`);

    for (const kind of ["say", "answer", "want", "sum", "no", "ask", "check"] as const) {
      const { answer, ended } = await press(core, meeting, kind);
      expect(ended.event).toBe("finished");
      const shape = HELP_SHAPE[kind];
      const shown = shownItems(readHelpReply(answer.text), {
        shape,
        leadIn: false,
        streaming: false,
      });
      expect(shown.length).toBeGreaterThan(0);
      if (shape === "lines") continue;
      expect(shown[0]?.recommended).toBe(true);
      expect(shown.every((item) => item.effect !== null)).toBe(true);
      if (kind === "answer") {
        expect(answer.citations).toContainEqual(
          expect.objectContaining({ documentName: "Price sheet", check: "found" }),
        );
      }
      if (kind === "want") {
        expect(answer.citations.length).toBeGreaterThan(0);
        expect(answer.citations.every((each) => each.check === "found")).toBe(true);
      }
    }

    await core.updateSettings({ user: { language: "zh-CN" } });
    const { answer } = await press(core, meeting, "no");
    expect(answer.text).toMatch(/→/);
  });

  test("a Chinese call gets its help in Chinese in an English interface", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { lines: ME_ZH, theirLines: THEM_ZH, maxSpeechMs: 1500 },
      createChatModel: createAiSdkChatModel,
    });
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(12_000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 6);
    if (REPORT) await appendFile(REPORT, `# ${MODEL}, a Chinese call, an English interface\n\n`);
    for (const kind of ["sum", "say"] as const) {
      const { answer } = await press(core, meeting, kind);
      const words = answer.text.replace(/\[[^\]]*\]/g, "");
      const han = words.match(/\p{Script=Han}/gu)?.length ?? 0;
      const latin = words.match(/[A-Za-z]/g)?.length ?? 0;
      expect(han).toBeGreaterThan(latin);
    }
  });
});
