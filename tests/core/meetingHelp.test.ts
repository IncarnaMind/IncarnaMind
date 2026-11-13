/**
 * One-click help during a call, through the core's public interface as the floating
 * panel and the assistant ask: a button's Question goes with the live transcript, the shape its
 * Answer takes and what the User's Documents say about the newest lines, found ahead; the
 * Meeting names its latest help, the line it answers and the conversation it went to; the
 * template adds its buttons.
 */
import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingHelpKind } from "../../src/core";
import { helpOwnLines, meetingHelpInstructions } from "../../src/core/answers/meetingHelp";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import { setMindModel } from "../../src/shared/mindModel";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { type ModelCall, scriptedModel, scriptedModels, unscripted } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

/**
 * A model that answers in the help shape, citing the first Passage found ahead if it has one, and
 * judges its sentences supported by what they cite (#2847).
 */
function helpingModel(calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
      if (found && !call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: found.id, quote: PRICE }] },
            },
          ],
        };
      }
      return {
        text: found
          ? "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send the price sheet\n→ buys time"
          : "★ Let me confirm by Friday\n→ keeps it moving\n\nWhat matters most to you?\n→ learns their priority",
      };
    },
    { judgesItsAnswers: true },
  );
}

/**
 * A model that writes its whole reply and records its Citation in the same turn, as Claude Haiku
 * 5.5 does: to the first Passage found ahead, or for a button that reads only the call, to its
 * newest line. Every part the core asks whether it is the model's working (#2371) is judged so,
 * and kept in `judged`.
 */
