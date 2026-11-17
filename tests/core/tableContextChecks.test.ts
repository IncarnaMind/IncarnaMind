import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { pendingProposals } from "../../src/shared/proposals";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { xlsxOf } from "../helpers/office";

/**
 * A table's cell is checked as a User reads it (#1459): the check after the assistant writes a
 * table reads each cell as Check this Mind does, with its column's heading, its row and the line
 * before the table, and gives each cell its own result; a sentence's check reads the Passage
 * its Citation quotes, headings and all. The model is scripted by the sentence each check is sent;
 * tests/live/tableCellChecks.live.test.ts and tests/live/summaryRowCheck.live.test.ts ask real
 * models.
 */

interface Budget {
  language: "en" | "zh-CN";
  file: { name: string; contents: string };
  caption: string;
  headings: [string, string, string];
  rows: { label: string; quote: string; values: [string, string] }[];
  /** Each cell as its check is sent it, and how the scripted model judges it. */
  plans: Record<string, Plan>;
}

const plan = (verdict: "supported" | "contradicted", quote: string): Plan => ({
  verdict,
  quote,
  says: verdict === "supported" ? "It says so." : "It gives another figure.",
  judgement: "conflict",
});

const EN_REVENUE = "Revenue\t100\t120\tthousand tonnes";
const EN_PROFIT = "Profit\t30\t42\tthousand tonnes";
const ZH_REVENUE = "收入\t100\t120\t万元";
const ZH_PROFIT = "利润\t30\t42\t万元";

const BUDGETS: Budget[] = [
  {
    language: "en",
    file: {
      name: "Budget.csv",
      contents: `Item,2024,2025,Unit\n${EN_REVENUE.replaceAll("\t", ",")}\n${EN_PROFIT.replaceAll("\t", ",")}\n`,
    },
    caption: "Revenue and profit, 2024 against 2025 (thousand tonnes)",
    headings: ["Item", "2024", "2025"],
    rows: [
      { label: "Revenue", quote: EN_REVENUE, values: ["100", "210"] },
      { label: "Profit", quote: EN_PROFIT, values: ["30", "42"] },
    ],
    plans: {
      "100": plan("supported", EN_REVENUE),
      "210": plan("contradicted", EN_REVENUE),
      "30": plan("supported", EN_PROFIT),
      "42": plan("supported", EN_PROFIT),
    },
  },
  {
    language: "zh-CN",
    file: {
      name: "预算表.csv",
      contents: `项目,2024年,2025年,单位\n${ZH_REVENUE.replaceAll("\t", ",")}\n${ZH_PROFIT.replaceAll("\t", ",")}\n`,
    },
    caption: "2024年与2025年收入、利润对比（单位：万元）",
    headings: ["项目", "2024年", "2025年"],
    rows: [
      { label: "收入", quote: ZH_REVENUE, values: ["100", "210"] },
      { label: "利润", quote: ZH_PROFIT, values: ["30", "42"] },
    ],
    plans: {
      "100": plan("supported", ZH_REVENUE),
      "210": plan("contradicted", ZH_REVENUE),
      "30": plan("supported", ZH_PROFIT),
      "42": plan("supported", ZH_PROFIT),
    },
  },
];

/** How a written table's cells land: each with its check's mark, Supported included (#1909). */
const LANDED = [
  ["100", "supported"],
  ["210", "contradicted"],
  ["30", "supported"],
  ["42", "supported"],
];

