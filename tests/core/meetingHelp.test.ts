/**
 * One-click help during a call, through the core's public interface as the floating
 * panel and the assistant ask: a button's Question goes with the live transcript, the shape its
 * Answer takes and what the User's Documents say about the newest lines, found ahead; the
 * Meeting names its latest help, the line it answers and the conversation it went to; the
 * template adds its buttons.
 */
import { describe, expect, test } from "vitest";
import type { Core, Meeting, MeetingHelpKind } from "../../src/core";
import { setMindModel } from "../../src/shared/mindModel";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

/** A model that answers in the help shape, citing the first Passage found ahead if it has one. */
function helpingModel(calls: ModelCall[]) {
  return scriptedModel((call) => {
    calls.push(call);
    const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
    if (found && !call.results.some((result) => result.tool === "cite")) {
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: found.id, quote: PRICE }] } },
        ],
      };
    }
    return {
      text: found
        ? "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send the price sheet\n→ buys time"
        : "★ Let me confirm by Friday\n→ keeps it moving\n\nWhat matters most to you?\n→ learns their priority",
    };
  });
}

/**
 * A meeting recording with lines from both sides; `before`, what to do first (Documents wait while
 * it records); `lines` and `theirLines`, what each side says.
 */
async function setUp(
  before?: (core: Core) => Promise<void>,
  said: { lines?: readonly string[]; theirLines?: readonly string[] } = {},
) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(helpingModel(calls));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: said,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await before?.(core);
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  return { core, meeting, calls, specs: models.specs };
}

/**
 * A meeting whose live text fell behind (#1366): `before` seconds were transcribed first, then
 * forty arrived at once, more than the engine decodes in time, so it stopped keeping up.
 */
async function behindSetUp(before = 0) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(helpingModel(calls));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: { decodeMs: 30 },
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  await until(core, meeting.id, (transcript) => transcript.state === "live");
  if (before > 0) {
    record(before * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  }
  record(40 * SECOND);
  const behind = await until(core, meeting.id, (transcript) => transcript.state === "behind");
  return { core, meeting, calls, lines: behind.lines };
}

