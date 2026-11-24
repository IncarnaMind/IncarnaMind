/**
 * What a model writes as Markdown through `propose_changes` lands as the block it means (#3747):
 * a heading, a list, a quote, a code block, a table or a rule, added at the top, in the middle or
 * at the end of a Note, or put in place of one of its paragraphs; from an outside agent, where it
 * waits, and from the box at a Note's foot, where it applies at once.
 */
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { OwnAiRunner } from "../../src/core/adapters";
import { type CitedToken, namedNote, proposeNamed } from "../../src/core/agents/proposals";
import { CITATION_NODE, FOOTNOTE_NODE, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { decideProposals, readProposalAttribute, waitingChanges } from "../../src/shared/proposals";
import { citingIn, harbours, optionsWith, SPRING, tides, userNote } from "../helpers/agentChanges";
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

  // protects=a paragraph with the User's Citation and footnote, rewritten as a heading and a list that keep them by handle, lands as those blocks with the same Citation and footnote; a handle the Markdown would turn into code is refused; fails_when=the rewrite is refused, or the Citation or footnote is lost or changed
  it("keeps the paragraph's Citation and footnote by handle in the blocks it becomes", async () => {
    const { agent, client, mindId } = await citedNote();
    const inCode = await proposeTo(agent, mindId, "¶1", "## Ferry `[kept:1]`");
    expect(inCode.isError).toBe(true);
    expect(inCode.content?.[0]?.text).toBe(translate("en", "agents.propose.lost", { name: "¶1" }));

    const result = await proposeTo(
      agent,
      mindId,
      "¶1",
      "## Spring tides [kept:1] [note:1]\n\n- The ferry waits for the tide",
    );
    expect(result.isError ?? false, result.content?.[0]?.text).toBe(false);
    await client.settled();
    expect(await decided(client, "accept")).toEqual(["heading:2", "bulletList", "p:2"]);
    const [title] = readMind(client).toJSON().content ?? [];
    expectKept(title);
  }, 60_000);

  // protects=a paragraph asked for as a title and a list, written as the title in its place and the list after it (¶1, then ¶+), or taken out with the title and the list added after it, the list keeping the paragraph's Citation and footnote by handle, lands as a heading and a list holding them, in order, as Haiku 5.5 wrote it; fails_when=the handles land as words and the Citation and footnote go, or the title lands after the list
  it("keeps the handles of a list written after the paragraph it rewrites or takes out", async () => {
    const list = "- The ferry waits for the tide [kept:1]\n- Seen in March [note:1]";
    for (const changes of [
      [
        { paragraph: "¶1", text: "## Spring tides" },
        { paragraph: "¶+", text: list },
      ],
      [
        { paragraph: "¶1", remove: true },
        { paragraph: "¶1+", text: "## Spring tides" },
        { paragraph: "¶+", text: list },
      ],
    ]) {
      const { agent, client, mindId } = await citedNote();
      const read = (await agent.callTool({
        name: "read_mind",
        arguments: { mindId, named: true },
      })) as { structuredContent?: { version?: string } };
      const result = (await agent.callTool({
        name: "propose_changes",
        arguments: { mindId, version: read.structuredContent?.version, changes },
      })) as { isError?: boolean; content?: { text?: string }[] };
      expect(result.isError ?? false, result.content?.[0]?.text).toBe(false);
      await client.settled();
      expect(await decided(client, "accept")).toEqual(["heading:2", "bulletList", "p:2"]);
      const [, kept] = readMind(client).toJSON().content ?? [];
      expectKept(kept, true);
      expect(JSON.stringify(readMind(client).toJSON())).not.toMatch(/kept:|note:/);
    }
  }, 60_000);

  // protects=a paragraph's title in its place and a list after it keeping its Citation and footnote, decided apart: while both wait, with the list accepted and the title declined, with the title accepted and the list declined, and with both accepted, each Citation and footnote goes by its id in one place only; fails_when=the paragraph and the list hold the same Citation or footnote id, so "Checked by me" on one shows on the other
  it("keeps the ids apart whichever of the title and the list the User accepts", async () => {
    const ids = (client: MindClient) => {
      const out: unknown[] = [];
      const visit = (node: JSONContent) => {
        if (node.type === CITATION_NODE || node.type === FOOTNOTE_NODE) out.push(node.attrs?.id);
        for (const child of node.content ?? []) visit(child);
      };
      visit(readMind(client).toJSON());
      return out;
    };
    for (const [title, list] of [
      [null, null],
      ["reject", "accept"],
      ["accept", "reject"],
      ["accept", "accept"],
    ] as const) {
      const { agent, client, mindId } = await citedNote();
      const read = (await agent.callTool({
        name: "read_mind",
        arguments: { mindId, named: true },
      })) as { structuredContent?: { version?: string } };
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: read.structuredContent?.version,
          changes: [
            { paragraph: "¶1", text: "## Spring tides" },
            {
              paragraph: "¶+",
              text: "- The ferry waits for the tide [kept:1]\n- Seen in March [note:1]",
            },
          ],
        },
      });
      await client.settled();
      const listRef = client.blocks
        .toArray()
        .flatMap((each) =>
          each instanceof Y.XmlElement && each.nodeName === "bulletList"
            ? [readProposalAttribute(each.getAttribute(PROPOSAL_ATTRIBUTE))?.id]
            : [],
        )[0];
      expect(listRef).toBeTruthy();
      client.doc.transact(() => {
        if (list) decideProposals(client.blocks, (ref) => ref.id === listRef, list);
        if (title) decideProposals(client.blocks, (ref) => ref.id !== listRef, title);
      }, "user");
      await client.settled();
      const all = ids(client);
      expect(new Set(all).size, `${title} ${list}: ${JSON.stringify(all)}`).toBe(all.length);
    }
  }, 60_000);
  // protects=in one call, each of two paragraphs rewritten as a title with a list added after it: each list keeps only the handles it names, of the paragraph it follows; the first keeps its Citation and not its footnote, the second its own Citation; fails_when=a handle keeps the other paragraph's Citation, or a handle left out still keeps its footnote
  it("keeps, after each of two rewritten paragraphs, only the handles named of the paragraph it follows", async () => {
    const { agent, client, mindId } = await citedNote([
      {
        type: "paragraph",
        attrs: { id: "walls" },
        content: [
          { type: "text", text: "Harbour walls are built for them " },
          { type: CITATION_NODE, attrs: harbours },
          { type: "text", text: "." },
        ],
      },
    ]);
    const read = (await agent.callTool({
      name: "read_mind",
      arguments: { mindId, named: true },
    })) as { structuredContent?: { version?: string } };
    const result = (await agent.callTool({
      name: "propose_changes",
      arguments: {
        mindId,
        version: read.structuredContent?.version,
        changes: [
          { paragraph: "¶1", text: "## Spring tides" },
          { paragraph: "¶+", text: "- The ferry waits for the tide [kept:1]" },
          { paragraph: "¶2", text: "## Harbour walls" },
          { paragraph: "¶+", text: "- Built for the spring tides [kept:1]" },
        ],
      },
    })) as { isError?: boolean; content?: { text?: string }[] };
    expect(result.isError ?? false, result.content?.[0]?.text).toBe(false);
    await client.settled();
    expect(await decided(client, "accept")).toEqual([
      "heading:2",
      "bulletList",
      "heading:2",
      "bulletList",
    ]);
    const [, first, , second] = readMind(client).toJSON().content ?? [];
    expect(citingOf(first)).toEqual({ cites: [tides.documentId], footnote: false });
    expect(citingOf(second)).toEqual({ cites: [harbours.documentId], footnote: false });
    expect(JSON.stringify(readMind(client).toJSON())).not.toMatch(/kept:|note:/);
  }, 60_000);
  // protects=a paragraph inside a list, rewritten with something added after it that keeps its Citation by handle, lands where the same call without the handle lands (a list item after it in its list, a paragraph after the list), with the Citation; a paragraph in a table cell likewise; fails_when=a piece moves out of its list, above it or elsewhere, or the handle lands as words
  it("adds what keeps a list item's or a table cell's handles where it adds it without them", async () => {
    const item = (content: JSONContent) => ({ type: "listItem", content: [content] });
    const list = (): JSONContent => ({
      type: "bulletList",
      content: [item(note("First item.")), item(citedParagraph()), item(note("Third item."))],
    });
    const table = (): JSONContent => ({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [note("Monday")] },
            { type: "tableCell", content: [citedParagraph()] },
          ],
        },
      ],
    });
    for (const [blocks, at, rewrite, added] of [
      [list, "¶2", "Spring tides", "- The ferry waits for the tide"],
      [list, "¶2", "Spring tides delay the ferry.", "The harbour master saw it."],
      [table, "¶2", "Spring tides", "The ferry waits for the tide."],
    ] as const) {
      const without = await landed(
        [blocks(), note(P2)],
        [
          { paragraph: at, text: rewrite },
          { paragraph: "¶+", text: added },
        ],
      );
      const kept = await landed(
        [blocks(), note(P2)],
        [
          { paragraph: at, text: rewrite },
          { paragraph: "¶+", text: `${added} [kept:1]` },
        ],
      );
      expect(
        wordsOf(kept).map((words) => words.trimEnd()),
        added,
      ).toEqual(wordsOf(without).map((words) => words.trimEnd()));
      expect(citingOf(kept), added).toEqual({ cites: [tides.documentId], footnote: false });
      expect(JSON.stringify(kept)).not.toMatch(/kept:|note:/);
    }
  }, 120_000);
});

