/**
 * An outside agent reads and writes a Note with tabs (#3414). A tab starts at a ```tab block of its
 * title, as `read_mind` shows it, whole or by named paragraph, and as `create_mind` and
 * `propose_changes` take it: the agent writes what it reads. A `# Title` stays a heading.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  NOTE_TAB_NODE,
  NOTE_TAB_TITLE_ATTRIBUTE,
  PICTURE_NODE,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core/api";
import { decideProposals, waitingChanges } from "../../src/shared/proposals";
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

const fence = (title: string) => `\`\`\`tab\n${title}\n\`\`\``;

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

/** A core with agents on, the User's Note of two tabs in "Harbour" and an agent that may write there. */
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

/** Each top-level Block of a Note: a tab by its title, any other by its kind. */
async function shapeOf(core: Awaited<ReturnType<typeof paired>>["core"], mindId: string) {
  const shape: string[] = [];
  readMind(await connectToMind(core, mindId)).forEach((block) => {
    shape.push(
      block.type.name === NOTE_TAB_NODE
        ? `tab ${String(block.attrs[NOTE_TAB_TITLE_ATTRIBUTE])}`
        : block.type.name,
    );
  });
  return shape;
}

const SUMMARY_AND_FLEET = [
  fence("Summary"),
  "Sailings ran on time on most days.",
  fence("Fleet"),
  "Two ferries were refitted over the winter.",
].join("\n\n");

