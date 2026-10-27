import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { createCalculationSession } from "../../src/core/answers/calculations";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { markSentence, textOf } from "../../src/core/answers/checks/sentences";
import { type AnswerDocuments, createCitationSession } from "../../src/core/answers/citations";
import { figureCitations } from "../../src/core/answers/citedVersions";
import type {
  ClaimCheckAttributes,
  FigureCheckAttributes,
  FigureCheckResult,
  FigureFinding,
} from "../../src/core/api";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { augmentFigureFooting, figureSchedule } from "../../src/core/figureSchedule";
import type { NodeJSON } from "../../src/shared/blockJson";
import { aggregateFigureResults } from "../../src/shared/figureChecks";

const paragraph = (id: string, text: string, attrs: Record<string, string> = {}): NodeJSON => ({
  type: "paragraph",
  attrs: { id, ...attrs },
  content: [{ type: "text", text }],
});
function note(...nodes: NodeJSON[]) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push(nodes.map(createElement));
  return blocks;
}
const project = (blocks: Y.XmlFragment) =>
  figureSchedule({
    mindId: "note",
    name: "Figures",
    basis: "exact-basis",
    blocks,
    versions: new Map<string, string>(),
    folderId: null,
    scope: null,
  });
function basis(text: string): ClaimCheckAttributes {
  return {
    id: "check",
    request: "request",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-27T00:00:00.000Z",
  };
}
const finding = (occurrence: ReturnType<typeof figuresInMind>[number]): FigureFinding => ({
  ...occurrence,
  sourceInput: null,
  source: null,
  roundedFrom: null,
  difference: null,
  footing: [],
});

test("the empty schedule is a read-only projection of the supplied Note basis", () => {
  const blocks = note();
  const before = Y.encodeStateAsUpdate(blocks.doc ?? new Y.Doc());
  expect(project(blocks)).toMatchObject({
    mindId: "note",
    basis: "exact-basis",
    rows: [],
    counts: { total: 0, supported: 0, needsLook: 0, notChecked: 0, checking: 0, kept: 0 },
  });
  expect(Y.encodeStateAsUpdate(blocks.doc ?? new Y.Doc())).toEqual(before);
});

test("a selected child Keep cannot leak the parent's verdict to a missing equal occurrence", () => {
  const blocks = note(paragraph("p", "Revenue £20 and costs £20."));
  const occurrences = figuresInMind(blocks);
  const block = blocks.get(0);
  const first = occurrences[0];
  if (!(block instanceof Y.XmlElement) || !first) throw new Error("Missing fixture");
  const parent = basis(textOf(block));
  const child: FigureCheckAttributes = { ...parent, ...finding(first), kept: true };
  markSentence(block, 0, textOf(block).length, { ...parent, figures: [child], remainder: null });
  expect(project(blocks).rows.map((row) => row.shown.state)).toEqual(["kept", "not-checked"]);
});

test("ordinary per-figure and atom-owned Check sources join the same retention closure", () => {
  const blocks = note(paragraph("p", "Revenue £20."));
  const block = blocks.get(0);
  const occurrence = figuresInMind(blocks)[0];
  if (!(block instanceof Y.XmlElement) || !occurrence) throw new Error("Missing fixture");
  const source = {
    passageId: "source-p",
    documentId: "source",
    documentName: "Accounts",
    contentHash: "v1",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page" as const, from: 1, to: 1 },
    quote: "Revenue £20",
    check: "not-found" as const,
    checkReason: "quote-not-on-pages" as const,
  };
  const parent = basis(textOf(block));
  markSentence(block, 0, textOf(block).length, {
    ...parent,
    figures: [{ ...parent, ...finding(occurrence), source }],
    remainder: null,
  });
  expect(figureCitations(blocks)).toContainEqual(source);
});

test("malformed per-figure inventories throw before replacing retained sources", () => {
  const blocks = note(paragraph("p", "Revenue £20."));
  const block = blocks.get(0);
  if (!(block instanceof Y.XmlElement)) throw new Error("Missing fixture");
  const text = block.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("Missing text");
  text.format(0, text.length, {
    claimCheck: { ...basis(text.toString()), figures: [{ id: "broken" }] },
  });
  expect(() => figureCitations(blocks)).toThrow(/check/i);
});

const cell = (
  id: string,
  text: string,
  header = false,
  attrs: Record<string, string> = {},
): NodeJSON => ({
  type: header ? "tableHeader" : "tableCell",
  content: [paragraph(id, text, attrs)],
});
const row = (...content: NodeJSON[]): NodeJSON => ({ type: "tableRow", content });
const table = (...content: NodeJSON[]): NodeJSON => ({
  type: "table",
  attrs: { id: "table" },
  content,
});

