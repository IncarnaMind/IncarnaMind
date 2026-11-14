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

/* The version before a Citation could say a check found it: this core with the newest content schema it understands set back to 58. */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 58,
}));

/** The content schema version `foundByCheck` came with (#3019). */
const FOUND_BY_CHECK = 59;

const citationOf = (doc: Y.Doc) => {
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  const citation = paragraph instanceof Y.XmlElement ? paragraph.get(1) : null;
  if (!(citation instanceof Y.XmlElement)) throw new Error("No Citation.");
  return citation;
};

describe("a version from before a Citation could say a check found it", () => {
  // protects=a version that doesn't know `foundByCheck` opens the Note read-only, so its editor can't delete the attribute and make the check's Citation read as the writer's (#3019); fails_when=the older version opens it to edit, or its change lands and strips the attribute; no_claim=what the newer version shows.
  test("opens the Note read-only, so its editor can't strip `foundByCheck`", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(58);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const written = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    const text = new Y.XmlText();
    text.insert(0, "Tides turn twice in a day here.");
    const citation = new Y.XmlElement("citation");
    for (const [key, value] of Object.entries({
      documentId: "document-1",
      contentHash: "version-1",
      quote: "The tide turns twice a day.",
      check: "found",
    })) {
      citation.setAttribute(key, value);
    }
    // Yjs types attributes as text, but keeps the editor's `true` as it is.
    (citation as unknown as Y.XmlElement<Record<string, boolean>>).setAttribute(
      "foundByCheck",
      true,
    );
    paragraph.insert(0, [text, citation]);
    written.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    written.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, FOUND_BY_CHECK);
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    citationOf(doc).removeAttribute("foundByCheck");
    const [update] = sent;
    if (!update) throw new Error("Nothing sent.");
    await expect(core.applyMindUpdate(mind.id, update)).rejects.toThrow(MindReadOnlyError);
    const after = new Y.Doc();
    Y.applyUpdate(after, (await core.openMind(mind.id)).state);
    expect(citationOf(after).getAttribute("foundByCheck")).toBe(true);
  });
});
