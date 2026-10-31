import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  COVERED_AT_ONCE,
  coverageOf,
  documentsAsked,
  namedCoverage,
} from "../../src/core/answers/coverage";
import { passagesIn, recordFor, recordsFor } from "../../src/main/fakeChat/passages";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

describe("What a Question asks of the Documents in scope", () => {
  // protects=a summary of the set, in English and Chinese, asks about each Document; fails_when=one reads as an ordinary Question; no_claim=every wording.
  test.each([
    "Write a summary page of these documents",
    "Summarise these papers",
    "summarise all the files",
    "Give me an overview of the 14 reports",
    "总结这些文档",
    "把这几篇论文概括一下",
    "写一份所有文件的摘要",
    "I mean write a summary about these 2 papers",
    "Write a summary page on these documents",
    "写一份关于这些文档的总结",
  ])("%s asks about each", (question) => {
    expect(documentsAsked(question)).toEqual({ each: true, main: null });
  });

  // protects=Questions about a topic, or one Document, don't; fails_when=one is read as a summary of each, or caps the scope; no_claim=none beyond protects.
  test.each([
    "What do the documents say about leverage?",
    "Overview of what the documents say about leverage",
    "总结这些文档中关于杠杆的内容",
    "Summarise the 10-K",
    "这份文件讲了什么？",
    "Give me an overview of the sources",
    "总结一下这两个",
    "每个都总结一下",
  ])("%s doesn't", (question) => {
    expect(documentsAsked(question).each).toBe(false);
  });

  // protects=a request for the main few names how many; fails_when=the count is lost; no_claim=none beyond protects.
  test.each([
    ["Write a summary about the two main documents", 2],
    ["compare the 3 key papers", 3],
    ["summarise the main document", 1],
    ["总结两份主要文档", 2],
    ["比较最重要的三篇", 3],
  ])("%s asks for the main %i", (question, main) => {
    expect(documentsAsked(question).main).toBe(main);
  });

  // protects=a summary about Documents named by their names is of each of them, not a topic; fails_when=it reads as a topic; no_claim=none beyond protects.
  test("a summary about the Documents by name is of each", () => {
    expect(
      documentsAsked("Write a summary about GraphST and the tutorial, the 2 papers here", () => [
        "GraphST",
      ]).each,
    ).toBe(true);
  });

  // protects=only Document words ask for the main few; fails_when=a Question about something else cuts the search to a few Documents; no_claim=none beyond protects.
  test.each([
    "What are the two main sources of revenue?",
    "Summarise the 2 main ones",
    "List the three key articles of the treaty",
  ])("%s asks for no main few", (question) => {
    expect(documentsAsked(question).main).toBeNull();
  });

  const sized = (count: number) =>
    Array.from({ length: count }, (_, at) => ({
      id: `d${at}`,
      name: `Doc ${at}`,
      size: 100 - at,
    }));

  // protects=a summary of more than a few covers the largest and keeps the rest's ids; the main few are the largest; fewer covers all; fails_when=it covers all of 14, picks other than the largest, or caps 8; no_claim=none beyond protects.
  test("covers the largest of many, the main few, or all", () => {
    const many = coverageOf({ each: true, main: null }, sized(14));
    expect(many?.kind).toBe("largest");
    expect(many?.used.map((each) => each.id)).toEqual(
      sized(COVERED_AT_ONCE).map((each) => each.id),
    );
    expect(many?.rest).toEqual(["d8", "d9", "d10", "d11", "d12", "d13"]);
    expect(coverageOf({ each: false, main: 2 }, sized(8))).toEqual({
      kind: "main",
      used: [
        { id: "d0", name: "Doc 0" },
        { id: "d1", name: "Doc 1" },
      ],
      rest: ["d2", "d3", "d4", "d5", "d6", "d7"],
    });
    expect(coverageOf({ each: true, main: null }, sized(COVERED_AT_ONCE))).toBeNull();
    expect(coverageOf({ each: false, main: 2 }, sized(2))).toBeNull();
  });
});

