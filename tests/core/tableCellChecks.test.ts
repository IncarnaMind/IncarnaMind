import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * A table's cell is checked as a User reads it (#1459): said with its row's label and its
 * column's heading, beside the line before the table, its headings and the cell's row, in the
 * check after the assistant writes a table, a check of selected cells and Check this Mind. The
 * model's verdicts are scripted by the claim each check is sent, so a cell sent alone ("100")
 * gets none and lands unsupported; tests/live/tableCellChecks.live.test.ts asks real models.
 */

interface Budget {
  language: "en" | "zh-CN";
  file: { name: string; contents: string };
  caption: string;
  headings: [string, string, string];
  rows: { label: string; quote: string; values: [string, string] }[];
  /** Each cell as its check is sent it, and how the scripted model judges it. */
  plans: Record<string, Plan>;
  /** The wrong cell's words. */
  wrong: string;
}

const supported = (quote: string): Plan => ({ verdict: "supported", quote, says: "It says so." });
const contradicted = (quote: string): Plan => ({
  verdict: "contradicted",
  quote,
  says: "It gives another figure.",
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
      [`Revenue — 2024: 100${INLINE_NODE}`]: supported(EN_REVENUE),
      [`Revenue — 2025: 210${INLINE_NODE}`]: contradicted(EN_REVENUE),
      [`Profit — 2024: 30${INLINE_NODE}`]: supported(EN_PROFIT),
      [`Profit — 2025: 42${INLINE_NODE}`]: supported(EN_PROFIT),
    },
    wrong: "210",
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
      [`收入 — 2024年: 100${INLINE_NODE}`]: supported(ZH_REVENUE),
      [`收入 — 2025年: 210${INLINE_NODE}`]: contradicted(ZH_REVENUE),
      [`利润 — 2024年: 30${INLINE_NODE}`]: supported(ZH_PROFIT),
      [`利润 — 2025年: 42${INLINE_NODE}`]: supported(ZH_PROFIT),
    },
    wrong: "210",
  },
];

/** What a cell's check is told of its table: the line before it, its headings, and its row with the other values left out. */
const tableOf = (budget: Budget, row: string) =>
  ["<table>", budget.caption, budget.headings.join(" | "), row, "</table>"].join("\n");

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
  judged: GenerateCall[],
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
    {
      generate: (call) => {
        judged.push(call);
        return checkGenerate(plans)(call);
      },
    },
  );
}

async function budgetMind(budget: Budget, model: ReturnType<typeof scriptedModel>) {
  const dataDir = await createTempDataFolder();
  const adapters = { createChatModel: scriptedModels(model).createChatModel };
  const core = startCore(dataDir, adapters);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
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

const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  ...(value && { content: [{ type: "text", text: value }] }),
});

const cell = (type: "tableHeader" | "tableCell", value: string): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(value)],
});

/** The budget's caption and table as the User has them, each value followed by `unit`. */
function budgetTable(budget: Budget, unit = ""): JSONContent[] {
  return [
    paragraph(budget.caption),
    {
      type: "table",
      content: [
        { type: "tableRow", content: budget.headings.map((each) => cell("tableHeader", each)) },
        ...budget.rows.map((row) => ({
          type: "tableRow",
          content: [
            cell("tableCell", row.label),
            ...row.values.map((value) => cell("tableCell", `${value}${unit}`)),
          ],
        })),
      ],
    },
  ];
}

/** The plans keyed by the cells as a check reads them without Citations, each value followed by `unit`. */
const plansOf = (budget: Budget, unit = "") =>
  Object.fromEntries(
    Object.entries(budget.plans).map(([claim, plan]) => [claim.replace(INLINE_NODE, unit), plan]),
  );

describe("A table the assistant writes is checked cell by cell, each with its row and column", () => {
  // protects=each cited cell of a written table is checked as "row — column: value" beside the table's caption, headings and its row without the other values, also when a contradiction is confirmed, so right cells land Supported and a wrong one Contradicted (#1459); fails_when=a cell is sent alone, the table isn't sent, or the confirmation judges it without the table; no_claim=how well a real model judges it (tests/live/tableCellChecks.live.test.ts).
  test.each(BUDGETS)(
    "$language: right cells land Supported and the wrong one Contradicted",
    async (budget) => {
      const checks: ModelCall[] = [];
      const judged: GenerateCall[] = [];
      const { core, client, mindId, folderId, reopen } = await budgetMind(
        budget,
        writingModel(budget, checks, judged),
      );
      writeMind(client, [paragraph(budget.language === "en" ? "Budget notes." : "预算要点。")]);
      await client.settled();

      const answer = await askAssistant(core, {
        text: "Add a table of the budget",
        mindId,
        scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
      });
      await client.settled();

      const sent = checks.filter((call) => call.results.length === 0);
      expect(sent.map(sentenceOf)).toEqual(Object.keys(budget.plans));
      const [first] = budget.rows;
      const wrongRow = `${first?.label} | … | ${budget.wrong}`;
      const wrong = sent.find((call) => sentenceOf(call).includes(budget.wrong));
      expect(promptOf(wrong)).toContain(tableOf(budget, wrongRow));
      // The right cell beside the wrong one is never shown it: Claude Haiku 5.5 then called it Contradicted.
      const beside = sent.find((call) => sentenceOf(call).includes("100"));
      expect(promptOf(beside)).toContain(tableOf(budget, `${first?.label} | 100 | …`));
      expect(promptOf(beside)).not.toContain(budget.wrong);
      const confirmed = judged.filter((call) => call.system.startsWith("Compare a sentence"));
      expect(confirmed.length).toBeGreaterThan(0);
      for (const call of confirmed) expect(call.prompt).toContain(tableOf(budget, wrongRow));
      expect(marksIn(client)).toEqual([[budget.wrong, "contradicted"]]);
      expect(changesIn(answer)[0]?.selfCheck).toMatchObject({ cited: 4, sent: 4, checked: 4 });
      await resolveChanges(client, "accept");
      expect(marksIn(client)).toEqual([[budget.wrong, "contradicted"]]);
      expect(marksIn(await reopen())).toEqual([[budget.wrong, "contradicted"]]);
    },
  );
});

