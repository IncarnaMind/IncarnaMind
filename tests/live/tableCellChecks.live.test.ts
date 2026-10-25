/**
 * The check of a table the assistant writes reads each cell with its row and column (#1459):
 * against Claude on the Anthropic key, right cells land Supported and wrong ones Contradicted.
 * The table is the scripted writer's, so its right and wrong cells are known; every check
 * goes to the real model. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is
 * INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by default). INCARNAMIND_LIVE_TABLE_RUNS asks
 * each language that many times, INCARNAMIND_LIVE_TABLE_ONLY ("shapes" or "few") writes fewer
 * cells, and INCARNAMIND_LIVE_REPORT keeps what each cell came to.
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import {
  type ChatModelFactory,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  createAiSdkChatModel,
} from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { askAssistant, changesIn } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_TABLE_RUNS ?? 1);

/** A cell as written, cited by `marker`; `few`: cited also when the run asks for few cells. */
interface Cell {
  text: string;
  right: boolean;
  marker: number;
  few?: boolean;
}

interface Table {
  before: string;
  headings: string[];
  /** Each row's cells: a Cell is cited, a string isn't. */
  rows: (string | Cell)[][];
}

interface Case {
  language: "en" | "zh-CN";
  file: { name: string; contents: string };
  ask: string;
  /** The rows the Citations quote, by marker. */
  quoted: Record<number, string>;
  /** The tables of each write, in order: one write's checks stop at twelve sentences. */
  writes: Table[][];
}

// "shapes" writes only the second set of tables, the shapes of #1966's review; "few", for a
// costlier model, cites only the cells marked `few` there: two right ones, a right figure under the
// wrong year, another row's figure, a wrong unit column and the figure an index column hides.
const ONLY = process.env.INCARNAMIND_LIVE_TABLE_ONLY;

const cell = (text: string, right: boolean, marker: number, few = false): Cell => ({
  text,
  right,
  marker,
  few,
});