describe("A summary of many Documents, through the core", { timeout: 60_000 }, () => {
  async function withDocuments(count: number) {
    const folder = await mkdtemp(join(tmpdir(), "coverage-"));
    const paths = await Promise.all(
      Array.from({ length: count }, async (_, at) => {
        const path = join(folder, `Report ${at + 1}.md`);
        const body = Array.from(
          { length: (count - at) * 4 },
          (_, line) => `Report ${at + 1}, finding ${line + 1}: the tide rose ${line} cm.`,
        ).join("\n\n");
        await writeFile(path, `# Report ${at + 1}\n\n${body}\n`);
        return path;
      }),
    );
    const calls: { system: string; results: string[] }[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      calls.push({ system: call.system, results: call.results.map((each) => each.text) });
      if (call.prompt.includes("search Report 3 only") && call.results.length === 0) {
        return {
          calls: [{ tool: "search_documents", input: { query: "tide", document: "Report 3" } }],
        };
      }
      return { text: "Covered." };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const group = await core.createLibraryGroup({ name: "Reports", description: "" });
    const added = await core.addDocuments(paths, { groupId: group.id });
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
      30_000,
    );
    const mind = await core.createMind({ title: "Notes", folderId: group.id });
    const scope = { folderIds: [group.id], tagIds: [], documentIds: [] };
    return { core, mind, scope, calls };
  }

  // protects=a summary of 10 Documents covers the 8 largest, tells the model which, records the 2 others to offer, and has the reply name those 2 as left for the next summary, in English and Chinese; fails_when=it covers all, the smaller ones, forgets the rest, or the reply isn't told which are left (#894); no_claim=what the model writes.
  test.each(["Write a summary page of these documents", "总结这些文档"])(
    "%s, of 10, covers the 8 largest and names the 2 others",
    async (text) => {
      const { core, mind, scope, calls } = await withDocuments(10);

      const answer = await askAssistant(core, { text, mindId: mind.id, scope });

      expect(answer.steps?.coverage?.kind).toBe("largest");
      expect(answer.steps?.coverage?.used.map((each) => each.name)).toEqual(
        Array.from({ length: 8 }, (_, at) => `Report ${at + 1}`),
      );
      expect(answer.steps?.coverage?.rest).toHaveLength(2);
      expect(calls[0]?.system).toContain("This Answer covers the 8 largest of the 10 Documents");
      expect(calls[0]?.system).toContain(
        "say that “Report 9” and “Report 10” are left for the next summary",
      );
    },
  );

  // protects=past what the next summary covers, the reply is told the 8 it takes and how many come after, not every name; fails_when=it is told none, or all 12 of the rest; no_claim=what the model writes.
  test("of 20 names the 8 the next summary takes and counts the 4 after", async () => {
    const { core, mind, scope, calls } = await withDocuments(20);

    const answer = await askAssistant(core, {
      text: "Write a summary page of these documents",
      mindId: mind.id,
      scope,
    });

    expect(answer.steps?.coverage?.rest).toHaveLength(12);
    const system = calls[0]?.system ?? "";
    expect(system).toContain("This Answer covers the 8 largest of the 20 Documents");
    expect(system).toContain("the next summary takes “Report 9”,");
    expect(system).toContain("and “Report 16”, and 4 more come after those");
    expect(system).not.toContain("“Report 17”");
  });

  // protects=a Question about a topic across many Documents searches them all, with no cap; fails_when=it covers only the largest 8; no_claim=what the model writes.
  test("“what the documents say about” a topic searches all 10", async () => {
    const { core, mind, scope, calls } = await withDocuments(10);

    const answer = await askAssistant(core, {
      text: "Overview of what the documents say about leverage",
      mindId: mind.id,
      scope,
    });

    expect(answer.steps?.coverage).toBeUndefined();
    expect(calls[0]?.system).not.toContain("This Answer covers the 8 largest");
  });

  // protects=the two main Documents are the two largest, named to the model, with the rest kept to offer; fails_when=the model is asked to choose, or the rest is lost; no_claim=none beyond protects.
  test("“the two main documents” are the two largest", async () => {
    const { core, mind, scope, calls } = await withDocuments(4);

    const answer = await askAssistant(core, {
      text: "Write a summary about the two main documents",
      mindId: mind.id,
      scope,
    });

    expect(answer.steps?.coverage).toMatchObject({
      kind: "main",
      used: [{ name: "Report 1" }, { name: "Report 2" }],
    });
    expect(answer.steps?.coverage?.rest).toHaveLength(2);
    expect(calls[0]?.system).toContain("IncarnaMind took “Report 1” and “Report 2”");
  });

  // protects=search_documents with a Document's name searches only that one, so a summary can reach each; fails_when=another Document's Passages come back; no_claim=none beyond protects.
  test("a search can name one Document", async () => {
    const { core, mind, scope, calls } = await withDocuments(4);

    await askAssistant(core, { text: "search Report 3 only", mindId: mind.id, scope });

    const found = calls.at(-1)?.results.at(-1) ?? "";
    const named = [...found.matchAll(/document="([^"]+)"/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set(["Report 3"]));
  });
});

