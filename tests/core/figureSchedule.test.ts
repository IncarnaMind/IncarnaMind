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
import { figureScheduleBook } from "../../src/core/exports/figureScheduleBook";
import { augmentFigureFooting, figureSchedule } from "../../src/core/figureSchedule";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { aggregateFigureResults } from "../../src/shared/figureChecks";
import { childrenOf, lineShows } from "../../src/shared/figureSchedule";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { addSignOff, figureSignOffBasis } from "../../src/shared/signOffs";

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
const project = (blocks: Y.XmlFragment) => figureSchedule(scheduleInput(blocks));
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

test.each(["supported", "unsupported", "contradicted"] as const)(
  "a legacy whole-sentence %s result is not per-figure evidence",
  (state) => {
    const blocks = note(paragraph("p", "Revenue £20."));
    const block = blocks.get(0);
    if (!(block instanceof Y.XmlElement)) throw new Error("Missing fixture");
    markSentence(block, 0, textOf(block).length, { ...basis(textOf(block)), state });
    expect(project(blocks).rows[0]?.shown.state).toBe("not-checked");
  },
);

test.each(["checking", "kept", "stale"] as const)(
  "a legacy owner's truthful %s state still projects",
  (state) => {
    const blocks = note(paragraph("p", "Revenue £20."));
    const block = blocks.get(0);
    if (!(block instanceof Y.XmlElement)) throw new Error("Missing fixture");
    markSentence(block, 0, textOf(block).length, {
      ...basis(state === "stale" ? "Other words £20." : textOf(block)),
      ...(state === "checking" && { state: "checking" }),
      ...(state === "kept" && { kept: true }),
    });
    expect(project(blocks).rows[0]?.shown.state).toBe(state === "stale" ? "needs-recheck" : state);
  },
);