describe("a token of a Citation the paragraph already holds (#3747)", () => {
  // protects=a token the agent may not cite with, of the Citation the paragraph holds, keeps that Citation in a rewrite written as words and in one written as a heading; fails_when=written as blocks the token reads as not found and the paragraph's Citation goes
  it("keeps the paragraph's own Citation, whether the rewrite is words or blocks", () => {
    const own = (token: string): CitedToken | null =>
      token === "tides1"
        ? {
            minted: { documentId: tides.documentId, quote: tides.quote, pageFrom: null },
            attributes: { ...tides },
            citable: false,
          }
        : null;
    for (const text of [
      "Spring tides come at new moon [cite:tides1].",
      "## Spring tides [cite:tides1]",
    ]) {
      const { doc, blocks } = userNote();
      const note = namedNote(blocks, { citation: () => null, waiting: "", busy: "" });
      let ids = 0;
      doc.transact(() =>
        proposeNamed(blocks, note, [{ kind: "rewrite", at: 0, text }], {
          ...optionsWith(() => `own-${++ids}`),
          cited: own,
        }),
      );
      doc.transact(() => decideProposals(blocks, () => true, "accept"));
      expect(citingIn(blocks)[`tides: ${SPRING}`], text).toBe(1);
    }
  });
});

/** The Citations in `node`, by Document, and whether a footnote is in it. */
function citingOf(node: JSONContent | undefined): { cites: unknown[]; footnote: boolean } {
  const cites: unknown[] = [];
  let footnote = false;
  const visit = (each: JSONContent) => {
    if (each.type === CITATION_NODE) cites.push(each.attrs?.documentId);
    if (each.type === FOOTNOTE_NODE) footnote = true;
    else for (const child of each.content ?? []) visit(child);
  };
  if (node) visit(node);
  return { cites, footnote };
}