const promptOf = (call: ModelCall | undefined) =>
  (call?.options.prompt ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

const markdownOf = (budget: Budget) =>
  [
    budget.caption,
    "",
    `| ${budget.headings.join(" | ")} |`,
    "|---|---|---|",
    ...budget.rows.map(
      (row, index) =>
        `| ${row.label} | ${row.values.map((value) => `${value}[^${index + 1}]`).join(" | ")} |`,
    ),
  ].join("\n");

/** Searches, cites each row, writes the table into the Mind in focus, and checks as the plans say. */
function writingModel(
  budget: Budget,
  checks: ModelCall[],
  plans: Record<string, Plan> = budget.plans,
) {
  return scriptedModel(
    (call): ScriptedReply => {
      if (isCheckRun(call)) {
        checks.push(call);
        return checkReply(call, plans);
      }
      // Asked to cut a cell, Claude Sonnet 5.5 wrote its reasons into it.
      if (call.prompt.includes('<task action="cut-unsupported">')) {
        checks.push(call);
        return { text: "The source gives no such figure [1].\n<why>Cut.</why>" };
      }
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return {
          calls: [
            {
              tool: "search_documents",
              input: { query: budget.rows.map((row) => row.label).join(" ") },
            },
          ],
        };
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const citations = budget.rows.map((row, index) => ({
          marker: index + 1,
          passage: passage?.id,
          quote: row.quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind")) {
        return { calls: [{ tool: "add_to_mind", input: { content: markdownOf(budget) } }] };
      }
      return { text: "Added the table." };
    },
    { generate: checkGenerate(plans) },
  );
}

async function budgetMind(budget: Budget, model: ReturnType<typeof scriptedModel>) {
  const dataDir = await createTempDataFolder();
  const adapters = { createChatModel: scriptedModels(model).createChatModel };
  const core = startCore(dataDir, adapters);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.updateSettings({ user: { checkAssistantWrites: true } });
  await core.updateSettings({ user: { language: budget.language } });
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, budget.file.name, budget.file.contents),
  ]);
  const folder = await core.createLibraryGroup({ name: "Budget", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const mind = await core.createMind({ title: "Budget notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  /** Quits the app and opens the Mind again on the same data. */
  const reopen = async () => {
    core.close();
    return connectToMind(startCore(dataDir, adapters), mind.id);
  };
  return { core, client, mindId: mind.id, folderId: folder.id, reopen };
}

/** Each check's mark in the Mind, by its cell's words. */
const marksIn = (client: MindClient) =>
  claimSpans(readMind(client)).map((span) => [
    span.sentence.text.replaceAll(INLINE_NODE, "").trim(),
    span.check.state,
  ]);

describe("A table the assistant writes is checked cell by cell, each with its row and column", () => {
  // protects=the check after a write reads each cited cell as Check this Mind does: its column's heading, its row and the line before the table go to the check with the cell, and each cell lands with its own result, through accepting, Undo, Redo and reopening (#1459); fails_when=a cell is sent alone, as "100" with "100" for its paragraph, or a mark goes; no_claim=how well a real model judges it (tests/live/tableCellChecks.live.test.ts).
  test.each(BUDGETS)(
    "$language: right cells land Supported and the wrong one Contradicted",
    async (budget) => {
      const checks: ModelCall[] = [];
      const { core, client, mindId, folderId, reopen } = await budgetMind(
        budget,
        writingModel(budget, checks),
      );
      writeMind(client, [
        {
          type: "paragraph",
          content: [{ type: "text", text: budget.language === "en" ? "Notes." : "要点。" }],
        },
      ]);
      await client.settled();

      const answer = await askAssistant(core, {
        text: "Add a table of the budget",
        mindId,
        scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
      });
      await client.settled();

      const sent = checks.filter((call) => call.results.length === 0);
      expect(sent.map(sentenceOf)).toEqual(budget.rows.flatMap((row) => row.values));
      const [first] = budget.rows;
      const cell = sent.find((call) => sentenceOf(call).startsWith("100"));
      const prompt = promptOf(cell);
      expect(prompt).toContain(budget.headings[1]);
      expect(prompt).toContain(`${first?.label} | 100 | 210`);
      expect(prompt).toContain(budget.caption);
      expect(marksIn(client)).toEqual(LANDED);
      // The caption, with no Citation, makes no claim the sort names: it is left out.
      expect(changesIn(answer)[0]?.selfCheck).toMatchObject({ cited: 4, checked: 4, leftOut: 1 });
      const schedule = await core.getFigureSchedule(mindId);
      expect(schedule.rows.map((row) => [row.reading.chars, row.shown.state])).toEqual(LANDED);
      const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
      await resolveChanges(client, "accept");
      expect(marksIn(client)).toEqual(LANDED);
      undo.undo();
      await client.settled();
      expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
      expect(marksIn(client)).toEqual(LANDED);
      undo.redo();
      await client.settled();
      expect(pendingProposals(client.blocks)).toHaveLength(0);
      expect(marksIn(await reopen())).toEqual(LANDED);
    },
  );

  // protects=a written cell found unsupported lands marked as it was written, never cut or rewritten: a cell's words are its figure, not a clause to take out; fails_when=Edit with AI is asked to cut it, or its words change; no_claim=none beyond protects.
  test("a cell its Citations don't support lands marked, its words as written", async () => {
    const budget = BUDGETS[0] as Budget;
    const plans: Record<string, Plan> = {
      ...budget.plans,
      "42": {
        reply: {
          text: [
            "Verdict: unsupported",
            "Explanation: The budget gives 42 for profit in 2025 without saying it was audited.",
            "Evidence: []",
          ].join("\n"),
        },
      },
    };
    const checks: ModelCall[] = [];
    const { core, client, mindId, folderId } = await budgetMind(
      budget,
      writingModel(budget, checks, plans),
    );

    await askAssistant(core, {
      text: "Add a table of the budget",
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    await client.settled();

    expect(checks.some((call) => call.prompt.includes('<task action="cut-unsupported">'))).toBe(
      false,
    );
    expect(marksIn(client).map(([words]) => words)).toEqual(["100", "210", "30", "42"]);
  });
});

describe("A sentence's check reads the Passage its Citation quotes", () => {
  const WORKBOOK = {
    en: {
      sheet: "2026 by region",
      head: ["Region", "2026 sales (£)"],
      sentence: "North's 2026 sales were £6,496,265",
      query: "2026 by region North",
    },
    "zh-CN": {
      sheet: "2026 年分地区",
      head: ["地区", "2026 年销售额（英镑）"],
      sentence: "北区 2026 年的销售额为 6,496,265 英镑",
      query: "2026 年分地区 北区",
    },
  } as const;

  // protects=a cited row of a summary sheet reaches the check with its sheet's name and heading row, as the Passage it quotes reads, and the check can cite it there without a search finding it first, or being sent back to search (#1459); fails_when=the check sees only the bare row "North 6496265", or only what its own search finds, the month rows; no_claim=how well a real model judges it (tests/live/summaryRowCheck.live.test.ts).
  test.each(["en", "zh-CN"] as const)(
    "%s: a summary row's year and region reach the check",
    async (language) => {
      const words = WORKBOOK[language];
      const months = Array.from({ length: 120 }, (_, index) => [
        `2026-${String((index % 12) + 1).padStart(2, "0")}`,
        language === "en" ? "North" : "北区",
        1000 + index,
      ]);
      const checks: ModelCall[] = [];
      const model = scriptedModel((call): ScriptedReply => {
        if (isCheckRun(call)) {
          checks.push(call);
          return { text: "Verdict: supported" };
        }
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search)
          return { calls: [{ tool: "search_documents", input: { query: words.query } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const quote = `${words.head[0] === "Region" ? "North" : "北区"}\t6496265`;
          const passage = shownPassages(search.text).find((each) => each.text.includes(quote));
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
            ],
          };
        }
        if (!call.results.some((result) => result.tool === "add_to_mind"))
          return { calls: [{ tool: "add_to_mind", input: { content: `${words.sentence}[^1].` } }] };
        return { text: "Done." };
      });
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await core.updateSettings({ user: { checkAssistantWrites: true } });
      await core.updateSettings({ user: { language } });
      const sources = await createTempDataFolder();
      const documents = await addAndProcess(core, [
        await writeSourceFile(
          sources,
          "Sales.xlsx",
          xlsxOf([
            {
              name: language === "en" ? "Sales" : "销售",
              rows: [["Month", "Region", "Sales"], ...months],
            },
            {
              name: words.sheet,
              rows: [[...words.head], [language === "en" ? "North" : "北区", 6496265]],
            },
          ]),
        ),
      ]);
      const folder = await core.createLibraryGroup({ name: "Sales", description: "" });
      await core.moveToFolder({
        documentIds: documents.map((each) => each.id),
        folderId: folder.id,
      });
      const mind = await core.createMind({ title: "Sales", folderId: folder.id });
      const client = await connectToMind(core, mind.id);
      await askAssistant(core, {
        text: "Write North's 2026 sales",
        mindId: mind.id,
        scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      });
      await client.settled();

      const [first] = checks;
      const prompt = promptOf(first);
      expect(prompt).toContain(`location="${words.sheet}`);
      expect(prompt).toContain(words.head.join("\t"));
      expect(prompt).toContain("6496265");
      // The quoted Passage is shown from the scope, so a verdict on it isn't sent back to search.
      expect(checks.some((call) => promptOf(call).includes("without reading any Passage"))).toBe(
        false,
      );
    },
  );

  // protects=a check's search may name the Document a Citation quotes, as an Answer's may, and gets that Document's Passages; fails_when=it is told no Document has that name, as checks were before, and searches all of them; no_claim=none beyond protects.
  test("its search may name the Document the Citation quotes", async () => {
    const budget = BUDGETS[0] as Budget;
    const searched: string[] = [];
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (isCheckRun(call)) {
          const search = call.results.find((result) => result.tool === "search_documents");
          if (!search)
            return {
              calls: [
                { tool: "search_documents", input: { query: "Revenue 2024", document: "Budget" } },
              ],
            };
          searched.push(search.text);
          return { text: "Verdict: supported" };
        }
        return { text: "Noted." };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await budgetMind(budget, model);
    await core.checkClaim({
      claim: "Revenue was 100 in 2024.",
      cited: [{ documentName: "Budget", quote: EN_REVENUE }],
    });
    expect(searched[0]).toContain("<passage");
    expect(searched[0]).not.toContain("No Document to search is called");
  });
});

describe("Check this Mind on the User's own numeric table", () => {
  // protects=a whole-Note check reads an ordinary table the User wrote cell by cell, with its headings: a quantity (3 where the Document gives 2) is checked with its row and column and gets its own result, not left out while the prose is checked (#1459); fails_when=the table's cells get no check, or are counted and left unchecked; no_claim=how well a real model judges it.
  test("checks each numeric cell with its row and column", async () => {
    const rows = [
      ["Item", "Unit mass (kg)", "Quantity"],
      ["Glass beads", 0.075, 2],
      ["Control weights", 0.05, 2],
    ];
    const plans: Record<string, Plan> = {
      "0.075": plan("supported", "Glass beads\t0.075\t2"),
      "3": plan("contradicted", "Glass beads\t0.075\t2"),
      "0.050": plan("supported", "Control weights\t0.05\t2"),
      "2": plan("supported", "Control weights\t0.05\t2"),
    };
    const checks: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        checks.push(call);
        // A Run searches with the words it will quote: a bare cell's own words find nothing.
        const sentence = sentenceOf(call);
        if (isCheckRun(call) && call.results.length === 0)
          return {
            calls: [
              {
                tool: "search_documents",
                input: { query: plans[sentence]?.quote ?? sentence },
              },
            ],
          };
        return checkReply(call, plans);
      },
      { generate: checkGenerate(plans) },
    );
    const budget = { ...(BUDGETS[0] as Budget), file: { name: "unused.csv", contents: "a\n" } };
    const { core, client, mindId, folderId } = await budgetMind(budget, model);
    const sources = await createTempDataFolder();
    const added = await addAndProcess(core, [
      await writeSourceFile(sources, "Worksheet.xlsx", xlsxOf([{ name: "Revision B", rows }])),
    ]);
    await core.moveToFolder({ documentIds: added.map((each) => each.id), folderId });
    const cell = (type: "tableHeader" | "tableCell", text: string): JSONContent => ({
      type,
      attrs: { colspan: 1, rowspan: 1 },
      content: [
        { type: "paragraph", attrs: { id: randomUUID() }, content: [{ type: "text", text }] },
      ],
    });
    const row = (type: "tableHeader" | "tableCell", ...cells: string[]): JSONContent => ({
      type: "tableRow",
      content: cells.map((text) => cell(type, text)),
    });
    writeMind(client, [
      {
        type: "table",
        attrs: { id: randomUUID() },
        content: [
          row("tableHeader", "Current worksheet item", "Unit mass (kg)", "Quantity"),
          row("tableCell", "Glass beads", "0.075", "3"),
          row("tableCell", "Control weights", "0.050", "2"),
        ],
      },
    ]);
    await client.settled();

    await core.checkMind({ requestId: randomUUID(), mindId, mode: "all" });

    const sent = checks.filter((call) => call.results.length === 0).map(sentenceOf);
    expect(sent).toEqual(expect.arrayContaining(["0.075", "3", "0.050", "2"]));
    const wrong = checks.find((call) => call.results.length === 0 && sentenceOf(call) === "3");
    expect(promptOf(wrong)).toContain("Quantity");
    expect(promptOf(wrong)).toContain("Glass beads | 0.075 | 3");
    // Its result lands on the cell as its own.
    const landed = claimSpans(readMind(client)).find((span) => span.sentence.text === "3");
    expect(landed?.check.state).toBe("contradicted");
  });
});