async function press(core: Core, meeting: Meeting, kind: MeetingHelpKind, conversationId?: string) {
  const result = await core.askMeetingHelp({
    meetingId: meeting.id,
    kind,
    ...(conversationId && { conversationId }),
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const latest = (await core.listMeetings()).find((each) => each.id === meeting.id);
  return { result, answer, messages, latest };
}

describe("Help during the call", { timeout: 60_000 }, () => {
  test("a button asks its name with the live transcript and the options' shape, offered the Documents' Tools only, and the Meeting names its help", async () => {
    const { core, meeting, calls } = await setUp();

    const { result, answer, messages, latest } = await press(core, meeting, "no");

    const [first] = calls;
    expect(first?.prompt).toContain("pressed a button for help");
    expect(first?.prompt).toContain('starting with "★ "');
    expect(first?.prompt).toContain("<live-transcript>");
    expect(first?.system).not.toContain("live text fell behind");
    expect(answer.steps?.textBehind).toBeUndefined();
    expect(first?.tools).toEqual(expect.arrayContaining(["search_documents", "cite"]));
    expect(first?.tools).not.toContain("add_to_mind");
    expect(messages[0]).toMatchObject({ kind: "question", text: "Say no politely" });
    expect(answer.text).toMatch(/^★ /);
    expect(latest?.help).toEqual({
      kind: "no",
      conversationId: result.asked && result.conversation.id,
      answerId: result.asked && result.answerId,
      heard: { text: expect.any(String), speaker: "Them" },
    });
  });

  // protects=every button sends the same instructions, its own going with its Question, so a call's presses share them in the provider's cache (#1634: about 3k tokens written again each press before); fails_when=a button's words, its shape or the call's language are in the instructions; no_claim=the provider's cache itself.
  test("every button sends the same instructions, its own with its Question", async () => {
    const { core, meeting, calls } = await setUp();
    await press(core, meeting, "no");
    const second = calls.length;
    await press(core, meeting, "want");

    expect(calls[second]?.system).toBe(calls[0]?.system);
    expect(calls[0]?.prompt).toContain("Decline what was just asked of the User");
    expect(calls[second]?.prompt).toContain("What does the other side want?");
  });

  test("Answer their question finds the User's Documents ahead for the newest lines, not the transcript, and cites them", async () => {
    const { core, meeting, calls } = await setUp(async (before) => {
      const sources = await createSourceFolder();
      const added = await before.addDocuments([
        await writeSourceFile(
          sources,
          "Price sheet.txt",
          `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}\nThe launch moves to the eighteenth of November for every plan.`,
        ),
      ]);
      await waitForProcessing(
        before,
        added.documents.map((document) => document.id),
      );
    });

    const { answer } = await press(core, meeting, "answer");

    const found = block(calls[0]?.prompt ?? "", "found-in-documents");
    expect(found).toContain("Price sheet");
    expect(found).not.toContain("Transcript");
    expect(calls[0]?.tools).toContain("search_documents");
    expect(answer.citations).toEqual([
      expect.objectContaining({ documentName: "Price sheet", quote: PRICE, check: "found" }),
    ]);
  });

  // protects=a button pressed while the live text is behind and has no line yet is answered with one plain line saying so, in the User's language, without asking the model; fails_when=the model is asked and may tell the User to retype what was said; no_claim=the panel's drawing of it (the smoke test) (#1366).
  test("with the live text behind and no line yet, a button's reply says so in the User's language, and the model isn't asked", async () => {
    const { core, meeting, calls, lines } = await behindSetUp();
    expect(lines).toBe(0);

    const english = await press(core, meeting, "answer");
    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = await press(core, meeting, "answer");

    expect(calls).toEqual([]);
    expect(english.answer.text).toBe(
      "The live text is behind, so none of the call is written yet. It is transcribed after the meeting stops.",
    );
    expect(chinese.answer.text).toBe(
      "实时转写跟不上，通话内容还没有转写出来，会议结束后才会转写。",
    );
    expect(english.answer.steps?.textBehind).toBe(true);
    expect(english.answer.citations).toEqual([]);
  });

  // protects=a button pressed while the live text is behind but has lines starts its reply with one line saying so, in the User's language, then the button's form from those lines; fails_when=the lines are left out, the form is replaced, or the line is left to the model; no_claim=what a real model writes after it (#1366).
  test("with the live text behind but some lines, a button's reply starts with a line saying so, then rests on them in its form", async () => {
    const { core, meeting, calls, lines } = await behindSetUp(9);
    expect(lines).toBeGreaterThanOrEqual(4);

    const english = await press(core, meeting, "answer");
    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = await press(core, meeting, "answer");

    const [first] = calls;
    expect(first?.prompt).toContain("<live-transcript>");
    expect(first?.prompt).toContain("Reply in exactly this form");
    expect(first?.prompt).toContain("A line saying so already starts the reply");
    expect(english.answer.text).toMatch(
      /^The live text is behind, so this rests on the lines so far\.\n\n★ /,
    );
    expect(chinese.answer.text).toMatch(/^实时转写跟不上，以下只依据已转写的内容。\n\n★ /);
    expect(english.answer.steps?.textBehind).toBe(true);
  });

  test("a second press goes on in the same conversation, the assistant's when it says so, and a deleted one starts anew", async () => {
    const { core, meeting } = await setUp();
    const first = await press(core, meeting, "say");
    const second = await press(core, meeting, "ask");
    expect(second.result.asked && second.result.conversation.id).toBe(
      first.result.asked && first.result.conversation.id,
    );
    expect(second.latest?.help?.kind).toBe("ask");

    if (first.result.asked) await core.deleteConversation(first.result.conversation.id);
    const third = await press(core, meeting, "sum");
    expect(third.result.asked && third.result.conversation.id).not.toBe(
      first.result.asked && first.result.conversation.id,
    );
    expect(third.latest?.help?.heard).toBeNull();
  });

  test("the template adds its buttons; another template's, or help after Stop, is refused", async () => {
    const { core, meeting } = await setUp();
    await expect(core.askMeetingHelp({ meetingId: meeting.id, kind: "leading" })).rejects.toThrow();

    const set = await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });
    expect(set.helpTemplate).toBe("interview");
    const { messages, latest } = await press(core, meeting, "leading");
    expect(messages.at(-2)).toMatchObject({ kind: "question", text: "Am I leading them?" });
    expect(latest?.help?.heard?.speaker).toBe("Me");
    await expect(
      core.askMeetingHelp({ meetingId: meeting.id, kind: "objection" }),
    ).rejects.toThrow();

    await core.stopMeeting(meeting.id);
    const stopped = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(stopped?.help).toBeNull();
    expect(stopped?.helpTemplate).toBeNull();
    await expect(core.askMeetingHelp({ meetingId: meeting.id, kind: "say" })).rejects.toThrow();
  });

  test("help is written without the model thinking first, an ordinary Question with it", async () => {
    const { core, meeting, specs } = await setUp(async (before) => {
      const saved = await before.saveChatProvider({
        kind: "anthropic",
        modelId: "claude-haiku-5-5",
        apiKey: "sk-test",
      });
      if (saved.service) await before.allowDataFlow("chat", saved.service.id);
    });
    await press(core, meeting, "say");
    expect(specs.at(-1)?.thinking).toBe("off");
    const asked = await core.askInConversation({ mindId: meeting.mindId, text: "Who joined?" });
    if (asked.asked) await answerEnded(core, asked.answerId);
    expect(specs.at(-1)?.thinking).toBe("answer");
  });

  test("help answers in the call's language, whatever the interface's: Sum up, What to ask next and Check what was said", async () => {
    const { core, meeting, calls } = await setUp(undefined, {
      lines: ["我们先看一下报价。", "团队版每个席位每月二十五美元。"],
      theirLines: ["企业版能便宜一点吗？", "四十个席位一共多少钱？"],
    });
    for (const kind of ["sum", "ask", "check"] as const) {
      await press(core, meeting, kind);
      expect(calls.at(-1)?.prompt).toContain(
        '- The call is in Chinese: write all of it in Chinese, the "→" lines too',
      );
      expect(calls.at(-1)?.system).not.toContain("The Question is written in English");
      expect(calls.at(-1)?.prompt).toContain("企业版");
    }
    await core.updateSettings({ user: { language: "zh-CN" } });
    const { messages } = await press(core, meeting, "ask");
    expect(messages.at(-2)).toMatchObject({ kind: "question", text: "接下来问什么" });
  });

  test("the help Question is asked with the model in use in the Meeting's Mind: its own pick, else the last pick, else the Answers default", async () => {
    const { core, meeting } = await setUp();
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
      keepDefault: true,
    });
    const claude = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
      keepDefault: true,
    });
    for (const provider of [openai, claude]) {
      if (provider.service) await core.allowDataFlow("chat", provider.service.id);
    }
    const answers = (await core.getSettings()).user.chatModel;
    const last = { providerId: claude.id, modelId: "claude-haiku-5-5" };
    const own = { providerId: openai.id, modelId: "gpt-6-luna" };
    const writtenBy = async () => (await press(core, meeting, "no")).answer.model;

    expect(await writtenBy()).toEqual(answers);

    await core.updateSettings({ device: { lastChatModel: last } });
    expect(await writtenBy()).toEqual(last);

    const client = await connectToMind(core, meeting.mindId);
    setMindModel(client.doc, own);
    await client.settled();
    expect(await writtenBy()).toEqual(own);
  });

  test("the buttons' and Call help's shortcuts are kept per device, and only keys with ⌘, ⌃ or ⌥ are taken", async () => {
    const { core } = await setUp();
    const saved = await core.updateSettings({
      device: { meetingHelpKeys: { say: "Ctrl+Alt+9", panel: "Ctrl+Alt+J" } },
    });
    expect(saved.device.meetingHelpKeys).toEqual({ say: "Ctrl+Alt+9", panel: "Ctrl+Alt+J" });
    expect(saved.device.meetingPanel).toBe(true);
    expect(saved.device.meetingPanelHidden).toBe(true);
    await expect(
      core.updateSettings({ device: { meetingHelpKeys: { say: "Shift+A" } } }),
    ).rejects.toThrow();
    await expect(
      core.updateSettings({ device: { meetingHelpKeys: { leading: "Ctrl+Alt+1" } } } as never),
    ).rejects.toThrow();
  });
});
