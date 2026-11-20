/**
 * An outside agent reads a Note with tabs (#3414): `read_mind` shows each tab as a part of the
 * Note under its title, in order, read whole or by its named paragraphs, and a tab's title is
 * never a paragraph to change.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NOTE_TAB_NODE, NOTE_TAB_TITLE_ATTRIBUTE, PICTURE_NODE } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

/** A PNG of one pixel, as an agent gives a picture inline. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const tab = (title: string): JSONContent => ({
  type: "noteTab",
  attrs: { id: randomUUID(), title },
});

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

/** A core with agents on, a Note of two tabs in "Harbour" and an agent that may read there. */
async function paired() {
  const { core } = await startAgentsCore(replyingModel());
  const harbour = await core.createLibraryGroup({ name: "Harbour", description: "Ferries." });
  const mind = await core.createMind({ title: "Harbourline Ferries", folderId: harbour.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    tab("Summary"),
    heading(1, "Harbourline Ferries"),
    note("Sailings ran on time on most days."),
    tab("Fleet"),
    note("Two ferries were refitted over the winter."),
  ]);
  await client.settled();
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [harbour.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(launch);
  return { core, agent, mind, harbour };
}

describe("read_mind on a Note with tabs", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("shows each tab under its title, whole and by named paragraph", async () => {
    const { agent, mind } = await paired();

    const whole = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id } }),
    );
    expect(whole.markdown).toContain(
      [
        "# Harbourline Ferries",
        "# Summary",
        "Sailings ran on time on most days.",
        "# Fleet",
        "Two ferries were refitted over the winter.",
      ].join("\n\n"),
    );
    // The Note's title is read once.
    expect(whole.markdown.match(/# Harbourline Ferries/g)).toHaveLength(1);

    const named = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    expect(named.markdown.split("\n\n")).toEqual([
      "Tab: Summary",
      "¶0 # Harbourline Ferries",
      "¶1 Sailings ran on time on most days.",
      "Tab: Fleet",
      "¶2 Two ferries were refitted over the winter.",
    ]);
  });

  it("keeps a picture an agent adds to a Note with tabs in the tab it adds it to", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbourline Ferries",
          markdown: "Sailings ran on time.\n\nTwo ferries were refitted.",
        },
      }),
    );
    // The User makes the Note two tabs, as the panel's New tab does.
    const client = await connectToMind(core, made.mindId);
    const tabBlock = (title: string) => {
      const block = new Y.XmlElement(NOTE_TAB_NODE);
      block.setAttribute("id", randomUUID());
      block.setAttribute(NOTE_TAB_TITLE_ATTRIBUTE, title);
      return block;
    };
    client.doc.transact(() => {
      client.blocks.insert(client.blocks.length - 1, [tabBlock("Fleet")]);
      client.blocks.insert(0, [tabBlock("Summary")]);
    });
    await client.settled();

    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    expect(read.markdown.split("\n\n")).toEqual([
      "Tab: Summary",
      "¶0 # Harbourline Ferries",
      "¶1 Sailings ran on time.",
      "Tab: Fleet",
      "¶2 Two ferries were refitted.",
    ]);
    const changed = structured<{ status: string; markdown: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [{ paragraph: "¶2+", text: `![Refit](data:image/png;base64,${PNG})` }],
        },
      }),
    );
    expect(changed.status).toBe("applied");
    expect(changed.markdown.split("\n\n").slice(3)).toEqual([
      "Tab: Fleet",
      "¶2 Two ferries were refitted.",
      "![Refit](data:image/png;base64,…)",
    ]);
    const kinds: string[] = [];
    readMind(await connectToMind(core, made.mindId)).forEach((block) => {
      kinds.push(block.type.name);
    });
    expect(kinds).toEqual([
      NOTE_TAB_NODE,
      "heading",
      "paragraph",
      NOTE_TAB_NODE,
      "paragraph",
      PICTURE_NODE,
    ]);

    // Read whole, the picture stands in Fleet's section.
    const whole = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId } }),
    );
    expect(whole.markdown).toMatch(/# Fleet\n\nTwo ferries were refitted\.\n\n!\[Refit\]/);
  });
});