describe("A name in the Question that fits several Documents (#1512)", () => {
  const contract = { id: "contract", name: "劳动合同-王芳" };
  const minutes = { id: "minutes", name: "会议纪要（2026年第三季度）" };
  const sync = {
    id: "sync",
    name: "people-policy-sync-2026-10-14",
    title: "人事政策同步会 会议纪要",
  };
  const zh = [contract, minutes, sync];
  const en = [
    { id: "contract", name: "Employment contract - Wang Fang" },
    { id: "minutes", name: "Meeting minutes (Q3 2026)" },
    {
      id: "sync",
      name: "people-policy-sync-2026-10-14",
      title: "People policy sync: meeting minutes",
    },
  ];

  // protects=the Document read by a name that another Document's title has too is named, with that other; fails_when=the other is missed, the contract counts, or a title isn't read; no_claim=which Document the model should have read.
  test("names the one it read and the other it fits, in Chinese and English", () => {
    expect(
      namedCoverage(
        "劳动合同-王芳的年假是几天？会议纪要里说的对吗？",
        ["contract", "minutes"],
        ["contract", "minutes"],
        zh,
      ),
    ).toEqual({
      kind: "named",
      used: [{ id: "minutes", name: "会议纪要（2026年第三季度）" }],
      rest: ["sync"],
    });
    expect(
      namedCoverage(
        "How many days of annual leave does Wang Fang's contract give? Is what the meeting minutes say right?",
        ["contract", "minutes"],
        ["contract", "minutes"],
        en,
      ),
    ).toEqual({
      kind: "named",
      used: [{ id: "minutes", name: "Meeting minutes (Q3 2026)" }],
      rest: ["sync"],
    });
  });

  // protects=a Document read by a machine-made file name is named by its title, as the User sees it; fails_when=the line shows "people-policy-sync-2026-10-14"; no_claim=none beyond protects.
  test("names one with a machine-made name by its title", () => {
    expect(namedCoverage("会议纪要里说的对吗？", ["sync"], ["sync"], zh)).toEqual({
      kind: "named",
      used: [{ id: "sync", name: "人事政策同步会 会议纪要" }],
      rest: ["minutes"],
    });
  });

  // protects=the Document the Answer cited is the one named, and one it only searched by name is not offered; fails_when=a Document it never used is named or offered; no_claim=which Document the model should have read.
  test("names the Document it used, not one it only searched by name", () => {
    const question = "劳动合同-王芳的年假是几天？会议纪要里说的对吗？";
    expect(namedCoverage(question, ["contract", "sync"], ["contract", "sync"], zh)).toEqual({
      kind: "named",
      used: [{ id: "sync", name: "人事政策同步会 会议纪要" }],
      rest: ["minutes"],
    });
    expect(namedCoverage(question, ["sync"], ["sync", "minutes"], zh)).toBeNull();
  });

  // protects=a name that fits only the Document read, or Documents all read, says nothing; fails_when=a line shows for a plain name; no_claim=none beyond protects.
  test("says nothing when the name fits only what it read", () => {
    const question = "劳动合同-王芳的年假是几天？会议纪要里说的对吗？";
    expect(namedCoverage(question, ["contract"], ["contract"], zh)).toBeNull();
    expect(namedCoverage(question, ["minutes", "sync"], ["minutes", "sync"], zh)).toBeNull();
    expect(namedCoverage(question, [], [], zh)).toBeNull();
    expect(
      namedCoverage("What do the Q3 meeting minutes say?", ["minutes"], ["minutes"], en),
    ).toBeNull();
    const contracts = [
      { id: "alder", name: "Alder supply contract" },
      { id: "birch", name: "Birch supply contract" },
    ];
    expect(
      namedCoverage("What notice does the Alder contract give?", ["alder"], ["alder"], contracts),
    ).toBeNull();
  });

  // protects=words that name no one Document (a number, "the document", "这个文件") make no line; fails_when=every Document with 2026 or "document" in its name is offered; no_claim=none beyond protects.
  test("a number, or a word for any Document, names none", () => {
    const plans = [
      { id: "plan", name: "Plan 2026" },
      { id: "budget", name: "Budget 2026" },
    ];
    expect(namedCoverage("What does the 2026 one say?", ["plan"], ["plan"], plans)).toBeNull();
    const documents = [
      { id: "design", name: "Design document" },
      { id: "spec", name: "Requirements document" },
    ];
    expect(namedCoverage("Summarise this document", ["design"], ["design"], documents)).toBeNull();
    const files = [
      { id: "design", name: "设计文件" },
      { id: "spec", name: "需求文件" },
    ];
    expect(namedCoverage("总结这个文件", ["design"], ["design"], files)).toBeNull();
  });

  // protects=a name that several Documents share offers all those it didn't read; fails_when=only one is counted, or one the name doesn't fit is; no_claim=none beyond protects.
  test("offers every other Document the name fits", () => {
    const contracts = [
      { id: "wang", name: "劳动合同-王芳" },
      { id: "li", name: "劳动合同-李雷" },
      { id: "zhao", name: "劳动合同-赵敏" },
      { id: "lease", name: "租赁合同" },
    ];
    expect(namedCoverage("劳动合同里年假是几天？", ["wang"], ["wang"], contracts)?.rest).toEqual([
      "li",
      "zhao",
    ]);
  });
});

