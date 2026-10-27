import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import {
  type AnswerAnalysis,
  type CalculatedFigureAttributes,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedFigureAnalysis,
} from "../../src/core/api";
import { noAnalysisOutput } from "../../src/shared/analysis";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import {
  figureRunsFor,
  installFigureRuns,
  pruneFigureRuns,
  readFigureRun,
  retainFigureAnalysis,
} from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";

const runId = "answer-1:analysis-1";
const generation: AnswerAnalysis = {
  number: 1,
  title: "Three results",
  language: "python",
  code: "result('a', 10)\nresult('b', 20)\nresult('c', 30)",
  inputs: [],
  versions: null,
  codeSha256: "a".repeat(64),
  outputSha256: "b".repeat(64),
  end: { kind: "done" },
  output: {
    ...noAnalysisOutput(),
    results: [10, 20, 30].map((value, index) => ({
      kind: "figure",
      name: ["a", "b", "c"][index] ?? "",
      label: `Result ${index + 1}`,
      value,
      unit: null,
    })),
  },
  ms: 5,
  ranAt: "2026-10-27T00:00:00.000Z",
  markers: {
    figures: ["a", "b", "c"].map((result, index) => ({ result, marker: index + 1 })),
    tables: [],
    charts: [],
  },
};

function figure(name: "a" | "b" | "c"): CalculatedFigureAttributes {
  const value = { a: 10, b: 20, c: 30 }[name];
  return {
    id: `figure-${name}`,
    analysisId: runId,
    figure: {
      label: name,
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
      analysis: { analysis: 1, result: name },
    },
  };
}

function record(names: ("a" | "b" | "c")[]): RetainedFigureAnalysis {
  const kept = retainFigureAnalysis(generation, runId, names.map(figure));
  if (!kept) throw new Error("The successful generation fixture was not retained.");
  return kept;
}

function blocks(names: ("a" | "b" | "c")[]): NodeJSON[] {
  return names.map((name) => {
    const value = figure(name);
    return calculatedFigureNode(value.figure, value.id, value.analysisId);
  });
}

function append(doc: Y.Doc, name: "a" | "b" | "c") {
  const value = figure(name);
  const node = createElement(calculatedFigureNode(value.figure, value.id, runId));
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([node]);
}

function docWith(names: ("a" | "b" | "c")[]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const name of names) append(doc, name);
    installFigureRuns(doc, [record(names)]);
  });
  return doc;
}

