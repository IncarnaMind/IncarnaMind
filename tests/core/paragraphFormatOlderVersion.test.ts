import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
  PARAGRAPH_FORMAT_ATTRIBUTE,
  TEXT_COLOR_MARK,
} from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/* The version before paragraph formatting: this core with the newest content schema it understands set back to 23. */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 23,
}));

const FORMATTING = 24;

describe("a version from before paragraph formatting", () => {
  test("opens a formatted Mind read-only, so its editor can't strip the format or the colour", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(23);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Memo" });
    const written = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    const formatted: Y.XmlElement<Record<string, string | object>> = paragraph;
    formatted.setAttribute(PARAGRAPH_FORMAT_ATTRIBUTE, { align: "center", firstLineChars: 2 });
    const text = new Y.XmlText();
    text.insert(0, "Red words", { [TEXT_COLOR_MARK]: { color: "C00000" } });
    paragraph.insert(0, [text]);
    written.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    written.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, FORMATTING);
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const line = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
    if (!(line instanceof Y.XmlElement)) throw new Error("No line.");
    line.removeAttribute(PARAGRAPH_FORMAT_ATTRIBUTE);
    const [update] = sent;
    if (!update) throw new Error("Nothing sent.");
    await expect(core.applyMindUpdate(mind.id, update)).rejects.toThrow(MindReadOnlyError);
  });
});
