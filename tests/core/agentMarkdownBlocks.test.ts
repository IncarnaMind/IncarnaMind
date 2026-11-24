/**
 * What a model writes as Markdown through `propose_changes` lands as the block it means (#3747):
 * a heading, a list, a quote, a code block, a table or a rule, added at the top, in the middle or
 * at the end of a Note, or put in place of one of its paragraphs; from an outside agent, where it
 * waits, and from the box at a Note's foot, where it applies at once.
 */
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { OwnAiRunner } from "../../src/core/adapters";
import { translate } from "../../src/shared/i18n";
import { decideProposals, waitingChanges } from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const P1 = "The early ferry runs late most weekdays.";
const P2 = "Commuters miss the 08:15 train when it does.";
const P3 = "The harbour plan adds a second ramp in 2027.";

/** Each block a model writes in everyday requests, as Markdown, and the node it means. */
const KINDS: [string, string, string][] = [
  ["a heading", "# Ferry delays", "heading:1"],
  ["a second-level heading", "## Ferry delays", "heading:2"],
  ["a third-level heading", "### Ferry delays", "heading:3"],
  ["a bullet list", "- Late on Mondays\n- Full café", "bulletList"],
  ["a numbered list", "1. Late on Mondays\n2. Full café", "orderedList"],
  ["a quote", "> The ramp is the bottleneck.", "blockquote"],
  ["a code block", "```\nferry --late\n```", "codeBlock"],
  ["a table", "| Day | Late |\n| --- | --- |\n| Monday | 12 |", "table"],
  ["a rule", "---", "horizontalRule"],
];

/** Where a change goes, and the Note's top-level blocks after it, `X` the block meant. */
const PLACES: [string, string, string[]][] = [
  ["at the top", "¶0+", ["X", "p:1", "p:2", "p:3"]],
  ["in the middle", "¶1+", ["p:1", "X", "p:2", "p:3"]],
  ["at the end", "¶3+", ["p:1", "p:2", "p:3", "X"]],
  ["in place of a paragraph", "¶2", ["p:1", "X", "p:3"]],
];

const WORDS: Record<string, string> = { "p:1": P1, "p:2": P2, "p:3": P3 };

/** The Note's top-level blocks: a paragraph by its words, anything else by its type (and level). */
const shape = (json: JSONContent): string[] =>
  (json.content ?? []).map((node) => {
    if (node.type === "heading") return `heading:${node.attrs?.level}`;
    if (node.type !== "paragraph") return node.type ?? "";
    const text = (node.content ?? []).map((each) => each.text ?? "").join("");
    return Object.entries(WORDS).find(([, words]) => words === text)?.[0] ?? `p(${text})`;
  });

const expected = (node: string, after: string[]) =>
  after.map((each) => (each === "X" ? node : each));

async function proposeTo(
  agent: { callTool(p: { name: string; arguments: Record<string, unknown> }): Promise<unknown> },
  mindId: string,
  paragraph: string,
  text: string,
) {
  const read = (await agent.callTool({
    name: "read_mind",
    arguments: { mindId, named: true },
  })) as {
    structuredContent?: { version?: string };
  };
  return (await agent.callTool({
    name: "propose_changes",
    arguments: { mindId, version: read.structuredContent?.version, changes: [{ paragraph, text }] },
  })) as {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: { status?: string };
  };
}

const decided = async (client: MindClient, outcome: "accept" | "reject") => {
  client.doc.transact(() => decideProposals(client.blocks, () => true, outcome), "user");
  await client.settled();
  return shape(readMind(client).toJSON());
};

