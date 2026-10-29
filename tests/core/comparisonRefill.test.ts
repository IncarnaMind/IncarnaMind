import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  COMPARISON_CELL_NODE,
  COMPARISON_TABLE_NODE,
  MIND_CONTENT_FIELD,
  MIND_SIGN_OFFS_FIELD,
} from "../../src/core";
import { createElement } from "../../src/core/answers/blocks";
import { cellIndex } from "../../src/core/documents/formats/sheetLayout";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { comparisonQuestionsOf } from "../../src/shared/comparisons";
import {
  addSignOff,
  comparisonCellReviewed,
  comparisonCellTarget,
  readSignOff,
  signOffsOf,
} from "../../src/shared/signOffs";
import { setUpWithDocuments } from "../helpers/citations";
import { type cellAsked, cellModel, compare, fillEnded } from "../helpers/comparisons";
import { startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { scriptedModels } from "../helpers/models";

const FILES = [
  { name: "Acme.txt", contents: "Acme.\nTermination notice: 90 days." },
  { name: "Brandt.txt", contents: "Brandt.\nTermination notice: 30 days." },
];

function tableElement(client: MindClient, tableId: string): Y.XmlElement {
  const table = client.doc
    .getXmlFragment(MIND_CONTENT_FIELD)
    .toArray()
    .find(
      (element): element is Y.XmlElement =>
        element instanceof Y.XmlElement &&
        element.nodeName === COMPARISON_TABLE_NODE &&
        element.getAttribute("id") === tableId,
    );
  if (!table) throw new Error("The comparison table is gone.");
  return table;
}

function cellElement(client: MindClient, tableId: string, documentId: string): Y.XmlElement {
  const row = tableElement(client, tableId)
    .toArray()
    .find(
      (element): element is Y.XmlElement =>
        element instanceof Y.XmlElement && element.getAttribute("documentId") === documentId,
    );
  const cell = row?.toArray()[0];
  if (!(cell instanceof Y.XmlElement)) throw new Error("The comparison cell is gone.");
  return cell;
}

function reviewCell(client: MindClient, tableId: string, documentId: string, questionId: string) {
  addSignOff(client.doc, {
    id: `sign-off-${documentId}`,
    target: comparisonCellTarget(tableId, documentId, questionId),
    at: "2026-10-28T10:00:00.000Z",
    contentHash: "before-fill",
    deletedAt: null,
  });
}

function reviewed(
  client: MindClient,
  tableId: string,
  documentId: string,
  questionId: string,
): boolean {
  return comparisonCellReviewed(
    signOffsOf(client.doc),
    comparisonCellTarget(tableId, documentId, questionId),
  );
}

function removedAt(client: MindClient, documentId: string): string | null | undefined {
  return readSignOff(client.doc.getMap(MIND_SIGN_OFFS_FIELD).get(`sign-off-${documentId}`))
    ?.deletedAt;
}

async function setup(model = cellModel()) {
  const setup = await setUpWithDocuments(model, FILES);
  const { core, client, mind, documents } = setup;
  const tableId = await compare(core, client, {
    mindId: mind.id,
    documentIds: documents.map((document) => document.id),
    questions: ["Termination notice"],
  });
  const questionId = comparisonQuestionsOf(tableElement(client, tableId).getAttributes())[0]?.id;
  if (!questionId) throw new Error("The table has no Question.");
  return { ...setup, tableId, questionId };
}

describe("A targeted comparison refill", () => {
  test("an explicit edited and reviewed cell alone is replaced, clears its marks, and asks no neighbour", async () => {
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first, second] = documents;
    if (!first || !second) throw new Error("The fixture is short of Documents.");
    asked.length = 0;
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("edited", "true");
      reviewCell(client, tableId, first.id, questionId);
      cell.setAttribute("fillId", "pass-1");
      cell.delete(0, cell.length);
      cell.insert(0, [
        createElement({ type: "paragraph", content: [{ type: "text", text: "My answer" }] }),
      ]);
    });
    const otherBefore = cellElement(client, tableId, second.id).toString();
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-1",
    });
    if (!result.started) throw new Error(`The refill did not start: ${JSON.stringify(result)}`);
    await ended;
    await client.settled();

    expect([...new Set(asked.map((call) => call.document))]).toEqual(["Acme"]);
    const cell = cellElement(client, tableId, first.id);
    expect(cell.getAttribute("status")).toBe("done");
    expect(cell.getAttribute("edited")).toBeUndefined();
    expect(reviewed(client, tableId, first.id, questionId)).toBe(false);
    expect(cell.toString()).toContain("90 days");
    expect(cell.toString()).not.toContain("My answer");
    expect(cellElement(client, tableId, second.id).toString()).toBe(otherBefore);
  });

  test("a failed explicit refill keeps the old Answer and its sign-off", async () => {
    let missing = false;
    const model = cellModel(() => (missing ? { text: "NOT_FOUND" } : null));
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("edited", "true");
      cell.setAttribute("fillId", "pass-missing");
      reviewCell(client, tableId, first.id, questionId);
    });
    missing = true;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-missing",
    });
    if (!result.started) throw new Error("The refill did not start.");
    await ended;
    await client.settled();

    const cell = cellElement(client, tableId, first.id);
    expect(cell.getAttribute("status")).toBe("failed");
    expect(cell.getAttribute("problem")).toBe("not-found");
    expect(cell.getAttribute("edited")).toBe("true");
    expect(cell.toString()).toContain("90 days");
    expect(reviewed(client, tableId, first.id, questionId)).toBe(true);
    expect(removedAt(client, first.id)).toBeNull();

    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Export failed: ${saved.status}`);
    const { sheets } = await readWorkbook(
      new Uint8Array(await readFile(saved.file.path)),
      undefined,
      {},
    );
    const exported = JSON.stringify(sheets);
    expect(exported).toContain("90 days");
    expect(exported).toContain("Termination notice: 90 days.");
    expect(sheets[0]?.layout?.notes.get(cellIndex(2, 1))).toContain("not found");
  });

  test("exact cells and a column scope fill together, not one without the other", async () => {
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    asked.length = 0;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      questionIds: [questionId],
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
    });
    if (!result.started) throw new Error("The refill did not start.");
    await ended;
    await client.settled();

    expect([...new Set(asked.map((call) => call.document))].sort()).toEqual(["Acme", "Brandt"]);
  });

  test("Stop restores the old Answer and marks instead of leaving a waiting or empty cell", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const model = cellModel(() =>
      paused ? { text: "90 days [^1]", pause: { after: 0, until: held } } : null,
    );
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("edited", "true");
      reviewCell(client, tableId, first.id, questionId);
      cell.setAttribute("fillId", "pass-stop");
      cell.delete(0, cell.length);
      cell.insert(0, [
        createElement({ type: "paragraph", content: [{ type: "text", text: "My answer" }] }),
      ]);
    });
    paused = true;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-stop",
    });
    if (!result.started) throw new Error("The refill did not start.");
    await vi.waitFor(() => {
      expect(cellElement(client, tableId, first.id).getAttribute("status")).toBe("writing");
    });
    expect(cellElement(client, tableId, first.id).toString()).toContain("My answer");

    await core.stopComparisonTable({ mindId: mind.id, tableId });
    await ended;
    release();
    await client.settled();

    const cell = cellElement(client, tableId, first.id);
    expect(cell.getAttribute("status")).toBe("done");
    expect(cell.getAttribute("edited")).toBe("true");
    expect(reviewed(client, tableId, first.id, questionId)).toBe(true);
    expect(cell.toString()).toContain("My answer");
    expect(cell.toString()).not.toContain("90 days");
    expect((await core.listTasks()).find((task) => task.blockId === tableId)?.status).toBe(
      "stopped",
    );
  });

  test("a provider failure keeps the old Answer and marks, with a retryable failure state", async () => {
    let failing = false;
    const model = cellModel(() =>
      failing ? { error: { status: 500, message: "provider down" } } : null,
    );
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("edited", "true");
      reviewCell(client, tableId, first.id, questionId);
      cell.setAttribute("fillId", "pass-failure");
      cell.delete(0, cell.length);
      cell.insert(0, [
        createElement({ type: "paragraph", content: [{ type: "text", text: "My answer" }] }),
      ]);
    });
    failing = true;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-failure",
    });
    if (!result.started) throw new Error("The refill did not start.");
    await ended;
    await client.settled();

    const cell = cellElement(client, tableId, first.id);
    expect(cell.getAttribute("status")).toBe("failed");
    expect(cell.getAttribute("edited")).toBe("true");
    expect(reviewed(client, tableId, first.id, questionId)).toBe(true);
    expect(cell.toString()).toContain("My answer");
  });

  test("ordinary Fill leaves a failed hand-edited cell and its marks whole", async () => {
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("status", "failed");
      cell.setAttribute("problem", "network");
      cell.setAttribute("edited", "true");
      reviewCell(client, tableId, first.id, questionId);
      cell.setAttribute("fillId", "pass-failed");
      cell.delete(0, cell.length);
      cell.insert(0, [
        createElement({ type: "paragraph", content: [{ type: "text", text: "My answer" }] }),
      ]);
    });
    const before = cellElement(client, tableId, first.id).toString();
    asked.length = 0;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({ mindId: mind.id, tableId });
    if (!result.started) throw new Error("The ordinary fill did not start.");
    await ended;
    await client.settled();

    expect(asked).toEqual([]);
    expect(cellElement(client, tableId, first.id).toString()).toBe(before);
  });

  test("a late result cannot overwrite a newer pass or User edit", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const model = cellModel(() =>
      paused ? { text: "90 days [^1]", pause: { after: 0, until: held } } : null,
    );
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      cellElement(client, tableId, first.id).setAttribute("fillId", "pass-old");
    });
    paused = true;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-old",
    });
    if (!result.started) throw new Error("The refill did not start.");
    await vi.waitFor(() => {
      expect(cellElement(client, tableId, first.id).getAttribute("status")).toBe("writing");
    });
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("fillId", "pass-new");
      cell.delete(0, cell.length);
      cell.insert(0, [
        createElement({ type: "paragraph", content: [{ type: "text", text: "Newer user words" }] }),
      ]);
    });
    release();
    await ended;
    await client.settled();

    const cell = cellElement(client, tableId, first.id);
    expect(cell.getAttribute("fillId")).toBe("pass-new");
    expect(cell.toString()).toContain("Newer user words");
    expect(cell.toString()).not.toContain("90 days");
  });

  test("a newer pass for the same cell replaces the live request's scope", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return paused ? { text: "90 days [^1]", pause: { after: 0, until: held } } : null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      cellElement(client, tableId, first.id).setAttribute("fillId", "pass-old");
    });
    paused = true;
    const ended = fillEnded(core, tableId);
    const old = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-old",
    });
    if (!old.started) throw new Error("The old refill did not start.");
    await vi.waitFor(() => {
      expect(cellElement(client, tableId, first.id).getAttribute("status")).toBe("writing");
    });
    client.doc.transact(() => {
      cellElement(client, tableId, first.id).setAttribute("fillId", "pass-new");
    });
    const newer = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-new",
    });
    if (!newer.started) throw new Error("The newer refill did not start.");
    paused = false;
    release();
    await ended;
    await client.settled();

    const cell = cellElement(client, tableId, first.id);
    expect(cell.getAttribute("status")).toBe("done");
    expect(cell.getAttribute("fillId")).toBe("pass-new");
    expect(cell.toString()).toContain("90 days");
  });

  test("ordinary Fill reaches new cells while an older pass is live", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const model = cellModel(() =>
      paused ? { text: "90 days [^1]", pause: { after: 0, until: held } } : null,
    );
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      cellElement(client, tableId, first.id).setAttribute("fillId", "pass-old");
    });
    paused = true;
    const ended = fillEnded(core, tableId);
    const old = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill",
      pass: "pass-old",
    });
    if (!old.started) throw new Error("The old refill did not start.");
    await vi.waitFor(() => {
      expect(cellElement(client, tableId, first.id).getAttribute("status")).toBe("writing");
    });
    const added = { id: "q-new", text: "Termination notice" };
    client.doc.transact(() => {
      const table = tableElement(client, tableId);
      table.setAttribute("questions", [
        ...comparisonQuestionsOf(table.getAttributes()),
        added,
      ] as never);
      for (const row of table.toArray()) {
        if (!(row instanceof Y.XmlElement)) continue;
        row.push([
          createElement({
            type: COMPARISON_CELL_NODE,
            attrs: { questionId: added.id, status: "waiting" },
            content: [{ type: "paragraph" }],
          }),
        ]);
      }
    });
    const ordinary = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      questionIds: [added.id],
    });
    if (!ordinary.started) throw new Error("The ordinary fill did not start.");
    paused = false;
    release();
    await ended;
    await client.settled();

    for (const row of tableElement(client, tableId).toArray()) {
      if (!(row instanceof Y.XmlElement)) continue;
      const cell = row
        .toArray()
        .find(
          (each): each is Y.XmlElement =>
            each instanceof Y.XmlElement && each.getAttribute("questionId") === added.id,
        );
      expect(cell?.getAttribute("status")).toBe("done");
    }
  });

  test("a one-Question column refill is still bulk and preserves a protected cell", async () => {
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [protectedDocument, ordinaryDocument] = documents;
    if (!protectedDocument || !ordinaryDocument) throw new Error("Two Documents are needed.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, protectedDocument.id);
      cell.setAttribute("edited", "true");
      reviewCell(client, tableId, protectedDocument.id, questionId);
      cell.setAttribute("fillId", "pass-column");
      cellElement(client, tableId, ordinaryDocument.id).setAttribute("fillId", "pass-column");
    });
    const protectedBefore = cellElement(client, tableId, protectedDocument.id).toString();
    asked.length = 0;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      questionIds: [questionId],
      mode: "refill",
      pass: "pass-column",
    });
    if (!result.started) throw new Error("The column refill did not start.");
    await ended;
    await client.settled();

    expect([...new Set(asked.map((call) => call.document))]).toEqual(["Brandt"]);
    expect(cellElement(client, tableId, protectedDocument.id).toString()).toBe(protectedBefore);
    expect(cellElement(client, tableId, ordinaryDocument.id).getAttribute("status")).toBe("done");
  });

  test("a protected cell in a bulk with an unfillable neighbour is not mistaken for a single refill", async () => {
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [protectedDocument, removedDocument] = documents;
    if (!protectedDocument || !removedDocument) throw new Error("Two Documents are needed.");
    client.doc.transact(() => {
      const protectedCell = cellElement(client, tableId, protectedDocument.id);
      protectedCell.setAttribute("edited", "true");
      reviewCell(client, tableId, protectedDocument.id, questionId);
      const removedCell = cellElement(client, tableId, removedDocument.id);
      removedCell.setAttribute("status", "failed");
      removedCell.setAttribute("problem", "source-removed");
    });
    asked.length = 0;
    const before = (await core.listTasks()).length;
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: documents.map((document) => ({ documentId: document.id, questionId })),
      mode: "refill",
      pass: "pass-protected",
    });

    expect(result).toEqual({ started: false, reason: "nothing-to-fill" });
    expect(asked).toEqual([]);
    expect(await core.listTasks()).toHaveLength(before);
  });

  test("failed-only refill skips successful cells, while Fill all overrides protection", async () => {
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return null;
    });
    const { core, client, mind, documents, tableId, questionId } = await setup(model);
    const [first, second] = documents;
    if (!first || !second) throw new Error("The fixture is short of Documents.");
    client.doc.transact(() => {
      const failed = cellElement(client, tableId, first.id);
      failed.setAttribute("status", "failed");
      failed.setAttribute("problem", "not-found");
      failed.setAttribute("fillId", "pass-problems");
      const done = cellElement(client, tableId, second.id);
      done.setAttribute("edited", "true");
      reviewCell(client, tableId, second.id, questionId);
      done.setAttribute("fillId", "pass-problems");
    });
    asked.length = 0;
    let ended = fillEnded(core, tableId);
    const problems = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: documents.map((document) => ({ documentId: document.id, questionId })),
      mode: "refill-problems",
      pass: "pass-problems",
    });
    if (!problems.started) throw new Error("The failed-only refill did not start.");
    await ended;
    await client.settled();
    expect([...new Set(asked.map((call) => call.document))]).toEqual(["Acme"]);
    expect(cellElement(client, tableId, second.id).getAttribute("status")).toBe("done");
    expect(removedAt(client, second.id)).toBeNull();
    expect((await core.listTasks()).find((task) => task.blockId === tableId)?.progress).toEqual({
      done: 1,
      total: 1,
    });

    asked.length = 0;
    ended = fillEnded(core, tableId);
    const all = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: documents.map((document) => ({ documentId: document.id, questionId })),
      mode: "refill-all",
      pass: "pass-problems",
    });
    if (!all.started) throw new Error("Fill all did not start.");
    await ended;
    await client.settled();
    expect([...new Set(asked.map((call) => call.document))].sort()).toEqual(["Acme", "Brandt"]);
    for (const document of documents) {
      const cell = cellElement(client, tableId, document.id);
      expect(cell.getAttribute("status")).toBe("done");
      expect(cell.getAttribute("edited")).toBeUndefined();
      expect(reviewed(client, tableId, document.id, questionId)).toBe(false);
    }
    expect(removedAt(client, second.id)).toEqual(expect.any(String));
  });

  test("a passless failed-only refill counts only its eligible cells in progress", async () => {
    const { core, client, mind, documents, tableId, questionId } = await setup();
    const [failed, done] = documents;
    if (!failed || !done) throw new Error("Two Documents are needed.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, failed.id);
      cell.setAttribute("status", "failed");
      cell.setAttribute("problem", "not-found");
    });
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: documents.map((document) => ({ documentId: document.id, questionId })),
      mode: "refill-problems",
    });
    if (!result.started) throw new Error("The failed-only refill did not start.");
    await ended;
    await client.settled();

    expect((await core.listTasks()).find((task) => task.blockId === tableId)?.progress).toEqual({
      done: 1,
      total: 1,
    });
  });

  test("failed-only progress includes cells completed before a quit", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const model = cellModel((_call, cell) =>
      paused && cell.document === "Brandt"
        ? { text: "30 days [^1]", pause: { after: 0, until: held } }
        : null,
    );
    const { core, client, mind, documents, tableId, questionId, dataDir } = await setup(model);
    for (const document of documents) {
      client.doc.transact(() => {
        const cell = cellElement(client, tableId, document.id);
        cell.setAttribute("status", "failed");
        cell.setAttribute("problem", "not-found");
        cell.setAttribute("fillId", "pass-resume-progress");
      });
    }
    paused = true;
    const started = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: documents.map((document) => ({ documentId: document.id, questionId })),
      mode: "refill-problems",
      pass: "pass-resume-progress",
    });
    if (!started.started) throw new Error("The failed-only refill did not start.");
    const [first, second] = documents;
    if (!first || !second) throw new Error("Two Documents are needed.");
    await vi.waitFor(() => {
      expect(cellElement(client, tableId, first.id).getAttribute("status")).toBe("done");
      expect(cellElement(client, tableId, second.id).getAttribute("status")).toBe("writing");
    });
    await core.close();
    paused = false;
    release();
    const reopened = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    try {
      const reopenedClient = await connectToMind(reopened, mind.id);
      await vi.waitFor(() => {
        expect(cellElement(reopenedClient, tableId, second.id).getAttribute("status")).toBe("done");
      });
      expect(
        (await reopened.listTasks()).find((task) => task.blockId === tableId)?.progress,
      ).toEqual({
        done: 2,
        total: 2,
      });
    } finally {
      await reopened.close();
    }
  });

  test("a failed-only refill resumes its in-flight pass after a quit", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const asked: ReturnType<typeof cellAsked>[] = [];
    const model = cellModel((_call, cell) => {
      asked.push(cell);
      return paused ? { text: "90 days [^1]", pause: { after: 0, until: held } } : null;
    });
    const { core, client, mind, documents, tableId, questionId, dataDir } = await setup(model);
    const [first] = documents;
    if (!first) throw new Error("The Document is missing.");
    client.doc.transact(() => {
      const cell = cellElement(client, tableId, first.id);
      cell.setAttribute("status", "failed");
      cell.setAttribute("problem", "not-found");
      cell.setAttribute("fillId", "pass-resume");
    });
    paused = true;
    const started = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      cells: [{ documentId: first.id, questionId }],
      mode: "refill-problems",
      pass: "pass-resume",
    });
    if (!started.started) throw new Error("The failed-only refill did not start.");
    await vi.waitFor(() => {
      expect(cellElement(client, tableId, first.id).getAttribute("status")).toBe("writing");
    });
    const before = asked.length;
    await core.close();
    paused = false;
    release();
    const reopened = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    try {
      const reopenedClient = await connectToMind(reopened, mind.id);
      await vi.waitFor(() => {
        expect(cellElement(reopenedClient, tableId, first.id).getAttribute("status")).toBe("done");
      });
      expect(asked.length).toBeGreaterThan(before);
    } finally {
      await reopened.close();
    }
  });
});