/** A paragraph of the User's holding a Citation of Tides and a footnote that cites. */
const citedParagraph = (): JSONContent => ({
  type: "paragraph",
  attrs: { id: "cited" },
  content: [
    { type: "text", text: "Spring tides delay the ferry " },
    { type: CITATION_NODE, attrs: tides },
    {
      type: FOOTNOTE_NODE,
      attrs: { id: "n1" },
      content: [
        { type: "text", text: "Seen by the harbour master " },
        { type: CITATION_NODE, attrs: harbours },
      ],
    },
    { type: "text", text: "." },
  ],
});

/** A Note of `blocks`, and an outside agent that may propose changes to it. */
async function noteWith(blocks: JSONContent[]) {
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
  writeMind(client, blocks);
  await client.settled();
  return { agent, client, mindId: mind.id };
}

/** A Note whose first paragraph holds the User's Citation of Tides and a footnote that cites. */
const citedNote = (rest: JSONContent[] = [note(P2)]) => noteWith([citedParagraph(), ...rest]);

/** `blocks` as they read once an outside agent's `changes` to them are accepted. */
async function landed(
  blocks: JSONContent[],
  changes: { paragraph: string; text?: string; remove?: boolean }[],
): Promise<JSONContent> {
  const { agent, client, mindId } = await noteWith(blocks);
  const read = (await agent.callTool({
    name: "read_mind",
    arguments: { mindId, named: true },
  })) as { structuredContent?: { version?: string } };
  const result = (await agent.callTool({
    name: "propose_changes",
    arguments: { mindId, version: read.structuredContent?.version, changes },
  })) as { isError?: boolean; content?: { text?: string }[] };
  expect(result.isError ?? false, result.content?.[0]?.text).toBe(false);
  await client.settled();
  await decided(client, "accept");
  return readMind(client).toJSON();
}

/** Each Block's words, a list item or a table cell by its own, the way they stand. */
function wordsOf(json: JSONContent): string[] {
  const words = (node: JSONContent): string =>
    node.text ?? (node.content ?? []).map(words).join("");
  const out: string[] = [];
  const visit = (node: JSONContent, depth: number) => {
    if (node.type === "paragraph" || node.type === "heading")
      out.push(`${"  ".repeat(depth)}${words(node)}`);
    else
      for (const child of node.content ?? []) visit(child, depth + (node.type === "doc" ? 0 : 1));
  };
  visit(json, 0);
  return out;
}

/**
 * `block` holds the paragraph's Citation of Tides and its footnote, its own Citation in it: under
 * their ids where the paragraph's own replacement keeps them, under ids of their own (`copies`)
 * where what is added after the paragraph keeps them, since that is decided apart (#1933).
 */
function expectKept(block: JSONContent | undefined, copies = false): void {
  const all: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    all.push(node);
    if (node.type !== FOOTNOTE_NODE) for (const child of node.content ?? []) visit(child);
  };
  if (block) visit(block);
  const citation = all.find((each) => each.type === CITATION_NODE)?.attrs;
  expect(citation).toMatchObject({ documentId: tides.documentId, quote: tides.quote });
  const kept = all.find((each) => each.type === FOOTNOTE_NODE);
  const inner = kept?.content?.find((each) => each.type === CITATION_NODE)?.attrs;
  expect(inner).toMatchObject({ documentId: harbours.documentId, quote: harbours.quote });
  const ids = [citation?.id, kept?.attrs?.id, inner?.id];
  if (copies)
    for (const [at, id] of ids.entries()) expect(id).not.toBe([tides.id, "n1", harbours.id][at]);
  else expect(ids).toEqual([tides.id, "n1", harbours.id]);
}

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