describe("Markdown blocks through propose_changes (#3747)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=each block a model writes, at the top, in the middle, at the end or in a paragraph's place, waits as that block and lands as it once accepted, and rejecting it leaves the Note as it was; fails_when=a heading or list lands as a paragraph with its Markdown marks, or "¶0+" can't add at the top of a Note with paragraphs
  it("from an outside agent, waits as the block it means and lands as it", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: ["all"],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    for (const [kind, markdown, node] of KINDS) {
      for (const [place, name, after] of PLACES) {
        const mind = await core.createMind({ title: "Ferry notes" });
        const client = await connectToMind(core, mind.id);
        writeMind(client, [note(P1), note(P2), note(P3)]);
        await client.settled();
        const result = await proposeTo(agent, mind.id, name, markdown);
        expect(result.isError ?? false, `${kind} ${place}: ${result.content?.[0]?.text}`).toBe(
          false,
        );
        expect(result.structuredContent?.status).toBe("waiting");
        await client.settled();
        expect(waitingChanges(client.blocks)).toBeGreaterThan(0);
        expect(await decided(client, "accept"), `${kind} ${place}`).toEqual(expected(node, after));
      }
    }
    // Rejected, a paragraph put in a block's place is back as it was.
    const mind = await core.createMind({ title: "Ferry notes" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note(P1), note(P2), note(P3)]);
    await client.settled();
    await proposeTo(agent, mind.id, "¶2", "## Why it is late\n\n- The vans load first");
    await client.settled();
    expect(await decided(client, "reject")).toEqual(["p:1", "p:2", "p:3"]);
  }, 300_000);

  // protects=a title over a paragraph, written in that paragraph's place, lands as a heading and the paragraph, its Citation kept; in a Note with a title, "¶0+" adds under it; fails_when=the title lands as "# …" words
  it("puts a heading and the paragraph in its place, and adds under a title", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: ["all"],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const plain = await core.createMind({ title: "Ferry notes" });
    const client = await connectToMind(core, plain.id);
    writeMind(client, [note(P1), note(P2)]);
    await client.settled();
    await proposeTo(agent, plain.id, "¶1", `# Ferry delays\n\n${P1}`);
    await client.settled();
    expect(await decided(client, "accept")).toEqual(["heading:1", "p:1", "p:2"]);

    const titled = await core.createMind({ title: "Ferry notes" });
    const under = await connectToMind(core, titled.id);
    writeMind(under, [heading(1, "Ferry notes"), note(P1)]);
    await under.settled();
    await proposeTo(agent, titled.id, "¶0+", "## This week");
    await under.settled();
    expect(await decided(under, "accept")).toEqual(["heading:1", "heading:2", "p:1"]);
  }, 120_000);

  // protects=two additions after one paragraph, in two calls, land in the order they were asked, as two items added to one list do; fails_when=the second lands before the first
  it("lands two additions after one paragraph, in two calls, in their order", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: ["all"],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const mind = await core.createMind({ title: "Ferry notes" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      note(P1),
      { type: "bulletList", content: [{ type: "listItem", content: [note(P2)] }] },
      note(P3),
    ]);
    await client.settled();
    await proposeTo(agent, mind.id, "¶1+", "## First");
    await proposeTo(agent, mind.id, "¶1+", "## Second");
    await proposeTo(agent, mind.id, "¶2+", "- Late on Mondays");
    await proposeTo(agent, mind.id, "¶2+", "- Full café");
    await client.settled();
    const json = readMind(client).toJSON();
    client.doc.transact(() => decideProposals(client.blocks, () => true, "accept"), "user");
    await client.settled();
    const after = readMind(client).toJSON();
    const text = (node: JSONContent): string =>
      node.text ?? (node.content ?? []).map(text).join(" ");
    expect((after.content ?? []).map(text)).toEqual([
      P1,
      "First",
      "Second",
      `${P2} Late on Mondays Full café`,
      P3,
    ]);
    expect(json.content?.length).toBeGreaterThan(3);
  }, 60_000);

  // protects=a paragraph holding a footnote or a Citation by handle, written as a heading, is refused with what to do instead; fails_when=it lands with its marks as words, or loses what it held
  it("refuses a heading in place of a paragraph holding a footnote by handle, and says what to do", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: ["all"],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const mind = await core.createMind({ title: "Ferry notes" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note(P1), note(P2)]);
    await client.settled();
    const kept = await proposeTo(agent, mind.id, "¶1", "## Ferry [note:1]");
    expect(kept.isError).toBe(true);
    expect(kept.content?.[0]?.text).toBe(
      translate("en", "agents.propose.blockKeeps", { name: "¶1" }),
    );
  }, 60_000);
});

describe("Markdown blocks from the box at a Note's foot (#3747)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a heading at the top, and a list in a paragraph's place, asked from the box, apply at once as those blocks; fails_when=they land as words with their marks
  it("applies at once as the block it means", async () => {
    const cases: [string, string, string[]][] = [
      ["¶0+", "# Ferry delays", ["heading:1", "p:1", "p:2", "p:3"]],
      ["¶2", "- Late on Mondays\n- Full café", ["p:1", "bulletList", "p:3"]],
      ["¶3+", "> The ramp is the bottleneck.", ["p:1", "p:2", "p:3", "blockquote"]],
    ];
    for (const [name, markdown, after] of cases) {
      let asked = "";
      const ownAi: OwnAiRunner = {
        installed: async () => true,
        status: async () => ({ kind: "ready" }),
        purge: async () => true,
        async run(request) {
          request.started?.();
          const agent = await connectLegacyAgent(request.server);
          const mindId = request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";
          const result = await proposeTo(agent, mindId, name, markdown);
          asked = result.structuredContent?.status ?? result.content?.[0]?.text ?? "";
          return { kind: "finished", reply: "Done." };
        },
      };
      const { core } = await startAgentsCore(replyingModel(), { ownAi }, { modelSetUp: false });
      await core.setAgentsEnabled(true);
      await core.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: ["all"],
        propose: true,
      });
      const mind = await core.createMind({ title: "Ferry notes" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [note(P1), note(P2), note(P3)]);
      await client.settled();
      const ended = new Promise<{ turnId: string; applied: { request: string }[] }>((resolve) =>
        core.on("agents.noteTurn", (turn) => {
          if (turn.state !== "working") resolve(turn);
        }),
      );
      await core.askInNote({ mindId: mind.id, words: "change the note" });
      const end = await ended;
      expect(asked, `${name} ${markdown}`).toBe("applied");
      await core.applyAskedChanges({
        answerId: end.turnId,
        mindId: mind.id,
        requests: end.applied.map((each) => each.request),
      });
      await client.settled();
      expect(shape(readMind(client).toJSON()), `${name} ${markdown}`).toEqual(after);
    }
  }, 180_000);
});
