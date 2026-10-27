import { getSchema } from "@tiptap/core";
import { DOMSerializer, DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { parseHTML } from "linkedom";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import {
  checkedSentences,
  checkText,
  everySentence,
  markSentence,
  selectedSentences,
  unmarkSentence,
  updateCheck,
} from "../../src/core/answers/checks/sentences";
import { type ClaimCheckAttributes, MIND_CONTENT_FIELD } from "../../src/core/api";
import { figureSchedule } from "../../src/core/figureSchedule";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { everythingChecked, noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { type ChartAttributes, chartCheckText, readChart } from "../../src/shared/charts";

const schema = getSchema(noteExtensions());
function chart(kind: ChartAttributes["kind"] = "bar"): ChartAttributes {
  const value = (n: number) => ({
    shown: String(n),
    value: n,
    unit: { kind: "plain" as const },
    scale: 1,
    citation: null,
    from: { kind: "text" as const, line: 0 },
  });
  return {
    kind,
    title: "Revenue / 收入",
    drawn: null,
    source: { kind: "figures" },
    data: {
      labelHeading: "Period",
      series: ["2024", "2025"],
      rows: [{ label: "A", values: [value(10), value(20)] }],
      cutFrom: null,
      cutRows: [],
    },
  };
}
function setup(kind: ChartAttributes["kind"] = "bar") {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const element = createElement({ type: "chart", attrs: { id: "chart", ...chart(kind) } });
  blocks.push([element]);
  return { doc, blocks, element };
}
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

test.each(["bar", "pie", "scatter"] as const)(
  "a %s chart has one canonical owner for its actual plotted quantities",
  (kind) => {
    const { blocks, element } = setup(kind);
    const sentences = everySentence(blocks);
    expect(sentences).toHaveLength(1);
    const sentence = sentences[0];
    if (!sentence) throw new Error("No chart sentence");
    expect(sentence).toMatchObject({
      element,
      from: 0,
      to: 1,
      text: chartCheckText(readChart(element.getAttributes())),
    });
    expect(sentence.figures).toHaveLength(kind === "pie" ? 1 : 2);
    expect(checkText(sentence).claim).toBe(sentence.text);
    const selected = selectedSentences(blocks, [
      { from: { blockId: "chart", offset: 0 }, to: { blockId: "chart", offset: 1 } },
    ]);
    expect(selected.ok && selected.sentences).toHaveLength(1);
  },
);

function checkedChart(blocks: Y.XmlFragment, element: Y.XmlElement) {
  const sentence = everySentence(blocks)[0];
  if (!sentence?.figures) throw new Error("No chart sentence");
  const parent = basis(sentence.text);
  const figures = sentence.figures.map((figure, index) => ({
    ...parent,
    ...figure,
    state: index === 1 ? ("contradicted" as const) : ("supported" as const),
    sourceInput: null,
    source: null,
    roundedFrom: null,
    difference: null,
    footing: [],
  }));
  markSentence(element, 0, 1, { ...parent, figures, remainder: null });
  return { parent, figures };
}

test("the same chart Check survives core/editor round trip, update, Undo and removal", () => {
  const { doc, blocks, element } = setup();
  const undo = new Y.UndoManager(blocks);
  onTestFinished(() => undo.destroy());
  checkedChart(blocks, element);
  expect(checkedSentences(blocks)).toHaveLength(1);
  const pm = yXmlFragmentToProseMirrorRootNode(blocks, schema);
  expect(claimSpans(pm)).toMatchObject([
    { kind: "chart", from: 0, to: 1, sentence: { text: chartCheckText(chart()) } },
  ]);
  const copied = new Y.Doc();
  onTestFinished(() => copied.destroy());
  prosemirrorToYXmlFragment(pm, copied.getXmlFragment(MIND_CONTENT_FIELD));
  expect(
    checkedSentences(copied.getXmlFragment(MIND_CONTENT_FIELD))[0]?.check.figures,
  ).toHaveLength(2);
  undo.undo();
  expect(checkedSentences(blocks)).toEqual([]);
  undo.redo();
  expect(checkedSentences(blocks)).toHaveLength(1);
  expect(
    updateCheck(blocks, "check", (check) => ({
      ...check,
      state: "not-checked",
      reason: "stopped",
    })),
  ).toBe(true);
  expect(checkedSentences(blocks)[0]?.check.reason).toBe("stopped");
  expect(unmarkSentence(element, 0, 1, "check-against-documents")).toBe(true);
  expect(checkedSentences(blocks)).toEqual([]);
  expect(doc.getXmlFragment(MIND_CONTENT_FIELD).length).toBe(1);
});

test("one bad chart child prevents all-good health and counts its owner once", () => {
  const { blocks, element } = setup();
  const { figures } = checkedChart(blocks, element);
  const pm = yXmlFragmentToProseMirrorRootNode(blocks, schema);
  const projected = claimsOf(pm, {
    versions: null,
    folderId: null,
    scope: null,
    figureContexts: new Map(figures.map((figure) => [figure.id, figure.context ?? ""])),
  });
  expect(projected.claims).toMatchObject([{ kind: "chart", shown: { state: "contradicted" } }]);
  const health = noteHealth(pm, { ...projected, citationCheck: (citation) => citation.check });
  expect(health.checkable).toBe(1);
  expect(health.contradicted).toEqual([0]);
  expect(everythingChecked(health, { running: false, problem: false })).toBe(false);
});

test.each(["title", "row-label", "series-label", "shown", "coordinate"] as const)(
  "a changed chart %s has one stale core/renderer basis",
  (change) => {
    const { blocks, element } = setup();
    checkedChart(blocks, element);
    const check = checkedSentences(blocks)[0]?.check;
    if (!check) throw new Error("No chart check");
    const changed = chart();
    const first = changed.data.rows[0];
    if (!first?.values[0]) throw new Error("No chart value");
    if (change === "title") changed.title = "新收入";
    else if (change === "row-label") first.label = "B";
    else if (change === "series-label") changed.data.series[0] = "2023";
    else if (change === "shown") first.values[0].shown = "11";
    else first.values[0].value = 10.01;
    blocks.delete(0, 1);
    blocks.push([
      createElement({ type: "chart", attrs: { id: "chart", ...changed, claimCheck: check } }),
    ]);
    const pm = yXmlFragmentToProseMirrorRootNode(blocks, schema);
    expect(claimSpans(pm)[0]?.sentence.text).toBe(checkedSentences(blocks)[0]?.sentence);
    expect(claimSpans(pm)[0]?.sentence.text).not.toBe(check.text);
    const current = figuresInMind(blocks);
    const projected = claimsOf(pm, {
      versions: null,
      folderId: null,
      scope: null,
      figureContexts: new Map(current.map((figure) => [figure.id, figure.context])),
    });
    expect(projected.claims[0]?.shown.state).toBe("needs-recheck");
    const schedule = figureSchedule({
      mindId: "note",
      name: "Chart",
      basis: "current",
      blocks,
      versions: null,
      folderId: null,
      scope: null,
    });
    expect(schedule.rows.every((row) => row.sentence === null)).toBe(true);
    expect(schedule.rows.every((row) => row.shown.state === "needs-recheck")).toBe(true);
  },
);

test("a Chart's internal Check is never serialized or imported from HTML", () => {
  const { blocks, element } = setup();
  checkedChart(blocks, element);
  const pm = yXmlFragmentToProseMirrorRootNode(blocks, schema);
  const { document } = parseHTML("<html><body></body></html>");
  const container = document.createElement("div");
  container.appendChild(
    DOMSerializer.fromSchema(schema).serializeFragment(pm.content, { document }),
  );
  expect(container.innerHTML).not.toContain("data-claim-check");
  const chartElement = container.querySelector('[data-type="chart"]');
  if (!chartElement) throw new Error("No serialized Chart");
  chartElement.setAttribute("data-claim-check", JSON.stringify(checkedSentences(blocks)[0]?.check));
  const pasted = ProseMirrorDOMParser.fromSchema(schema).parse(container);
  expect(pasted.child(0).attrs.claimCheck).toBeNull();
  expect(claimSpans(pasted)).toEqual([]);
});

test("an unchecked Chart contributes one to-check owner rather than disappearing from health", () => {
  const { blocks } = setup();
  const pm = yXmlFragmentToProseMirrorRootNode(blocks, schema);
  const projected = claimsOf(pm, { versions: null, folderId: null, scope: null });
  const health = noteHealth(pm, { ...projected, citationCheck: (citation) => citation.check });
  expect(health.checkable).toBe(1);
  expect(health.toCheck).toEqual([0]);
  expect(everythingChecked(health, { running: false, problem: false })).toBe(false);
});