describe("an agent and a Note with tabs", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("reads each tab's start as a ```tab block of its title, whole and by named paragraph", async () => {
    const { agent, mind } = await paired();

    const whole = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id } }),
    );
    expect(whole.markdown).toContain(
      [
        fence("Summary"),
        "# Harbourline Ferries",
        "Sailings ran on time on most days.",
        fence("Fleet"),
        "Two ferries were refitted over the winter.",
      ].join("\n\n"),
    );
    expect(whole.markdown.match(/# Harbourline Ferries/g)).toHaveLength(1);

    const named = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    expect(named.markdown.split("\n\n")).toEqual([
      fence("Summary"),
      "¶0 # Harbourline Ferries",
      "¶1 Sailings ran on time on most days.",
      fence("Fleet"),
      "¶2 Two ferries were refitted over the winter.",
    ]);
  });

  it("writes a Note in tabs, its title heading in the first, and reads it back as it wrote it", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string; title: string; uncited: string[] }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbourline Ferries", markdown: SUMMARY_AND_FLEET },
      }),
    );
    expect(made.title).toBe("Harbourline Ferries");
    // A tab's title makes no claim to cite.
    expect(made.uncited.join(" ")).not.toMatch(/Summary|Fleet/);
    expect(await shapeOf(core, made.mindId)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
    ]);
    const ids = new Set<string>();
    readMind(await connectToMind(core, made.mindId)).forEach((block) => {
      if (block.type.name === NOTE_TAB_NODE) ids.add(String(block.attrs.id ?? ""));
    });
    expect([...ids].filter((id) => id !== "")).toHaveLength(2);

    const whole = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId } }),
    );
    expect(whole.markdown).toContain(
      [
        fence("Summary"),
        "# Harbourline Ferries",
        "Sailings ran on time on most days.",
        fence("Fleet"),
        "Two ferries were refitted over the winter.",
      ].join("\n\n"),
    );
    // What it reads, written again, is the same Note.
    const again = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbourline Ferries", markdown: whole.markdown },
      }),
    );
    expect(await shapeOf(core, again.mindId)).toEqual(await shapeOf(core, made.mindId));
  });

  it("keeps a title heading written above the first tab in that tab, as the window does", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string; title: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Ferries",
          markdown: `# Harbourline Ferries\n\n${SUMMARY_AND_FLEET}`,
        },
      }),
    );
    expect(made.title).toBe("Harbourline Ferries");
    // The panel shows the two tabs asked for, with no tab before them.
    expect(await shapeOf(core, made.mindId)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
    ]);
  });

  it("reads a tab written as one block holding its Markdown, its title on the fence or inside", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string; uncited: string[] }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbourline Ferries",
          markdown: [
            "```tab Fleet",
            "Six ferries ran in 2026.",
            "",
            "```python",
            "print(6)",
            "```",
            "```",
            "",
            "```tab",
            "Costs",
            "Fuel cost 3.1 million in 2026.",
            "```",
          ].join("\n"),
        },
      }),
    );
    expect(await shapeOf(core, made.mindId)).toEqual([
      "tab Fleet",
      "heading",
      "paragraph",
      "codeBlock",
      "tab Costs",
      "paragraph",
    ]);
    // Its words are a claim like any other.
    expect(made.uncited).toEqual(["Six ferries ran in 2026.", "Fuel cost 3.1 million in 2026."]);
  });

  it("makes no tab of a heading, nor of a ```tab block inside a list", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbourline Ferries",
          markdown: [
            "# Summary",
            "Sailings ran on time.",
            "# Fleet",
            `- Refits:\n\n  ${fence("Fleet").replaceAll("\n", "\n  ")}`,
          ].join("\n\n"),
        },
      }),
    );
    expect(await shapeOf(core, made.mindId)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bulletList",
    ]);
  });

  it("adds a tab after a paragraph of a Note it wrote, at once", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbourline Ferries", markdown: SUMMARY_AND_FLEET },
      }),
    );
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    const changed = structured<{ status: string; markdown: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [
            { paragraph: "¶2+", text: `${fence("Costs")}\n\nFuel cost more in the winter.` },
            // A tab it means to fill later: in its own Note, there at once.
            { paragraph: "¶+", text: fence("Notes") },
          ],
        },
      }),
    );
    expect(changed.status).toBe("applied");
    expect(changed.markdown.split("\n\n").slice(3)).toEqual([
      fence("Fleet"),
      "¶2 Two ferries were refitted over the winter.",
      fence("Costs"),
      "¶3 Fuel cost more in the winter.",
      fence("Notes"),
    ]);
    expect(await shapeOf(core, made.mindId)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
      "tab Costs",
      "paragraph",
      "tab Notes",
    ]);
  });

  it("proposes a tab in the User's Note with the first Block it holds, one change to decide", async () => {
    const { core, agent, mind } = await paired();
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    const propose = (text: string) =>
      agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [{ paragraph: "¶2+", text }],
        },
      });
    // An empty tab would wait where the User never sees it.
    expect(refusal(await propose(fence("Costs")))).toContain("¶2+");

    const proposed = structured<{ status: string; waiting: number; markdown: string }>(
      await propose(`${fence("Costs")}\n\nFuel cost more in the winter.`),
    );
    expect(proposed).toMatchObject({ status: "waiting", waiting: 1 });
    // A tab still waiting isn't the User's yet: the Note reads as it is.
    expect(proposed.markdown).not.toContain("Costs");
    expect(await shapeOf(core, mind.id)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
      "tab Costs",
      "paragraph",
    ]);

    const client = await connectToMind(core, mind.id);
    const [added] = client.blocks
      .toArray()
      .filter(
        (block): block is Y.XmlElement =>
          block instanceof Y.XmlElement && block.nodeName === NOTE_TAB_NODE,
      )
      .slice(2);
    const proposal = added?.getAttribute(PROPOSAL_ATTRIBUTE) as unknown as { id: string };
    client.doc.transact(() => {
      decideProposals(client.blocks, (each) => each.id === proposal.id, "accept");
    }, "user");
    await client.settled();
    // Accepting what the User sees of it accepts the tab too.
    expect(waitingChanges(client.blocks)).toBe(0);
    const now = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    expect(now.markdown.split("\n\n").slice(-2)).toEqual([
      fence("Costs"),
      "¶3 Fuel cost more in the winter.",
    ]);
  });

  it("proposes a tab holding only a picture as one change with the picture", async () => {
    const { core, agent, mind } = await paired();
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    const proposed = structured<{ waiting: number }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [
            {
              paragraph: "¶2+",
              text: `${fence("Plan")}\n\n![Deck plan](data:image/png;base64,${PNG})`,
            },
          ],
        },
      }),
    );
    expect(proposed.waiting).toBe(1);
    const client = await connectToMind(core, mind.id);
    const [tabBlock, picture] = client.blocks.toArray().slice(-2) as Y.XmlElement[];
    expect([tabBlock?.nodeName, picture?.nodeName]).toEqual([NOTE_TAB_NODE, PICTURE_NODE]);
    const proposalOf = (block: Y.XmlElement | undefined) =>
      (block?.getAttribute(PROPOSAL_ATTRIBUTE) as unknown as { id: string } | undefined)?.id;
    const shared = proposalOf(picture);
    expect(shared).toBeDefined();
    expect(proposalOf(tabBlock)).toBe(shared);
    client.doc.transact(() => {
      decideProposals(client.blocks, (each) => each.id === shared, "reject");
    }, "user");
    await client.settled();
    expect(await shapeOf(core, mind.id)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
    ]);
  });

  it("rejecting a proposed tab takes it out with what it held", async () => {
    const { core, agent, mind } = await paired();
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    // Its words may come in the change after it.
    const proposed = structured<{ waiting: number }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [
            { paragraph: "¶1+", text: fence("Routes") },
            { paragraph: "¶+", text: "The island route ran daily." },
          ],
        },
      }),
    );
    expect(proposed.waiting).toBe(1);
    const client = await connectToMind(core, mind.id);
    client.doc.transact(() => {
      decideProposals(client.blocks, () => true, "reject");
    }, "user");
    await client.settled();
    expect(await shapeOf(core, mind.id)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
    ]);
  });

  it("refuses a tab in a paragraph's rewrite: a tab is added after it", async () => {
    const { agent, mind } = await paired();
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    const refused = refusal(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [{ paragraph: "¶1", text: `${fence("Costs")}\n\nFuel cost more.` }],
        },
      }),
    );
    expect(refused).toContain("¶1+");
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
      fence("Summary"),
      "¶0 # Harbourline Ferries",
      "¶1 Sailings ran on time.",
      fence("Fleet"),
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
      fence("Fleet"),
      "¶2 Two ferries were refitted.",
      "![Refit](data:image/png;base64,…)",
    ]);
    expect(await shapeOf(core, made.mindId)).toEqual([
      "tab Summary",
      "heading",
      "paragraph",
      "tab Fleet",
      "paragraph",
      PICTURE_NODE,
    ]);

    // Read whole, the picture stands in Fleet's tab.
    const whole = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId } }),
    );
    expect(whole.markdown).toContain(
      `${fence("Fleet")}\n\nTwo ferries were refitted.\n\n![Refit](data:image/png;base64,…)`,
    );
  });

  it("names a tab without a title as the panel does, and keeps the title in a Note's first tab", async () => {
    const { core, agent, harbour } = await paired();
    const mind = await core.createMind({ title: "Harbour log", folderId: harbour.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [tab(""), note("Sailings ran on time."), tab(""), note("Refits.")]);
    await client.settled();
    const whole = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id } }),
    );
    expect(whole.markdown).toContain(
      [fence("Tab 1"), "# Harbour log", "Sailings ran on time.", fence("Tab 2"), "Refits."].join(
        "\n\n",
      ),
    );
  });

  it("numbers untitled tabs without a tab still waiting for the User", async () => {
    const { core, agent, harbour } = await paired();
    const mind = await core.createMind({ title: "Harbour log", folderId: harbour.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [tab(""), note("Sailings ran on time."), tab(""), note("Refits.")]);
    await client.settled();
    const before = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: before.version,
          changes: [{ paragraph: "¶1+", text: `${fence("Costs")}\n\nFuel cost more.` }],
        },
      }),
    );
    const waiting = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    expect(waiting.markdown).toBe(before.markdown);
    expect(waiting.markdown).toContain(fence("Tab 2"));
  });

  it("reads a title that looks like a fence as the title, as read_mind writes it", async () => {
    const { core, agent } = await paired();
    const made = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Snippets",
          markdown: ["````tab", "```js", "````", "", "Run it daily."].join("\n"),
        },
      }),
    );
    expect(await shapeOf(core, made.mindId)).toEqual(["tab ```js", "heading", "paragraph"]);
  });
});
