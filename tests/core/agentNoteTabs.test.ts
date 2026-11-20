/**
 * An outside agent reads a Note with tabs (#3414): `read_mind` shows each tab as a part of the
 * Note under its title, in order, read whole or by its named paragraphs, and a tab's title is
 * never a paragraph to change.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

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
  return { agent, mind };
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
});