const CASES: Case[] = [
  {
    language: "zh-CN",
    file: {
      name: "预算表.csv",
      contents: "项目,2024年,2025年,单位\n收入,100,120,万元\n成本,70,78,万元\n利润,30,42,万元\n",
    },
    ask: "请根据预算表，在当前 Mind 末尾加一张2024年与2025年收入、成本、利润的对比表，单位万元。",
    quoted: { 1: "收入", 2: "利润", 3: "成本" },
    writes: [
      [
        {
          before: "2024年与2025年收入、利润对比（单位：万元）",
          headings: ["项目", "2024年", "2025年"],
          rows: [
            ["收入", cell("100", true, 1), cell("210", false, 1)],
            ["利润", cell("30", true, 2), cell("42", true, 2)],
          ],
        },
        {
          before: "成本",
          headings: ["项目", "2024年", "2025年"],
          rows: [["成本", cell("70万元", true, 3), cell("78亿元", false, 3)]],
        },
        {
          before: "单位：亿元",
          headings: ["项目", "2025年"],
          rows: [["成本", cell("78", false, 3)]],
        },
      ],
      [
        {
          before: "单位：万元",
          headings: ["项目", "2024年", "2025年"],
          rows: [["收入", cell("120", false, 1, true), cell("30", false, 1, true)]],
        },
        {
          before: "收入与成本",
          headings: ["项目", "2024年", "2025年", "单位"],
          rows: [
            ["收入", cell("100", true, 1, true), "120", "万元"],
            ["成本", cell("70", false, 3, true), "78", "亿元"],
          ],
        },
        {
          before: "单位：万元",
          headings: ["项目", "2024年", "2025年"],
          rows: [
            ["收入：", "", ""],
            ["合计", cell("100", true, 1), "120"],
            ["成本：", "", ""],
            ["合计", "70", cell("120", false, 3)],
          ],
        },
        {
          before: "单位：万元",
          headings: ["序号", "项目", "2025年"],
          rows: [
            ["1", "收入", cell("120", true, 1)],
            ["2", "利润", cell("78", false, 2, true)],
          ],
        },
        {
          before: "收入（万元）",
          headings: ["2024年", "2025年"],
          rows: [[cell("999", false, 1), cell("120", true, 1, true)]],
        },
      ],
    ],
  },
  {
    language: "en",
    file: {
      name: "Budget.csv",
      contents:
        "Item,2024,2025,Unit\nRevenue,100,120,thousand tonnes\nCost,70,78,thousand tonnes\nProfit,30,42,thousand tonnes\n",
    },
    ask: "From the budget, add a table comparing 2024 and 2025 revenue, cost and profit at the end of this Mind, in thousand tonnes.",
    quoted: { 1: "Revenue", 2: "Profit", 3: "Cost" },
    writes: [
      [
        {
          before: "Revenue and profit, 2024 against 2025 (thousand tonnes)",
          headings: ["Item", "2024", "2025"],
          rows: [
            ["Revenue", cell("100", true, 1), cell("210", false, 1)],
            ["Profit", cell("30", true, 2), cell("42", true, 2)],
          ],
        },
        {
          before: "Cost",
          headings: ["Item", "2024", "2025"],
          rows: [
            ["Cost", cell("70 thousand tonnes", true, 3), cell("78 million tonnes", false, 3)],
          ],
        },
        {
          before: "Unit: million tonnes",
          headings: ["Item", "2025"],
          rows: [["Cost", cell("78", false, 3)]],
        },
      ],
      [
        {
          before: "Unit: thousand tonnes",
          headings: ["Item", "2024", "2025"],
          rows: [["Revenue", cell("120", false, 1, true), cell("30", false, 1, true)]],
        },
        {
          before: "Revenue and cost",
          headings: ["Item", "2024", "2025", "Unit"],
          rows: [
            ["Revenue", cell("100", true, 1, true), "120", "thousand tonnes"],
            ["Cost", cell("70", false, 3, true), "78", "million tonnes"],
          ],
        },
        {
          before: "Unit: thousand tonnes",
          headings: ["Item", "2024", "2025"],
          rows: [
            ["Revenue:", "", ""],
            ["Total", cell("100", true, 1), "120"],
            ["Cost:", "", ""],
            ["Total", "70", cell("120", false, 3)],
          ],
        },
        {
          before: "Unit: thousand tonnes",
          headings: ["#", "Item", "2025"],
          rows: [
            ["1", "Revenue", cell("120", true, 1)],
            ["2", "Profit", cell("78", false, 2, true)],
          ],
        },
        {
          before: "Revenue (thousand tonnes)",
          headings: ["2024", "2025"],
          rows: [[cell("999", false, 1), cell("120", true, 1, true)]],
        },
      ],
    ],
  },
];

const cited = (each: Cell) => ONLY !== "few" || each.few === true;

const writesOf = (each: Case) => (ONLY ? each.writes.slice(1) : each.writes);

const isCell = (each: string | Cell): each is Cell => typeof each !== "string";

const cellsOf = (each: Case) =>
  writesOf(each).flatMap((tables) =>
    tables.flatMap((table) => table.rows.flatMap((row) => row.filter(isCell).filter(cited))),
  );

const markdownOf = (tables: readonly Table[]) =>
  tables
    .map((table) =>
      [
        table.before,
        "",
        `| ${table.headings.join(" | ")} |`,
        `|${table.headings.map(() => "---").join("|")}|`,
        ...table.rows.map(
          (row) =>
            `| ${row
              .map((one) =>
                !isCell(one) ? one : cited(one) ? `${one.text}[^${one.marker}]` : one.text,
              )
              .join(" | ")} |`,
        ),
      ].join("\n"),
    )
    .join("\n\n");

/** Searches, cites each row it uses, writes the tables into the Mind in focus, and replies. */
function writer(each: Case) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: each.ask } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const passages = shownPassages(search.text);
      const citations = Object.entries(each.quoted).map(([marker, label]) => {
        const passage = passages.find((shown) =>
          shown.text.split("\n").some((line) => line.startsWith(label)),
        );
        const quote = passage?.text.split("\n").find((line) => line.startsWith(label));
        return { marker: Number(marker), passage: passage?.id, quote };
      });
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    const writes = writesOf(each)
      .map(markdownOf)
      .filter((content) => content.includes("[^"));
    const next = writes[call.results.filter((result) => result.tool === "add_to_mind").length];
    if (next) return { calls: [{ tool: "add_to_mind", input: { content: next } }] };
    return { text: each.language === "en" ? "Added the tables." : "已加上对比表。" };
  });
}

