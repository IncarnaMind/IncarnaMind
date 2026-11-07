/**
 * Notes filled in again after the User named who spoke (#138), on a real model: a call in English
 * and one in Chinese, heard through the fake capture and transcriber, its other side told apart
 * into two Speakers, filled in, then both Speakers named and the notes filled in again. The notes
 * name people as the User did, never by the labels they replaced, and still write the User in the
 * first person. Runs only with INCARNAMIND_LIVE_DEEPSEEK_KEY (INCARNAMIND_LIVE_DEEPSEEK_MODEL,
 * deepseek-flash by default); INCARNAMIND_LIVE_REPORT keeps both notes and what they cost.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting, TranscriptSpeakers } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { withSpeakerChosen } from "../../src/shared/speakers";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { note, readMind, shownWithAiText, writeMind } from "../helpers/minds";
import { fakeSeparator, savedCues, transcribingCore, until } from "../helpers/transcription";

const KEY = process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

interface Call {
  name: string;
  language: "en" | "zh-CN";
  me: string[];
  them: string[];
  /** Who the first and the second Speaker of the other side are. */
  names: [string, string];
  /**
   * The labels the names replace. "The other side" (对方) stays fair: a Speaker who says "we" speaks
   * for their side, which the notes may name as a side.
   */
  labels: RegExp;
  /** The User written in the first person. */
  firstPerson: RegExp;
  /** The User named as a third party, or by the label "Me". */
  notTheUser: RegExp;
}

const CALLS: Call[] = [
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
      "I will book a viewing for next week.",
    ],
    names: ["Dana Whitfield", "Tom Becker"],
    labels: /\bSpeaker \d\b/,
    firstPerson: /\b(?:I|I'll|I will|my|we|our)\b/,
    notTheUser: /\bthe User\b|\bMe\b/,
  },
  {
    name: "a supplier, in Chinese",
    language: "zh-CN",
    me: ["我们这周要定下供应商。", "交货能不能提前到十二月一号？", "我周四之前把采购单发给你。"],
    them: [
      "我们的报价是每件三十二元。",
      "十二月一号可以，但要加百分之五的加急费。",
      "收到采购单后，我们三天内发货。",
    ],
    names: ["王丽", "陈明"],
    labels: /发言人\s*\d|Speaker \d/,
    firstPerson: /我/,
    notTheUser: /用户|\bMe\b/,
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

async function fillSettled(core: Core, meeting: Meeting) {
  const fill = await vi.waitFor(
    async () => {
      const now = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!now || ["waiting", "filling", "undone"].includes(now.state)) throw new Error("Not yet.");
      return now;
    },
    { timeout: 240_000, interval: 250 },
  );
  expect(fill.state, JSON.stringify(fill.problem)).toBe("filled");
}

async function namedAndFilledAgain(call: Call) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, {
    engine: { lines: call.me, theirLines: call.them },
    speakerSeparator: fakeSeparator().separator,
    createChatModel: createAiSdkChatModel,
  });
  await core.updateSettings({ user: { language: call.language } });
  await core.saveChatProvider({ kind: "deepseek", apiKey: KEY ?? "", modelId: MODEL });
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [note("")]);
  await client.settled();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(25_000);
  await until(core, meeting.id, (transcript) => transcript.lines >= 8);
  await core.stopMeeting(meeting.id);
  await fillSettled(core, meeting);
  const before = shown(client);

  const cues = await savedCues(core, meeting.id);
  const documentId = (await core.listMeetings()).find((each) => each.id === meeting.id)?.transcript
    ?.documentId as string;
  const lines = cues.flatMap((cue) =>
    cue.speaker ? [{ startMs: cue.startMs, label: cue.speaker }] : [],
  );
  let speakers: TranscriptSpeakers | null = null;
  for (const [index, label] of ["Speaker 1", "Speaker 2"].entries()) {
    const line = lines.find((each) => each.label === label);
    if (!line) throw new Error(`No line by ${label}.`);
    speakers = withSpeakerChosen(
      speakers,
      lines,
      line,
      { name: call.names[index] as string },
      true,
    );
  }
  await core.setTranscriptSpeakers({ documentId, speakers: speakers ?? { labels: {}, lines: {} } });
  await core.undoMeetingFill(meeting.id);
  await core.fillMeetingNotes(meeting.id);
  await fillSettled(core, meeting);
  const after = shown(client);
  const cost = (await core.getCostSummary()).spent;
  core.close();
  return { before, after, cost };
}

describe.skipIf(!KEY)(
  "Notes filled in again after the User named who spoke",
  { timeout: 1_800_000 },
  () => {
    test("they name people as the User did, never by the labels, and write the User as I", async () => {
      const failed: string[] = [];
      for (const call of CALLS) {
        const { before, after, cost } = await namedAndFilledAgain(call);
        const text = aiText(after);
        const wrong: string[] = [];
        if (text.trim() === "") wrong.push("no notes");
        if (!call.names.some((name) => text.includes(name))) wrong.push("no name the User gave");
        if (call.labels.test(text)) wrong.push("a label a name replaced");
        if (!call.firstPerson.test(text)) wrong.push("the User not in the first person");
        if (call.notTheUser.test(text)) wrong.push("the User by a label or as the User");
        if (wrong.length > 0) failed.push(`${call.name}: ${wrong.join(", ")}`);
        if (REPORT) {
          const spent = cost
            .map((each) => `${each.amount.toFixed(4)} ${each.currency}`)
            .join(" + ");
          await appendFile(
            REPORT,
            `## ${MODEL}: ${call.name}: ${wrong.join(", ") || "ok"} (${spent || "nothing counted"})\n\n### Before naming\n\n${before.join("\n")}\n\n### After naming ${call.names.join(" and ")}\n\n${after.join("\n")}\n\n`,
          );
        }
      }
      expect(failed).toEqual([]);
    });
  },
);
