import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type CitationAttributes,
  COMPARISON_TABLE_NODE,
  InvalidInputError,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { CLOUD_CELLS_AT_ONCE } from "../../src/core/comparisons";
import { readBlocks } from "../../src/core/mindText";
import { comparisonQuestionsOf } from "../../src/shared/comparisons";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { cellModel, compare, fillEnded } from "../helpers/comparisons";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { footnotesOf, part, textOf, unzip } from "../helpers/docx";
import { exportMind, linkWithExports } from "../helpers/evidence";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import {
  editMind,
  note,
  outline,
  question,
  readMind,
  resolveChanges,
  shownWithAiText,
  writeMind,
} from "../helpers/minds";
import { scriptedModels } from "../helpers/models";

/** Three suppliers' terms, a line each. */
const CORVANE =
  "Corvane Agreement.\nTermination notice: 90 days.\nLiability cap: 12 months of fees.";
const HALVARD =
  "Halvard MSA.\nTermination notice: 6 months.\nLiability cap: twice the annual fees.";
const LUMERIC = "Lumeric Order Form.\nTermination notice: 30 days.\nGoverning law: New York.";

const SUPPLIERS = [
  { name: "Corvane.txt", contents: CORVANE },
  { name: "Halvard.txt", contents: HALVARD },
  { name: "Lumeric.txt", contents: LUMERIC },
];

interface ShownCell {
  status: string;
  problem: string | null;
  text: string;
  citations: CitationAttributes[];
}

/** The Mind's comparison table, as the editor reads it: each row's Document and cells. */
function tableIn(client: MindClient) {
  let table: ProseMirrorNode | null = null;
  readMind(client).forEach((block) => {
    if (block.type.name === "comparisonTable") table = block;
  });
  if (!table) throw new Error("There is no comparison table in the Mind.");
  const found = table as ProseMirrorNode;
  const rows: { document: string; cells: ShownCell[] }[] = [];
  found.forEach((row) => {
    const cells: ShownCell[] = [];
    row.forEach((cell) => {
      const citations: CitationAttributes[] = [];
      cell.descendants((node) => {
        if (node.type.name === "citation") citations.push(node.attrs as CitationAttributes);
      });
      cells.push({
        status: cell.attrs.status,
        problem: cell.attrs.problem,
        text: cell.textContent.trim(),
        citations,
      });
    });
    rows.push({ document: row.attrs.documentName, cells });
  });
  return {
    id: found.attrs.id as string,
    questions: (found.attrs.questions as { text: string }[]).map((question) => question.text),
    proposal: found.attrs.proposal as { kind: string } | null,
    rows,
  };
}

/** A table of `documents` by `questions`, every cell waiting: what an editor leaves before a fill. */
function waitingTable(
  documents: readonly { id: string; name: string }[],
  questions: readonly { id: string; text: string }[],
): NodeJSON {
  const cell = (questionId: string): NodeJSON => ({
    type: "comparisonCell",
    attrs: { questionId, status: "waiting" },
    content: [{ type: "paragraph", attrs: { id: crypto.randomUUID() } }],
  });
  return {
    type: "comparisonTable",
    attrs: { id: "held-table", questions },
    content: documents.map((document) => ({
      type: "comparisonRow",
      attrs: { documentId: document.id, documentName: document.name },
      content: questions.map((question) => cell(question.id)),
    })),
  };
}

/** A core with a cloud model billed per token, allowed to be sent to, and the suppliers' terms added. */
async function cloudSetUp(
  model: MockLanguageModelV4,
  provider: { kind: "anthropic" | "ollama"; modelId: string } = {
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
  },
  files: readonly { name: string; contents: string }[] = SUPPLIERS,
) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider(
    provider.kind === "ollama" ? provider : { ...provider, apiKey: "sk-test" },
  );
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createSourceFolder();
  const paths = await Promise.all(
    files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  const documents = await addAndProcess(core, paths);
  const mind = await core.createMind({ title: "Shortlist" });
  const client = await connectToMind(core, mind.id);
  return { core, documents, mind, client, dataDir };
}

const QUESTIONS = ["Termination notice", "Liability cap"];

