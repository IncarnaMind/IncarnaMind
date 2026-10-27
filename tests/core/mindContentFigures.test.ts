import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { DATABASE_FILE } from "../../src/core";
import { createElement, nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import {
  addCitedVersions,
  type CitedVersions,
  isCited,
} from "../../src/core/answers/citedVersions";
import {
  type Citation,
  CONTENT_SCHEMA_VERSION,
  type FigureInput,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  MIND_SETTINGS_FIELD,
  type RetainedFigureAnalysis,
} from "../../src/core/api";
import { createVersionRetention } from "../../src/core/documents/retention";
import { createMindContent } from "../../src/core/mindContent";
import { migrate, openDatabase } from "../../src/core/storage";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { figureRunsFor, installFigureRuns } from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { refuseWrites } from "../helpers/failingStorage";
import { connectToMind } from "../helpers/mindClient";

function run(names: string[], id = "run"): RetainedFigureAnalysis {
  return {
    id,
    title: "Revenue / 收入",
    language: "python",
    code: "result('a', 10)\nresult('b', 20)",
    inputs: [],
    versions: null,
    codeSha256: "a".repeat(64),
    ranAt: "2026-10-27T00:00:00.000Z",
    values: names.map((name) => ({
      kind: "figure",
      name,
      label: name,
      value: name === "a" ? 10 : 20,
      unit: null,
    })),
  };
}

function figure(name: string, id = "run", inputs: FigureInput[] = []): NodeJSON {
  return calculatedFigureNode(
    {
      label: name,
      formula: "",
      inputs,
      value: name === "a" ? 10 : 20,
      unit: { kind: "plain" },
      approximate: false,
      shown: name === "a" ? "10" : "20",
      show: { language: "en", as: "number", decimals: 0, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      analysis: { analysis: 1, result: name },
    },
    `figure-${name}`,
    id,
  );
}

function append(doc: Y.Doc, name: string, id = "run", inputs: FigureInput[] = []): void {
  doc
    .getXmlFragment(MIND_CONTENT_FIELD)
    .push([createElement({ type: "paragraph", content: [figure(name, id, inputs)] })]);
}

function kept(doc: Y.Doc): RetainedFigureAnalysis[] {
  return figureRunsFor(doc, topLevelBlocks(doc.getXmlFragment(MIND_CONTENT_FIELD)).map(nodeOf));
}

function withFigures(names: string[]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const name of names) append(doc, name);
    installFigureRuns(doc, [run(names)]);
  });
  return doc;
}

function citation(documentId: string): Citation {
  return {
    documentId,
    documentName: `${documentId}.md`,
    passageId: `${documentId}-passage`,
    contentHash: `${documentId}-version`,
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "section", heading: "Revenue / 收入" },
    quote: "Revenue / 收入 10",
    check: "found",
    checkReason: null,
  };
}

