/**
 * The line above an Answer that wrote cited text into a Note (#2768), through the core as the
 * assistant asks and in the app's own words, English and Chinese: it names the sources the Note's
 * text cites, after a search, while a meeting records and when the write was stopped halfway; and a
 * request that names its two Documents gets no "I read … · Use others" about a third.
 */
import { describe, expect, test, vi } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { foldedLine, type StepsInput, stepRows } from "../../src/renderer/src/answerSteps";
import { foldedWords, mindCallText } from "../../src/renderer/src/answerStepWords";
import { translate } from "../../src/shared/i18n";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { shownWithChanges } from "../helpers/minds";
import {
  judgesNothing,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

const WALKS = {
  en: {
    question:
      "Write a detailed summary of the Field Report and the Quarterly Research Update into this note, with a section for each.",
    asked: [
      {
        file: "Field Report - Northern Estuary.md",
        text: "# Field Report: Northern Estuary\n\nThe spring survey read twelve tide gauges along the northern estuary.\n",
        quote: "The spring survey read twelve tide gauges along the northern estuary.",
      },
      {
        file: "Quarterly Research Update.md",
        text: "# Quarterly Research Update\n\nThe tide model now covers the harbour mouth and the upper reach.\n",
        quote: "The tide model now covers the harbour mouth and the upper reach.",
      },
    ],
    // Found by the search, and named only by "report", a word of the Field Report's name.
    found: {
      file: "Harlow Basin Annual Report 2022.md",
      text: "# Harlow Basin Annual Report 2022\n\nThe basin authority approved the spring survey of its tide gauges.\n",
    },
    // Another "report" no search finds: what "Use others" would have offered.
    other: {
      file: "Ferry Timetable Report.md",
      text: "# Ferry timetable\n\nFerries leave the north pier every forty minutes.\n",
    },
    fillers: [
      ["Parking rota.md", "Spaces in the basement are given out monthly."],
      ["Travel claims.md", "Staff fill in a form before they travel."],
      ["Purchasing steps.md", "A head of department approves each purchase."],
      ["Appraisal guide.md", "Appraisals happen twice a year in four bands."],
      ["Client list.md", "Eastern clients: Hollin, Marrow and Sedge."],
      ["Office supplies.md", "Paper, pens, folders and staplers."],
      ["Staff handbook contents.md", "Attendance, leave, learning and leaving."],
      ["Induction plan.md", "New starters spend two days in induction."],
      ["Expense ledger.md", "June's office costs came to thirty-two thousand."],
      ["Visitor log.md", "Visitors sign in at the front desk."],
      ["Fire drill.md", "The alarm is tested every Thursday at noon."],
    ],
    query: "spring survey tide gauges model",
    content:
      "## Field Report\n\nThe spring survey read twelve tide gauges [^1].\n\n## Quarterly Research Update\n\nThe tide model now covers the harbour mouth [^2].",
    secondHeading: "## Quarterly",
    reply: "I added a section for each to this Note.",
    lines: {
      written: "Searched All Documents · 2 sources",
      meeting: "Listened to the live transcript · 2 sources",
      stopped: "Searched All Documents · 1 source",
      stoppedRow: "Edited “Estuary” · 2 changes",
    },
    used: "2 used",
  },
  "zh-CN": {
    question: "在这个笔记里为现场报告和季度研究更新各写一节详细摘要。",
    asked: [
      {
        file: "现场报告（北部河口）.md",
        text: "# 现场报告（北部河口）\n\n春季调查读取了北部河口的十二个潮位站。\n",
        quote: "春季调查读取了北部河口的十二个潮位站。",
      },
      {
        file: "季度研究更新.md",
        text: "# 季度研究更新\n\n潮汐模型现在覆盖港口入口和上游河段。\n",
        quote: "潮汐模型现在覆盖港口入口和上游河段。",
      },
    ],
    found: {
      file: "哈洛盆地2022年度报告.md",
      text: "# 哈洛盆地2022年度报告\n\n盆地管理局批准了潮位站的春季调查。\n",
    },
    other: { file: "渡轮时刻报告.md", text: "# 渡轮时刻\n\n渡轮每四十分钟从北码头出发。\n" },
    fillers: [
      ["停车位安排.md", "地下车位按月分配。"],
      ["差旅报销制度.md", "员工出差前需填写申请单。"],
      ["采购流程.md", "采购申请由部门负责人审批。"],
      ["绩效考核说明.md", "考核每半年一次，结果分为四档。"],
      ["客户名单.md", "华东区客户：恒远、启明、南岭。"],
      ["办公用品清单.md", "打印纸、签字笔、文件夹与订书机。"],
      ["员工手册目录.md", "考勤、假期、培训与离职四章。"],
      ["培训计划.md", "新员工入职培训为期两天。"],
      ["费用台账.md", "六月办公费用合计三万二千元。"],
      ["访客登记.md", "访客需在前台登记并领取临时证件。"],
      ["消防演练.md", "每周四中午测试一次警报。"],
    ],
    query: "春季调查 潮位站 潮汐模型",
    content:
      "## 现场报告\n\n春季调查读取了十二个潮位站[^1]。\n\n## 季度研究更新\n\n潮汐模型现在覆盖港口入口[^2]。",
    secondHeading: "## 季度",
    reply: "我在这个笔记里为两份文件各写了一节。",
    lines: {
      written: "已搜索全部文档 · 2 个来源",
      meeting: "已听实时转写 · 2 个来源",
      stopped: "已搜索全部文档 · 1 个来源",
      stoppedRow: "修改了“Estuary” · 2 处修订",
    },
    used: "用了 2 段",
  },
} as const;

type Walk = (typeof WALKS)[keyof typeof WALKS];

/**
 * A model that searches, cites a sentence of each Document asked about, then writes a section of
 * each into the Note in focus, its input streamed: held before the second section when `hold`
 * says, so the write can be stopped there.
 */
function writingModel(walk: Walk, hold?: Promise<void>) {
  return scriptedModel(
    (call): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: walk.query } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const shown = shownPassages(search.text);
        const citations = walk.asked.map(({ quote }, at) => {
          const passage = shown.find((each) => each.text.includes(quote));
          if (!passage) throw new Error(`The search didn't find “${quote}”.`);
          return { marker: at + 1, passage: passage.id, quote };
        });
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind")) {
        const input = { content: walk.content };
        // Into the second heading: the first section's paragraph is whole, so it is in the Note.
        const after = JSON.stringify(input).indexOf(walk.secondHeading) + walk.secondHeading.length;
        return {
          calls: [{ tool: "add_to_mind", input, streamInput: true }],
          ...(hold && { pause: { after, until: hold } }),
        };
      }
      return { text: walk.reply };
    },
    { generate: judgesNothing },
  );
}

