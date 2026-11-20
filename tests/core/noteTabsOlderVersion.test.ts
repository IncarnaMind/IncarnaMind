import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
  NOTE_TAB_NODE,
} from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before tabs in a Note (#3414): a 61 build, which knows no noteTab node and would
 * drop it when it saves the Note, running its tabs together.
 */
const real = vi.hoisted(() => ({ version: 0 }));

vi.mock("../../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<{ CONTENT_SCHEMA_VERSION: number }>();
  real.version = actual.CONTENT_SCHEMA_VERSION;
  return { ...actual, CONTENT_SCHEMA_VERSION: 61 };
});

/** The content schema version tabs came with. */
const TABS = 62;

function mindWithTabs(): Y.Doc {
  const doc = new Y.Doc();
  const blocks = [
    ["summary", "Summary", "Sailings ran on time on most days."],
    ["fleet", "Fleet", "Two ferries were refitted over the winter."],
  ].flatMap(([id, title, words]) => {
    const tab = new Y.XmlElement(NOTE_TAB_NODE);
    tab.setAttribute("id", id as string);
    tab.setAttribute("title", title as string);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", `${id}-text`);
    paragraph.insert(0, [new Y.XmlText(words)]);
    return [tab, paragraph];
  });
  doc.getXmlFragment(MIND_CONTENT_FIELD).push(blocks);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, TABS);
  return doc;
}

function blocksOf(state: Uint8Array): Y.XmlFragment {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(MIND_CONTENT_FIELD);
}

const names = (blocks: Y.XmlFragment) =>
  blocks.toArray().map((block) => (block instanceof Y.XmlElement ? block.nodeName : "text"));

describe("a version from before tabs in a Note", () => {
  test("opens a Note with tabs read-only, and keeps its tab Blocks", async () => {
    // This test is the guard on the bump: a revert to 61 must fail here.
    expect(real.version).toBeGreaterThanOrEqual(TABS);
    expect(CONTENT_SCHEMA_VERSION).toBe(61);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Harbourline Ferries" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithTabs()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const shape = [NOTE_TAB_NODE, "paragraph", NOTE_TAB_NODE, "paragraph"];
    expect(names(blocksOf(opened.state))).toEqual(shape);

    // An older editor would drop the tab Blocks it doesn't know: that change is refused.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    doc.getXmlFragment(MIND_CONTENT_FIELD).delete(2, 1);
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );

    expect(names(blocksOf((await core.openMind(mind.id)).state))).toEqual(shape);
  });
});
