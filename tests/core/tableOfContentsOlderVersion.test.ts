import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
  TABLE_OF_CONTENTS_NODE,
} from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before a table of contents Block (#1935): a 37 build, which
 * knows no tableOfContents node and would drop it when it saves the Note.
 */
const real = vi.hoisted(() => ({ version: 0 }));

vi.mock("../../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<{ CONTENT_SCHEMA_VERSION: number }>();
  real.version = actual.CONTENT_SCHEMA_VERSION;
  return { ...actual, CONTENT_SCHEMA_VERSION: 37 };
});

/** The content schema version a table of contents came with. */
const CONTENTS = 38;

function mindWithContents(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  paragraph.insert(0, [new Y.XmlText("Written after the headings.")]);
  const contents = new Y.XmlElement(TABLE_OF_CONTENTS_NODE);
  contents.setAttribute("id", "block-2");
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph, contents]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, CONTENTS);
  return doc;
}

function blocksOf(state: Uint8Array): Y.XmlFragment {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(MIND_CONTENT_FIELD);
}

describe("a version from before a table of contents", () => {
  test("opens the Note read-only, and keeps the Block it doesn't know", async () => {
    // This test is the guard on the bump: a revert to 37 must fail here.
    expect(real.version).toBeGreaterThanOrEqual(38);
    expect(CONTENT_SCHEMA_VERSION).toBe(37);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Contents" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithContents()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const blocks = blocksOf(opened.state);
    expect(blocks.length).toBe(2);
    expect(blocks.get(1)).toBeInstanceOf(Y.XmlElement);
    expect((blocks.get(1) as Y.XmlElement).nodeName).toBe(TABLE_OF_CONTENTS_NODE);

    // An older editor would drop the node it doesn't know: that change is refused.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    doc.getXmlFragment(MIND_CONTENT_FIELD).delete(1, 1);
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );

    const again = blocksOf((await core.openMind(mind.id)).state);
    expect(again.length).toBe(2);
    expect((again.get(1) as Y.XmlElement).nodeName).toBe(TABLE_OF_CONTENTS_NODE);
  });
});
