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

/* The version before numbered lists' schemes: this core with the newest content schema it understands set back to 26. */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 26,
}));

/** The content schema version numbered lists came with. */
const NUMBERED = 27;

const NUMBERING = "numbering";
const START_LEVEL = "startLevel";
const CONTINUES = "continues";

describe("a version from before numbered lists' schemes", () => {
  test("opens the Mind of a numbered list read-only, so its editor can't strip the scheme", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(26);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Report" });
    const written = new Y.Doc();
    const list = new Y.XmlElement("orderedList");
    const numbered: Y.XmlElement<Record<string, string | number | boolean>> = list;
    numbered.setAttribute(NUMBERING, "clauses");
    numbered.setAttribute(START_LEVEL, 2);
    numbered.setAttribute(CONTINUES, true);
    const item = new Y.XmlElement("listItem");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    const text = new Y.XmlText();
    text.insert(0, "Clause one.");
    paragraph.insert(0, [text]);
    item.insert(0, [paragraph]);
    list.insert(0, [item]);
    written.getXmlFragment(MIND_CONTENT_FIELD).push([list]);
    written.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, NUMBERED);
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const stored = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
    if (!(stored instanceof Y.XmlElement)) throw new Error("No list.");
    stored.removeAttribute(NUMBERING);
    const [update] = sent;
    if (!update) throw new Error("Nothing sent.");
    await expect(core.applyMindUpdate(mind.id, update)).rejects.toThrow(MindReadOnlyError);
    const after = new Y.Doc();
    Y.applyUpdate(after, (await core.openMind(mind.id)).state);
    const kept = after.getXmlFragment(MIND_CONTENT_FIELD).get(0);
    if (!(kept instanceof Y.XmlElement)) throw new Error("No list.");
    expect(kept.getAttribute(NUMBERING)).toBe("clauses");
    expect(kept.getAttribute(START_LEVEL)).toBe(2);
    expect(kept.getAttribute(CONTINUES)).toBe(true);
  });
});
