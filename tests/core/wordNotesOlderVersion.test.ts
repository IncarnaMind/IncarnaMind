import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  FOOTNOTE_NODE,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
  PAGE_BREAK_NODE,
} from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before a Word file's notes and page breaks were the Note's own
 * (#746): a build that reads one content schema older than this one, whose
 * editor writes a footnote back without its source and endnote, and drops a
 * page break it doesn't know.
 */
const real = vi.hoisted(() => ({ version: 0 }));

vi.mock("../../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<{ CONTENT_SCHEMA_VERSION: number }>();
  real.version = actual.CONTENT_SCHEMA_VERSION;
  return { ...actual, CONTENT_SCHEMA_VERSION: actual.CONTENT_SCHEMA_VERSION - 1 };
});

const SOURCE = "w:endnoteReference#0";

/** A paragraph as a Note converted from an older import holds it: an endnote and a page break of its own. */
const converted: NodeJSON = {
  type: "paragraph",
  attrs: { id: "block-1" },
  content: [
    { type: "text", text: "The fittings are listed in the schedule." },
    {
      type: FOOTNOTE_NODE,
      attrs: { id: "note-1", source: SOURCE, endnote: true },
      content: [{ type: "text", text: "Schedule 3 lists the fittings." }],
    },
    { type: PAGE_BREAK_NODE, attrs: { source: "w:br#0" } },
  ],
};

const footnoteIn = (doc: Y.Doc) =>
  (doc.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement)
    .toArray()
    .find(
      (element): element is Y.XmlElement =>
        element instanceof Y.XmlElement && element.nodeName === FOOTNOTE_NODE,
    );

describe("a version from before a Word file's notes were the Note's own", () => {
  // protects=a build one content schema older opens a converted Note read-only, so its editor can't write a footnote back without its source and endnote; fails_when=the notes' version is not above the reader's, it opens writable, or its write reaches the stored footnote; no_claim=how the newer version shows it.
  test("opens a converted Note read-only, and its footnote can't be written back without its source and endnote", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(real.version - 1);
    const doc = new Y.Doc();
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(converted)]);
    doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, real.version);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Lease brief" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its editor, which knows neither attribute, writes the footnote back without them: refused.
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, opened.state);
    const sent: Uint8Array[] = [];
    theirs.on("update", (update: Uint8Array) => sent.push(update));
    theirs.transact(() => {
      const own = footnoteIn(theirs);
      if (!own) throw new Error("The Note has no footnote.");
      own.removeAttribute("source");
      own.removeAttribute("endnote");
    });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await core.openMind(mind.id)).state);
    const kept = footnoteIn(stored);
    expect(kept?.getAttribute("source")).toBe(SOURCE);
    expect((kept?.getAttributes() as Record<string, unknown> | undefined)?.endnote).toBe(true);
  });
});