describe("A written table's cell its Citations don't support", () => {
  // protects=a cell found unsupported, with the part its Citations cover named, lands marked as it was written, never cut or rewritten; fails_when=the cell's words change or Edit with AI is asked to cut it; no_claim=none beyond protects.
  test("lands marked, its words as written", async () => {
    const budget = BUDGETS[0] as Budget;
    const plans = {
      ...budget.plans,
      [`Profit — 2025: 42${INLINE_NODE}`]: {
        reply: {
          text: "Verdict: unsupported\nThe budget gives 42 for profit in 2025 without saying it was audited.\nCovered: profit in 2025\nNot covered: the audit",
        },
      },
    };
    const checks: ModelCall[] = [];
    const { core, client, mindId, folderId } = await budgetMind(
      budget,
      writingModel(budget, checks, [], plans),
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
    expect(marksIn(client)).toEqual([
      [budget.wrong, "contradicted"],
      ["42", "unsupported"],
    ]);
  });
});

describe("Checking a User's own table reads each cell with its row and column", () => {
  async function ownTable(budget: Budget, unit: string) {
    const plans = plansOf(budget, unit);
    const checks: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        checks.push(call);
        return checkReply(call, plans);
      },
      { generate: checkGenerate(plans) },
    );
    const setup = await budgetMind(budget, model);
    const blocks = budgetTable(budget, unit);
    writeMind(setup.client, blocks);
    await setup.client.settled();
    return { ...setup, blocks, checks };
  }

  // protects=a check of selected cells sends each as "row — column: value" with its table, and marks each cell with its own result; fails_when=a cell is sent alone and lands unsupported, or the wrong cell isn't contradicted; no_claim=none beyond protects.
  test("selected cells, in Chinese", async () => {
    const budget = BUDGETS[1] as Budget;
    const { core, client, mindId, blocks } = await ownTable(budget, "");
    const idOf = (row: number, column: number) => {
      const inCell = blocks[1]?.content?.[row]?.content?.[column]?.content?.[0];
      return String(inCell?.attrs?.id);
    };

    expect(
      await core.checkSentences({
        requestId: randomUUID(),
        mindId,
        action: "check-against-documents",
        from: { blockId: idOf(1, 1), offset: 0 },
        to: { blockId: idOf(1, 2), offset: 3 },
        more: [
          { from: { blockId: idOf(2, 1), offset: 0 }, to: { blockId: idOf(2, 2), offset: 2 } },
        ],
      }),
    ).toMatchObject({ kind: "checked", sentences: 4, checked: 4 });

    expect(marksIn(client)).toEqual([
      ["100", "supported"],
      ["210", "contradicted"],
      ["30", "supported"],
      ["42", "supported"],
    ]);
  });

  // protects=Check this Mind names and checks a table's cells as "row — column: value" with their table, and leaves the caption and labels; fails_when=a cell is sent alone or without its table; no_claim=which cells a real model names as claims.
  test("Check this Mind, in English", async () => {
    const budget = BUDGETS[0] as Budget;
    const unit = " thousand tonnes";
    const { core, client, mindId, checks } = await ownTable(budget, unit);

    expect(await core.checkMind({ requestId: randomUUID(), mindId, mode: "all" })).toMatchObject({
      kind: "checked",
      sentences: 4,
      checked: 4,
    });

    expect(marksIn(client)).toEqual([
      [`100${unit}`, "supported"],
      [`210${unit}`, "contradicted"],
      [`30${unit}`, "supported"],
      [`42${unit}`, "supported"],
    ]);
    const wrong = checks.find(
      (call) => call.results.length === 0 && sentenceOf(call).includes("210"),
    );
    expect(sentenceOf(wrong as ModelCall)).toBe(`Revenue — 2025: 210${unit}`);
    expect(promptOf(wrong)).toContain(tableOf(budget, `Revenue | … | 210${unit}`));
  });
});
