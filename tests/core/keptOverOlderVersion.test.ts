import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/* The version before Keep citing the old version: this core with the newest content schema it understands set back to 27. */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 27,
}));

/** The content schema version `keptOver` came with. */
const KEPT_OVER = 28;

const citationOf = (doc: Y.Doc) => {
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  const citation = paragraph instanceof Y.XmlElement ? paragraph.get(1) : null;
  if (!(citation instanceof Y.XmlElement)) throw new Error("No Citation.");
  return citation;
};

describe("a version from before Keep citing the old version", () => {
  test("opens the Mind of a kept Citation read-only, so its editor can't strip `keptOver`", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(27);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Notice" });
    const written = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    const text = new Y.XmlText();
    text.insert(0, "The notice period is sixty days.");
    const citation = new Y.XmlElement("citation");
    for (const [key, value] of Object.entries({
      documentId: "document-1",
      contentHash: "version-1",
      quote: "The notice period is sixty (60) days.",
      check: "found",
      keptOver: "version-2",
    })) {
      citation.setAttribute(key, value);
    }
    paragraph.insert(0, [text, citation]);
    written.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    written.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, KEPT_OVER);
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    citationOf(doc).removeAttribute("keptOver");
    const [update] = sent;
    if (!update) throw new Error("Nothing sent.");
    await expect(core.applyMindUpdate(mind.id, update)).rejects.toThrow(MindReadOnlyError);
    const after = new Y.Doc();
    Y.applyUpdate(after, (await core.openMind(mind.id)).state);
    expect(citationOf(after).getAttribute("keptOver")).toBe("version-2");
  });
});