const writesBesideCite = (reply: string, judged: string[][]) => (calls: ModelCall[]) =>
  scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
      const heard = shownPassages(block(call.prompt, "live-transcript") ?? "").at(-1);
      const record = found
        ? { marker: 1, passage: found.id, quote: PRICE }
        : heard && {
            marker: 1,
            passage: heard.id,
            quote: (heard.text.split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]\s*/, ""),
          };
      if (!record || call.results.some((result) => result.tool === "cite")) return { text: "" };
      return { text: reply, calls: [{ tool: "cite", input: { citations: [record] } }] };
    },
    {
      judgesItsAnswers: true,
      generate: (call) => {
        if (call.question !== "working-text") return unscripted(call.question, call.system);
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
  helpFormJudged?: () => boolean,
) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(answering(calls));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: said,
    ...(helpFormJudged && { helpFormJudged }),
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

/** Asks a question typed in the panel's field (#2925), as `press` presses a button. */
async function ask(core: Core, meeting: Meeting, text: string) {
  const result = await core.askMeetingQuestion({ meetingId: meeting.id, text });
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
      question: null,
      conversationId: result.asked && result.conversation.id,
      answerId: result.asked && result.answerId,
      heard: { text: expect.any(String), speaker: "Them" },
      atMs: expect.any(Number),
    });
    expect(latest?.helps).toEqual([latest?.help]);
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

  // protects=only a help reply's own lines (an option's or reading's sentence through its "→" line, a short line, the lead-in of Am I leading them?) are never judged as the model's working, so none the User saw is taken back; notes and remarks before, between and after them, a numbered plan among them, are still judged and taken back, in English and Chinese; fails_when=an own line is taken back, or notes, a remark or a plan stay and show as advice; no_claim=how a real model's judgement decides (#2778).
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
      name: "notes between two options, in English",
      kind: "answer" as const,
      reply:
        "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nLet me double-check the price sheet before the second option.\n\nI'll send you the price sheet today [^1]\n→ buys time",
      kept: "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll send you the price sheet today [^1]\n→ buys time",
      judged: [["Let me double-check the price sheet before the second option."]],
    },
    {
      name: "notes between two options, in Chinese",
      kind: "answer" as const,
      reply:
        "★ 是的，企业版每个席位每月 45 美元 [^1]\n→ 直接回答\n\n我先再核对一下价格表，再写第二个选项。\n\n我今天就把价格表发给你 [^1]\n→ 争取时间",
      kept: "★ 是的，企业版每个席位每月 45 美元 [^1]\n→ 直接回答\n\n我今天就把价格表发给你 [^1]\n→ 争取时间",
      judged: [["我先再核对一下价格表，再写第二个选项。"]],
    },
    {
      name: "options with no star, the first uncited, in English",
      kind: "answer" as const,
      reply:
        "We can start the pilot on Monday\n→ shows speed\n\nYes, Enterprise is $45 a seat [^1]\n→ answers at once",
      kept: "We can start the pilot on Monday\n→ shows speed\n\nYes, Enterprise is $45 a seat [^1]\n→ answers at once",
      judged: [],
    },
    {
      name: "options with no star, the first uncited, in Chinese",
      kind: "answer" as const,
      reply:
        "我们周一就能开始试用\n→ 显出速度\n\n是的，企业版每个席位每月 45 美元 [^1]\n→ 直接回答",
      kept: "我们周一就能开始试用\n→ 显出速度\n\n是的，企业版每个席位每月 45 美元 [^1]\n→ 直接回答",
      judged: [],
    },
    {
      name: "Am I leading them? with notes before its lead-in, in English",
      kind: "leading" as const,
      reply:
        "The User's newest question asks whether the price is too high, which suggests an answer.\n\nA little: it suggests the answer.\n★ How do you think about the price? [^1]\n→ hears their view",
      kept: "A little: it suggests the answer.\n★ How do you think about the price? [^1]\n→ hears their view",
      judged: [
        [
          "The User's newest question asks whether the price is too high, which suggests an answer.",
        ],
      ],
    },
    {
      name: "Am I leading them? with notes before its lead-in, in Chinese",
      kind: "leading" as const,
      reply:
        "用户最新的问题在问价格是不是太高，这暗示了答案。\n\n有一点：它暗示了答案。\n★ 你怎么看这个价格？ [^1]\n→ 听听对方的看法",
      kept: "有一点：它暗示了答案。\n★ 你怎么看这个价格？ [^1]\n→ 听听对方的看法",
      judged: [["用户最新的问题在问价格是不是太高，这暗示了答案。"]],
    },
    {
      name: "short lines",
      kind: "facts" as const,
      reply:
        "- Enterprise is $45 a seat a month [^1]\n- Single sign-on comes with it\n- The Team plan is $25 a seat",
      kept: "- Enterprise is $45 a seat a month [^1]\n- Single sign-on comes with it\n- The Team plan is $25 a seat",
      judged: [],
    },
    {
      name: "notes between short lines, in English",
      kind: "facts" as const,
      reply:
        "- Enterprise is $45 a seat a month [^1]\n\nLet me check the SSO terms before the next line.\n\n- Single sign-on comes with it [^1]",
      kept: "- Enterprise is $45 a seat a month [^1]\n\n- Single sign-on comes with it [^1]",
      judged: [["Let me check the SSO terms before the next line."]],
    },
    {
      name: "notes between short lines, in Chinese",
      kind: "facts" as const,
      reply:
        "- 企业版每个席位每月 45 美元 [^1]\n\n我先核对一下单点登录的条款，再写下一行。\n\n- 含单点登录 [^1]",
      kept: "- 企业版每个席位每月 45 美元 [^1]\n\n- 含单点登录 [^1]",
      judged: [["我先核对一下单点登录的条款，再写下一行。"]],
    },
    {
      name: "a numbered plan before short lines, in English",
      kind: "facts" as const,
      reply:
        "1. Find the prices\n2. Cite the price sheet\n\n- Enterprise is $45 a seat a month [^1]",
      kept: "- Enterprise is $45 a seat a month [^1]",
      judged: [["1. Find the prices\n2. Cite the price sheet"]],
    },
    {
      name: "a numbered plan before short lines, in Chinese",
      kind: "facts" as const,
      reply: "1. 找到价格\n2. 引用价目表\n\n- 企业版每个席位每月 45 美元 [^1]",
      kept: "- 企业版每个席位每月 45 美元 [^1]",
      judged: [["1. 找到价格\n2. 引用价目表"]],
    },
  ])(
    "a reply's own lines are never taken back as the model's working, and nothing else is spared: $name",
    async ({ kind, reply, kept, judged }) => {
      const asked: string[][] = [];
      const { core, meeting } = await setUp(addPriceSheet, {}, writesBesideCite(reply, asked));
      if (kind === "facts")
        await core.setMeetingTemplate({ meetingId: meeting.id, template: "sales" });
      if (kind === "leading")
        await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });

      const { answer } = await press(core, meeting, kind);

      expect(answer.text).toBe(kept);
      expect(asked).toEqual(judged);
      if (kind !== "leading") {
        expect(answer.citations).toEqual([
          expect.objectContaining({ documentName: "Price sheet", quote: PRICE, check: "found" }),
        ]);
      }
    },
  );

  // protects=the evaluation's switch to main's rule judges a reply's own lines as before #2778, so a paired run compares the two rules and nothing else; fails_when=the switch leaves the form unjudged; no_claim=which rule is right (#2778).
  test("with the form judged as before, its last → line is asked about and taken back", async () => {
    const asked: string[][] = [];
    const reply = "★ 是的，企业版每个席位每月 45 美元，含单点登录 [^1]\n→ 直接回答，推进通话";
    const { core, meeting } = await setUp(
      addPriceSheet,
      {},
      writesBesideCite(reply, asked),
      () => true,
    );

    const { answer } = await press(core, meeting, "answer");

    expect(asked).toEqual([["→ 直接回答，推进通话"]]);
    expect(answer.text).toBe("★ 是的，企业版每个席位每月 45 美元，含单点登录 [^1]");
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

  test("a question typed in the panel goes on in the help's conversation, reading the turns before it, the live transcript and what the Documents say about it; the Meeting lists it after the button, with its time (#2925)", async () => {
    const { core, meeting, calls } = await setUp(addPriceSheet);
    const button = await press(core, meeting, "say");
    const before = calls.length;

    const typed = await ask(core, meeting, "  How much is Enterprise per seat?  ");

    const sent = calls[before];
    expect(sent?.prompt).toContain("typed a question about it");
    expect(sent?.prompt).not.toContain("pressed a button for help");
    expect(sent?.prompt).toContain("<live-transcript>");
    expect(sent?.prompt).toContain("What should I say?");
    expect(block(sent?.prompt ?? "", "found-in-documents")).toContain(PRICE);
    expect(sent?.tools).toEqual(expect.arrayContaining(["search_documents", "cite"]));
    expect(sent?.tools).not.toContain("add_to_mind");
    expect(typed.result.asked && typed.result.conversation.id).toBe(
      button.result.asked && button.result.conversation.id,
    );
    expect(typed.messages.at(-2)).toMatchObject({
      kind: "question",
      text: "How much is Enterprise per seat?",
    });
    expect(typed.answer.citations).toEqual([
      expect.objectContaining({ documentName: "Price sheet", quote: PRICE }),
    ]);
    const helps = typed.latest?.helps ?? [];
    expect(helps.map(({ kind, question }) => [kind, question])).toEqual([
      ["say", null],
      ["question", "How much is Enterprise per seat?"],
    ]);
    expect(helps[1]?.atMs).toBeGreaterThanOrEqual(helps[0]?.atMs ?? Number.POSITIVE_INFINITY);
    expect(typed.latest?.help).toEqual(helps[1]);
    expect(helps[1]?.heard).toBeNull();
  });

  test("a typed question written again is still the call's: Try again keeps its form, while the same words asked in the assistant or from the Note are an ordinary Question (#2925)", async () => {
    const { core, meeting, calls } = await setUp(addPriceSheet);
    const words = "How much is Enterprise per seat?";
    const typed = await ask(core, meeting, words);
    if (!typed.result.asked) throw new Error("Not asked.");
    const before = calls.length;
    const again = await core.regenerateConversationAnswer({
      conversationId: typed.result.conversation.id,
      answerId: typed.result.answerId,
    });
    if (again.asked) await answerEnded(core, again.answerId);
    expect(calls[before]?.prompt).toContain("typed a question about it");

    const ordinary = async (conversationId?: string) => {
      const at = calls.length;
      const asked = await core.askInConversation({
        mindId: meeting.mindId,
        text: words,
        ...(conversationId && { conversationId }),
      });
      if (!asked.asked) throw new Error("Not asked.");
      await answerEnded(core, asked.answerId);
      return calls[at]?.prompt ?? "";
    };
    for (const prompt of [await ordinary(typed.result.conversation.id), await ordinary()]) {
      expect(prompt).toContain(words);
      expect(prompt).not.toContain("typed a question about it");
      expect(prompt).not.toContain("pressed a button for help");
    }
    const latest = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(latest?.helps.map(({ kind }) => kind)).toEqual(["question"]);
  });

  test("a press is the button's, whatever was typed before: its own name typed in the panel first is a typed question, then the press is the button, in English and Chinese (#2925)", async () => {
    const { core, meeting, calls } = await setUp();
    const form = (prompt = "") =>
      prompt.includes("typed a question about it")
        ? "typed"
        : prompt.includes("pressed a button for help")
          ? "button"
          : "ordinary";
    const typedThenPressed = async (name: string) => {
      const typedAt = calls.length;
      await ask(core, meeting, name);
      const pressedAt = calls.length;
      const pressed = await press(core, meeting, "say");
      expect(pressed.messages.at(-2)).toMatchObject({ kind: "question", text: name });
      return [form(calls[typedAt]?.prompt), form(calls[pressedAt]?.prompt)];
    };

    expect(await typedThenPressed("What should I say?")).toEqual(["typed", "button"]);
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await typedThenPressed("我该怎么说？")).toEqual(["typed", "button"]);
    const latest = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(latest?.helps.map(({ kind }) => kind)).toEqual(["question", "say", "question", "say"]);
  });

  // protects=a typed question reads the call's earlier Answers as their words, with no Citation ids, so a marker its reply gives no record is never asked about again by the request to cite again, whose answer the User saw in the run (#2925); and a button pressed after it is sent exactly what the same button was before it; fails_when=the typed question's context shows an earlier Answer's Citation as "[Document · C1]", the request to cite again goes out, or the button's request changes; no_claim=how a real model cites.
  test("a typed question reads the earlier Answers' words without their Citations, so its unrecorded marker isn't asked again, and a button after it is sent what it was before (#2925)", async () => {
    const marking = (calls: ModelCall[]) =>
      scriptedModel(
        (call) => {
          calls.push(call);
          // Typed, it marks its fact and records nothing; pressed, it cites the price sheet.
          if (call.prompt.includes("typed a question about it"))
            return { text: "Enterprise is $45 a seat [^1]" };
          const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
          if (found && !call.results.some((result) => result.tool === "cite")) {
            return {
              calls: [
                {
                  tool: "cite",
                  input: { citations: [{ marker: 1, passage: found.id, quote: PRICE }] },
                },
              ],
            };
          }
          return { text: "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once" };
        },
        {
          judgesItsAnswers: true,
          generate: (call) =>
            call.question === "unmarked-quotes"
              ? { text: JSON.stringify({ citations: [] }) }
              : unscripted(call.question, call.system),
        },
      );
    const { core, meeting, calls } = await setUp(addPriceSheet, {}, marking);
    // A press reads the call's Transcript as indexed when it is pressed, waiting only a moment for
    // that, and the two presses below are compared byte for byte. So one press comes first, and the
    // Transcript then holds every line of the nine seconds recorded, four a side, before them: both
    // read the same call.
    const { documentId } = await until(
      core,
      meeting.id,
      (each) => each.lines >= 8 && each.documentId !== null,
    );
    if (!documentId) throw new Error("No Transcript.");
    await press(core, meeting, "say");
    await vi.waitFor(
      async () => {
        const { pages } = await core.readDocumentText(documentId);
        expect(pages.flatMap((page) => page.text.split("\n"))).toHaveLength(8);
      },
      { timeout: 20_000, interval: 20 },
    );
    const firstAt = calls.length;
    await press(core, meeting, "say");
    const before = calls[firstAt];
    const typedAt = calls.length;
    const typed = await ask(core, meeting, "How much is Enterprise per seat?");
    const sent = calls[typedAt]?.prompt ?? "";
    expect(sent).toContain("typed a question about it");
    expect(sent).toContain("Yes, Enterprise is $45 a seat");
    expect(sent).not.toMatch(/· C\d/);
    expect(sent).not.toContain("[Price sheet");
    expect(calls.slice(typedAt).some((call) => call.prompt.includes("no cite record backs"))).toBe(
      false,
    );
    expect(typed.answer.text).toContain("Enterprise is $45 a seat");

    const pressedAt = calls.length;
    await press(core, meeting, "say");
    const after = calls[pressedAt];
    expect(after?.prompt).not.toContain("How much is Enterprise per seat?");
    expect(after?.prompt).toBe(before?.prompt);
    expect(after?.system).toBe(before?.system);
  });

  // protects=a press and a question asked at once, before either has its conversation, go on in one conversation, the second reading the first, in the order asked (#2925); fails_when=each starts a conversation of its own, or the Meeting lists them out of order; no_claim=how long the second waits.
  test("a press and a question asked at once go on in one conversation, in the order asked (#2925)", async () => {
    const { core, meeting } = await setUp(addPriceSheet);
    const [pressed, typed] = await Promise.all([
      core.askMeetingHelp({ meetingId: meeting.id, kind: "say" }),
      core.askMeetingQuestion({ meetingId: meeting.id, text: "How much is Enterprise per seat?" }),
    ]);
    if (!pressed.asked || !typed.asked) throw new Error("Not asked.");
    await Promise.all([answerEnded(core, pressed.answerId), answerEnded(core, typed.answerId)]);
    expect(typed.conversation.id).toBe(pressed.conversation.id);
    const { messages } = await core.getConversation(pressed.conversation.id);
    expect(messages.filter((each) => each.kind === "question").map((each) => each.text)).toEqual([
      "What should I say?",
      "How much is Enterprise per seat?",
    ]);
    const latest = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(latest?.helps.map(({ kind }) => kind)).toEqual(["say", "question"]);
  });

  // protects=a typed question whose reply starts in another language than the question and the call, which are in one, is asked anew once with the same request, and the reply shown is the new one; a question in another language than its call is never asked anew; fails_when=the reply in the other language stands, the request changes, or a question on a call in another language is asked twice; no_claim=what a real model writes the second time.
  test("a typed reply in another language than its question and call is asked anew once; across languages it isn't (#2925)", async () => {
    const answering = (english: boolean) => (calls: ModelCall[]) =>
      scriptedModel(
        (call) => {
          calls.push(call);
          if (call.json) return { text: JSON.stringify({ citations: [] }) };
          if (!call.prompt.includes("typed a question about it"))
            return { text: "- 我们先看了报价" };
          const typed = calls.filter(
            (each) => !each.json && each.prompt.includes("typed a question about it"),
          ).length;
          return {
            text:
              english || typed === 1
                ? "The Team plan is twenty-five dollars a seat."
                : "团队版每个席位每月二十五美元。",
          };
        },
        { judgesItsAnswers: true },
      );
    const typedCalls = (calls: ModelCall[]) =>
      calls.filter((call) => !call.json && call.prompt.includes("typed a question about it"));

    const chinese = await setUp(
      undefined,
      {
        lines: ["我们先看一下报价。", "团队版每个席位每月二十五美元。"],
        theirLines: ["企业版能便宜一点吗？", "四十个席位一共多少钱？"],
      },
      answering(false),
    );
    const anew = await ask(chinese.core, chinese.meeting, "团队版每个席位多少钱？");
    const asked = typedCalls(chinese.calls);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.prompt).toBe(asked[0]?.prompt);
    expect(anew.answer.text).toBe("团队版每个席位每月二十五美元。");

    const english = await setUp(undefined, {}, answering(true));
    const across = await ask(english.core, english.meeting, "团队版每个席位多少钱？");
    expect(typedCalls(english.calls)).toHaveLength(1);
    expect(across.answer.text).toBe("The Team plan is twenty-five dollars a seat.");
  });

  test("a blank question, or one after Stop, is refused (#2925)", async () => {
    const { core, meeting } = await setUp();
    await expect(core.askMeetingQuestion({ meetingId: meeting.id, text: "  " })).rejects.toThrow(
      "Type a question to ask about the call.",
    );
    await core.stopMeeting(meeting.id);
    await expect(
      core.askMeetingQuestion({ meetingId: meeting.id, text: "Who joined?" }),
    ).rejects.toThrow("That Meeting isn’t being recorded.");
    const stopped = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(stopped?.helps).toEqual([]);
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

  test("the help Question is asked with the model in use in the Meeting's Mind: its own pick, else the Answers default", async () => {
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
    const other = { providerId: claude.id, modelId: "claude-haiku-5-5" };
    const own = { providerId: openai.id, modelId: "gpt-6-luna" };
    const writtenBy = async () => (await press(core, meeting, "no")).answer.model;

    expect(await writtenBy()).toEqual(answers);

    await core.updateSettings({ user: { chatModel: other } });
    expect(await writtenBy()).toEqual(other);

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

// protects=a help reply's own lines, which the core never judges as the model's working, are found however a model marks them ("★" or "⭐", "→" or "->", bold marks, Windows line ends, no star, two options in a paragraph, a star still waiting for its "→" line, the lead-in of "Am I leading them?", short lines), and nothing around them is; fails_when=an own line is missed, or notes, a remark or a numbered plan count as one; no_claim=what the judgement then decides (#2778).
test("a help reply's own lines are found however a model marks them, and nothing around them is", () => {
  const own = (kind: MeetingHelpKind, text: string) =>
    helpOwnLines(kind, text).map(({ from, to }) => text.slice(from, to));
  const notes = "The newest lines ask about the price.";
  const remark = "Citations need to be recorded now.";
  expect(
    own("answer", `${notes}\n\n★ One [^1]\n→ a\n\nLet me check.\n\nTwo\n→ b\n${remark}`),
  ).toEqual(["★ One [^1]\n→ a", "Two\n→ b"]);
  expect(
    own("want", `${notes}\n**⭐ They want a date**\n12:04 “by June” [^1]\n-> ask why`),
  ).toEqual(["**⭐ They want a date**\n12:04 “by June” [^1]\n-> ask why"]);
  expect(own("answer", `${notes}\r\n\r\n★ One [^1]\r\n→ a\r\n\r\n${remark}`)).toEqual([
    "★ One [^1]\r\n→ a\r",
  ]);
  expect(
    own("answer", "We can start on Monday\n→ shows speed\n\n我们可以 [^1]\n→ 直接回答"),
  ).toEqual(["We can start on Monday\n→ shows speed", "我们可以 [^1]\n→ 直接回答"]);
  expect(own("answer", "★ One [^1]\n→ a\nTwo\n→ b")).toEqual(["★ One [^1]\n→ a", "Two\n→ b"]);
  expect(own("answer", "★ One [^1]\n\nTwo\n→ b")).toEqual(["★ One [^1]", "Two\n→ b"]);
  expect(
    own("leading", `${notes}\n\nA little: it suggests the answer.\n★ What happened?\n→ hears`),
  ).toEqual(["A little: it suggests the answer.", "★ What happened?\n→ hears"]);
  expect(own("sum", `${notes}\n- One [^1]\n\nLet me check.\n\n• 两个\n\n1. A step`)).toEqual([
    "- One [^1]",
    "• 两个",
  ]);
  expect(own("answer", notes)).toEqual([]);
  expect(own("sum", "1. Find the prices\n2. Cite them")).toEqual([]);
});

// protects=a typed question's reply keeps its options and short lines as its own, as a button's are, and its sentences are judged as any Answer's are (#2925); fails_when=an option or a short line is judged as working, or a sentence that answers it is never judged; no_claim=what the judgement decides.
test("a typed question's own lines are its options and short lines; a sentence that answers it is judged", () => {
  const own = (text: string) =>
    helpOwnLines("question", text).map(({ from, to }) => text.slice(from, to));
  const notes = "The newest lines ask about the price.";
  expect(own(`${notes}\n\n★ Yes, it's $45 [^1]\n→ answers at once`)).toEqual([
    "★ Yes, it's $45 [^1]\n→ answers at once",
  ]);
  expect(own(`${notes}\n- Team is $25 [^1]\n- 企业版 $45 [^1]`)).toEqual([
    "- Team is $25 [^1]",
    "- 企业版 $45 [^1]",
  ]);
  expect(own("Enterprise is $45 a seat [^1]")).toEqual([]);
});

// protects=a typed question is told how an option is written in the very words a button is, so a change to the options' rule reaches both; its sentences are in the language it was typed in, named, and an option to say in the call's (#2925); fails_when=the question's rule for options drifts from the buttons', the language is left as "the Question's" (which an English request of the app's after it takes over), or the language rule is the button's; no_claim=how a real model follows them.
test("a typed question's instructions give an option's rule word for word as a button's, and its language by name", () => {
  const button = meetingHelpInstructions("say", {
    found: true,
    language: "en",
    callLanguage: "English",
  }).split("\n");
  const asked = (question: string, callLanguage: string | null) =>
    meetingHelpInstructions("question", {
      found: true,
      language: "en",
      callLanguage,
      asked: question,
    }).split("\n");
  const rule = button.filter(
    (line) => line.startsWith("- One or two options") || line.startsWith("- Each option is two"),
  );
  expect(rule).toHaveLength(2);
  const english = asked("What should I say about the price?", "English");
  for (const line of rule) expect(english).toContain(line);
  expect(english).toContain(
    '- Write in English, the language the User typed the Question in. An option to say is in English, the call\'s language, its "→" line too.',
  );
  expect(english).toContain("Single sign-on is included in Enterprise at no extra cost [^1]");
  // A question typed in Chinese in an English call: its sentence's example is Chinese, its options' English.
  const chinese = asked("对方问的价格是多少？", "English");
  expect(chinese).toContain(
    '- Write in Simplified Chinese, the language the User typed the Question in. An option to say is in English, the call\'s language, its "→" line too.',
  );
  expect(chinese).toContain("企业版已包含单点登录，不另收费 [^1]");
  const option = button[button.indexOf("For example:") + 1];
  expect(option).toMatch(/^★ We can't/);
  expect(chinese).toContain(option);
  expect(asked("Who joined?", null)).toContain(
    "- Write in English, the language the User typed the Question in.",
  );
  expect(asked("Who joined?", null).join("\n")).not.toContain("language of the Question");
  expect(asked("Who joined?", null).join("\n")).not.toContain("pressed a button");
});

// protects=a typed question's reply says first that it doesn't know what no source gives, promises nothing in an option, cites each list item by its own words, and says what it found rather than where it looked (#2925); fails_when=one of these rules is missing from a typed question's instructions or reaches a button's; no_claim=how a real model follows them.
test("a typed question is told to open with not knowing, promise nothing, cite each listed item and not say what it didn't find; a button isn't", () => {
  const typed = meetingHelpInstructions("question", {
    found: true,
    language: "en",
    callLanguage: "English",
    asked: "Do we insure linen in transit?",
  });
  expect(typed).toContain(
    "the reply's first words say it isn't known, never a yes or a guess, with no Citation",
  );
  expect(typed).toContain(
    "To a question of what to say, an option then promises nothing: the User says they will check and come back.",
  );
  expect(typed).toContain(
    "Each line cites the words of its own item, never a Citation another line has.",
  );
  expect(typed).toContain(
    "Say what you found; never say where you looked or what you didn't find.",
  );
  expect(typed).not.toContain("write one sentence that says you don't know it");
  const button = meetingHelpInstructions("say", {
    found: true,
    language: "en",
    callLanguage: "English",
  });
  for (const rule of ["isn't known", "promises nothing", "its own item", "what you didn't find"])
    expect(button).not.toContain(rule);
});
