/**
 * A Note's calculated figure in its exports and Question context (#439): its shown text, then in
 * Numbered a note saying how it was worked out and where its inputs are from, numbered with the
 * Citations and footnotes; in a citation style its inputs' cluster with "calculated from"
 * ("据…计算"), their Documents in the Bibliography; and "(calculated)" for the model.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Core, Document, MindExport, ReferencePatch } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { questionContextOf } from "../../src/core/answers/context";
import { createContextCitations } from "../../src/core/answers/contextCitations";
import type {
  CalculatedFigure,
  Citation,
  FigureInput,
  RetainedFigureAnalysis,
} from "../../src/core/api";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { installFigureRuns } from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

const QUOTE = "Revenue was 1,482.6 million in 2025 and 1,231.4 million in 2024.";

async function setUp(language: "en" | "zh-CN" = "en") {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock().now, printer: fakePrinter().printer });
  if (language === "zh-CN") await core.updateSettings({ user: { language } });
  const path = await writeSourceFile(sources, "Acme Annual Report 2025.txt", QUOTE);
  const [acme] = await addAndProcess(core, [path]);
  const mind = await core.createMind({ title: "Results" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, acme: acme as Document };
}

type Cited = Pick<Document, "id" | "name" | "contentHash">;

function quoted(acme: Cited): Citation {
  return {
    passageId: "passage-1",
    documentId: acme.id,
    documentName: acme.name,
    contentHash: acme.contentHash,
    pageFrom: 4,
    pageTo: 4,
    location: { kind: "page", from: 4, to: 4 },
    quote: QUOTE,
    check: "found",
    checkReason: null,
  };
}

function input(acme: Cited, name: string, label: string, chars: string): FigureInput {
  return {
    name,
    label,
    citation: quoted(acme),
    number: {
      chars,
      at: QUOTE.indexOf(chars),
      value: Number(chars.replace(",", "")) * 1e6,
      scale: 1e6,
      scaleWord: "million",
      unit: { kind: "plain" },
      decimals: 1,
      approximate: false,
      reading: null,
    },
    cell: null,
    unitStatement: null,
  };
}

/** Revenue growth from two inputs quoted from the same page, labelled in `language`. */
function growth(acme: Cited, language: "en" | "zh-CN"): NodeJSON {
  const [latest, before] =
    language === "en" ? ["Revenue 2025", "Revenue 2024"] : ["2025 年营收", "2024 年营收"];
  const figure: CalculatedFigure = {
    label: language === "en" ? "Revenue growth 2025" : "2025 年营收增长",
    formula: "(rev2025 - rev2024) / rev2024",
    inputs: [input(acme, "rev2025", latest, "1,482.6"), input(acme, "rev2024", before, "1,231.4")],
    value: 1482.6 / 1231.4 - 1,
    unit: { kind: "percent" },
    approximate: false,
    shown: "20.4%",
    show: { language, as: "percent", decimals: 1, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
  };
  return calculatedFigureNode(figure, "figure-1");
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const citation = (acme: Cited): JSONContent => ({ type: "citation", attrs: { ...quoted(acme) } });

const footnote = (value: string): JSONContent => ({
  type: "footnote",
  attrs: { id: "footnote-1" },
  content: [text(value)],
});

const decode = (exported: MindExport) => new TextDecoder().decode(exported.data);

async function exported(core: Core, mindId: string) {
  const markdown = decode(await core.exportMind(mindId, { format: "markdown" }));
  const files = unzip((await core.exportMind(mindId, { format: "docx" })).data);
  return {
    markdown,
    word: paragraphsOf(part(files, "word/document.xml")).map((each) => each.text),
    footnotes: footnotesOf(part(files, "word/footnotes.xml")),
  };
}

const ENGLISH_NOTE =
  "Calculated: (Revenue 2025 − Revenue 2024) ÷ Revenue 2024 = 20.4%. Revenue 2025 and Revenue 2024: Acme Annual Report 2025, p. 4.";
const CHINESE_NOTE =
  "计算得出：(2025 年营收 − 2024 年营收) ÷ 2024 年营收 = 20.4%。2025 年营收和 2024 年营收：Acme Annual Report 2025，第 4 页。";

describe("in Numbered", () => {
  test("Markdown and Word follow the figure with its note, numbered between a Citation and a footnote", async () => {
    const { core, mind, client, acme } = await setUp();
    await core.setMindCitationStyle(mind.id, "numbered");
    writeMind(client, [
      paragraph(
        text("Revenue was $1,482.6 million "),
        citation(acme),
        text(" and grew "),
        growth(acme, "en"),
        text(" on the year "),
        footnote("Unaudited."),
        text("."),
      ),
    ]);
    await client.settled();

    const { markdown, word, footnotes } = await exported(core, mind.id);
    expect(markdown).toBe(
      [
        "Revenue was \\$1,482.6 million[^1] and grew 20.4%[^2] on the year[^3].",
        "",
        `[^1]: Acme Annual Report 2025, p. 4\n[^2]: ${ENGLISH_NOTE}\n[^3]: Unaudited.`,
        "",
      ].join("\n"),
    );
    expect(word).toContain("Revenue was $1,482.6 million[1] and grew 20.4%[2] on the year[3].");
    expect(footnotes).toMatchObject({
      "1": "Acme Annual Report 2025, p. 4",
      "2": ENGLISH_NOTE,
      "3": "Unaudited.",
    });
  });

  test("in Chinese, the note is in the export's language, with Chinese punctuation", async () => {
    const { core, mind, client, acme } = await setUp("zh-CN");
    await core.setMindCitationStyle(mind.id, "numbered");
    writeMind(client, [paragraph(text("营收增长 "), growth(acme, "zh-CN"), text("。"))]);
    await client.settled();

    const { markdown, word, footnotes } = await exported(core, mind.id);
    expect(markdown).toBe(`营收增长 20.4%[^1]。\n\n[^1]: ${CHINESE_NOTE}\n`);
    expect(word).toContain("营收增长 20.4%[1]。");
    expect(footnotes).toMatchObject({ "1": CHINESE_NOTE });
  });
});

/** A figure an Analysis gave, from one input, and the run the Note keeps for it. */
function fromAnalysis(acme: Cited): { node: NodeJSON; run: RetainedFigureAnalysis } {
  const figure: CalculatedFigure = {
    label: "Revenue 2025",
    formula: "",
    inputs: [],
    value: 1482.6,
    unit: { kind: "plain" },
    approximate: false,
    shown: "1,482.6",
    show: { language: "en", as: "number", decimals: 1, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
    analysis: { analysis: 1, result: "total" },
  };
  const run: RetainedFigureAnalysis = {
    id: "run-1",
    title: "Revenue by year",
    language: "python",
    code: "result('total', inputs['rev2025'])",
    inputs: [
      {
        kind: "figure",
        name: "rev2025",
        input: input(acme, "rev2025", "Revenue 2025", "1,482.6"),
        sha256: "b".repeat(64),
      },
    ],
    versions: null,
    codeSha256: "a".repeat(64),
    ranAt: "2026-10-27T00:00:00.000Z",
    values: [{ kind: "figure", name: "total", label: "Total", value: 1482.6, unit: null }],
  };
  return { node: calculatedFigureNode(figure, "figure-2", run.id), run };
}

describe("a figure an Analysis gave", () => {
  test("its note names the Analysis and where its inputs are from", async () => {
    const { core, mind, client, acme } = await setUp();
    await core.setMindCitationStyle(mind.id, "numbered");
    const { node, run } = fromAnalysis(acme);
    client.doc.transact(() => {
      writeMind(client, [paragraph(text("Revenue was "), node, text("."))]);
      installFigureRuns(client.doc, [run]);
    });
    await client.settled();
    expect(decode(await core.exportMind(mind.id, { format: "markdown" }))).toBe(
      "Revenue was 1,482.6[^1].\n\n[^1]: Calculated by the Analysis “Revenue by year”: 1,482.6. Revenue 2025: Acme Annual Report 2025, p. 4.\n",
    );
  });

  test.each(["en", "zh-CN"] as const)(
    "%s: a figure whose Analysis record is missing is written as its value with a note, and the file is saved",
    async (language) => {
      const { core, mind, client, acme } = await setUp(language);
      await core.setMindCitationStyle(mind.id, "numbered");
      const { node } = fromAnalysis(acme);
      writeMind(client, [
        paragraph(text(language === "en" ? "Revenue was " : "营收为 "), node, text(".")),
      ]);
      await client.settled();

      const markdown = decode(await core.exportMind(mind.id, { format: "markdown" }));
      expect(markdown).toContain("1,482.6");
      expect(markdown).toContain(
        language === "en"
          ? "The saved inputs for 1,482.6 aren't available, so IncarnaMind writes it as its value."
          : "“1,482.6”保存的输入暂不可用，IncarnaMind 按数值写出。",
      );
      const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
      expect(
        paragraphsOf(part(files, "word/document.xml"))
          .map((each) => each.text)
          .join(" "),
      ).toContain("1,482.6");
      expect((await core.exportMind(mind.id, { format: "pdf" })).data.byteLength).toBeGreaterThan(
        0,
      );
    },
  );
});

const ACME: ReferencePatch = {
  type: "report",
  title: "Annual Report 2025",
  authors: [{ literal: "Acme Corp." }],
  issued: "2025",
};

describe("in a citation style", () => {
  test("APA 7 follows the figure with its inputs' cluster, calculated from, and lists their Document", async () => {
    const { core, mind, client, acme } = await setUp();
    await core.updateReference(acme.id, ACME);
    await core.setMindCitationStyle(mind.id, "apa");
    writeMind(client, [paragraph(text("Revenue grew "), growth(acme, "en"), text("."))]);
    await client.settled();

    const { markdown, word } = await exported(core, mind.id);
    expect(markdown).toBe(
      [
        "Revenue grew 20.4% calculated from (Acme Corp., 2025, p. 4).",
        "",
        "## References",
        "",
        "Acme Corp. (2025). *Annual Report 2025*.",
        "",
      ].join("\n"),
    );
    expect(word).toContain("Revenue grew 20.4% calculated from (Acme Corp., 2025, p. 4).");
    expect(word).toContain("Acme Corp. (2025). Annual Report 2025.");
  });

  test("GB/T 7714 writes it the Chinese way, 据…计算", async () => {
    const { core, mind, client, acme } = await setUp("zh-CN");
    await core.updateReference(acme.id, {
      ...ACME,
      title: "2025 年年度报告",
      authors: [{ literal: "Acme 公司" }],
      language: "zh",
    });
    await core.setMindCitationStyle(mind.id, "gb-t-7714-2015-author-date");
    writeMind(client, [
      paragraph(text("本公司全年营收增长 "), growth(acme, "zh-CN"), text("，主要来自海外订单。")),
    ]);
    await client.settled();

    const { markdown, word } = await exported(core, mind.id);
    expect(markdown).toBe(
      [
        "本公司全年营收增长 20.4% 据(Acme 公司, 2025)<sup>4</sup>计算，主要来自海外订单。",
        "",
        "## 参考文献",
        "",
        "ACME 公司, 2025. 2025 年年度报告\\[R\\].",
        "",
      ].join("\n"),
    );
    expect(word).toEqual([
      "本公司全年营收增长 20.4% 据(Acme 公司, 2025)4计算，主要来自海外订单。",
      "参考文献",
      "ACME 公司, 2025. 2025 年年度报告[R].",
    ]);
  });
});

describe("in Question context", () => {
  test("a figure reads as its shown text and (calculated), with its Analysis gone too; its inputs take no Citation ids", () => {
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment("blocks");
    const acme: Cited = { id: "acme", name: "Acme Annual Report 2025", contentHash: "v1" };
    blocks.insert(0, [
      createElement({
        type: "paragraph",
        content: [
          { type: "text", text: "Revenue grew " },
          growth(acme, "en"),
          { type: "text", text: " in 2025 " },
          {
            type: "citation",
            attrs: {
              ...quoted(acme),
              passageId: "passage-2",
              pageFrom: 5,
              pageTo: 5,
              location: { kind: "page", from: 5, to: 5 },
            },
          },
          { type: "text", text: ", to " },
          fromAnalysis(acme).node,
          { type: "text", text: " million." },
        ],
      }),
      createElement({ type: "question", content: [{ type: "text", text: "Why?" }] }),
    ]);
    const { context } = questionContextOf(blocks, 1, undefined, null, createContextCitations());
    expect(context.messages.at(-1)?.content).toBe(
      "Revenue grew 20.4% (calculated) in 2025 [Acme Annual Report 2025, p. 5 · C1], to 1,482.6 (calculated) million.\n\nWhy?",
    );
  });
});
