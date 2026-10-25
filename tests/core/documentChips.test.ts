import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  DOCUMENT_CHIP_NODE,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

/*
 * Document chips the User writes with "@", and checklists (#115), in the
 * core: kept in the Mind's Yjs content across a restart and between clients,
 * with the content schema version that says an older version can't read them.
 */

const text = (value: string): JSONContent => ({ type: "text", text: value });

const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content,
});

const chip = (documentId: string, name: string): JSONContent => ({
  type: DOCUMENT_CHIP_NODE,
  attrs: { documentId, name },
});

const checklist = (): JSONContent => ({
  type: "taskList",
  attrs: { id: randomUUID() },
  content: [
    {
      type: "taskItem",
      attrs: { checked: true },
      content: [paragraph(text("Read the tide table"))],
    },
    { type: "taskItem", attrs: { checked: false }, content: [paragraph(text("潮汐表"))] },
  ],
});

const sample = (): JSONContent[] => [
  paragraph(
    text("Compare with "),
    chip("doc-1", "Tides 2026.pdf"),
    text(" and "),
    chip("doc-2", "潮汐表.docx"),
  ),
  checklist(),
];

/** The chips and checklist items in a Mind, as they are stored. */
function stored(doc: ReturnType<typeof readMind>) {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === DOCUMENT_CHIP_NODE) {
      found.push(`chip ${node.attrs.documentId} ${node.attrs.name}`);
    } else if (node.type.name === "taskItem") {
      found.push(`item ${node.attrs.checked} ${node.textContent}`);
    }
    return true;
  });
  return found;
}

describe("Document chips and checklists in the Mind's Yjs content", () => {
  test("reach another client, and are there after a restart, with the new content schema version", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { now: manualClock().now });
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const other = await connectToMind(core, mind.id);
    writeMind(client, sample());
    await client.settled();

    const written = stored(readMind(client));
    expect(written).toEqual([
      "chip doc-1 Tides 2026.pdf",
      "chip doc-2 潮汐表.docx",
      "item true Read the tide table",
      "item false 潮汐表",
    ]);
    await expect.poll(() => stored(readMind(other))).toEqual(written);
    expect(client.doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
      CONTENT_SCHEMA_VERSION,
    );

    core.close();
    const restarted = startCore(dataDir);
    const reader = await connectToMind(restarted, mind.id);
    expect(stored(readMind(reader))).toEqual(written);
    restarted.close();
  });

  test("Markdown keeps each chip's name and the checklist's completion state", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { now: manualClock().now });
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, sample());
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "markdown" });
    const markdown = new TextDecoder().decode(exported.data);
    expect(markdown).toContain("Compare with Tides 2026.pdf and 潮汐表.docx");
    expect(markdown).toContain("- [x] Read the tide table");
    expect(markdown).toContain("- [ ] 潮汐表");
    core.close();
  });
});
