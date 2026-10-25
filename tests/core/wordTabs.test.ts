import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MIND_WORD_LOOK_FIELD,
  WORD_LOOK_ATTRIBUTE,
  WORD_TAB_MARK,
} from "../../src/core";
import { wordLookOf } from "../../src/shared/wordLook";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { paragraphsOf, unzip } from "../helpers/docx";
import { recordingLog } from "../helpers/log";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { contractFile, resumeFile } from "../helpers/wordLookFiles";
import { importWordBytes } from "../helpers/wordMinds";

function tabs(client: MindClient): { marked: number; unmarked: number } {
  let marked = 0;
  let unmarked = 0;
  readMind(client).descendants((node) => {
    if (!node.isText || !node.text?.includes("\t")) return true;
    const tab = node.marks.some((mark) => mark.type.name === WORD_TAB_MARK);
    const count = node.text.split("\t").length - 1;
    if (tab) marked += count;
    else unmarked += count;
    return true;
  });
  return { marked, unmarked };
}

function typeAtStartOf(client: MindClient, line: string, typed: string): void {
  for (const node of client.blocks.createTreeWalker(() => true)) {
    if (node instanceof Y.XmlText && node.toString().includes(line)) {
      node.insert(0, typed);
      return;
    }
  }
  throw new Error(`No line with ${line}.`);
}

/** The tab stops of the paragraph whose text starts with `line`. */
function stopsOf(client: MindClient, line: string) {
  const look = wordLookOf(client.doc);
  for (const node of client.blocks.createTreeWalker(() => true)) {
    if (node instanceof Y.XmlElement && node.nodeName === "paragraph") {
      const text = node.toArray().find((child) => child instanceof Y.XmlText);
      const key = node.getAttribute(WORD_LOOK_ATTRIBUTE);
      if (text?.toString().startsWith(line) && typeof key === "string") {
        return look?.paragraphs[key]?.tabs;
      }
    }
  }
  return undefined;
}

describe("the tabs of a Mind imported from Word", () => {
  test("each carries its tab mark, and export still writes the file's own bytes", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    onTestFinished(() => core.close());
    const bytes = resumeFile();
    const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
    const written =
      (unzip(bytes).get("word/document.xml")?.toString() ?? "").split("<w:tab/>").length - 1;
    expect(written).toBeGreaterThan(4);
    expect(tabs(client)).toEqual({ marked: written, unmarked: 0 });

    const result = await core.exportMind(mindId, { format: "docx" });
    const before = unzip(bytes);
    const after = unzip(result.data);
    expect(
      [...before.keys()].filter(
        (name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)),
      ),
    ).toEqual([]);
  });

  test("typed into a line of tab stops, export writes that line with its tabs and every other as it was", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    onTestFinished(() => core.close());
    const bytes = resumeFile();
    const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
    client.doc.transact(() => typeAtStartOf(client, "复旦大学", "A"));
    await client.settled();

    const result = await core.exportMind(mindId, { format: "docx" });
    const before = paragraphsOf(unzip(bytes).get("word/document.xml")?.toString() ?? "");
    const after = paragraphsOf(unzip(result.data).get("word/document.xml")?.toString() ?? "");
    const typed = before.findIndex((each) => each.text.startsWith("复旦大学"));
    expect(after[typed]?.text).toBe(`A${before[typed]?.text}`);
    expect(after[typed]?.text.split("\t")).toHaveLength(4);
    expect(after.filter((_, index) => index !== typed)).toEqual(
      before.filter((_, index) => index !== typed),
    );
  });

  test("an edited line of tab stops exports with its stops, and the file imports again the same", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    onTestFinished(() => core.close());
    const { mindId, client } = await importWordBytes(core, dataDir, resumeFile(), {
      origin: "own",
    });
    const stops = stopsOf(client, "复旦大学");
    expect(stops?.length).toBeGreaterThan(1);
    client.doc.transact(() => typeAtStartOf(client, "复旦大学", "A"));
    await client.settled();

    const exported = await core.exportMind(mindId, { format: "docx" });
    const again = await importWordBytes(core, dataDir, Buffer.from(exported.data), {
      origin: "own",
      name: "Edited.docx",
    });
    expect(stopsOf(again.client, "A复旦大学")).toEqual(stops);
    expect(tabs(again.client)).toEqual(tabs(client));
    expect(readMind(again.client).textContent).toBe(readMind(client).textContent);
  });

  test("the file's own default tab stops are kept, and a Word default when it sets none", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    onTestFinished(() => core.close());
    const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="420"/></w:settings>`;
    const chinese = await importWordBytes(core, dataDir, contractFile({ settings }), {
      origin: "own",
    });
    expect(wordLookOf(chinese.client.doc)?.defaultTab).toBe(21);
    const plain = await importWordBytes(core, dataDir, contractFile(), { origin: "own" });
    expect(wordLookOf(plain.client.doc)?.defaultTab).toBeNull();
  });

  test("a Mind whose look an earlier version read gets them at the next start, on Blocks edited since import too", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mindId, client } = await importWordBytes(core, dataDir, resumeFile(), {
      origin: "own",
    });
    client.doc.transact(() => {
      const strip = (element: Y.XmlElement) => {
        for (const child of element.toArray()) {
          if (child instanceof Y.XmlElement) strip(child);
          else if (child instanceof Y.XmlText)
            child.format(0, child.length, { [WORD_TAB_MARK]: null });
        }
      };
      for (const child of client.blocks.toArray()) if (child instanceof Y.XmlElement) strip(child);
      typeAtStartOf(client, "复旦大学", "A");
      client.doc.getMap(MIND_WORD_LOOK_FIELD).set("version", 1);
    });
    await client.settled();
    expect(tabs(client).marked).toBe(0);
    core.close();
    queryDatabase(dataDir, "UPDATE word_packages SET look_version = 1 WHERE mind_id = ?", [mindId]);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    onTestFinished(() => restarted.close());
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    expect(tabs(after).unmarked).toBe(0);
    expect(tabs(after).marked).toBeGreaterThan(4);
  });
});

describe("Minds written before tab stops", () => {
  test("a Mind written at content schema 21 or 22 opens to edit, and records the newest once written to", async () => {
    const core = startCore(await createTempDataFolder());
    onTestFinished(() => core.close());
    for (const version of [21, 22]) {
      const mind = await core.createMind({ title: `Written at ${version}` });
      const written = new Y.Doc();
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute("id", `block-${version}`);
      paragraph.insert(0, [new Y.XmlText("Plain words.")]);
      written.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
      written.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, version);
      await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));

      const opened = await core.openMind(mind.id);
      expect(opened.access, `${version}`).toBe("edit");
      const client = await connectToMind(core, mind.id);
      client.doc.transact(() => {
        const text = client.blocks.get(0);
        if (text instanceof Y.XmlElement) text.insert(1, [new Y.XmlText(" More.")]);
      });
      await client.settled();
      expect(client.doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
        CONTENT_SCHEMA_VERSION,
      );
    }
    expect(CONTENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(23);
  });
});