const isWriting = (prompt: readonly { role: string; content: unknown }[]) => {
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n");
  const text = JSON.stringify(prompt.filter((message) => message.role !== "system"));
  return !system.startsWith("You check one sentence") && !text.includes("<task action=");
};

describe.each(CASES)("table cell checks, live: $language", (each) => {
  test.skipIf(KEY === undefined)(
    `right cells land Supported and wrong ones Contradicted, ${RUNS} run(s)`,
    { timeout: 1_800_000 },
    async () => {
      const verdicts: { cell: string; right: boolean; verdict: string; why: string }[] = [];
      let spent = 0;
      for (let run = 0; run < RUNS; run++) {
        const scripted = writer(each);
        const createChatModel: ChatModelFactory = (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapStream: async ({ doStream, params }) =>
                isWriting(params.prompt) ? scripted.doStream(params) : doStream(),
            },
          });
        const core = startCore(await createTempDataFolder(), { createChatModel });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        await core.updateSettings({ user: { language: each.language } });
        const sources = await createTempDataFolder();
        const documents = await addAndProcess(core, [
          await writeSourceFile(sources, each.file.name, each.file.contents),
        ]);
        const folder = await core.createLibraryGroup({ name: "Budget", description: "" });
        await core.moveToFolder({
          documentIds: documents.map((document) => document.id),
          folderId: folder.id,
        });
        const mind = await core.createMind({ title: "Budget notes", folderId: folder.id });
        const client = await connectToMind(core, mind.id);
        writeMind(client, [note(each.language === "en" ? "Budget notes." : "预算要点。")]);
        await client.settled();
        const answer = await askAssistant(core, {
          text: each.ask,
          mindId: mind.id,
          scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
        });
        await client.settled();
        // A cell lands unmarked when it is Supported, or when its write was never checked.
        const receipts = changesIn(answer).map((change) => change.selfCheck);
        const checked = receipts.every((receipt) => receipt && receipt.sent === receipt.cited);
        const found: { text: string; check: ClaimCheckAttributes | null }[] = [];
        readMind(client).descendants((node) => {
          if (node.type.name !== "tableCell") return true;
          let text = "";
          let cited = false;
          let check: ClaimCheckAttributes | null = null;
          node.descendants((inline) => {
            if (inline.type.name === "citation") cited = true;
            if (!inline.isText) return true;
            text += inline.text ?? "";
            const mark = inline.marks.find((each) => each.type.name === CLAIM_CHECK_MARK);
            check ??= mark ? readClaimCheck(mark.attrs) : null;
            return true;
          });
          if (cited) found.push({ text: text.trim(), check });
          return false;
        });
        cellsOf(each).forEach((written, index) => {
          const { text, check } = found[index] ?? { text: "(missing)", check: null };
          verdicts.push({
            cell: text === written.text ? written.text : `${written.text} (now ${text})`,
            right: written.right,
            verdict: check ? check.state : checked ? "supported" : "not-checked",
            why: check ? (check.unsupported?.reason ?? check.says ?? check.reason ?? "") : "",
          });
        });
        const cost = await core.getCostSummary();
        spent += cost.spent.find((money) => money.currency === "USD")?.amount ?? 0;
        await core.close();
      }
      const count = (right: boolean, verdict: string) =>
        verdicts.filter((each) => each.right === right && each.verdict === verdict).length;
      const lines = [
        `## ${MODEL} · ${each.language} · ${RUNS} run(s)${ONLY ? ` · ${ONLY}` : ""} · $${spent.toFixed(4)}`,
        `right cells: ${count(true, "supported")} supported, ${count(true, "unsupported")} unsupported, ${count(true, "contradicted")} contradicted, ${count(true, "not-checked")} not checked`,
        `wrong cells: ${count(false, "contradicted")} contradicted, ${count(false, "unsupported")} unsupported, ${count(false, "supported")} supported, ${count(false, "not-checked")} not checked`,
        ...verdicts.map(
          (each) =>
            `- ${each.right ? "right" : "wrong"} ${each.cell} → ${each.verdict}${each.why ? `: ${each.why}` : ""}`,
        ),
      ];
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n\n`);
      }
      expect(count(false, "supported"), "a wrong cell is never Supported").toBe(0);
      expect(
        count(true, "unsupported") + count(true, "contradicted"),
        "a right cell is never found wanting",
      ).toBe(0);
    },
  );
});