async function addLibrary(core: Core, walk: Walk) {
  const folder = await createSourceFolder();
  const files = [
    ...walk.asked,
    walk.found,
    walk.other,
    ...walk.fillers.map(([file, text]) => ({
      file,
      text: `# ${file.replace(/\.md$/, "")}\n\n${text}\n`,
    })),
  ];
  await addAndProcess(
    core,
    await Promise.all(files.map(({ file, text }) => writeSourceFile(folder, file, text))),
    30_000,
  );
}

/** The Answer's line and its search's row, worded as the assistant words them. */
function wording(answer: ConversationAnswer, mindId: string, language: keyof typeof WALKS) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const steps: StepsInput = {
    answer,
    askedFrom: { mindId, name: "", deleted: false },
    meeting: answer.steps?.sent?.transcript === true,
  };
  const line = foldedLine(steps);
  if (!line) throw new Error("The Answer has no line.");
  const search = stepRows(steps).find((row) => row.kind === "search");
  return {
    line: foldedWords(t, line, {
      scope: () => t("steps.scope.all"),
      modelOf: (id) => id,
      documentOf: (document) => document.name,
    }),
    found:
      search?.kind === "search"
        ? t("steps.search.found", { found: search.found, used: search.used })
        : null,
  };
}

for (const language of ["en", "zh-CN"] as const) {
  const walk = WALKS[language];

  describe(`the line above a write into a Note (${language})`, { timeout: 60_000 }, () => {
    /** The request's write, asked from an empty Note in a Library of `walk`'s Documents. */
    const written = async () => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(writingModel(walk)).createChatModel,
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await addLibrary(core, walk);
      const mind = await core.createMind({ title: "Estuary" });
      const answer = await askAssistant(core, { text: walk.question, mindId: mind.id });
      expect(answer.text).toBe(walk.reply);
      expect(answer.citations).toEqual([]);
      return { answer, mindId: mind.id };
    };

    // protects=a write whose reply cites nothing, with Citations in the Note, names those sources on its line and counts them used by its search; fails_when=the line says "no sentence matched them" or "no sources", or the search says "0 used"; no_claim=what a real model writes, which tests/live/writtenSourcesLine.live.test.ts checks.
    test("a cited write names its sources", async () => {
      const { answer, mindId } = await written();

      const words = wording(answer, mindId, language);
      expect(words.line).toBe(walk.lines.written);
      expect(words.found).toContain(walk.used);
    });

    // protects=a request naming its two Documents, both cited in the Note, gets no "I read … · Use others" about a third Document its search found that a word of one name ("report") fits; fails_when="I read “Harlow Basin Annual Report 2022”; 1 other Document matches" shows; no_claim=a name that fits two Documents, which tests/core/coverage.test.ts holds.
    test("a request naming two Documents names no third", async () => {
      const { answer } = await written();

      expect(answer.steps?.coverage).toBeUndefined();
    });

    // protects=a write asked while the Note's meeting records names the sources its Note text cites beside "Listened to the live transcript"; fails_when=it says "no sources" over the cited write; no_claim=what the transcript says.
    test("a cited write during a meeting names its sources", async () => {
      const { core, record } = await transcribingCore(await createTempDataFolder(), {
        model: writingModel(walk),
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await addLibrary(core, walk);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(9 * SECOND, ["microphone"]);
      await until(core, meeting.id, (transcript) => transcript.lines >= 2);

      const answer = await askAssistant(core, { text: walk.question, mindId: meeting.mindId });

      expect(answer.steps?.sent?.transcript).toBe(true);
      const words = wording(answer, meeting.mindId, language);
      expect(words.line).toBe(walk.lines.meeting);
      expect(words.found).toContain(walk.used);
    });

    // protects=a write stopped halfway keeps what it wrote, its line names the source that text cites, and its row says what it changed; fails_when=the stopped write's line says "no sentence matched them", or its row "Couldn't change"; no_claim=what Undo does with it.
    test("a write stopped halfway names the source of what it wrote", async () => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(writingModel(walk, new Promise(() => undefined)))
          .createChatModel,
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await addLibrary(core, walk);
      const mind = await core.createMind({ title: "Estuary" });
      const client = await connectToMind(core, mind.id);

      const asked = await core.askInConversation({ text: walk.question, mindId: mind.id });
      if (!asked.asked) throw new Error("Not asked.");
      await vi.waitFor(() => expect(pendingProposals(client.blocks)).toHaveLength(2), {
        timeout: 20_000,
      });
      await core.stopConversationAnswer({
        conversationId: asked.conversation.id,
        answerId: asked.answerId,
      });
      const { messages } = await core.getConversation(asked.conversation.id);
      const answer = messages.find((message) => message.id === asked.answerId);
      if (answer?.kind !== "answer") throw new Error("No Answer.");

      expect(answer.status).toBe("stopped");
      expect(pendingProposals(client.blocks)).toHaveLength(2);
      expect(wording(answer, mind.id, language).line).toBe(walk.lines.stopped);
      const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
        translate(language, key, params);
      const write = answer.toolCalls.find((call) => call.tool === "add_to_mind");
      if (!write) throw new Error("No write.");
      expect(mindCallText(t, write, "Estuary", language)).toBe(walk.lines.stoppedRow);
    });
  });
}