test("a corner total preserves both axes when only one does not add up", () => {
  const blocks = note(
    table(
      row(
        cell("h0", "Item", true),
        cell("h1", "A", true),
        cell("h2", "B", true),
        cell("h3", "Total", true),
      ),
      row(cell("l1", "Revenue"), cell("a1", "10"), cell("b1", "20"), cell("t1", "30")),
      row(cell("l2", "Costs"), cell("a2", "5"), cell("b2", "7"), cell("t2", "12")),
      row(cell("l3", "Total"), cell("a3", "15"), cell("b3", "28"), cell("t3", "43")),
    ),
  );
  const corner = project(blocks).rows.find(
    (figure) => figure.locator.kind === "text" && figure.locator.from.blockId === "t3",
  );
  expect(corner?.footing.map((axis) => [axis.axis, axis.sum, axis.agrees])).toEqual([
    ["row", 42, false],
    ["column", 43, true],
  ]);
  expect(corner?.shown.state).toBe("unsupported");
  expect(corner?.reason).toBe("doesnt-add-up");
});

test("explicit Treat as total and Not a total override literal row labels", () => {
  const blocks = note(
    table(
      row(cell("h0", "Item", true), cell("h1", "Amount", true)),
      row(cell("l1", "Revenue"), cell("a1", "10")),
      row(cell("l2", "Total"), cell("a2", "20", false, { figureRowRole: "detail" })),
      row(cell("l3", "Net"), cell("a3", "30", false, { figureRowRole: "total" })),
    ),
  );
  const rows = project(blocks).rows;
  expect(rows[1]?.footing).toEqual([]);
  expect(rows[2]?.footing).toMatchObject([{ axis: "row", sum: 30, agrees: true }]);
});

test("an unavailable nonblank numeric cell is unknown while a blank row contributes nothing", () => {
  const blocks = note(
    table(
      row(cell("h0", "项目", true), cell("h1", "金额", true)),
      row(cell("l1", "收入"), cell("a1", "10")),
      row(cell("empty0", ""), cell("empty1", "")),
      row(cell("l2", "支出"), cell("a2", "N/A")),
      row(cell("l3", "合计"), cell("a3", "10")),
    ),
  );
  expect(project(blocks).rows.at(-1)?.footing).toMatchObject([
    { axis: "row", agrees: null, inability: "missing-figure" },
  ]);
});

function sourceTable(lines: string[]) {
  const text = lines.join("\n");
  const documents: AnswerDocuments = {
    searchableCount: () => 1,
    async search() {
      throw new Error("Source footing must not search or ask a model");
    },
    citationSource: (id) =>
      id === "passage"
        ? {
            passageId: id,
            documentId: "accounts",
            documentName: "Accounts",
            contentHash: "v1",
            documentKind: "xlsx",
            documentDeleted: false,
            notCited: false,
            text,
            pageFrom: 1,
            pageTo: 1,
          }
        : null,
    pageTexts: () => [
      {
        kind: "rows",
        page: 1,
        text,
        label: { sheet: "Accounts", rows: lines.map((_, index) => index + 1), column: 0 },
      },
    ],
    documentDate: () => null,
  };
  const citations = createCitationSession(documents, { onRecord: () => undefined });
  const passage = documents.citationSource("passage");
  if (!passage) throw new Error("Missing source Passage");
  citations.show([{ ...passage, seq: 0, position: 0, windowFrom: 0, windowTo: 0 }]);
  const calculations = createCalculationSession({
    documents,
    quotes: citations.quotes,
    language: "en",
  });
  const input = (row: number) => {
    const found = calculations.number({
      name: "source",
      label: lines[row - 1]?.split("\t")[0] ?? "",
      passage: "passage",
      location: `Accounts, row ${row}`,
      quote: lines[row - 1],
      position: 1,
    });
    if (!("input" in found)) throw new Error(found.problem);
    return found.input;
  };
  return { documents, input };
}

test("a matching source total names an omitted source row only from a checked exact cell", () => {
  const blocks = note(
    table(
      row(cell("h0", "Item", true), cell("h1", "Amount", true)),
      row(cell("l1", "A"), cell("a1", "10")),
      row(cell("l2", "B"), cell("a2", "20")),
      row(cell("lt", "Total"), cell("at", "35")),
    ),
  );
  const source = sourceTable(["Item\tAmount", "A\t10", "B\t20", "C\t5", "Total\t35"]);
  const results = figuresInMind(blocks).map((occurrence, index): FigureCheckResult => {
    const input = source.input(index === 2 ? 5 : index + 2);
    return {
      ...finding(occurrence),
      sourceInput: input,
      result: {
        verdict: "supported",
        evidence: input.citation,
        says: null,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        versions: [{ documentId: "accounts", contentHash: "v1" }],
        excluded: [],
      },
    };
  });
  const result = augmentFigureFooting(
    blocks,
    { ...aggregateFigureResults(results, null), figures: results, remainder: null },
    source.documents,
  );
  const total = result.figures?.at(-1);
  expect(total?.result.verdict).toBe("supported");
  expect(total?.footing).toMatchObject([{ axis: "row", sum: 30, agrees: false }]);
  expect(total?.sourceFooting).toMatchObject([
    {
      axis: "row",
      componentIds: results.slice(0, 2).map((row) => row.id),
      sum: 35,
      agrees: true,
      inputs: [
        { label: "C", number: { value: 5 }, cell: { ref: "B4" }, citation: { check: "found" } },
      ],
    },
  ]);
  expect(result.verdict).toBe("unsupported");
});
