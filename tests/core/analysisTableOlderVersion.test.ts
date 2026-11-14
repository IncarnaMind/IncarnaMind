/**
 * The content schema bump for an Analysis's table as one calculated object (#2378): a Mind written
 * at version 51, whose table of an Analysis's numbers is a typed table, opens and edits as it did,
 * keeps that table typed and unbound, and nothing rewrites it until the User changes it; a change
 * records version 59.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as Y from "yjs";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  DATABASE_FILE,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";

const cell = (kind: "tableHeader" | "tableCell", text: string): Y.XmlElement => {
  const element = new Y.XmlElement(kind);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  element.insert(0, [paragraph]);
  return element;
};

const row = (kind: "tableHeader" | "tableCell", texts: readonly string[]): Y.XmlElement => {
  const element = new Y.XmlElement("tableRow");
  element.insert(
    0,
    texts.map((text) => cell(kind, text)),
  );
  return element;
};

/** A Mind as version 51 wrote it: an Analysis's totals as a typed table, with no binding. */
function version51State(): Uint8Array {
  const doc = new Y.Doc();
  const table = new Y.XmlElement("table");
  table.setAttribute("id", "table-1");
  table.insert(0, [
    row("tableHeader", ["region", "amount"]),
    row("tableCell", ["Central", "8,325"]),
    row("tableCell", ["North", "9,450"]),
  ]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([table]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, 51);
  return Y.encodeStateAsUpdate(doc);
}

/** Stores a Mind's document row as an older version wrote it, without this version stamping it. */
function storeMind(dataDir: string, mindId: string, state: Uint8Array): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    const at = "2026-11-01T09:00:00.000Z";
    db.run(
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
      [randomUUID(), mindId, state, at, at],
    );
  } finally {
    db.close();
  }
}

const docOf = (state: Uint8Array): Y.Doc => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
};

const versionOf = (state: Uint8Array): unknown =>
  docOf(state).getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY);

const tableOf = (state: Uint8Array): Y.XmlElement | undefined =>
  docOf(state)
    .getXmlFragment(MIND_CONTENT_FIELD)
    .toArray()
    .find(
      (each): each is Y.XmlElement => each instanceof Y.XmlElement && each.nodeName === "table",
    );

test("a Mind written before Analysis tables opens to edit, its table typed, and opening it rewrites nothing", async () => {
  expect(CONTENT_SCHEMA_VERSION).toBe(59);
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Older" });
  storeMind(dataDir, mind.id, version51State());

  const opened = await core.openMind(mind.id);
  expect(opened.access).toBe("edit");
  expect(versionOf(opened.state)).toBe(51);
  expect(tableOf(opened.state)?.getAttribute(ANALYSIS_TABLE_ATTRIBUTE)).toBeUndefined();
  core.closeMind(mind.id);
  const again = await core.openMind(mind.id);
  expect(again.state).toEqual(opened.state);
  core.close();
});

test("a change to a Mind written before Analysis tables records the current version, 59", async () => {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Older" });
  storeMind(dataDir, mind.id, version51State());
  const opened = await core.openMind(mind.id);

  const doc = docOf(opened.state);
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("Totals by region.")]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).insert(0, [paragraph]);
  const [update] = updates;
  if (!update) throw new Error("The edit made no update.");
  await core.applyMindUpdate(mind.id, update);
  const stored = await core.openMind(mind.id);
  expect(versionOf(stored.state)).toBe(59);
  expect(tableOf(stored.state)?.getAttribute(ANALYSIS_TABLE_ATTRIBUTE)).toBeUndefined();
  core.close();
});

test("a Mind a later version wrote opens read-only, so its table binding is never dropped", async () => {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Newer" });
  const doc = docOf(version51State());
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, CONTENT_SCHEMA_VERSION + 1);
  storeMind(dataDir, mind.id, Y.encodeStateAsUpdate(doc));
  const opened = await core.openMind(mind.id);
  expect(opened.access).toBe("read-only");
  core.close();
});