describe("A name that fits two Documents, through the core (#1512)", { timeout: 60_000 }, () => {
  // Eleven unrelated Documents, past the twelve the assistant sends whole, so the Answer searches.
  const fillers: [string, string][] = [
    ["停车位安排.md", "# 停车位安排\n\n地下车位按月分配。\n"],
    ["差旅报销制度.md", "# 差旅报销制度\n\n员工出差前需填写申请单。\n"],
    ["采购流程.md", "# 采购流程\n\n采购申请由部门负责人审批。\n"],
    ["绩效考核说明.md", "# 绩效考核说明\n\n考核每半年一次，结果分为四档。\n"],
    ["客户名单.md", "# 客户名单\n\n华东区客户：恒远、启明、南岭。\n"],
    ["项目周报.md", "# 项目周报\n\n本周完成数据迁移与接口联调。\n"],
    ["办公用品清单.md", "# 办公用品清单\n\n打印纸、签字笔、文件夹与订书机。\n"],
    ["员工手册目录.md", "# 员工手册目录\n\n考勤、假期、培训与离职四章。\n"],
    ["培训计划.md", "# 培训计划\n\n新员工入职培训为期两天。\n"],
    ["费用台账.md", "# 费用台账\n\n六月办公费用合计三万二千元。\n"],
    ["访客登记.md", "# 访客登记\n\n访客需在前台登记并领取临时证件。\n"],
  ];

  // protects=an Answer that searched one Document by a name another's title has too records which it read and the other, as stored; fails_when=nothing is recorded, or the contract it also read is offered; no_claim=what the model writes.
  test("records the Document it read by name and the other the name fits", async () => {
    const folder = await mkdtemp(join(tmpdir(), "named-"));
    const files: [string, string][] = [
      ...fillers,
      ["劳动合同-王芳.md", "# 劳动合同-王芳\n\n第五条 乙方每年享有带薪年假 10 天。\n"],
      [
        "会议纪要（2026年第三季度）.md",
        "# 会议纪要（2026年第三季度）\n\n本季度讨论了办公室搬迁和年假安排。\n",
      ],
      ["people-policy-sync-2026-10-14.md", "# 人事政策同步会 会议纪要\n\n王芳的年假为 15 天。\n"],
    ];
    const paths = await Promise.all(
      files.map(async ([name = "", text = ""]) => {
        const path = join(folder, name);
        await writeFile(path, text);
        return path;
      }),
    );
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length > 0) return { text: "会议纪要里没有写王芳的年假。" };
      return {
        calls: ["劳动合同-王芳", "会议纪要（2026年第三季度）"].map((document) => ({
          tool: "search_documents",
          input: { query: "王芳 年假", document },
        })),
      };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const added = await core.addDocuments(paths);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
      30_000,
    );
    const idOf = (name: string) => added.documents.find((each) => each.name === name)?.id;

    const answer = await askAssistant(core, {
      text: "劳动合同-王芳的年假是几天？会议纪要里说的对吗？",
    });

    expect(answer.steps?.coverage).toEqual({
      kind: "named",
      used: [{ id: idOf("会议纪要（2026年第三季度）"), name: "会议纪要（2026年第三季度）" }],
      rest: [idOf("people-policy-sync-2026-10-14")],
    });
  });

  // protects=an Answer that searched without a name and cited one of two Documents a name fits names the one it cited, and offers the other it never read; fails_when=it names nothing, or offers the Document it read; no_claim=what the model writes.
  test("records the Document it cited after a search that named none", async () => {
    const folder = await mkdtemp(join(tmpdir(), "named-"));
    const files: [string, string][] = [
      ...fillers,
      ["劳动合同-王芳.md", "# 劳动合同-王芳\n\n第五条 乙方每年享有带薪年假 10 天。\n"],
      [
        "会议纪要（2026年第三季度）.md",
        "# 会议纪要（2026年第三季度）\n\n本季度讨论了办公室搬迁。\n",
      ],
      ["people-policy-sync-2026-10-14.md", "# 人事政策同步会 会议纪要\n\n王芳的年假为 15 天。\n"],
    ];
    const paths = await Promise.all(
      files.map(async ([name = "", text = ""]) => {
        const path = join(folder, name);
        await writeFile(path, text);
        return path;
      }),
    );
    const question = "会议纪要里说王芳的年假是几天？";
    let citing = false;
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "人事政策 同步" } }] };
      }
      const results = call.results.map((result) => result.text).join("\n");
      const records = recordsFor(results, question);
      if (!citing && records.length > 0) {
        citing = true;
        return { calls: [{ tool: "cite", input: { citations: records } }] };
      }
      return { text: "会议纪要里写道“王芳的年假为 15 天。”[^1]。" };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const added = await core.addDocuments(paths);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
      30_000,
    );
    const idOf = (name: string) => added.documents.find((each) => each.name === name)?.id;

    const answer = await askAssistant(core, { text: question });

    expect(answer.steps?.coverage).toEqual({
      kind: "named",
      used: [{ id: idOf("people-policy-sync-2026-10-14"), name: "人事政策同步会 会议纪要" }],
      rest: [idOf("会议纪要（2026年第三季度）")],
    });
  });

  const minuteLibrary = async (folder: string) => {
    const files: [string, string][] = [
      ...fillers,
      ["会议纪要（2026年第三季度）.md", "# 会议纪要（2026年第三季度）\n\n王芳的年假为 10 天。\n"],
      ["会议纪要（2026年第二季度）.md", "# 会议纪要（2026年第二季度）\n\n王芳的年假为 12 天。\n"],
      [
        "会议纪要（2026年第一季度）.md",
        "# 会议纪要（2026年第一季度）\n\n本季度讨论了办公室搬迁。\n",
      ],
    ];
    return Promise.all(
      files.map(async ([name, text]) => {
        const path = join(folder, name);
        await writeFile(path, text);
        return path;
      }),
    );
  };

  // protects=a marker cited again for another Document leaves the replaced Document out of the line; fails_when=the line names the Document the final Citation no longer points to; no_claim=which Document the model should have cited.
  test("names the Document the final Citation points to after a marker is replaced", async () => {
    const folder = await mkdtemp(join(tmpdir(), "named-"));
    const paths = await minuteLibrary(folder);
    const question = "会议纪要里说王芳的年假是几天？";
    let found: ReturnType<typeof passagesIn> = [];
    let phase = 0;
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "年假" } }] };
      }
      const results = call.results.map((result) => result.text).join("\n");
      if (phase === 0) {
        phase = 1;
        found = passagesIn(results);
        const record = (at: number) => {
          const passage = found[at];
          return passage ? (recordFor(passage, question, 1)?.record ?? null) : null;
        };
        const first = record(0);
        const second = record(1);
        if (!first || !second) throw new Error("The search found fewer than two Passages.");
        return {
          calls: [
            { tool: "cite", input: { citations: [first] } },
            { tool: "cite", input: { citations: [second] } },
          ],
        };
      }
      if (phase === 1) {
        phase = 2;
        const taken = found[1] && recordFor(found[1], question, 1);
        return { text: `会议纪要写道“${String(taken?.record.quote ?? "")}”[^1]。` };
      }
      return { text: "会议纪要里没有写王芳的年假。" };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const added = await core.addDocuments(paths);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
      30_000,
    );
    const idOf = (name: string) => added.documents.find((each) => each.name === name)?.id;

    const answer = await askAssistant(core, { text: question });

    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(answer.steps?.coverage).toEqual({
      kind: "named",
      used: [{ id: idOf(found[1]?.document ?? ""), name: found[1]?.document }],
      rest: [idOf("会议纪要（2026年第一季度）")],
    });
  });

  // protects=a record the text never uses leaves no Document in the line; fails_when=the line names a Document cited only by an unused record; no_claim=which Document the model should have cited.
  test("leaves out a Document cited only by a record the text doesn't use", async () => {
    const folder = await mkdtemp(join(tmpdir(), "named-"));
    const paths = await minuteLibrary(folder);
    const question = "会议纪要里说王芳的年假是几天？";
    let found: ReturnType<typeof passagesIn> = [];
    let phase = 0;
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "年假" } }] };
      }
      const results = call.results.map((result) => result.text).join("\n");
      if (phase === 0) {
        phase = 1;
        found = passagesIn(results);
        const first = found[0] && recordFor(found[0], question, 1)?.record;
        const second = found[1] && recordFor(found[1], question, 2)?.record;
        if (!first || !second) throw new Error("The search found fewer than two Passages.");
        return { calls: [{ tool: "cite", input: { citations: [first, second] } }] };
      }
      if (phase === 1) {
        phase = 2;
        const taken = found[1] && recordFor(found[1], question, 2);
        return { text: `会议纪要写道“${String(taken?.record.quote ?? "")}”[^2]。` };
      }
      return { text: "会议纪要里没有写王芳的年假。" };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const added = await core.addDocuments(paths);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
      30_000,
    );
    const idOf = (name: string) => added.documents.find((each) => each.name === name)?.id;

    const answer = await askAssistant(core, { text: question });

    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(answer.steps?.coverage).toEqual({
      kind: "named",
      used: [{ id: idOf(found[1]?.document ?? ""), name: found[1]?.document }],
      rest: [idOf("会议纪要（2026年第一季度）")],
    });
  });
});
