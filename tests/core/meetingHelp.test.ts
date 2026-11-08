/**
 * One-click help during a call, through the core's public interface as the floating
 * panel and the assistant ask: a button's Question goes with the live transcript, the shape its
 * Answer takes and what the User's Documents say about the newest lines, found ahead; the
 * Meeting names its latest help, the line it answers and the conversation it went to; the
 * template adds its buttons.
 */
import { describe, expect, test } from "vitest";
import type { Core, Meeting, MeetingHelpKind } from "../../src/core";
import { helpForm } from "../../src/core/answers/meetingHelp";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import { WORKING_TEXT_INSTRUCTIONS } from "../../src/core/answers/workingText";
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
 * A model that writes its whole reply and records its Citation to the first Passage found ahead
 * in the same turn, as Claude Haiku 5.5 does. Every part the core asks whether it is the model's
 * working (#2371) is judged so, and kept in `judged`.
 */
const writesBesideCite = (reply: string, judged: string[][]) => (calls: ModelCall[]) =>
  scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
      if (!found || call.results.some((result) => result.tool === "cite")) return { text: "" };
      return {
        text: reply,
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: found.id, quote: PRICE }] } },
        ],
      };
    },
    {
      judgesItsAnswers: true,
      generate: (call) => {
        if (call.system !== WORKING_TEXT_INSTRUCTIONS) return { text: "" };
        const parts = [...call.prompt.matchAll(/<reply id="\d+">\n([\s\S]*?)\n<\/reply>/g)].map(
          (match) => match[1] ?? "",
        );
        judged.push(parts);
        return { text: JSON.stringify({ parts: parts.map(() => "working") }) };
      },
    },
  );

/** Adds the price sheet before the meeting records, for the buttons that read the Documents. */
async function addPriceSheet(core: Core) {
  const sources = await createSourceFolder();
  const added = await core.addDocuments([
    await writeSourceFile(
      sources,
      "Price sheet.txt",
      `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}\nThe launch moves to the eighteenth of November for every plan.`,
    ),
  ]);
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
}

/**
 * A meeting recording with lines from both sides; `before`, what to do first (Documents wait while
 * it records); `lines` and `theirLines`, what each side says; `answering`, the model.
 */