function input(documentId: string): FigureInput {
  return {
    name: documentId,
    label: "Revenue / 收入",
    citation: citation(documentId),
    number: {
      chars: "10",
      at: 13,
      value: 10,
      scale: 1,
      scaleWord: null,
      unit: { kind: "plain" },
      decimals: 0,
      approximate: false,
      reading: null,
    },
    cell: null,
    unitStatement: {
      citation: citation("unit"),
      scale: 1,
      scaleWord: null,
      currency: null,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("core ownership of calculated figures", () => {
  test("deleting figures through the core drops unused values and the last run", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    client.doc.transact(() => {
      append(client.doc, "a");
      append(client.doc, "b");
      installFigureRuns(client.doc, [run(["a", "b"])]);
    });
    await client.settled();
    client.blocks.delete(0, 1);
    await client.settled();
    expect(kept(client.doc)[0]?.values.map((value) => value.name)).toEqual(["b"]);
    expect(client.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
    client.blocks.delete(0, 1);
    await client.settled();
    expect(client.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
    const reopened = await connectToMind(core, mind.id);
    expect(reopened.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
  });

  test("core edit, Undo and Redo move the last figure and its run in one update", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const changed = vi.fn();
    const content = createMindContent(db, () => "2026-10-27T00:00:00.000Z", changed);
    const source = withFigures(["a"]);
    content.apply("mind", Y.encodeStateAsUpdate(source));
    const blocks = content.read("mind", (value) => value);
    const doc = blocks.doc;
    if (!doc) throw new Error("The loaded Mind has no document.");
    const runs = doc.getMap(MIND_FIGURE_RUNS_FIELD);
    const undo = new Y.UndoManager([blocks, runs], { trackedOrigins: new Set(["edit"]) });
    changed.mockClear();
    content.edit("mind", (value) => value.delete(0, 1), "edit");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(runs.size).toBe(0);
    undo.undo();
    content.edit("mind", () => undefined);
    expect(kept(doc)[0]?.values.map((value) => value.name)).toEqual(["a"]);
    undo.redo();
    content.edit("mind", () => undefined);
    expect(blocks.length).toBe(0);
    expect(runs.size).toBe(0);
    undo.destroy();
    content.closeAll();
    source.destroy();
    db.close();
  });

  test("a core edit that throws still stores its deletion and removes the orphan run", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const content = createMindContent(
      db,
      () => "2026-10-27T00:00:00.000Z",
      () => {},
    );
    const source = withFigures(["a"]);
    content.apply("mind", Y.encodeStateAsUpdate(source));
    const failure = new Error("The edit stopped after changing the Blocks.");
    expect(() =>
      content.edit("mind", (blocks) => {
        blocks.delete(0, 1);
        throw failure;
      }),
    ).toThrow(failure);
    content.closeAll();
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, content.state("mind"));
    expect(loaded.getXmlFragment(MIND_CONTENT_FIELD).length).toBe(0);
    expect(loaded.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
    content.closeAll();
    loaded.destroy();
    source.destroy();
    db.close();
  });

  test("missing causal content keeps its already received run until the earlier update arrives", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const remote = new Y.Doc();
    const changes: Uint8Array[] = [];
    remote.on("update", (update: Uint8Array) => changes.push(update));
    const paragraph = new Y.XmlElement("paragraph");
    remote.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    paragraph.push([createElement(figure("a"))]);
    const [earlier, later] = changes;
    if (!earlier || !later) throw new Error("The causal update fixture is incomplete.");
    const dependency = new Y.Doc();
    installFigureRuns(dependency, [run(["a"])]);
    core.retention.retain("note-figure", mind.id, [
      { documentId: "pending-source", contentHash: "pending-version" },
    ]);
    await expect(
      core.applyMindUpdate(mind.id, Y.mergeUpdates([later, Y.encodeStateAsUpdate(dependency)])),
    ).rejects.toThrow();
    const pending = new Y.Doc();
    Y.applyUpdate(pending, (await core.openMind(mind.id)).state);
    expect(pending.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
    expect(core.retention.retainedBy("note-figure", mind.id)).toMatchObject([
      { documentId: "pending-source", contentHash: "pending-version" },
    ]);
    await core.applyMindUpdate(mind.id, earlier);
    const complete = new Y.Doc();
    Y.applyUpdate(complete, (await core.openMind(mind.id)).state);
    expect(kept(complete)[0]?.values.map((value) => value.name)).toEqual(["a"]);
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual([]);
    remote.destroy();
    dependency.destroy();
    pending.destroy();
    complete.destroy();
  });

  test("an incoming newer schema and its orphan run stay unchanged and read-only", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const remote = new Y.Doc();
    remote.transact(() => {
      remote.getMap(MIND_SETTINGS_FIELD).set("schemaVersion", CONTENT_SCHEMA_VERSION + 1);
      installFigureRuns(remote, [run(["a"])]);
    });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(remote));
    const state = (await core.openMind(mind.id)).state;
    const opened = new Y.Doc();
    Y.applyUpdate(opened, state);
    expect(opened.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
    await expect(core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(remote))).rejects.toThrow();
    expect((await core.openMind(mind.id)).state).toEqual(state);
    remote.destroy();
    opened.destroy();
  });

  test("a concurrent last deletion and new figure preserve the new result through the core", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const first = await connectToMind(core, mind.id);
    first.doc.transact(() => {
      append(first.doc, "a");
      installFigureRuns(first.doc, [run(["a"])]);
    });
    await first.settled();
    const second = await connectToMind(core, mind.id);
    second.goOffline();
    first.blocks.delete(0, 1);
    await first.settled();
    second.doc.transact(() => {
      append(second.doc, "b");
      installFigureRuns(second.doc, [run(["b"])]);
    });
    await second.goOnline();
    expect(first.blocks.length).toBe(1);
    expect(kept(first.doc)[0]?.values.map((value) => value.name)).toEqual(["b"]);
    expect(kept(second.doc)).toEqual(kept(first.doc));
    expect(first.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
  });

  test("History restores only its figures' dependencies while keeping current settings", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [run(["a"])]);
      client.doc.getMap(MIND_SETTINGS_FIELD).set("model", "old-model");
    });
    await client.settled();
    const saved = await core.saveCheckpoint(mind.id, "accept");
    client.doc.transact(() => {
      client.blocks.delete(0, client.blocks.length);
      append(client.doc, "b", "another-run");
      installFigureRuns(client.doc, [run(["b"], "another-run")]);
      client.doc.getMap(MIND_SETTINGS_FIELD).set("model", "new-model");
    });
    await client.settled();
    const { before } = await core.restoreCheckpoint(mind.id, saved.id);
    await client.settled();
    expect(kept(client.doc)).toEqual([run(["a"])]);
    expect(client.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
    expect(client.doc.getMap(MIND_SETTINGS_FIELD).get("model")).toBe("new-model");
    await core.restoreCheckpoint(mind.id, before.id);
    await client.settled();
    expect(kept(client.doc)).toEqual([run(["b"], "another-run")]);
    expect(client.doc.getMap(MIND_SETTINGS_FIELD).get("model")).toBe("new-model");
  });

  test("History validates a missing saved run before changing content or saving another checkpoint", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [run(["a"])]);
    });
    await client.settled();
    const incomplete = await core.saveCheckpoint(mind.id, "accept");
    const damaged = new Y.Doc();
    Y.applyUpdate(damaged, (await core.openMind(mind.id)).state);
    damaged.getMap(MIND_FIGURE_RUNS_FIELD).clear();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE mind_checkpoints SET data = ? WHERE id = ?", [
        Y.encodeStateAsUpdate(damaged),
        incomplete.id,
      ]);
    } finally {
      db.close();
      damaged.destroy();
    }
    client.doc.transact(() => {
      client.blocks.delete(0, client.blocks.length);
      append(client.doc, "b", "another-run");
      installFigureRuns(client.doc, [run(["b"], "another-run")]);
    });
    await client.settled();
    const before = (await core.openMind(mind.id)).state;
    const checkpoints = (await core.listCheckpoints(mind.id)).checkpoints;
    await expect(core.restoreCheckpoint(mind.id, incomplete.id)).rejects.toThrow();
    expect((await core.openMind(mind.id)).state).toEqual(before);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual(checkpoints);
  });

  test("a Note retains its figures' input, unit and Analysis range versions and heals its projection", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const analysis = run(["a", "b"]);
    analysis.inputs = [
      { kind: "figure", name: "analysis", input: input("analysis"), sha256: "b".repeat(64) },
      {
        kind: "range",
        name: "range",
        citation: citation("range"),
        range: "A1:A2",
        rows: 2,
        columns: 1,
        rowCount: 2,
        cut: false,
        sha256: "c".repeat(64),
      },
    ];
    client.doc.transact(() => {
      append(client.doc, "a", "run", [input("formula")]);
      append(client.doc, "b");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    const expected = ["analysis", "formula", "range", "unit"];
    const retained = () =>
      core.retention
        .retainedBy("note-figure", mind.id)
        .map((value) => value.documentId)
        .sort();
    expect(retained()).toEqual(expected);
    core.retention.release("note-figure", mind.id);
    expect(retained()).toEqual([]);
    await core.saveCheckpoint(mind.id, "accept");
    expect(retained()).toEqual(expected);
    core.retention.release("note-figure", mind.id);
    await core.openMind(mind.id);
    expect(retained()).toEqual(expected);
    client.blocks.delete(0, client.blocks.length);
    await client.settled();
    expect(retained()).toEqual([]);
  });

  test("an incomplete run or a future-schema Note never erases existing source retention", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const analysis = run(["a"]);
    analysis.inputs = [
      { kind: "figure", name: "analysis", input: input("analysis"), sha256: "b".repeat(64) },
    ];
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    const before = core.retention.retainedBy("note-figure", mind.id);
    expect(before).toHaveLength(2);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    client.doc.getMap(MIND_FIGURE_RUNS_FIELD).clear();
    await client.settled();
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual(before);
    expect(logged).toHaveBeenCalled();
    await expect(core.openMind(mind.id)).resolves.toHaveProperty("access", "edit");
    client.doc.getMap(MIND_SETTINGS_FIELD).set("schemaVersion", CONTENT_SCHEMA_VERSION + 1);
    await client.settled();
    const state = (await core.openMind(mind.id)).state;
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual(before);
    expect((await core.openMind(mind.id)).state).toEqual(state);
  });

  test("a deleted Note retains its source versions until it is permanently purged", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const analysis = run(["a"]);
    analysis.inputs = [
      { kind: "figure", name: "analysis", input: input("analysis"), sha256: "b".repeat(64) },
    ];
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    await core.deleteMind(mind.id);
    expect(core.retention.retainedBy("note-figure", mind.id)).toHaveLength(2);
    await core.restore([{ kind: "mind", id: mind.id }]);
    expect(core.retention.retainedBy("note-figure", mind.id)).toHaveLength(2);
    await core.deleteMind(mind.id);
    await core.deletePermanently([{ kind: "mind", id: mind.id }]);
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual([]);
  });

  test("a refused Note deletion cannot release its persisted figure's source projection", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const analysis = run(["a"]);
    analysis.inputs = [
      { kind: "figure", name: "analysis", input: input("analysis"), sha256: "b".repeat(64) },
    ];
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    const before = core.retention.retainedBy("note-figure", mind.id);
    const restore = refuseWrites(dataDir);
    try {
      client.blocks.delete(0, client.blocks.length);
      await client.settled();
      expect(await core.unsavedChanges()).toMatchObject({ mindIds: [mind.id] });
      expect(core.retention.retainedBy("note-figure", mind.id)).toEqual(before);
    } finally {
      restore();
    }
    expect(await core.saveChangesAgain()).toBeNull();
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual([]);
  });

  test("a refused projection keeps the Note update queued until both can be stored", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const analysis = run(["a"]);
    analysis.inputs = [
      { kind: "figure", name: "analysis", input: input("analysis"), sha256: "b".repeat(64) },
    ];
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    const before = core.retention.retainedBy("note-figure", mind.id);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.exec(
      "CREATE TRIGGER refuse_figure_projection BEFORE UPDATE ON retained_versions WHEN OLD.kind = 'note-figure' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      client.blocks.delete(0, client.blocks.length);
      await client.settled();
      expect(await core.unsavedChanges()).toMatchObject({ mindIds: [mind.id] });
      expect(core.retention.retainedBy("note-figure", mind.id)).toEqual(before);
      const stored = new Y.Doc();
      for (const row of queryDatabase<{ data: Uint8Array }>(
        dataDir,
        "SELECT data FROM mind_updates WHERE mind_id = ? AND deleted_at IS NULL ORDER BY rowid",
        [mind.id],
      ))
        Y.applyUpdate(stored, row.data);
      expect(stored.getXmlFragment(MIND_CONTENT_FIELD).length).toBe(1);
      stored.destroy();
    } finally {
      db.exec("DROP TRIGGER refuse_figure_projection");
      db.close();
    }
    expect(await core.saveChangesAgain()).toBeNull();
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual([]);
  });

  test("malformed figure attributes preserve the prior run and source retention", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const analysis = run(["a"]);
    analysis.inputs = [
      { kind: "figure", name: "analysis", input: input("analysis"), sha256: "b".repeat(64) },
    ];
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    const before = core.retention.retainedBy("note-figure", mind.id);
    const broken = figure("a");
    if (!broken.attrs) throw new Error("The figure fixture has no attributes.");
    broken.attrs.figure = { invalid: true };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    client.doc.transact(() => {
      client.blocks.delete(0, client.blocks.length);
      client.blocks.push([createElement({ type: "paragraph", content: [broken] })]);
    });
    await client.settled();
    expect(client.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
    expect(core.retention.retainedBy("note-figure", mind.id)).toEqual(before);
    expect(logged).toHaveBeenCalled();
    await expect(core.openMind(mind.id)).resolves.toHaveProperty("access", "edit");
  });

  test("source collection preserves future-schema figure retention without parsing its dependencies", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const retention = createVersionRetention(db, () => "2026-10-27T00:00:00.000Z");
    retention.retain("note-figure", "future-note", [
      { documentId: "future-source", contentHash: "future-version" },
    ]);
    const future = withFigures(["a"]);
    future.getMap(MIND_SETTINGS_FIELD).set("schemaVersion", CONTENT_SCHEMA_VERSION + 1);
    future.getMap(MIND_FIGURE_RUNS_FIELD).clear();
    const cited: CitedVersions = new Map();
    expect(() => {
      addCitedVersions(future.getXmlFragment(MIND_CONTENT_FIELD), cited);
      retention.addRetainedVersions(cited);
    }).not.toThrow();
    expect(isCited(cited, "future-source", "future-version")).toBe(true);
    future.destroy();
    db.close();
  });

  test("a damaged run does not block startup or drop its source; the last reference still releases it", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const firstText = "# Revenue / 收入\n\nRevenue / 收入 10\n";
    const nextText = "# Revenue / 收入\n\nRevenue / 收入 20\n";
    const path = await writeSourceFile(folder, "Revenue.md", firstText);
    const otherPath = await writeSourceFile(folder, "Other.md", firstText);
    const core = startCore(dataDir);
    const [document, other] = await addAndProcess(core, [path, otherPath]);
    if (!document?.contentHash || !other?.contentHash)
      throw new Error("The source Documents were not processed.");
    const source = input(document.id);
    source.name = "revenue";
    source.citation.contentHash = document.contentHash;
    source.unitStatement = null;
    const analysis = run(["a"]);
    analysis.inputs = [{ kind: "figure", name: "revenue", input: source, sha256: "b".repeat(64) }];
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    client.doc.transact(() => {
      append(client.doc, "a");
      installFigureRuns(client.doc, [analysis]);
    });
    await client.settled();
    await writeFile(path, nextText);
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    core.close();
    const versions = (id = document.id) =>
      queryDatabase<{ content_hash: string }>(
        dataDir,
        "SELECT DISTINCT content_hash FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY content_hash",
        [id],
      ).map((row) => row.content_hash);
    const second = startCore(dataDir);
    expect(versions()).toEqual([sha256(firstText), sha256(nextText)].sort());
    const reopened = await connectToMind(second, mind.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unprojected = run(["b"], "another-run");
    const otherInput = input("other");
    otherInput.citation = { ...citation(other.id), contentHash: other.contentHash };
    otherInput.unitStatement = null;
    unprojected.inputs = [
      { kind: "figure", name: "other", input: otherInput, sha256: "b".repeat(64) },
    ];
    reopened.doc.transact(() => {
      reopened.doc.getMap(MIND_FIGURE_RUNS_FIELD).clear();
      append(reopened.doc, "b", "another-run");
      installFigureRuns(reopened.doc, [unprojected]);
    });
    await reopened.settled();
    expect(
      second.retention.retainedBy("note-figure", mind.id).map((row) => row.documentId),
    ).toEqual([document.id]);
    await writeFile(otherPath, nextText);
    await second.reconcileDocuments();
    await waitForProcessing(second, [other.id]);
    second.close();
    const third = startCore(dataDir);
    expect(versions()).toEqual([sha256(firstText), sha256(nextText)].sort());
    expect(versions(other.id)).toEqual([sha256(firstText), sha256(nextText)].sort());
    const repaired = await connectToMind(third, mind.id);
    installFigureRuns(repaired.doc, [analysis]);
    await repaired.settled();
    expect(kept(repaired.doc)).toEqual([analysis, unprojected]);
    expect(third.retention.retainedBy("note-figure", mind.id)).toHaveLength(2);
    expect(logged).toHaveBeenCalled();
    third.close();
    const fourth = startCore(dataDir);
    const complete = await connectToMind(fourth, mind.id);
    expect(versions(other.id)).toEqual([sha256(firstText), sha256(nextText)].sort());
    complete.blocks.delete(0, complete.blocks.length);
    await complete.settled();
    expect(fourth.retention.retainedBy("note-figure", mind.id)).toEqual([]);
    fourth.close();
    startCore(dataDir);
    expect(versions()).toEqual([sha256(nextText)]);
    expect(versions(other.id)).toEqual([sha256(nextText)]);
  });
});
