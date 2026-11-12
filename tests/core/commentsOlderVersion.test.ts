/**
 * The content schema bump for comments (#328, #216): a Mind written before
 * comments, at version 48, opens and edits as it did, and nothing rewrites
 * it until the User changes it; a change records this version.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  DATABASE_FILE,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";

/** A Mind as version 48 wrote it: a paragraph of text, and no comments. */
function version48State(): Uint8Array {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  paragraph.insert(0, [new Y.XmlText("A line written before comments.")]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, 48);
  return Y.encodeStateAsUpdate(doc);
}

/** Stores a Mind's document row as an older version wrote it, without this version stamping it. */
function storeMind(dataDir: string, mindId: string, state: Uint8Array): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    const at = "2026-10-02T09:00:00.000Z";
    db.run(
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
      [randomUUID(), mindId, state, at, at],
    );
  } finally {
    db.close();
  }
}

const versionOf = (state: Uint8Array): unknown => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY);
};

test("a Mind written before comments opens to edit, and opening it alone rewrites nothing", async () => {
  expect(CONTENT_SCHEMA_VERSION).toBe(58);
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Older" });
  storeMind(dataDir, mind.id, version48State());

  const opened = await core.openMind(mind.id);
  expect(opened.access).toBe("edit");
  expect(versionOf(opened.state)).toBe(48);
  core.closeMind(mind.id);
  const again = await core.openMind(mind.id);
  expect(versionOf(again.state)).toBe(48);
  expect(again.state).toEqual(opened.state);
  core.close();
});

test("a change to an older Mind records this version", async () => {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Older" });
  storeMind(dataDir, mind.id, version48State());
  const opened = await core.openMind(mind.id);

  const updates = editInDocument(opened.state);
  await core.applyMindUpdate(mind.id, updates);
  const stored = await core.openMind(mind.id);
  expect(versionOf(stored.state)).toBe(58);
  core.close();
});

/** One change to a copy of a Mind's document, as the editor sends it. */
function editInDocument(state: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
  const text = paragraph.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("No text.");
  text.insert(text.length, " Edited.");
  const [update] = updates;
  if (!update) throw new Error("The edit made no update.");
  doc.destroy();
  return update;
}