const LEASES = {
  en: {
    question: "Write a summary of the Harbour lease into this note.",
    first: {
      name: "Harbour lease 2023",
      text: "The deposit was one month's rent.",
      query: "deposit",
    },
    cited: {
      name: "Harbour lease 2024",
      text: "The rent rises by three percent each April.",
      query: "rent rises",
    },
    unread: { name: "Harbour lease 2022", text: "The tenancy ended in March." },
    content: "## Harbour lease\n\nThe rent rises by three percent each April [^1].",
    reply: "I added a summary of the Harbour lease to this Note.",
  },
  "zh-CN": {
    question: "把海港租约的摘要写进这个笔记。",
    first: { name: "海港租约2023", text: "押金为一个月租金。", query: "押金" },
    cited: { name: "海港租约2024", text: "租金每年四月上调百分之三。", query: "租金上调" },
    unread: { name: "海港租约2022", text: "租期于三月结束。" },
    content: "## 海港租约\n\n租金每年四月上调百分之三[^1]。",
    reply: "我把海港租约的摘要加进了这个笔记。",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  const lease = LEASES[language];
  const walk = WALKS[language];

  describe(`the Document a write cites is the one named as read (${language})`, {
    timeout: 60_000,
  }, () => {
    // protects=when a name fits several Documents, "I read X" names the one the Note's text cites, not the first its searches found; fails_when=it names "Harbour lease 2023", whose Passage only came first; no_claim=a request that names its Documents, held above.
    test("“I read” names the Document the Note cites", async () => {
      const model = scriptedModel(
        (call): ScriptedReply => {
          if (isCheckRun(call)) return checkReply(call, {});
          const searches = call.results.filter((result) => result.tool === "search_documents");
          if (searches.length === 0) {
            return { calls: [{ tool: "search_documents", input: { query: lease.first.query } }] };
          }
          if (searches.length === 1) {
            return { calls: [{ tool: "search_documents", input: { query: lease.cited.query } }] };
          }
          if (!call.results.some((result) => result.tool === "cite")) {
            const passage = shownPassages(searches[1]?.text ?? "").find((each) =>
              each.text.includes(lease.cited.text),
            );
            if (!passage) throw new Error(`The search didn't find “${lease.cited.text}”.`);
            const citations = [{ marker: 1, passage: passage.id, quote: lease.cited.text }];
            return { calls: [{ tool: "cite", input: { citations } }] };
          }
          if (!call.results.some((result) => result.tool === "add_to_mind")) {
            return { calls: [{ tool: "add_to_mind", input: { content: lease.content } }] };
          }
          return { text: lease.reply };
        },
        { generate: judgesNothing },
      );
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(model).createChatModel,
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const folder = await createSourceFolder();
      const files = [
        lease.first,
        lease.cited,
        lease.unread,
        ...walk.fillers.map(([file, text]) => ({ name: file.replace(/\.md$/, ""), text })),
      ];
      const added = await addAndProcess(
        core,
        await Promise.all(
          files.map(({ name, text }) =>
            writeSourceFile(folder, `${name}.md`, `# ${name}\n\n${text}\n`),
          ),
        ),
        30_000,
      );
      const idOf = (name: string) => added.find((document) => document.name === name)?.id;
      const mind = await core.createMind({ title: "Leases" });

      const answer = await askAssistant(core, { text: lease.question, mindId: mind.id });

      expect(answer.citations).toEqual([]);
      expect(answer.steps?.coverage).toEqual({
        kind: "named",
        used: [{ id: idOf(lease.cited.name), name: lease.cited.name }],
        rest: [idOf(lease.unread.name)],
      });
    });
  });
}

describe("a streamed write taken back as a second copy, then stopped", { timeout: 60_000 }, () => {
  const RISKS = [
    "## Risks",
    "The supplier of the main part is three weeks late, and nobody has told us why.",
    "The courier who takes the parts to the plant has raised its prices twice this year.",
  ].join("\n\n");

  // protects=a write that streamed in, was taken back as a second copy of the assistant's own waiting text, and was stopped before its call ended claims nothing in the Note: no change on its card, its row says it couldn't change it; fails_when=the call keeps the change it reported before the take-back, so its row reads "Edited “Q3 review”"; no_claim=the copy check itself, which tests/core/assistantTurns.test.ts holds.
  test("claims nothing it took back", async () => {
    const content = `${RISKS}\n\nThe courier is late too.`;
    const after = JSON.stringify({ content }).indexOf("The courier is late too") + 3;
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (call.results.some((each) => each.tool === "add_to_mind")) return { text: "Done." };
        const more = call.prompt.includes("write more about the risks");
        return {
          calls: [
            { tool: "add_to_mind", input: { content: more ? content : RISKS }, streamInput: true },
          ],
          ...(more && { pause: { after, until: new Promise<void>(() => undefined) } }),
        };
      },
      { generate: judgesNothing },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Q3 review" });
    const client = await connectToMind(core, mind.id);
    const first = await askAssistant(core, { text: "add a risks section", mindId: mind.id });
    const risks = () => shownWithChanges(client).filter((line) => line === "+ Risks").length;
    let most = 0;
    client.blocks.observeDeep(() => {
      most = Math.max(most, risks());
    });

    const asked = await core.askInConversation({
      text: "write more about the risks",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    if (!asked.asked) throw new Error("Not asked.");
    await vi.waitFor(() => expect([most, risks()]).toEqual([2, 1]), { timeout: 20_000 });
    await core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");

    const write = answer.toolCalls.find((call) => call.tool === "add_to_mind");
    expect(write?.status).toBe("failed");
    expect(write?.mindChange).toBeUndefined();
    const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    expect(write && mindCallText(en, write, "Q3 review", "en")).toBe("Couldn’t change “Q3 review”");
  });
});