test("the schedule exposes only its DTO rather than duplicating raw Check verdict fields", () => {
  const blocks = note(paragraph("p", "Revenue £20."));
  const block = blocks.get(0);
  const occurrence = figuresInMind(blocks)[0];
  if (!(block instanceof Y.XmlElement) || !occurrence) throw new Error("Missing fixture");
  const parent = basis(textOf(block));
  markSentence(block, 0, textOf(block).length, {
    ...parent,
    figures: [{ ...parent, ...finding(occurrence) }],
    remainder: null,
  });
  expect(project(blocks).rows[0]).not.toHaveProperty("state");
  expect(project(blocks).rows[0]).not.toHaveProperty("evidence");
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
      { ...row(cell("l2", "Total"), cell("a2", "20")), attrs: { figureRowRole: "detail" } },
      { ...row(cell("l3", "Net"), cell("a3", "30")), attrs: { figureRowRole: "total" } },
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
        label: {
          sheet: "Accounts",
          from: 1,
          to: lines.length,
          rows: lines.map((_, index) => index + 1),
          column: 0,
        },
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
  const input = (row: number, position = 1) => {
    const found = calculations.number({
      name: "source",
      label: lines[row - 1]?.split("\t")[0] ?? "",
      passage: "passage",
      location: `Accounts, row ${row}`,
      quote: lines[row - 1],
      position,
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

function findBlock(blocks: Y.XmlFragment | Y.XmlElement, id: string): Y.XmlElement {
  const pending = [...blocks.toArray()];
  while (pending.length > 0) {
    const element = pending.shift();
    if (!(element instanceof Y.XmlElement)) continue;
    if (element.getAttribute("id") === id) return element;
    pending.push(...element.toArray());
  }
  throw new Error(`No fixture block ${id}`);
}

function markOccurrence(
  blocks: Y.XmlFragment,
  occurrence: ReturnType<typeof figuresInMind>[number],
  overrides: Partial<FigureCheckAttributes> = {},
) {
  if (occurrence.locator.kind !== "text") throw new Error("Not a text occurrence");
  const element = findBlock(blocks, occurrence.locator.from.blockId);
  const parent = { ...basis(textOf(element)), id: `check-${String(element.getAttribute("id"))}` };
  const child = { ...parent, ...finding(occurrence), ...overrides };
  markSentence(element, 0, textOf(element).length, {
    ...parent,
    request: child.request,
    state: child.state,
    figures: [child],
    remainder: null,
  });
  return child;
}

function checkedResult(
  occurrence: ReturnType<typeof figuresInMind>[number],
  input: ReturnType<ReturnType<typeof sourceTable>["input"]>,
): FigureCheckResult {
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
}

const joinedResult = (figures: FigureCheckResult[]) => ({
  ...aggregateFigureResults(figures, null),
  figures,
  remainder: null,
});

test.each([false, true])("a changed header does not reuse a resolved scale (kept=%s)", (kept) => {
  const blocks = note(
    table(
      row(cell("h0", "Item", true), cell("h1", "£m", true)),
      row(cell("l1", "Revenue"), cell("a1", "10")),
    ),
  );
  const occurrence = figuresInMind(blocks)[0];
  if (!occurrence) throw new Error("No fixture figure");
  const selected = occurrence.reading.ambiguous
    .flatMap((ambiguity) => ambiguity.readings)
    .find((reading) => reading.scale === 1_000_000);
  if (!selected) throw new Error("No offered scale reading");
  markOccurrence(blocks, occurrence, {
    reading: { ...occurrence.reading, ...selected, ambiguous: [] },
    ...(kept && { kept: true }),
  });
  expect(project(blocks).rows[0]?.reading.scale).toBe(1_000_000);
  const header = findBlock(blocks, "h1").get(0);
  if (!(header instanceof Y.XmlText)) throw new Error("No fixture header text");
  header.delete(0, header.length);
  header.insert(0, "£ thousand");
  const current = figuresInMind(blocks)[0];
  const projected = project(blocks).rows[0];
  expect(projected?.context).toBe(current?.context);
  expect(projected?.reading.ambiguous.length).toBeGreaterThan(0);
  expect(projected?.shown.state).toBe(kept ? "kept" : "needs-recheck");
});

test("progress counts raw targets even when a checking total already needs a look", () => {
  const blocks = note(
    table(
      row(cell("h0", "Item", true), cell("h1", "Amount", true)),
      row(cell("l1", "A"), cell("a1", "10")),
      row(cell("l2", "B"), cell("a2", "20")),
      row(cell("lt", "Total"), cell("at", "40")),
    ),
    paragraph("outside", "Other £99."),
  );
  const occurrences = figuresInMind(blocks);
  for (const occurrence of occurrences.slice(0, 3))
    markOccurrence(blocks, occurrence, {
      state:
        occurrence.locator.kind === "text" && occurrence.locator.from.blockId === "at"
          ? "checking"
          : "supported",
      request: "active",
    });
  const schedule = project(blocks);
  expect(schedule.rows[2]?.shown.state).toBe("unsupported");
  expect(schedule.progress).toEqual({ done: 2, total: 3 });
  expect(schedule.counts.checking).toBe(0);
});

test("a selected-only run excludes the unselected child's earlier request from progress", () => {
  const blocks = note(paragraph("p", "Revenue £20 and costs £20."));
  const element = findBlock(blocks, "p");
  const parent = basis(textOf(element));
  const children = figuresInMind(blocks).map(
    (occurrence, index): FigureCheckAttributes => ({
      ...parent,
      ...finding(occurrence),
      state: index === 0 ? "checking" : "supported",
      request: index === 0 ? "active" : "earlier",
      ...(index === 1 && { kept: true }),
    }),
  );
  markSentence(element, 0, textOf(element).length, {
    ...parent,
    request: "active",
    figures: children,
    remainder: null,
  });
  expect(project(blocks).progress).toEqual({ done: 0, total: 1 });
});

test("horizontal source proof uses actual source columns rather than matching equal values", () => {
  const blocks = note(
    table(
      row(
        cell("h0", "Item", true),
        cell("h1", "A", true),
        cell("h2", "B", true),
        cell("ht", "Total", true),
      ),
      row(cell("l1", "Revenue"), cell("a1", "10"), cell("b1", "20"), cell("t1", "40")),
    ),
  );
  const source = sourceTable(["Item\tA\tB\tC\tTotal", "Revenue\t10\t20\t10\t40"]);
  const results = figuresInMind(blocks).map((occurrence, index) =>
    checkedResult(occurrence, source.input(2, index === 2 ? 4 : index + 1)),
  );
  const result = augmentFigureFooting(blocks, joinedResult(results), source.documents);
  expect(result.figures?.at(-1)?.sourceFooting).toMatchObject([
    {
      axis: "column",
      sum: 40,
      agrees: true,
      inputs: [{ label: "C", number: { value: 10 }, cell: { ref: "D2" } }],
    },
  ]);
});

test("a source's own inconsistent sum is proved rather than inferred from a residual", () => {
  const blocks = note(
    table(
      row(cell("h0", "Item", true), cell("h1", "Amount", true)),
      row(cell("l1", "A"), cell("a1", "10")),
      row(cell("l2", "B"), cell("a2", "20")),
      row(cell("lt", "Total"), cell("at", "35")),
    ),
  );
  const source = sourceTable(["Item\tAmount", "A\t10", "B\t20", "C\t4", "Total\t35"]);
  const results = figuresInMind(blocks).map((occurrence, index) =>
    checkedResult(occurrence, source.input(index === 2 ? 5 : index + 2)),
  );
  expect(
    augmentFigureFooting(blocks, joinedResult(results), source.documents).figures?.at(-1)
      ?.sourceFooting,
  ).toMatchObject([
    { sum: 34, agrees: false, inputs: [{ number: { value: 4 }, cell: { ref: "B4" } }] },
  ]);
});

test.each(["unrelated-version", "unread-row", "over-limit"] as const)(
  "%s source evidence never produces an invented omission",
  (problem) => {
    const extra =
      problem === "over-limit"
        ? Array.from({ length: 31 }, (_, index) => `C${index}\t1`)
        : [`C\t${problem === "unread-row" ? "N/A" : "5"}`];
    const total = problem === "over-limit" ? "61" : "35";
    const blocks = note(
      table(
        row(cell("h0", "Item", true), cell("h1", "Amount", true)),
        row(cell("l1", "A"), cell("a1", "10")),
        row(cell("l2", "B"), cell("a2", "20")),
        row(cell("lt", "Total"), cell("at", total)),
      ),
    );
    const lines = ["Item\tAmount", "A\t10", "B\t20", ...extra, `Total\t${total}`];
    const source = sourceTable(lines);
    const results = figuresInMind(blocks).map((occurrence, index) => {
      const read = source.input(index === 2 ? lines.length : index + 2);
      const input =
        problem === "unrelated-version" && index === 0
          ? { ...read, citation: { ...read.citation, contentHash: "another-version" } }
          : read;
      return checkedResult(occurrence, input);
    });
    expect(
      augmentFigureFooting(blocks, joinedResult(results), source.documents).figures?.at(-1)
        ?.sourceFooting,
    ).toEqual([]);
  },
);

test("atom-owned Check closure retains source, unit and supplemental references", () => {
  const source = sourceTable(["Item\tAmount", "A\t10"]);
  const input = source.input(2);
  const figure = calculatedFigureNode(
    {
      label: "A",
      formula: "source",
      inputs: [input],
      value: 10,
      unit: { kind: "plain" },
      approximate: false,
      shown: "10",
      show: { language: "en", as: "number", decimals: 0, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
    },
    "atom",
    null,
  );
  const blocks = note({ type: "paragraph", attrs: { id: "p" }, content: [figure] });
  const occurrence = figuresInMind(blocks)[0];
  if (!occurrence) throw new Error("No atom occurrence");
  const unit = { ...input.citation, documentId: "unit", contentHash: "unit-v1" };
  const omitted = {
    ...input,
    citation: { ...input.citation, documentId: "omitted", contentHash: "omitted-v1" },
  };
  const attempted = {
    ...input.citation,
    documentId: "attempted",
    contentHash: "attempted-v1",
    check: "not-found" as const,
    checkReason: "quote-not-on-pages" as const,
  };
  markOccurrence(blocks, occurrence, {
    source: attempted,
    sourceInput: {
      ...input,
      unitStatement: { citation: unit, scale: 1, scaleWord: null, currency: null },
    },
    footing: [
      {
        id: occurrence.id,
        axis: "row",
        role: "total",
        componentIds: [],
        excludedIds: [],
        sum: 0,
        difference: -10,
        agrees: false,
      },
    ],
    sourceFooting: [{ axis: "row", componentIds: [], inputs: [omitted], sum: 10, agrees: true }],
  });
  const atom = findBlock(blocks, "p").get(0);
  expect(atom instanceof Y.XmlElement && atom.getAttribute("claimCheck")).toBeTruthy();
  expect(new Set(figureCitations(blocks).map((citation) => citation.documentId))).toEqual(
    new Set(["accounts", "unit", "omitted", "attempted"]),
  );
  expect(project(blocks).rows[0]?.locator).toMatchObject({
    from: { offset: 0 },
    to: { offset: 1 },
  });
});

test("concurrent visible copies of one Check id retain both source closures", () => {
  const blocks = note(paragraph("p1", "Revenue £20."), paragraph("p2", "Costs £30."));
  const source = sourceTable(["Item\tAmount", "A\t20", "B\t30"]);
  for (const [index, occurrence] of figuresInMind(blocks).entries()) {
    if (occurrence.locator.kind !== "text") throw new Error("No text figure");
    const element = findBlock(blocks, occurrence.locator.from.blockId);
    const parent = basis(textOf(element));
    const input = source.input(index + 2);
    markSentence(element, 0, textOf(element).length, {
      ...parent,
      figures: [
        {
          ...parent,
          ...finding(occurrence),
          sourceInput: { ...input, citation: { ...input.citation, documentId: `source-${index}` } },
        },
      ],
      remainder: null,
    });
  }
  expect(new Set(figureCitations(blocks).map((citation) => citation.documentId))).toEqual(
    new Set(["source-0", "source-1"]),
  );
});

test("the existing Citation session checks quotes with only its read port and refuses search", async () => {
  const source = sourceTable(["Item\tAmount", "A\t10"]);
  const { citationSource, pageTexts, documentDate } = source.documents;
  const session = createCitationSession(
    { citationSource, pageTexts, documentDate },
    { onRecord: () => undefined },
  );
  const passage = citationSource("passage");
  if (!passage) throw new Error("No source Passage");
  session.show([{ ...passage, seq: 0, position: 0, windowFrom: 0, windowTo: 0 }]);
  const quote = session.quotes.quote(
    {
      passage: "P1",
      location: "Accounts, row 2",
      quote: "A\t10",
    },
    { structured: true },
  );
  expect("check" in quote && quote.check().check).toBe("found");
  expect(() => session.tools.documentCount).toThrow(/unavailable/);
  expect(() => session.find("A")).toThrow(/unavailable/);
  await expect(session.tools.searchDocuments("A")).rejects.toThrow(/unavailable/);
  await expect(session.tools.searchDocuments("A")).rejects.toThrow(/unavailable/);
});

test("whole-parent Keep applies to every stored child until a selected recheck reopens it", () => {
  const blocks = note(paragraph("p", "Revenue £20 and costs £30."));
  const element = findBlock(blocks, "p");
  const parent = basis(textOf(element));
  const figures = figuresInMind(blocks).map(
    (occurrence, index): FigureCheckAttributes => ({
      ...parent,
      ...finding(occurrence),
      state: index === 1 ? "contradicted" : "supported",
    }),
  );
  markSentence(element, 0, textOf(element).length, {
    ...parent,
    kept: true,
    figures,
    remainder: null,
  });
  expect(project(blocks).rows.map((row) => row.shown.state)).toEqual(["kept", "kept"]);
});

test("an inserted cell inherits the explicit column role from its visual column", () => {
  const blocks = note(
    table(
      row(cell("h0", "Item", true), cell("h1", "A", true), cell("h2", "B", true), {
        ...cell("ht", "Net", true),
        attrs: { figureColumnRole: "total" },
      }),
      row(cell("l1", "Revenue"), cell("a1", "10"), cell("b1", "20"), cell("t1", "30")),
    ),
  );
  expect(project(blocks).rows.at(-1)?.footing).toMatchObject([
    { axis: "column", sum: 30, agrees: true },
  ]);
});

test("the schedule includes compact used Analysis closure once and isolates a corrupt run", async () => {
  const { installFigureRuns } = await import("../../src/shared/figureRuns");
  const source = sourceTable(["Item\tAmount", "A\t10", "B\t20"]);
  const input = source.input(2);
  const atom = (id: string, value: number) =>
    calculatedFigureNode(
      {
        label: id,
        formula: "",
        inputs: [],
        value,
        unit: { kind: "plain" },
        approximate: false,
        shown: String(value),
        show: { language: "en", as: "number", decimals: 0, scale: null },
        literals: [],
        engine: FORMULA_VERSION,
        written: null,
        analysis: { analysis: 1, result: "total" },
      },
      `figure-${id}`,
      id,
    );
  const blocks = note(
    { type: "paragraph", attrs: { id: "a" }, content: [atom("run-a", 10)] },
    { type: "paragraph", attrs: { id: "b" }, content: [atom("run-b", 20)] },
  );
  const doc = blocks.doc;
  if (!doc) throw new Error("No Note document");
  installFigureRuns(
    doc,
    [10, 20].map((value) => ({
      id: value === 10 ? "run-a" : "run-b",
      title: "Revenue",
      language: "python",
      code: "result('total', inputs['sales'].sum())",
      inputs: [
        {
          kind: "range",
          name: "sales",
          citation: input.citation,
          range: "A1:B3",
          rows: 2,
          columns: 2,
          rowCount: 2,
          cut: false,
          sha256: "range",
        },
      ],
      versions: null,
      codeSha256: "code",
      ranAt: "2026-10-27T00:00:00.000Z",
      values: [
        { kind: "figure", name: "total", label: "Revenue", unit: null, value },
        { kind: "figure", name: "unused", label: "Unused", unit: null, value: 999 },
      ],
    })),
  );
  for (const occurrence of figuresInMind(blocks)) markOccurrence(blocks, occurrence);
  const complete = project(blocks);
  expect(complete.analyses).toHaveLength(2);
  expect(complete.analyses[0]?.values).toHaveLength(1);
  expect(complete.analyses[0]).not.toHaveProperty("output");
  // The range its Analysis read is the figure's input, in the schedule and in the workpaper.
  const first = complete.rows[0];
  if (!first) throw new Error("No Analysis row");
  const [read] = childrenOf(first, complete);
  if (!read) throw new Error("The Analysis row has no input");
  expect(lineShows(read, "en")).toMatchObject({
    name: "sales",
    value: "A1:B3 · 2 rows",
    citation: input.citation,
    status: { word: "claim.state.supported" },
  });
  const book = figureScheduleBook(complete, { language: "en", modelName: () => "" });
  expect(book.sheets[0]?.rows.find((each) => each.id === read.id)?.cells[0]).toMatchObject({
    column: "figure",
    value: { kind: "text", text: "sales" },
  });
  doc.getMap("figureRuns").delete(JSON.stringify(["run-b"]));
  const before = Y.encodeStateAsUpdate(doc);
  const partial = project(blocks);
  expect(partial.analyses.map((run) => run.id)).toEqual(["run-a"]);
  expect(partial.rows.map((row) => row.shown.state)).toEqual(["supported", "not-checked"]);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
});

test.each([
  { name: "another sentence before it is edited", edit: [0, "Overall, "], state: "supported" },
  { name: "its own sentence is edited", edit: [27, " net"], state: "needs-recheck" },
] as const)(
  "a figure's result stands when $name only if its sentence is unchanged",
  ({ edit, state }) => {
    const blocks = note(paragraph("p", "Costs were flat. Revenue was £20."));
    const block = blocks.get(0);
    const before = figuresInMind(blocks)[0];
    if (!(block instanceof Y.XmlElement) || !before) throw new Error("Missing fixture");
    const from = textOf(block).indexOf("Revenue");
    const sentence = textOf(block).slice(from);
    const parent = basis(sentence);
    markSentence(block, from, textOf(block).length, {
      ...parent,
      figures: [{ ...parent, ...finding(before) }],
      remainder: null,
    });
    expect(project(blocks).rows.map((row) => row.shown.state)).toEqual(["supported"]);
    const text = block.get(0);
    if (!(text instanceof Y.XmlText)) throw new Error("Missing text");
    text.insert(edit[0], edit[1]);
    expect(project(blocks).rows.map((row) => row.shown.state)).toEqual([state]);
  },
);

// protects=a figure the User marked Checked by me shows their mark on its row, and as changed once its sentence's words change, while the mark itself is kept (D280, #1933); fails_when=the row has no mark, still says checked after the edit, or the mark goes; no_claim=a Document's newer version, which signOffs.test covers.
test("a figure's own check shows on its row, and as changed once its sentence changes", () => {
  const blocks = note(paragraph("p", "Revenue rose 5% in the year."));
  const doc = blocks.doc;
  if (!doc) throw new Error("No note document");
  const [row] = project(blocks).rows;
  if (!row) throw new Error("No figure row");
  addSignOff(doc, {
    id: "mark",
    target: { kind: "figure", id: row.id },
    at: "2026-10-28T09:00:00.000Z",
    contentHash: figureSignOffBasis(row),
    deletedAt: null,
    name: "Ada Lovelace",
    personId: "person-1",
  });
  const mine = (rows: ReturnType<typeof project>["rows"]) => rows[0]?.signOff ?? null;

  expect(
    mine(figureSchedule({ ...scheduleInput(blocks), personId: "person-1" }).rows),
  ).toMatchObject({ state: "checked", name: "Ada Lovelace", mine: true });
  expect(
    mine(figureSchedule({ ...scheduleInput(blocks), personId: "person-2" }).rows),
  ).toMatchObject({ state: "checked", mine: false });

  const text = blocks.get(0);
  if (!(text instanceof Y.XmlElement)) throw new Error("No paragraph");
  const words = text.get(0);
  if (!(words instanceof Y.XmlText)) throw new Error("No text");
  words.insert(0, "Group ");
  expect(
    mine(figureSchedule({ ...scheduleInput(blocks), personId: "person-1" }).rows),
  ).toMatchObject({ state: "changed", target: { kind: "figure", id: row.id } });
});

function scheduleInput(blocks: Y.XmlFragment) {
  return {
    mindId: "note",
    name: "Figures",
    basis: "exact-basis",
    blocks,
    versions: new Map<string, string>(),
    folderId: null,
    scope: null,
  };
}