describe("a Note's bounded Analysis dependencies", () => {
  test("keeps one successful run with only named values, not its tables or printed output", () => {
    const kept = retainFigureAnalysis(
      {
        ...generation,
        output: {
          ...generation.output,
          printed: "unrelated output",
          results: [
            ...generation.output.results,
            {
              kind: "table",
              name: "unused",
              label: "Unused",
              unit: null,
              table: { columns: ["x"], rows: [[99]], rowCount: 1, columnCount: 1 },
            },
          ],
        },
      },
      runId,
      [figure("a")],
    );
    expect(kept?.values.map((value) => value.name)).toEqual(["a"]);
    expect(kept).not.toHaveProperty("output");
    expect(kept).not.toHaveProperty("outputSha256");
    expect(kept?.code).toBe(generation.code);
    expect(readFigureRun({ ...kept, output: generation.output })).toEqual(kept);
  });

  test("a failed run or a figure not matching the recorded result is not execution evidence", () => {
    expect(
      retainFigureAnalysis({ ...generation, end: { kind: "stopped" } }, runId, [figure("a")]),
    ).toBeNull();
    const changed = figure("a");
    changed.figure.value = 999;
    expect(retainFigureAnalysis(generation, runId, [changed])).toBeNull();
  });

  test("deleting one figure prunes its value; deleting the last run and Undo are one change", () => {
    const doc = docWith(["a", "b"]);
    const content = doc.getXmlFragment(MIND_CONTENT_FIELD);
    const runs = doc.getMap(MIND_FIGURE_RUNS_FIELD);
    const undo = new Y.UndoManager([content, runs], { trackedOrigins: new Set(["edit"]) });
    let updates = 0;
    doc.on("update", () => updates++);
    doc.transact(() => {
      content.delete(0, 1);
      pruneFigureRuns(doc);
    }, "edit");
    expect(updates).toBe(1);
    expect(figureRunsFor(doc, blocks(["b"]))[0]?.values.map((value) => value.name)).toEqual(["b"]);
    undo.stopCapturing();
    doc.transact(() => {
      content.delete(0, 1);
      pruneFigureRuns(doc);
    }, "edit");
    expect(runs.size).toBe(0);
    undo.undo();
    expect(content.length).toBe(1);
    expect(figureRunsFor(doc, blocks(["b"]))[0]?.values.map((value) => value.name)).toEqual(["b"]);
    undo.undo();
    expect(content.length).toBe(2);
    expect(
      figureRunsFor(doc, blocks(["a", "b"]))[0]
        ?.values.map((value) => value.name)
        .sort(),
    ).toEqual(["a", "b"]);
    undo.redo();
    undo.redo();
    expect(content.length).toBe(0);
    expect(runs.size).toBe(0);
    undo.destroy();
    doc.destroy();
  });

  test("a single-figure copy owns only its required values after the source closes", () => {
    const source = docWith(["a", "b"]);
    const carried = figureRunsFor(source, blocks(["b"]));
    const target = new Y.Doc();
    target.transact(() => {
      append(target, "b");
      installFigureRuns(target, carried);
    });
    source.destroy();
    expect(figureRunsFor(target, blocks(["b"]))[0]?.values.map((value) => value.name)).toEqual([
      "b",
    ]);
    expect(figureRunsFor(target, blocks(["b"]))[0]?.code).toBe(generation.code);
    target.destroy();
  });

  test("invalid later records cannot partially install dependencies", () => {
    const doc = new Y.Doc();
    const invalid = { ...record(["b"]), id: "another", code: 4 };
    expect(() => doc.transact(() => installFigureRuns(doc, [record(["a"]), invalid]))).toThrow();
    expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
    doc.destroy();
  });

  test("a copy refuses a missing, invalid or different Analysis result", () => {
    const source = docWith(["a"]);
    const runs = source.getMap(MIND_FIGURE_RUNS_FIELD);
    const entries = [...runs];
    for (const [key, value] of entries) {
      runs.delete(key);
      expect(() => figureRunsFor(source, blocks(["a"]))).toThrow();
      runs.set(key, value);
      runs.set(key, { invalid: true });
      expect(() => figureRunsFor(source, blocks(["a"]))).toThrow();
      runs.set(key, value);
    }
    const changed = blocks(["a"]);
    const attrs = changed[0]?.attrs;
    if (!attrs) throw new Error("The figure fixture has no attributes.");
    attrs.figure = { ...figure("a").figure, value: 11 };
    expect(() => figureRunsFor(source, changed)).toThrow();
    expect(() => figureRunsFor(source, [...blocks(["a"]), ...changed])).toThrow();
    source.destroy();
  });

  test("a concurrent last-reference deletion does not delete a newly added result", () => {
    const original = docWith(["a"]);
    const removing = new Y.Doc();
    const adding = new Y.Doc();
    Y.applyUpdate(removing, Y.encodeStateAsUpdate(original));
    Y.applyUpdate(adding, Y.encodeStateAsUpdate(original));
    removing.transact(() => {
      removing.getXmlFragment(MIND_CONTENT_FIELD).delete(0, 1);
      pruneFigureRuns(removing);
    });
    adding.transact(() => {
      append(adding, "b");
      installFigureRuns(adding, [record(["b"])]);
      pruneFigureRuns(adding);
    });
    for (const changes of [
      [removing, adding],
      [adding, removing],
    ]) {
      const merged = new Y.Doc();
      merged.transact(() => {
        for (const change of changes) Y.applyUpdate(merged, Y.encodeStateAsUpdate(change));
        pruneFigureRuns(merged);
      });
      expect(merged.getXmlFragment(MIND_CONTENT_FIELD).length).toBe(1);
      expect(figureRunsFor(merged, blocks(["b"]))[0]?.values.map((value) => value.name)).toEqual([
        "b",
      ]);
      expect(merged.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
      merged.destroy();
    }
    removing.destroy();
    adding.destroy();
    original.destroy();
  });

  test("concurrent additions keep each used value from the same generation", () => {
    const original = docWith(["a"]);
    const first = new Y.Doc();
    const second = new Y.Doc();
    Y.applyUpdate(first, Y.encodeStateAsUpdate(original));
    Y.applyUpdate(second, Y.encodeStateAsUpdate(original));
    first.transact(() => {
      append(first, "b");
      installFigureRuns(first, [record(["b"])]);
      pruneFigureRuns(first);
    });
    second.transact(() => {
      append(second, "c");
      installFigureRuns(second, [record(["c"])]);
      pruneFigureRuns(second);
    });
    original.transact(() => {
      Y.applyUpdate(original, Y.encodeStateAsUpdate(first));
      Y.applyUpdate(original, Y.encodeStateAsUpdate(second));
      pruneFigureRuns(original);
    });
    expect(
      figureRunsFor(original, blocks(["a", "b", "c"]))[0]
        ?.values.map((value) => value.name)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    first.destroy();
    second.destroy();
    original.destroy();
  });
});