describe("Compare Documents", () => {
  test("3 Documents × 2 Questions give 6 cells, each an Answer from its own Document with a checked Citation", async () => {
    const model = cellModel();
    const { core, client, mind, documents } = await setUpWithDocuments(model, SUPPLIERS);
    writeMind(client, [note("Ten suppliers made the shortlist.")]);
    await client.settled();

    const tableId = await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });

    const table = tableIn(client);
    expect(table.id).toBe(tableId);
    expect(table.questions).toEqual(QUESTIONS);
    expect(table.rows.map((row) => row.document)).toEqual(["Corvane", "Halvard", "Lumeric"]);
    expect(table.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ["90 days", "12 months of fees"],
      ["6 months", "twice the annual fees"],
      ["30 days", ""],
    ]);
    const cited = table.rows.flatMap((row, index) =>
      row.cells.flatMap((cell) =>
        cell.citations.map((citation) => ({
          row: index,
          document: citation.documentId,
          check: citation.check,
        })),
      ),
    );
    expect(cited).toHaveLength(5);
    for (const each of cited) {
      expect(each.document).toBe(documents[each.row]?.id);
      expect(each.check).toBe("found");
    }
    // Lumeric's terms say nothing of a liability cap.
    expect(table.rows[2]?.cells[1]).toMatchObject({ status: "failed", problem: "not-found" });
    // Each cell searched its own Document alone, offered only search and cite.
    for (const call of model.doStreamCalls) {
      expect(call.tools?.map((tool) => tool.name).sort()).toEqual(["cite", "search_documents"]);
    }
  });

  test("a table's Task names each cell's step by its Document and its Question, and offers Pause and Stop", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(cellModel(), SUPPLIERS);
    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    const [task] = await core.listTasks();
    if (!task) throw new Error("The table has no Task.");
    expect(task.actions).toEqual(["pause", "stop"]);
    expect(task.stepCount).toBe(6);
    expect(task.steps).toHaveLength(4);
    const steps = await core.listTaskSteps(task.id);
    expect(steps.map((step) => step.text).sort()).toEqual(
      [
        "Corvane · Liability cap",
        "Corvane · Termination notice",
        "Halvard · Liability cap",
        "Halvard · Termination notice",
        "Lumeric · Liability cap",
        "Lumeric · Termination notice",
      ].sort(),
    );
    // Lumeric's terms say nothing of a liability cap: its step ended without a result.
    expect(steps.find((step) => step.text === "Lumeric · Liability cap")?.status).toBe("failed");
  });

  test("the table arrives as one change after the cursor's Block: Accept all keeps it, Reject all takes it out", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(cellModel(), SUPPLIERS);
    const first = note("Ten suppliers made the shortlist.");
    writeMind(client, [first, note("Procurement wants one name by Friday.")]);
    await client.settled();

    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
      afterBlockId: first.attrs?.id as string,
    });

    expect(outline(client)).toEqual(["paragraph", "comparisonTable", "paragraph"]);
    expect(tableIn(client).proposal).toMatchObject({ kind: "insert" });
    const [before] = (await core.listCheckpoints(mind.id)).checkpoints;
    expect(before?.reason).toBe("compare");
    // Waiting, it isn't the Mind's yet: an export or Question context leaves it out.
    const read = () =>
      readBlocks(client.blocks, {
        includeQuestions: true,
        footnote: () => ({ source: "", unverified: false }),
        trimBeforeCitation: false,
      });
    expect(read().map((block) => block.kind)).toEqual(["paragraph", "paragraph"]);

    const accepted = await resolveChanges(client, "accept");
    expect(accepted).toHaveLength(1);
    expect(tableIn(client).proposal).toBeNull();
    expect(read().map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph"]);

    // A second table, rejected: gone.
    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: ["Governing law"],
    });
    const tables = () => outline(client).filter((type) => type === "comparisonTable");
    expect(tables()).toHaveLength(2);
    await resolveChanges(client, "reject");
    expect(tables()).toHaveLength(1);
  });

  test("the cells' words are AI text, and stay AI text once the table is accepted", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(cellModel(), SUPPLIERS);
    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.slice(0, 2).map((document) => document.id),
      questions: QUESTIONS,
    });
    const shownCells = () => {
      const shown: string[] = [];
      readMind(client).descendants((node) => {
        if (node.type.name !== "comparisonCell") return true;
        shown.push(shownWithAiText(node));
        return false;
      });
      return shown;
    };
    const marked = ["«90 days »￼", "«12 months of fees »￼"];
    expect(shownCells().slice(0, 2)).toEqual(marked);

    await resolveChanges(client, "accept");
    expect(tableIn(client).proposal).toBeNull();
    expect(shownCells().slice(0, 2)).toEqual(marked);
  });

  test("rejecting the table while it fills stops the fill: nothing more is asked", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answers = 0;
    const model = cellModel((call) => {
      if (call.results.some((result) => result.tool === "cite")) {
        answers++;
        return { text: "90 days [^1]", pause: { after: 0, until: held } };
      }
      return null;
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, SUPPLIERS);
    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    if (!result.started) throw new Error("The table wasn't made.");
    const ended = fillEnded(core, result.tableId);
    await vi.waitFor(() => expect(answers).toBe(1));
    await client.settled();

    await resolveChanges(client, "reject");
    await ended;
    release();

    expect(answers).toBe(1);
    expect(await core.listFillingComparisons()).toEqual([]);
    expect(outline(client)).not.toContain("comparisonTable");
    expect((await core.listTasks())[0]?.status).toBe("stopped");
  });

  describe("a cell as it is written", () => {
    /** A one-cell table whose cell's last request holds `reply` out until `release` is called. */
    async function holdLastRequest(reply: string, after: number) {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const model = cellModel((call) =>
        call.results.some((result) => result.tool === "cite") || reply === NOT_FOUND
          ? { text: reply, pause: { after, until: held } }
          : null,
      );
      const setup = await setUpWithDocuments(model, SUPPLIERS);
      const result = await setup.core.compareDocuments({
        mindId: setup.mind.id,
        documentIds: [setup.documents[0]?.id ?? ""],
        questions: ["Termination notice"],
      });
      if (!result.started) throw new Error("The table wasn't made.");
      return {
        ...setup,
        tableId: result.tableId,
        release,
        ended: fillEnded(setup.core, result.tableId),
      };
    }
    const NOT_FOUND = "NOT_FOUND";
    const firstCell = (client: MindClient) => tableIn(client).rows[0]?.cells[0];

    test("its words show as they stream, and its Citation lands checked when it finishes", async () => {
      const { client, release, ended } = await holdLastRequest("90 days [^1]", 12);

      await vi.waitFor(() => {
        expect(firstCell(client)).toMatchObject({ status: "writing", text: "90 days" });
      });
      expect(firstCell(client)?.citations).toEqual([]);

      release();
      await ended;
      await client.settled();
      const finished = firstCell(client);
      expect(finished).toMatchObject({ status: "done", text: "90 days" });
      expect(finished?.citations.map((citation) => citation.check)).toEqual(["found"]);
    });

    test("words with no marker yet, and NOT_FOUND, are not shown while they stream", async () => {
      const uncited = await holdLastRequest("90 days", 7);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await uncited.client.settled();
      expect(firstCell(uncited.client)).toMatchObject({ status: "writing", text: "" });
      uncited.release();
      await uncited.ended;
      await uncited.client.settled();
      expect(firstCell(uncited.client)).toMatchObject({ status: "done", text: "90 days" });

      const missing = await holdLastRequest(NOT_FOUND, 9);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await missing.client.settled();
      expect(firstCell(missing.client)).toMatchObject({ status: "writing", text: "" });
      missing.release();
      await missing.ended;
      await missing.client.settled();
      expect(firstCell(missing.client)).toMatchObject({ status: "failed", problem: "not-found" });
    });

    test("a cell that streamed ends as the cell written without streaming does", async () => {
      const shape = (cell: ShownCell | undefined) => ({
        status: cell?.status,
        text: cell?.text,
        citations: cell?.citations.map(
          ({ check, quote, location, documentName, pageFrom, pageTo }) => ({
            check,
            quote,
            location,
            documentName,
            pageFrom,
            pageTo,
          }),
        ),
      });
      const held = await holdLastRequest("90 days [^1]", 12);
      await vi.waitFor(() => expect(firstCell(held.client)?.text).toBe("90 days"));
      held.release();
      await held.ended;
      await held.client.settled();

      const plain = await setUpWithDocuments(cellModel(), SUPPLIERS);
      await compare(plain.core, plain.client, {
        mindId: plain.mind.id,
        documentIds: [plain.documents[0]?.id ?? ""],
        questions: ["Termination notice"],
      });

      expect(shape(firstCell(held.client))).toEqual(shape(firstCell(plain.client)));
      expect(shape(firstCell(plain.client)).citations).toHaveLength(1);
    });

    test("Chinese words stream as English ones do", async () => {
      const { client, release, ended } = await holdLastRequest("通知期为 90 天 [^1]", 14);
      await vi.waitFor(() => {
        expect(firstCell(client)).toMatchObject({ status: "writing", text: "通知期为 90 天" });
      });
      release();
      await ended;
      await client.settled();
      expect(firstCell(client)).toMatchObject({ status: "done", text: "通知期为 90 天" });
    });

    test("a table of 30 cells shows the words of the cells being written, 4 at a time, and ends with every cell checked", async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const trees = [
        "Aspen",
        "Birch",
        "Cedar",
        "Dogwood",
        "Elder",
        "Hazel",
        "Larch",
        "Maple",
        "Poplar",
        "Willow",
      ];
      const files = [1, 2, 3].map((number) => ({
        name: `Supplier ${number}.txt`,
        contents: [
          `Supplier ${number}.`,
          ...trees.map((tree, at) => `${tree} term: ${number}${at} days.`),
        ].join("\n"),
      }));
      const { core, client, mind, documents } = await cloudSetUp(
        cellModel(undefined, held),
        undefined,
        files,
      );
      const result = await core.compareDocuments({
        mindId: mind.id,
        documentIds: documents.map((document) => document.id),
        questions: trees,
      });
      if (!result.started) throw new Error("The table wasn't made.");
      const ended = fillEnded(core, result.tableId);
      const withWords = () =>
        tableIn(client)
          .rows.flatMap((row) => row.cells)
          .filter((cell) => cell.status === "writing" && cell.text !== "").length;
      await vi.waitFor(() => expect(withWords()).toBe(CLOUD_CELLS_AT_ONCE));
      await client.settled();
      expect(withWords()).toBe(CLOUD_CELLS_AT_ONCE);

      release();
      await ended;
      await client.settled();
      const cells = tableIn(client).rows.flatMap((row) => row.cells);
      expect(cells).toHaveLength(30);
      for (const cell of cells) {
        expect(cell.status).toBe("done");
        expect(cell.citations.map((citation) => citation.check)).toEqual(["found"]);
      }
    });

    test("rejecting the table while words stream takes the table out and ends the fill", async () => {
      const { core, client, release, ended } = await holdLastRequest("90 days [^1]", 12);
      await vi.waitFor(() => expect(firstCell(client)?.text).toBe("90 days"));

      await resolveChanges(client, "reject");
      await ended;
      release();
      await client.settled();

      expect(await core.listFillingComparisons()).toEqual([]);
      expect(outline(client)).not.toContain("comparisonTable");
    });

    test("Stop takes the words not yet finished out of the cell, and a fill writes it again", async () => {
      const { core, client, mind, tableId, release, ended } = await holdLastRequest(
        "90 days [^1]",
        12,
      );
      await vi.waitFor(() => expect(firstCell(client)?.text).toBe("90 days"));

      await core.stopComparisonTable({ mindId: mind.id, tableId });
      await ended;
      release();
      await client.settled();

      expect(firstCell(client)).toMatchObject({ status: "waiting", text: "" });
      expect((await core.listTasks())[0]?.status).toBe("stopped");
    });
  });

  test("on a model off this computer, at most 4 cells are written at once; on one on it, one at a time", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const searches = { count: 0 };
    let writing = 0;
    // Every cell waits at its first request, until the test lets them go.
    const model = cellModel((call, asked) => {
      if (call.results.length > 0) return null;
      searches.count++;
      writing++;
      return {
        calls: [{ tool: "search_documents", input: { query: asked.question } }],
        pause: { after: 0, until: held },
      };
    });
    const { core, client, mind, documents } = await cloudSetUp(model);
    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: [...QUESTIONS, "Governing law"],
    });
    if (!result.started) throw new Error("The table wasn't made.");
    const ended = fillEnded(core, result.tableId);
    await vi.waitFor(() => expect(writing).toBe(CLOUD_CELLS_AT_ONCE));
    // The other five cells haven't started: they wait for a free place.
    expect(searches.count).toBe(CLOUD_CELLS_AT_ONCE);
    release();
    await ended;
    await client.settled();
    expect(searches.count).toBe(9);

    // The same on a model on this computer: one cell at a time.
    let releaseLocal = () => {};
    const heldLocal = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const local = { searches: 0, writing: 0 };
    const localModel = cellModel((call, asked) => {
      if (call.results.length > 0) return null;
      local.searches++;
      local.writing++;
      return {
        calls: [{ tool: "search_documents", input: { query: asked.question } }],
        pause: { after: 0, until: heldLocal },
      };
    });
    const set = await setUpWithDocuments(localModel, SUPPLIERS);
    const started = await set.core.compareDocuments({
      mindId: set.mind.id,
      documentIds: set.documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    if (!started.started) throw new Error("The table wasn't made.");
    const localEnded = fillEnded(set.core, started.tableId);
    await vi.waitFor(() => expect(local.writing).toBe(1));
    expect(local.searches).toBe(1);
    releaseLocal();
    await localEnded;
    expect(local.searches).toBe(6);
  });

  test("a provider limiting requests mid-run is waited out and the table completes", async () => {
    const limited = new Set<string>();
    const model = cellModel((call, asked) => {
      // Halvard's first try is refused, as a busy provider does.
      if (
        call.results.length === 0 &&
        asked.document === "Halvard" &&
        !limited.has(asked.question)
      ) {
        limited.add(asked.question);
        return { error: { status: 429, message: "Too many requests" } };
      }
      return null;
    });
    const { core, client, mind, documents } = await cloudSetUp(model);

    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });

    expect(limited.size).toBe(2);
    expect(tableIn(client).rows[1]?.cells.map((cell) => [cell.status, cell.text])).toEqual([
      ["done", "6 months"],
      ["done", "twice the annual fees"],
    ]);
  });

  test("each kind of failure says why in its cell: a refused key, no text, a Document deleted mid-run", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let keyRefused = true;
    const model = cellModel((call, asked) => {
      if (call.results.length > 0) return null;
      if (asked.document === "Halvard" && asked.question === "Liability cap" && keyRefused) {
        return { error: { status: 401, message: "Invalid API key" } };
      }
      // The first cell waits, so a Document can be deleted while the table fills.
      return asked.document === "Corvane" && asked.question === "Termination notice"
        ? {
            calls: [{ tool: "search_documents", input: { query: asked.question } }],
            pause: { after: 0, until: held },
          }
        : null;
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      ...SUPPLIERS,
      { name: "Scan.pdf", contents: "this is not a PDF" },
    ]);
    const [corvane, halvard, lumeric, scan] = documents;
    if (!corvane || !halvard || !lumeric || !scan) throw new Error("The Documents weren't added.");

    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: [corvane.id, halvard.id, lumeric.id, scan.id],
      questions: QUESTIONS,
    });
    if (!result.started) throw new Error("The table wasn't made.");
    const ended = fillEnded(core, result.tableId);
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBeGreaterThan(0));
    await core.deleteDocument(lumeric.id);
    release();
    await ended;
    await client.settled();

    const problems = () => tableIn(client).rows.map((row) => row.cells.map((cell) => cell.problem));
    expect(problems()).toEqual([
      [null, null],
      [null, "auth"],
      ["source-removed", "source-removed"],
      ["nothing-to-search", "nothing-to-search"],
    ]);

    // Filling again writes the cell that failed, not those whose Document can't answer.
    keyRefused = false;
    const filled = await core.fillComparisonTable({ mindId: mind.id, tableId: result.tableId });
    expect(filled).toEqual({ started: true, tableId: result.tableId });
    await fillEnded(core, result.tableId);
    await client.settled();
    expect(problems()[1]).toEqual([null, null]);
    expect(tableIn(client).rows[1]?.cells[1]?.text).toBe("twice the annual fees");
    expect(problems()[2]).toEqual(["source-removed", "source-removed"]);
  });

  test("a fill of one column writes that column alone, so a reword or an insert never retries its neighbours", async () => {
    let keyRefused = true;
    /** Each cell asked, once per try: the Question's text. */
    const asked: string[] = [];
    const model = cellModel((call, question) => {
      if (call.results.length > 0) return null;
      asked.push(question.question);
      return keyRefused ? { error: { status: 401, message: "Invalid API key" } } : null;
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, SUPPLIERS);
    const tableId = await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    const problems = () => tableIn(client).rows.map((row) => row.cells.map((cell) => cell.problem));
    expect(problems()).toEqual([
      ["auth", "auth"],
      ["auth", "auth"],
      ["auth", "auth"],
    ]);
    const columns = comparisonQuestionsOf(
      client.doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .toArray()
        .find(
          (element): element is Y.XmlElement =>
            element instanceof Y.XmlElement && element.nodeName === COMPARISON_TABLE_NODE,
        )
        ?.getAttributes() ?? {},
    );
    const [notice, liability] = columns;
    if (!notice || !liability) throw new Error("The table has no columns.");
    const askedSince = (at: number) => new Set(asked.slice(at));

    // A column reworded fills its column alone: the failed cells beside it keep their problem.
    keyRefused = false;
    let calls = asked.length;
    await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: [notice.id] });
    await fillEnded(core, tableId);
    await client.settled();
    expect(askedSince(calls)).toEqual(new Set(["Termination notice"]));
    expect(problems()).toEqual([
      [null, "auth"],
      [null, "auth"],
      [null, "auth"],
    ]);
    const written = tableIn(client).rows.map((row) => row.cells[0]?.text);

    // Retrying the failed column alone writes it, and leaves the other column whole.
    calls = asked.length;
    await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: [liability.id] });
    await fillEnded(core, tableId);
    await client.settled();
    expect(askedSince(calls)).toEqual(new Set(["Liability cap"]));
    expect(problems()).toEqual([
      [null, null],
      [null, null],
      [null, "not-found"],
    ]);
    expect(tableIn(client).rows.map((row) => row.cells[0]?.text)).toEqual(written);
    expect(tableIn(client).rows.map((row) => row.cells[0]?.citations.length)).toEqual([1, 1, 1]);
  });

  test("a column asked for while one fills is filled after it, when that column's cells are released", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** Each cell asked, once per try: the Question's text. */
    const asked: string[] = [];
    const model = cellModel((call, question) => {
      if (call.results.length === 0) asked.push(question.question);
      return null;
    }, held);
    const { core, client, mind, documents } = await setUpWithDocuments(model, SUPPLIERS);
    const questions = [
      { id: "q-notice", text: "Termination notice" },
      { id: "q-liability", text: "Liability cap" },
    ];
    client.doc.transact(() =>
      client.doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .push([createElement(waitingTable(documents, questions))]),
    );
    await client.settled();
    const tableId = "held-table";
    const statuses = () => tableIn(client).rows.map((row) => row.cells.map((cell) => cell.status));

    // The first column's cells are held mid-answer; the second column is asked for meanwhile,
    // twice: it joins once, and each of its cells is filled once.
    expect(
      await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: ["q-notice"] }),
    ).toEqual({ started: true, tableId });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(new Set(asked)).toEqual(new Set(["Termination notice"]));
    for (let ask = 0; ask < 2; ask++) {
      expect(
        await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: ["q-liability"] }),
      ).toEqual({ started: true, tableId });
    }
    release();
    await fillEnded(core, tableId);
    await client.settled();

    // Lumeric has no Liability cap line: its cell was asked, and says why it has no Answer.
    expect(statuses()).toEqual([
      ["done", "done"],
      ["done", "done"],
      ["done", "failed"],
    ]);
    expect(tableIn(client).rows[2]?.cells[1]?.problem).toBe("not-found");
    expect(asked.filter((question) => question === "Liability cap")).toHaveLength(3);
  });

  test("a column queued while another fills is still filled after a quit", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = cellModel(undefined, held);
    const { core, client, mind, documents, dataDir } = await setUpWithDocuments(model, SUPPLIERS);
    const questions = [
      { id: "q-notice", text: "Termination notice" },
      { id: "q-liability", text: "Liability cap" },
    ];
    client.doc.transact(() =>
      client.doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .push([createElement(waitingTable(documents, questions))]),
    );
    await client.settled();
    const tableId = "held-table";
    expect(
      await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: ["q-notice"] }),
    ).toEqual({ started: true, tableId });
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBeGreaterThan(0));
    expect(
      await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: ["q-liability"] }),
    ).toEqual({ started: true, tableId });
    const [task] = await core.listTasks();
    expect(task).toMatchObject({ kind: "comparison", blockId: tableId });
    core.close();
    release();

    // The Task's input kept the queued column: the run it resumes fills both columns.
    const reopened = startCore(dataDir, {
      createChatModel: scriptedModels(model).createChatModel,
    });
    const again = await connectToMind(reopened, mind.id);
    await vi.waitFor(
      async () =>
        expect((await reopened.listTasks()).find((each) => each.id === task?.id)?.status).toBe(
          "done",
        ),
      { timeout: 15_000 },
    );
    await again.settled();
    expect(tableIn(again).rows.map((row) => row.cells.map((cell) => cell.status))).toEqual([
      ["done", "done"],
      ["done", "done"],
      ["done", "failed"],
    ]);
  });

  test("the whole table asked for while a column fills is still filled after a quit", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: string[] = [];
    const model = cellModel((call, question) => {
      if (call.results.length === 0) asked.push(question.question);
      return null;
    }, held);
    const { core, client, mind, documents, dataDir } = await setUpWithDocuments(model, SUPPLIERS);
    const questions = [
      { id: "q-notice", text: "Termination notice" },
      { id: "q-liability", text: "Liability cap" },
      { id: "q-law", text: "Governing law" },
    ];
    client.doc.transact(() =>
      client.doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .push([createElement(waitingTable(documents, questions))]),
    );
    await client.settled();
    const tableId = "held-table";
    expect(
      await core.fillComparisonTable({ mindId: mind.id, tableId, questionIds: ["q-notice"] }),
    ).toEqual({ started: true, tableId });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    // Fill, with no column named: the Task widens to every cell.
    expect(await core.fillComparisonTable({ mindId: mind.id, tableId })).toEqual({
      started: true,
      tableId,
    });
    const [task] = await core.listTasks();
    const beforeQuit = asked.length;
    core.close();
    release();

    const reopened = startCore(dataDir, {
      createChatModel: scriptedModels(model).createChatModel,
    });
    const again = await connectToMind(reopened, mind.id);
    await vi.waitFor(
      async () =>
        expect((await reopened.listTasks()).find((each) => each.id === task?.id)?.status).toBe(
          "done",
        ),
      { timeout: 15_000 },
    );
    await again.settled();
    const cells = tableIn(again).rows.flatMap((row) => row.cells);
    expect(cells.every((cell) => cell.status === "done" || cell.status === "failed")).toBe(true);
    expect(new Set(asked.slice(beforeQuit))).toEqual(
      new Set(["Termination notice", "Liability cap", "Governing law"]),
    );
  });

  test("a plan's limit mid-run stops the fill: the cells left say they weren't checked", async () => {
    const model = cellModel((call, asked) =>
      call.results.length === 0 && asked.document === "Halvard"
        ? { error: { status: 402, message: "You have reached your weekly usage limit" } }
        : null,
    );
    const { core, client, mind, documents } = await cloudSetUp(model, {
      kind: "ollama",
      modelId: "glm-5.3:cloud",
    });

    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });

    const problems = tableIn(client).rows.map((row) => row.cells.map((cell) => cell.problem));
    expect(problems[0]).toEqual([null, null]);
    expect(problems[1]).toEqual(["plan-limit", "plan-limit"]);
    expect(problems[2]).toEqual(["plan-limit", "plan-limit"]);
  });

  test("the monthly cap stops the fill before anything is sent, and every cell says it wasn't checked", async () => {
    const model = cellModel();
    const { core, client, mind, documents } = await cloudSetUp(model);
    await core.updateSettings({ user: { monthlyCap: { amount: 0.000001, currency: "USD" } } });

    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });

    expect(model.doStreamCalls).toHaveLength(0);
    for (const row of tableIn(client).rows) {
      expect(row.cells.map((cell) => cell.problem)).toEqual(["cost-cap", "cost-cap"]);
    }
  });

  test("files IncarnaMind wrote aren't compared: checks leave them out of their evidence", async () => {
    const model = cellModel();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const { documents } = await linkWithExports(core, SUPPLIERS.slice(0, 2));
    const exported = await exportMind(core, "Report", "Termination notice: 14 days.");
    const mind = await core.createMind({ title: "Shortlist" });
    const client = await connectToMind(core, mind.id);

    await compare(core, client, {
      mindId: mind.id,
      documentIds: [...documents.map((document) => document.id), exported.id],
      questions: ["Termination notice"],
    });

    expect(tableIn(client).rows.map((row) => row.document)).toEqual(["Corvane", "Halvard"]);
    await expect(
      core.compareDocuments({
        mindId: mind.id,
        documentIds: [exported.id],
        questions: ["Termination notice"],
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  test("with no Documents or no Questions, nothing is made, and it says what's missing", async () => {
    const { core, mind, documents } = await setUpWithDocuments(cellModel(), SUPPLIERS);
    await expect(
      core.compareDocuments({ mindId: mind.id, documentIds: [], questions: QUESTIONS }),
    ).rejects.toThrow("There are no Documents to compare.");
    await expect(
      core.compareDocuments({
        mindId: mind.id,
        documentIds: documents.map((each) => each.id),
        questions: ["  "],
      }),
    ).rejects.toThrow("Add a Question to compare by.");
  });

  test("a column added to the table is filled by the next fill", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(cellModel(), SUPPLIERS);
    const tableId = await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: ["Termination notice"],
    });
    await resolveChanges(client, "accept");

    // As the editor's "+ Question" does: a column, and a waiting cell in each row.
    client.doc.transact(() => {
      const table = client.blocks
        .toArray()
        .find(
          (block): block is Y.XmlElement =>
            block instanceof Y.XmlElement && block.nodeName === "comparisonTable",
        );
      if (!table) throw new Error("No table.");
      const questions = table.getAttribute("questions") as unknown as {
        id: string;
        text: string;
      }[];
      table.setAttribute("questions", [
        ...questions,
        { id: "q-law", text: "Governing law" },
      ] as never);
      for (const row of table.toArray()) {
        if (!(row instanceof Y.XmlElement)) continue;
        const cell = new Y.XmlElement("comparisonCell");
        cell.setAttribute("questionId", "q-law");
        cell.setAttribute("status", "waiting");
        cell.insert(0, [new Y.XmlElement("paragraph")]);
        row.push([cell]);
      }
    });
    await client.settled();
    await core.fillComparisonTable({ mindId: mind.id, tableId });
    await fillEnded(core, tableId);
    await client.settled();

    expect(tableIn(client).rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ["90 days", ""],
      ["6 months", ""],
      ["30 days", "New York"],
    ]);
  });

  test("once accepted, it exports to Markdown and Word as a table with its Citations as footnotes, in the interface's language", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(cellModel(), SUPPLIERS);
    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    await resolveChanges(client, "accept");
    const lumeric = documents[2];
    if (!lumeric) throw new Error("Lumeric wasn't added.");
    await core.deleteDocument(lumeric.id);

    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    const [table, footnotes] = markdown.trim().split("\n\n");
    expect(table?.split("\n")).toEqual([
      "| Document | Termination notice | Liability cap |",
      "| --- | --- | --- |",
      "| Corvane | 90 days[^1] | 12 months of fees[^2] |",
      "| Halvard | 6 months[^3] | twice the annual fees[^4] |",
      "| Lumeric (source removed) | 30 days[^5] | not found |",
    ]);
    const notes = footnotes?.split("\n") ?? [];
    expect(notes).toHaveLength(5);
    expect(notes[0]).toMatch(/^\[\^1\]: Corvane, /);
    expect(notes[2]).toMatch(/^\[\^3\]: Halvard, /);
    // Its Document is gone, so its quote can't be checked any more.
    expect(notes[4]).toMatch(/^\[\^5\]: Lumeric, .*\[unverified\]$/);

    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    const word = part(files, "word/document.xml");
    const rows = [
      ...(/<w:tbl>[\s\S]*<\/w:tbl>/.exec(word)?.[0] ?? "").matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g),
    ];
    expect(rows[0]?.[1]).toContain("<w:tblHeader/>");
    expect(
      rows.map((row) =>
        [...(row[1] ?? "").matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((cell) =>
          textOf(cell[1] ?? ""),
        ),
      ),
    ).toEqual([
      ["Document", "Termination notice", "Liability cap"],
      ["Corvane", "90 days[1]", "12 months of fees[2]"],
      ["Halvard", "6 months[3]", "twice the annual fees[4]"],
      ["Lumeric (source removed)", "30 days[5]", "not found"],
    ]);
    expect(Object.values(footnotesOf(part(files, "word/footnotes.xml")))).toHaveLength(5);

    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(chinese).toContain("| 文档 | Termination notice | Liability cap |");
    expect(chinese).toContain("| Lumeric（来源已删除） | 30 days[^5] | 未找到 |");
  });

  test("quitting halfway: the table goes on filling by itself at the next start, nothing lost or doubled", async () => {
    const held = new Promise<void>(() => {});
    let first = true;
    const model = cellModel((call, asked) => {
      // The first cell is still being written when the app quits.
      if (call.results.length > 0 || !first) return null;
      first = false;
      return {
        calls: [{ tool: "search_documents", input: { query: asked.question } }],
        pause: { after: 0, until: held },
      };
    });
    const { core, mind, documents, dataDir } = await setUpWithDocuments(model, SUPPLIERS);
    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    if (!result.started) throw new Error("The table wasn't made.");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    const [task] = await core.listTasks();
    expect(task).toMatchObject({ kind: "comparison", mindId: mind.id, blockId: result.tableId });
    core.close();

    const reopened = startCore(dataDir, {
      createChatModel: scriptedModels(cellModel()).createChatModel,
    });
    const again = await connectToMind(reopened, mind.id);
    await vi.waitFor(
      async () =>
        expect((await reopened.listTasks()).find((each) => each.id === task?.id)?.status).toBe(
          "done",
        ),
      { timeout: 10_000 },
    );
    await again.settled();
    expect(tableIn(again).rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ["90 days", "12 months of fees"],
      ["6 months", "twice the annual fees"],
      ["30 days", ""],
    ]);
    // Each cell has its one Citation, none written twice.
    expect(
      tableIn(again).rows.flatMap((row) => row.cells.map((cell) => cell.citations.length)),
    ).toEqual([1, 1, 1, 1, 1, 0]);
  });

  test("quitting while a cell's words show: at the next start no cell is left reading, and the table fills whole", async () => {
    const held = new Promise<void>(() => {});
    const model = cellModel((call, asked) =>
      call.results.some((result) => result.tool === "cite") &&
      asked.document === "Corvane" &&
      asked.question === QUESTIONS[0]
        ? { text: "90 days [^1]", pause: { after: 12, until: held } }
        : null,
    );
    const { core, client, mind, documents, dataDir } = await setUpWithDocuments(model, SUPPLIERS);
    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    if (!result.started) throw new Error("The table wasn't made.");
    await vi.waitFor(() =>
      expect(tableIn(client).rows[0]?.cells[0]).toMatchObject({
        status: "writing",
        text: "90 days",
      }),
    );
    const [task] = await core.listTasks();
    core.close();

    const reopened = startCore(dataDir, {
      createChatModel: scriptedModels(cellModel()).createChatModel,
    });
    const again = await connectToMind(reopened, mind.id);
    await vi.waitFor(
      async () =>
        expect((await reopened.listTasks()).find((each) => each.id === task?.id)?.status).toBe(
          "done",
        ),
      { timeout: 10_000 },
    );
    await again.settled();
    const cells = tableIn(again).rows.flatMap((row) => row.cells);
    expect(cells.map((cell) => cell.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "failed",
    ]);
    expect(cells.map((cell) => cell.text)).toEqual([
      "90 days",
      "12 months of fees",
      "6 months",
      "twice the annual fees",
      "30 days",
      "",
    ]);
    expect(cells.map((cell) => cell.citations.length)).toEqual([1, 1, 1, 1, 1, 0]);
  });

  test("the monthly cap pauses the table's Task; filling again once the cap allows resumes that Task", async () => {
    const model = cellModel();
    const { core, client, mind, documents } = await cloudSetUp(model);
    await core.updateSettings({ user: { monthlyCap: { amount: 0.000001, currency: "USD" } } });
    const tableId = await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    const [paused] = await core.listTasks();
    expect(paused).toMatchObject({ status: "paused", pausedReason: "cost-cap", ask: null });
    expect(paused?.finishedAt).toBeNull();

    await core.updateSettings({ user: { monthlyCap: null } });
    const ended = fillEnded(core, tableId);
    expect((await core.fillComparisonTable({ mindId: mind.id, tableId })).started).toBe(true);
    await ended;
    await client.settled();
    const tasks = await core.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: paused?.id, status: "done" });
    expect(tableIn(client).rows.map((row) => row.cells.map((cell) => cell.status))).toEqual([
      ["done", "done"],
      ["done", "done"],
      ["done", "failed"],
    ]);
  });

  test("a table's Task keeps its Documents' versions while unfinished (#79), and keys its requests to it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const model = cellModel((call) => {
      if (paused || call.results.length > 0) return null;
      paused = true;
      return { text: "", calls: [], pause: { after: 0, until: held } };
    });
    const { core, client, mind, documents, dataDir } = await cloudSetUp(model);
    const before = model.doStreamCalls.length;
    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    if (!result.started) throw new Error("The table wasn't made.");
    const [task] = await core.listTasks();
    if (!task) throw new Error("No Task.");
    await vi.waitFor(
      () =>
        expect(core.retention.retainedBy("task", task.id).map((each) => each.documentId)).toEqual(
          documents.map((document) => document.id),
        ),
      { timeout: 10_000 },
    );
    expect(core.retention.retainedBy("task", task.id).map((each) => each.contentHash)).toEqual(
      documents.map((document) => document.contentHash),
    );
    const ended = fillEnded(core, result.tableId);
    release();
    await ended;
    await client.settled();
    expect(core.retention.retainedBy("task", task.id)).toEqual([]);
    const done = (await core.listTasks())[0];
    expect(done?.status).toBe("done");
    expect(done?.cost?.amount).toBeGreaterThan(0);
    // Every request its cells made is keyed to it, so its cost is told apart.
    const keyed = queryDatabase<{ id: string }>(
      dataDir,
      "SELECT id FROM model_requests WHERE run_id = ? AND deleted_at IS NULL",
      [task.id],
    );
    expect(keyed).toHaveLength(model.doStreamCalls.length - before);
  });

  test("Answers come first: a cell on this computer's model gives way to an Answer and is written after it", async () => {
    let firstCell = true;
    const events: string[] = [];
    const model = cellModel((call, asked) => {
      if (!asked.document) {
        events.push("answer");
        return { text: "High water is at noon." };
      }
      if (call.results.length === 0) events.push("cell");
      if (firstCell && call.results.length === 0) {
        firstCell = false;
        return {
          calls: [{ tool: "search_documents", input: { query: asked.question } }],
          pause: { after: 0, until: new Promise<void>(() => {}) },
        };
      }
      return null;
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, SUPPLIERS);
    const result = await core.compareDocuments({
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    if (!result.started) throw new Error("The table wasn't made.");
    await vi.waitFor(() => expect(events).toEqual(["cell"]), { timeout: 10_000 });
    const ended = fillEnded(core, result.tableId);
    // Asked below the table, which stays.
    const asked = question("When is high water?");
    editMind(client, (blocks) => [...blocks, asked]);
    await client.settled();
    const answer = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!answer.asked) throw new Error("The Question wasn't asked.");
    expect((await answerEnded(core, answer.answerId)).event).toBe("finished");
    await ended;
    await client.settled();
    // The cell in flight gave way; none started while the Answer was written; it was written after.
    expect(events.slice(0, 2)).toEqual(["cell", "answer"]);
    expect(events.filter((each) => each === "cell")).toHaveLength(7);
    expect(
      tableIn(client).rows.flatMap((row) => row.cells.map((cell) => cell.citations.length)),
    ).toEqual([1, 1, 1, 1, 1, 0]);
  });

  test("the table survives sync and a restart: another device sees its cells, and they're there after reopening", async () => {
    const { core, client, mind, documents, dataDir } = await setUpWithDocuments(
      cellModel(),
      SUPPLIERS,
    );
    const other = await connectToMind(core, mind.id);
    other.goOffline();
    writeMind(other, [note("Written offline on another computer.")]);

    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: QUESTIONS,
    });
    await other.goOnline();
    expect(tableIn(other).rows.map((row) => row.cells[0]?.text)).toEqual([
      "90 days",
      "6 months",
      "30 days",
    ]);

    core.close();
    const reopened = startCore(dataDir, {
      createChatModel: scriptedModels(cellModel()).createChatModel,
    });
    const again = await connectToMind(reopened, mind.id);
    expect(tableIn(again).rows.map((row) => row.cells[1]?.text)).toEqual([
      "12 months of fees",
      "twice the annual fees",
      "",
    ]);
    expect(again.doc.getXmlFragment(MIND_CONTENT_FIELD).length).toBeGreaterThan(1);
  });
});