async function setUp(
  before?: (core: Core) => Promise<void>,
  said: { lines?: readonly string[]; theirLines?: readonly string[] } = {},
  answering: (calls: ModelCall[]) => ReturnType<typeof scriptedModel> = helpingModel,
) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(answering(calls));
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

  // Button instructions stay with the Question so presses with the same Search scope share the provider's cache (#1634).
  test("buttons with the same source scope send the same instructions, their own with the Question", async () => {
    const { core, meeting, calls } = await setUp();
    await press(core, meeting, "want");
    const second = calls.length;
    await press(core, meeting, "sum");

    expect(calls[second]?.system).toBe(calls[0]?.system);
    expect(calls[0]?.prompt).toContain("What does the other side want?");
    expect(calls[second]?.prompt).toContain("Sum up the call so far");

    const third = calls.length;
    await press(core, meeting, "answer");
    const fourth = calls.length;
    await press(core, meeting, "check");
    expect(calls[fourth]?.system).toBe(calls[third]?.system);
  });

  test("Answer their question finds the User's Documents ahead for the newest lines, not the transcript, and cites them", async () => {
    const { core, meeting, calls } = await setUp(addPriceSheet);

    const { answer } = await press(core, meeting, "answer");

    const found = block(calls[0]?.prompt ?? "", "found-in-documents");
    expect(found).toContain("Price sheet");
    expect(found).not.toContain("Transcript");
    expect(calls[0]?.tools).toContain("search_documents");
    expect(answer.citations).toEqual([
      expect.objectContaining({ documentName: "Price sheet", quote: PRICE, check: "found" }),
    ]);
  });

  // protects=a help reply's own lines, from its first option to its last "→" line or its short lines, are never judged as the model's working and taken back, so the "→" line the User saw stays; notes before them and a remark after them are still judged and taken back; fails_when=a "→" line, a short line or an option is taken back, or the notes or the remark stay; no_claim=how a real model's judgement decides (#2778).
  test.each([
    {
      name: "two options in English, with notes before them and a remark after",
      kind: "answer" as const,
      reply:
        "The newest lines ask about the Enterprise price, and the price sheet has it.\n\n★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send you the price sheet today [^1]\n→ buys time\nCitations need to be recorded now.",
      kept: "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send you the price sheet today [^1]\n→ buys time",
      judged: [
        [
          "The newest lines ask about the Enterprise price, and the price sheet has it.",
          "Citations need to be recorded now.",
        ],
      ],
    },
    {
      name: "one option in Chinese",
      kind: "answer" as const,
      reply: "★ 是的，企业版每个席位每月 45 美元，含单点登录 [^1]\n→ 直接回答，推进通话",
      kept: "★ 是的，企业版每个席位每月 45 美元，含单点登录 [^1]\n→ 直接回答，推进通话",
      judged: [],
    },
    {
      name: "an uncited last option with a remark under it",
      kind: "answer" as const,
      reply:
        "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send you the price sheet today\n→ buys time\nCitations need to be recorded now.",
      kept: "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send you the price sheet today\n→ buys time",
      judged: [["Citations need to be recorded now."]],
    },
    {
      name: "an option with no star",
      kind: "answer" as const,
      reply: "Yes, Enterprise is $45 a seat [^1]\n→ answers at once",
      kept: "Yes, Enterprise is $45 a seat [^1]\n→ answers at once",
      judged: [],
    },
    {
      name: "short lines",
      kind: "facts" as const,
      reply:
        "- Enterprise is $45 a seat a month [^1]\n- Single sign-on comes with it\n- The Team plan is $25 a seat",
      kept: "- Enterprise is $45 a seat a month [^1]\n- Single sign-on comes with it\n- The Team plan is $25 a seat",
      judged: [],
    },
  ])(
    "a reply's own lines are never taken back as the model's working: $name",
    async ({ kind, reply, kept, judged }) => {
      const asked: string[][] = [];
      const { core, meeting } = await setUp(addPriceSheet, {}, writesBesideCite(reply, asked));
      if (kind === "facts")
        await core.setMeetingTemplate({ meetingId: meeting.id, template: "sales" });

      const { answer } = await press(core, meeting, kind);

      expect(answer.text).toBe(kept);
      expect(asked).toEqual(judged);
      expect(answer.citations).toEqual([
        expect.objectContaining({ documentName: "Price sheet", quote: PRICE, check: "found" }),
      ]);
    },
  );

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
    expect(specs.findLast((spec) => spec.thinking === "answer")?.thinking).toBe("answer");
  });

  test("help answers in the call's language, whatever the interface's: Sum up, What to ask next and Check what was said", async () => {
    const { core, meeting, calls } = await setUp(undefined, {
      lines: ["我们先看一下报价。", "团队版每个席位每月二十五美元。"],
      theirLines: ["企业版能便宜一点吗？", "四十个席位一共多少钱？"],
    });
    // The scripted help is in English, over Chinese lines: the request for its Citations follows it.
    const helped = () => calls.findLast((call) => call.system !== CITE_RETRY_INSTRUCTIONS);
    for (const kind of ["sum", "ask", "check"] as const) {
      await press(core, meeting, kind);
      expect(helped()?.prompt).toContain(
        '- The call is in Chinese: write all of it in Chinese, the "→" lines too',
      );
      expect(helped()?.system).not.toContain("The Question is written in English");
      expect(helped()?.prompt).toContain("企业版");
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

// protects=the form a help reply lays out, which the core never judges as the model's working, is found however a model marks it: "★" or "⭐", "→" or "->", bold marks, Windows line ends, no star, the lead-in of "Am I leading them?" and short lines; fails_when=a line of the form falls outside it or notes and a remark fall inside; no_claim=what is judged outside it (#2778).
test("a help reply's form runs from its first option to its last → line, however it is marked", () => {
  const formOf = (kind: MeetingHelpKind, text: string) => {
    const form = helpForm(kind, text);
    return form && text.slice(form.from, form.to);
  };
  const notes = "The newest lines ask about the price.";
  const remark = "Citations need to be recorded now.";
  expect(formOf("answer", `${notes}\n\n★ One [^1]\n→ a\n\nTwo\n→ b\n${remark}`)).toBe(
    "★ One [^1]\n→ a\n\nTwo\n→ b",
  );
  expect(
    formOf("want", `${notes}\n**⭐ They want a date**\n12:04 “by June” [^1]\n-> ask why`),
  ).toBe("**⭐ They want a date**\n12:04 “by June” [^1]\n-> ask why");
  expect(formOf("answer", `${notes}\r\n\r\n★ One [^1]\r\n→ a\r\n\r\n${remark}`)).toBe(
    "★ One [^1]\r\n→ a\r",
  );
  expect(formOf("answer", `${notes}\n\nOne [^1]\n→ a`)).toBe("→ a");
  expect(formOf("leading", "A little: it suggests the answer.\n★ What happened?\n→ hears")).toBe(
    "A little: it suggests the answer.\n★ What happened?\n→ hears",
  );
  expect(formOf("sum", `${notes}\n- One [^1]\n- Two\n\n${remark}`)).toBe("- One [^1]\n- Two");
  expect(formOf("answer", notes)).toBeNull();
  expect(formOf("sum", notes)).toBeNull();
});
