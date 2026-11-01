/**
 * An outside agent proposes changes to a Note (#352): through the shim the app ships, with the
 * MCP SDK's own client, it reads the Note with its paragraphs named and names the paragraph
 * each change is for. The changes wait in the Note as Proposals marked with the agent's name,
 * which the User accepts, rejects and takes back with Undo in the editor's copy of the Note.
 */
import { randomUUID } from "node:crypto";
import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import {
  CITATION_NODE,
  MIND_PROPOSAL_REQUESTS_FIELD,
  MIND_TEXT_ORIGINS_FIELD,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { ProposalReview, pendingIn } from "../../src/renderer/src/editor/proposalReview";
import { uncitedSentences } from "../../src/renderer/src/editor/uncitedSentences";
import {
  aiUseOfAccepted,
  decideProposals,
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  type ResolvedProposal,
} from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import {
  addAndProcess,
  createSourceFolder,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";
import { acceptedParagraphs, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon. Their range is the largest of the month.",
  "",
  "Neap tides come at the first and third quarters of the moon. Their range is the smallest of the month.",
].join("\n");

const SPRING = "Spring tides happen twice a month, at new moon and full moon.";
const ROCKS = "Moon rocks are grey basalt and dust.";
const MOON = ["# Moon", "", `${ROCKS} The far side is never seen from Earth.`].join("\n");
const NEAP = "Neap tides come at the first and third quarters of the moon.";

const words = (text: string): JSONContent[] => (text ? [{ type: "text", text }] : []);
const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { id: randomUUID(), level: 2 },
  content: words(text),
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: words(text),
});
const list = (...items: string[]): JSONContent => ({
  type: "bulletList",
  attrs: { id: randomUUID() },
  content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
});

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

/** A Tool call's typed result, once it is known not to be a refusal. */
function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

/** A refusal's words, as the agent reads them. */
function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

interface Named {
  markdown: string;
  version: string;
}

interface Proposed {
  waiting: number;
  citations: { cite: string; check: string; changed: boolean; document: string | null }[];
  uncited: string[];
}

const readNamed = async (agent: Agent, mindId: string) =>
  structured<Named>(
    await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
  );

/** The Note as it reads with its changes waiting: none of them in it. */
const asItReads = async (agent: Agent, mindId: string) =>
  structured<{ markdown: string }>(
    await agent.callTool({ name: "read_mind", arguments: { mindId } }),
  ).markdown;

/** A token for a quote of Tides, as the agent gets one from a search. */
async function tokenFor(agent: Agent, query: string, quote: string): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: [{ passageId: passages[0]?.passageId, quote }] },
    }),
  );
  const cite = citations[0]?.cite;
  if (!cite) throw new Error(`No Citation for “${quote}”.`);
  return cite;
}

/** Where a Citation is in a Block's text, as `shown` writes it. */
const CITED = "‹C›";

/** A Block's text, each Citation as `CITED` and each footnote as "‹F›", word joiners kept. */
function shown(block: ProseMirrorNode): string {
  let text = "";
  block.descendants((node) => {
    if (node.isText) text += node.text ?? "";
    else if (node.type.name === CITATION_NODE) text += CITED;
    else if (node.type.name === "footnote") {
      text += "‹F›";
      return false;
    }
    return true;
  });
  return text;
}

/** How many nodes of a kind the editor's copy of the Note holds. */
function nodesNamed(client: MindClient, name: string): number {
  let count = 0;
  readMind(client).descendants((node) => {
    if (node.type.name === name) count++;
  });
  return count;
}

/** The Citation nodes in the editor's copy of the Note, with their attributes. */
function citationsIn(client: MindClient): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs);
  });
  return found;
}

/** A core with agents on, Tides in "Coast", an agent that may propose changes there, and a Note. */
async function pairedWithNote(
  content: JSONContent[],
  { propose = true, language = "en" as "en" | "zh-CN" } = {},
) {
  const started = await startAgentsCore(replyingModel());
  const { core } = started;
  if (language !== "en") await core.updateSettings({ user: { language } });
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const { launch, pairing } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose,
  });
  const mind = await core.createMind({ title: "Field notes", folderId: coast.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, content);
  await client.settled();
  const agent = await connectLegacyAgent(launch);
  return { ...started, core, sources, tides, coast, finance, pairing, mind, client, agent };
}

/** The sentences the change bars in the editor count as uncited, each once, in the Note's order. */
function barUncited(client: MindClient): string[] {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), ProposalReview],
    content: readMind(client).toJSON(),
  });
  onTestFinished(() => editor.destroy());
  const state = EditorState.create({
    doc: editor.state.doc,
    plugins: editor.extensionManager.plugins,
  });
  const counted = new Map<number, string>();
  for (const proposal of pendingIn(state)) {
    for (const { from, to } of uncitedSentences(state.doc, proposal)) {
      counted.set(from, state.doc.textBetween(from, to));
    }
  }
  return [...counted.entries()].sort(([a], [b]) => a - b).map(([, words]) => words);
}

/**
 * Another agent, Codex, that may change the Note but can't read Tides: the Note moves to a Folder
 * of its own, which Codex is given with `folderIds`.
 */
async function agentWithoutTides(
  core: Core,
  mindId: string,
  folderIds: string[] = [],
): Promise<Agent> {
  const notes = await core.createLibraryGroup({ name: "Notes", description: "Mine." });
  await core.moveToFolder({ mindIds: [mindId], folderId: notes.id });
  const other = await core.connectAgent({
    name: "Codex",
    folderIds: [notes.id, ...folderIds],
    propose: true,
  });
  return connectLegacyAgent(other.launch);
}

/** Moon, in a Folder of its own (Sky), for an agent that can't read Tides to cite. */
async function addMoon(core: Core, sources: string) {
  const [moon] = await addAndProcess(core, [await writeSourceFile(sources, "Moon.md", MOON)]);
  if (!moon) throw new Error("Moon wasn't added.");
  const sky = await core.createLibraryGroup({ name: "Sky", description: "Up there." });
  await core.assignDocumentGroup(moon.id, sky.id);
  return { moon, sky };
}

/** Accepts or rejects in the editor's copy, as one step its Undo takes back, as the editor does. */
function decide(
  client: MindClient,
  undo: Y.UndoManager,
  picked: (id: string) => boolean,
  outcome: "accept" | "reject",
): ResolvedProposal[] {
  let resolved: ResolvedProposal[] = [];
  undo.stopCapturing();
  client.doc.transact(() => {
    resolved = decideProposals(client.blocks, (proposal) => picked(proposal.id), outcome);
  }, "user");
  return resolved;
}

/** The Proposal that takes out the top-level Block holding `text`. */
function removalIn(client: MindClient, text: string): string {
  for (const block of client.blocks.toArray()) {
    if (!(block instanceof Y.XmlElement) || !block.toString().includes(text)) continue;
    const proposal = block.getAttribute(PROPOSAL_ATTRIBUTE) as unknown;
    if (typeof proposal === "object" && proposal !== null && "id" in proposal) {
      return String(proposal.id);
    }
  }
  throw new Error(`Nothing proposes taking out “${text}”.`);
}

/** As the editor's Undo takes a decision back: its Blocks, its counts and the third-party marks. */
const undoOf = (client: MindClient) =>
  new Y.UndoManager(
    [
      client.blocks,
      client.doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD),
      client.doc.getMap(MIND_TEXT_ORIGINS_FIELD),
    ],
    { trackedOrigins: new Set(["user"]) },
  );

/** The Blocks marked as holding an outside agent's text. */
const agentText = (client: MindClient): string[] =>
  Object.entries(client.doc.getMap(MIND_TEXT_ORIGINS_FIELD).toJSON())
    .filter(([, source]) => source === "outside-agent")
    .map(([id]) => id);

const settle = async (core: Core, client: MindClient) => {
  await client.settled();
  await core.listAiUse();
};

describe("an outside agent's proposed changes (#352)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("read the Note with each paragraph named, Citations as tokens and a version", async () => {
    const { agent, mind } = await pairedWithNote([
      heading("Tides"),
      paragraph("Tides rise twice a day."),
      paragraph(""),
      list("Spring tides are big.", "Neap tides are small."),
      paragraph("A ¶ sign the User typed."),
    ]);
    const named = await readNamed(agent, mind.id);
    expect(named.markdown).toBe(
      [
        "¶1 ## Tides",
        "¶2 Tides rise twice a day.",
        "¶3 - Spring tides are big.",
        "¶4 - Neap tides are small.",
        "¶5 A \\¶ sign the User typed.",
      ].join("\n\n"),
    );
    expect(named.version).toMatch(/^[\w-]{16}$/);
    // The same Note reads the same, and so names its paragraphs the same.
    expect((await readNamed(agent, mind.id)).version).toBe(named.version);
  });

  it("propose a rewrite, new paragraphs and a removal: they wait, marked with the agent's name, and accept, reject and Undo work", async () => {
    const { core, agent, mind, client, pairing } = await pairedWithNote([
      heading("Tides"),
      paragraph("Tides rise twice a day."),
      list("Spring tides are big.", "Neap tides are small."),
      paragraph("The moon is made of cheese."),
    ]);
    const spring = await tokenFor(agent, "spring tides new moon", SPRING);
    const { version } = await readNamed(agent, mind.id);
    const proposed = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [
            { paragraph: "¶2", text: `Spring tides come twice a month ${spring}.` },
            { paragraph: "¶4+", text: "- King tides are the biggest of the year." },
            { paragraph: "¶5", remove: true },
          ],
        },
      }),
    );
    expect(proposed.citations).toEqual([
      expect.objectContaining({ cite: spring, check: "found", document: "Tides", changed: false }),
    ]);
    expect(proposed.uncited).toEqual(["King tides are the biggest of the year."]);
    await client.settled();

    // Waiting, not written: the Note reads as it was, and every change is the agent's.
    const waiting = pendingProposals(client.blocks);
    expect(proposed.waiting).toBe(waiting.length);
    expect(waiting.length).toBeGreaterThanOrEqual(3);
    const requests = new Set(waiting.map((each) => each.request));
    expect(requests.size).toBe(1);
    const [request] = [...requests];
    expect(proposalRequestOf(client.doc, request ?? "")).toMatchObject({
      source: "outside-agent",
      agent: "Claude Code",
      pairingId: pairing.id,
    });
    const before = await asItReads(agent, mind.id);
    expect(before).toContain("Tides rise twice a day.");
    expect(before).toContain("The moon is made of cheese.");
    expect(before).not.toContain("King tides");
    // Waiting, its text marks nothing as third-party: only what the User accepts is in the Note.
    expect(agentText(client)).toEqual([]);
    // The new list item goes into the list, right after the item it names.
    const text = readMind(client).textContent;
    expect(text.indexOf("King tides")).toBeGreaterThan(text.indexOf("Neap tides are small."));
    expect(text.indexOf("King tides")).toBeLessThan(text.indexOf("The moon is made of cheese."));

    const undo = undoOf(client);
    const removalId = removalIn(client, "The moon is made of cheese.");
    // Accept everything but the removal, then reject the removal.
    const accepted = decide(client, undo, (id) => id !== removalId, "accept");
    expect(accepted.length).toBe(waiting.length - 1);
    const rejected = decide(client, undo, (id) => id === removalId, "reject");
    expect(rejected).toHaveLength(1);
    await core.recordAiUse(
      aiUseOfAccepted(client.doc, mind.id, accepted, "2026-11-01T09:00:00.000Z"),
    );
    await settle(core, client);
    // Accepted, the Blocks holding its words are third-party text, as an imported file's are.
    const marked = agentText(client);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked).toEqual(expect.arrayContaining(accepted.flatMap((each) => each.blockIds)));

    const after = await asItReads(agent, mind.id);
    expect(after).toContain("Spring tides come twice a month");
    expect(after).toContain("King tides are the biggest of the year.");
    expect(after).toContain("The moon is made of cheese.");
    expect(after).not.toContain("Tides rise twice a day.");
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(citationsIn(client)).toEqual([
      expect.objectContaining({ documentName: "Tides", quote: SPRING, check: "found" }),
    ]);
    // The record of AI use names the agent, and no model: IncarnaMind can't know which it used.
    const used = await core.listAiUse(mind.id);
    expect(used.length).toBeGreaterThan(0);
    for (const entry of used) {
      expect(entry).toMatchObject({
        kind: "outside-agent-change-accepted",
        agent: "Claude Code",
        providerId: null,
        modelId: null,
      });
    }

    // Undo takes back the reject, then the accept: the changes wait again.
    undo.undo();
    await client.settled();
    expect(pendingProposals(client.blocks).map((each) => each.id)).toEqual([removalId]);
    undo.undo();
    await client.settled();
    expect(pendingProposals(client.blocks)).toHaveLength(waiting.length);
    expect(await asItReads(agent, mind.id)).toBe(before);
    expect(agentText(client)).toEqual([]);
  });

  it("check every Citation again as they propose it, and keep what isn't a token theirs as words", async () => {
    const { core, agent, mind, client, sources, tides } = await pairedWithNote([
      paragraph("Tides rise twice a day."),
      paragraph("Neap tides are small."),
    ]);
    const spring = await tokenFor(agent, "spring tides new moon", SPRING);
    const neap = await tokenFor(agent, "neap tides quarters", NEAP);
    // Tides is edited after the agent got its tokens: the neap sentence goes, the spring one stays.
    await writeSourceFile(
      sources,
      "Tides.md",
      TIDES.replace(NEAP, "Neap tides are the quiet weeks."),
    );
    await core.reconcileDocuments();
    const edited = await waitForDocuments(core, (documents) => {
      const changed = documents.find((each) => each.id === tides.id);
      expect(changed?.status).toBe("ready");
      expect(changed?.contentHash).not.toBe(tides.contentHash);
    });
    const { version } = await readNamed(agent, mind.id);
    const proposed = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [
            {
              paragraph: "¶1",
              text: `Spring tides come twice a month ${spring}, as the harbour says [^1] and [=1] and \\[^2] and [cite:zzzzzzzz].`,
            },
            { paragraph: "¶2", text: `Neap tides come at the quarter moons ${neap}.` },
          ],
        },
      }),
    );
    expect(proposed.citations).toEqual([
      expect.objectContaining({ cite: spring, check: "found", changed: true }),
      expect.objectContaining({ cite: "[cite:zzzzzzzz]", check: "unknown", document: null }),
      expect.objectContaining({ cite: neap, check: "not-found", changed: true }),
    ]);
    expect(proposed.uncited).toEqual([]);
    await client.settled();
    const undo = undoOf(client);
    decide(client, undo, () => true, "accept");
    await client.settled();

    // The spring quote is found in Tides as it is now; the neap one is kept as found in the version
    // it was cited from, which the Note shows as needing a check again.
    const cited = citationsIn(client);
    expect(cited).toEqual([
      expect.objectContaining({
        quote: SPRING,
        check: "found",
        contentHash: edited.find((each) => each.id === tides.id)?.contentHash,
      }),
      expect.objectContaining({ quote: NEAP, check: "found", contentHash: tides.contentHash }),
    ]);
    // Nothing else became a Citation: the agent's own markers, escaped or not, and a token it made
    // up are words, the made-up one saying its quote wasn't found.
    // A word joiner after each "[" that could start a marker keeps it words, unseen.
    const first = readMind(client).firstChild?.textContent ?? "";
    expect(first.match(/\[\u2060/g)).toHaveLength(4);
    expect(first.replaceAll("\u2060", "")).toBe(
      "Spring tides come twice a month , as the harbour says [^1] and [=1] and [^2] and [quote not found].",
    );
  });

  it("cite only with tokens minted for them: another agent's token is no token here", async () => {
    const { core, agent, mind, client, coast } = await pairedWithNote([
      paragraph("Tides rise twice a day."),
    ]);
    const other = await core.connectAgent({ name: "Codex", folderIds: [coast.id], propose: true });
    const theirs = await tokenFor(
      await connectLegacyAgent(other.launch),
      "neap tides quarters",
      NEAP,
    );
    const mine = await tokenFor(agent, "spring tides new moon", SPRING);
    const { version } = await readNamed(agent, mind.id);
    const proposed = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [{ paragraph: "¶1", text: `Spring tides ${mine}. Neap tides ${theirs}.` }],
        },
      }),
    );
    expect(proposed.citations).toEqual([
      expect.objectContaining({ cite: mine, check: "found" }),
      expect.objectContaining({ cite: theirs, check: "unknown" }),
    ]);
    // The other agent's check of its own token still finds it.
    const checked = structured<{ citations: { check: string }[] }>(
      await (await connectLegacyAgent(other.launch)).callTool({
        name: "check_citations",
        arguments: { text: `Neap tides ${theirs}.` },
      }),
    );
    expect(checked.citations).toEqual([expect.objectContaining({ check: "found" })]);
    await client.settled();
    decide(client, undoOf(client), () => true, "accept");
    expect(citationsIn(client)).toEqual([expect.objectContaining({ quote: SPRING })]);
  });

  it("are refused, with nothing written, what their pairing doesn't allow, and allowed once it does", async () => {
    const { core, agent, mind, client, pairing, finance } = await pairedWithNote(
      [paragraph("Tides rise twice a day."), paragraph("Neap tides are small.")],
      { propose: false },
    );
    const elsewhere = await core.createMind({ title: "Costs", folderId: finance.id });
    const propose = async (mindId: string, version: string, changes: object[]) =>
      agent.callTool({ name: "propose_changes", arguments: { mindId, version, changes } });
    const rewrite = [{ paragraph: "¶1", text: "Tides rise and fall twice a day." }];
    const { version } = await readNamed(agent, mind.id);

    expect(refusal(await propose(mind.id, version, rewrite))).toBe(
      "This agent may only read. To let it propose changes to your notes, allow it in Settings → Agents.",
    );
    expect(pendingProposals(client.blocks)).toEqual([]);
    await core.updateAgent(pairing.id, { propose: true });
    expect(structured<Proposed>(await propose(mind.id, version, rewrite)).waiting).toBe(1);

    // A Note outside its Folders is no Note it can name, read or change.
    expect(refusal(await propose(elsewhere.id, version, rewrite))).toBe(
      "No such passage, Document, note or Citation in the Folders shared with this agent.",
    );
    expect(
      refusal(
        await agent.callTool({
          name: "read_mind",
          arguments: { mindId: elsewhere.id, named: true },
        }),
      ),
    ).toMatch(/No such passage/);

    // A paragraph already waiting can't take a second change; another one can.
    await client.settled();
    const again = await readNamed(agent, mind.id);
    expect(again.markdown).toBe(
      "¶1 (changes waiting) Tides rise twice a day.\n\n¶2 Neap tides are small.",
    );
    expect(refusal(await propose(mind.id, again.version, rewrite))).toBe(
      "¶1 already has changes waiting in IncarnaMind. Accept or reject them there first.",
    );
    expect(pendingProposals(client.blocks)).toHaveLength(1);

    // Names the Note hasn't, or names written wrong, change nothing.
    for (const [changes, said] of [
      [[{ paragraph: "¶9", text: "x" }], "¶9 isn’t in the note: its paragraphs are ¶1 to ¶2."],
      [[{ paragraph: "¶2a", text: "x" }], /“¶2a” isn’t a paragraph’s name/],
      [
        [{ paragraph: "¶+", text: "x" }],
        "¶+ adds after the change before it: name a paragraph first.",
      ],
      [
        [
          { paragraph: "¶2", text: "x" },
          { paragraph: "¶2", remove: true },
        ],
        "¶2 is named twice: change each paragraph once.",
      ],
    ] as const) {
      const said_ = refusal(await propose(mind.id, again.version, [...changes]));
      if (typeof said === "string") expect(said_).toBe(said);
      else expect(said_).toMatch(said);
    }
    expect(pendingProposals(client.blocks)).toHaveLength(1);

    // The Note changed since it was read: its names may not hold. Read again, and they do.
    const typed = client.blocks.get(1);
    if (!(typed instanceof Y.XmlElement)) throw new Error("No second paragraph.");
    (typed.get(0) as Y.XmlText).insert(0, "Very ");
    await client.settled();
    const late = [{ paragraph: "¶2", text: "Neap tides are the smallest." }];
    expect(refusal(await propose(mind.id, again.version, late))).toBe(
      "This note changed after the agent read it. Read it again, then propose the changes again.",
    );
    const fresh = await readNamed(agent, mind.id);
    expect(fresh.markdown).toContain("¶2 Very Neap tides are small.");
    // Two changes in it: "Very" goes, and "small" becomes "the smallest".
    expect(structured<Proposed>(await propose(mind.id, fresh.version, late)).waiting).toBe(2);

    const activity = await core.listAgentActivity(pairing.id);
    expect(
      activity.filter((each) => each.tool === "propose_changes").map((each) => each.problem),
    ).toEqual([
      null,
      "changed",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "waiting",
      "not-found",
      null,
      "read-only",
    ]);
    expect(activity.find((each) => each.tool === "propose_changes")).toMatchObject({
      outcome: "done",
      summary: "Field notes",
      count: 2,
      effects: [
        { action: "read", scope: { kind: "documents" } },
        { action: "write", scope: { kind: "mind", mindId: mind.id } },
      ],
    });
  });

  it("work in Chinese: names, words and refusals in the interface language", async () => {
    const { core, agent, mind, client, pairing } = await pairedWithNote(
      [heading("潮汐"), paragraph("潮水每天涨落两次。")],
      { language: "zh-CN" },
    );
    const spring = await tokenFor(agent, "spring tides new moon", SPRING);
    const { markdown, version } = await readNamed(agent, mind.id);
    expect(markdown).toBe("¶1 ## 潮汐\n\n¶2 潮水每天涨落两次。");
    const proposed = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [
            { paragraph: "¶2", text: `大潮每月出现两次，在新月和满月时${spring}。` },
            { paragraph: "¶2+", text: "港口管理处每年都会公布全年的潮汐时间表。" },
          ],
        },
      }),
    );
    expect(proposed.uncited).toEqual(["港口管理处每年都会公布全年的潮汐时间表。"]);
    await client.settled();
    const again = await readNamed(agent, mind.id);
    expect(again.markdown).toBe("¶1 ## 潮汐\n\n¶2 （修订待处理） 潮水每天涨落两次。");
    expect(
      refusal(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: again.version,
            changes: [{ paragraph: "¶2", remove: true }],
          },
        }),
      ),
    ).toBe("¶2 已有修订待处理。先在 IncarnaMind 中接受或拒绝。");
    // What it got wrong, it reads in Chinese too.
    for (const [paragraph, said] of [
      [
        "¶2a",
        "“¶2a”不是段落名称。用 ¶3 指 read_mind 列出的段落，用 ¶3+ 在其后添加，用 ¶+ 在上一处修改之后添加。",
      ],
      ["¶9", "笔记中没有 ¶9：段落为 ¶1 到 ¶2。"],
    ] as const) {
      expect(
        refusal(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId: mind.id,
              version: again.version,
              changes: [{ paragraph, text: "潮水" }],
            },
          }),
        ),
      ).toBe(said);
    }
    await core.updateAgent(pairing.id, { propose: false });
    expect(
      refusal(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: again.version,
            changes: [{ paragraph: "¶1", remove: true }],
          },
        }),
      ),
    ).toBe("这个智能体只能读取。要让它对笔记提出修改，在“设置 → 智能体”中允许。");

    const accepted = decide(client, undoOf(client), () => true, "accept");
    await core.recordAiUse(
      aiUseOfAccepted(client.doc, mind.id, accepted, "2026-11-01T09:00:00.000Z"),
    );
    await client.settled();
    expect(await asItReads(agent, mind.id)).toContain("港口管理处每年都会公布全年的潮汐时间表。");
    expect((await core.listAiUse(mind.id)).map((each) => each.agent)).toContain("Claude Code");
  });

  it("go out of date when the User changes the words they change, and only those", async () => {
    const { agent, mind, client } = await pairedWithNote([
      paragraph("Tides rise twice a day."),
      paragraph("Neap tides are small."),
    ]);
    const { version } = await readNamed(agent, mind.id);
    structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [
            { paragraph: "¶1", text: "Tides rise two times a day." },
            { paragraph: "¶2", text: "Neap tides are the smallest." },
          ],
        },
      }),
    );
    await client.settled();
    const [first, second] = pendingProposals(client.blocks);
    expect(outOfDateProposals(client.blocks)).toEqual(new Set());
    // The User edits "twice", the word the first change replaces.
    const typed = client.blocks.get(0);
    if (!(typed instanceof Y.XmlElement)) throw new Error("No first paragraph.");
    (typed.get(0) as Y.XmlText).delete("Tides rise tw".length, 1);
    await client.settled();
    const stale = outOfDateProposals(client.blocks);
    expect(stale.has(first?.id ?? "")).toBe(true);
    expect(stale.has(second?.id ?? "")).toBe(false);
  });

  // What parsing could join to a number: emphasis, escapes and their mixes, around a bracket.
  const BRACKETS = [
    "[**1**]",
    "[*1*]",
    "[_1_]",
    "[__1__]",
    "[~~1~~]",
    "[1]",
    "\\[1]",
    "[_^1_]",
    "[**^1**]",
    "[^1]",
    "\\[^1]",
    "[\\^1]",
    "[=1]",
    "[=**1**]",
  ];

  for (const language of ["en", "zh-CN"] as const) {
    const madeUp =
      language === "en"
        ? (bracket: string) => `The moon is made of green cheese ${bracket}.`
        : (bracket: string) => `月亮是绿色奶酪做的${bracket}。`;

    it(`attach no Citation or footnote they didn't get, whatever parsing makes of a bracket: in a rewrite (${language})`, async () => {
      const { core, agent, mind, client, tides } = await pairedWithNote([], { language });
      const [passage] = structured<{ passages: { passageId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "spring tides new moon" } }),
      ).passages;
      if (!passage) throw new Error("Tides wasn't found.");
      // The User's own Note, each line with a real Citation of Tides and a footnote of theirs.
      writeMind(
        client,
        BRACKETS.map((_, index) => ({
          type: "paragraph",
          attrs: { id: randomUUID() },
          content: [
            { type: "text", text: `Line ${index + 1}: spring tides come at new moon ` },
            {
              type: "citation",
              attrs: {
                passageId: passage.passageId,
                documentId: tides.id,
                documentName: "Tides",
                contentHash: tides.contentHash,
                quote: SPRING,
                check: "found",
              },
            },
            {
              type: "footnote",
              attrs: { id: randomUUID() },
              content: [{ type: "text", text: "The User's own note." }],
            },
          ],
        })),
      );
      await client.settled();
      const codex = await agentWithoutTides(core, mind.id);
      const { markdown, version } = await readNamed(codex, mind.id);
      expect(markdown).not.toContain("[cite:");
      structured<Proposed>(
        await codex.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version,
            changes: BRACKETS.map((bracket, index) => ({
              paragraph: `¶${index + 1}`,
              text: madeUp(bracket),
            })),
          },
        }),
      );
      await client.settled();
      decide(client, undoOf(client), () => true, "accept");
      await client.settled();

      // Every line is the agent's sentence alone: the User's Citation and footnote went with
      // their words, and none came back on the made-up claim.
      expect(citationsIn(client)).toEqual([]);
      expect(nodesNamed(client, "footnote")).toBe(0);
      const lines = [...readMind(client).children].map((each) => each.textContent);
      expect(lines.map((line) => line.includes("[\u2060"))).toEqual(BRACKETS.map(() => true));
    });

    it(`attach no Citation they didn't get, whatever parsing makes of a bracket: in new paragraphs (${language})`, async () => {
      const { agent, mind, client } = await pairedWithNote([paragraph("Tides rise twice a day.")], {
        language,
      });
      const spring = await tokenFor(agent, "spring tides new moon", SPRING);
      const { version } = await readNamed(agent, mind.id);
      const real = language === "en" ? "Spring tides come twice a month" : "大潮每月出现两次";
      // A place a token held while parsing, written by the agent itself, is only words too.
      const forged = "\uE0000\uE001";
      structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version,
            changes: [
              {
                paragraph: "¶1+",
                text: [`${real} ${spring}.`, ...BRACKETS.map(madeUp), madeUp(forged)].join(" "),
              },
            ],
          },
        }),
      );
      await client.settled();
      decide(client, undoOf(client), () => true, "accept");
      await client.settled();

      // One Citation, on the claim the token was given for, and nothing on the made-up ones.
      const added = shown(readMind(client).child(1));
      expect(added.split(CITED)).toHaveLength(2);
      expect(added.startsWith(`${real} ${CITED}.`)).toBe(true);
      expect(nodesNamed(client, "footnote")).toBe(0);
      // Every "[" the agent wrote stays words, a word joiner after it.
      expect(added.match(/\[(?!\u2060)/g)).toBeNull();
      expect(added.match(/\[\u2060/g)).toHaveLength(BRACKETS.length);
    });
  }

  it("cite with a token only while its Document is in their Folders", async () => {
    const { core, agent, mind, client, pairing, coast } = await pairedWithNote([
      paragraph("Tides rise twice a day."),
    ]);
    const notes = await core.createLibraryGroup({ name: "Notes", description: "Mine." });
    await core.moveToFolder({ mindIds: [mind.id], folderId: notes.id });
    await core.updateAgent(pairing.id, { folderIds: [coast.id, notes.id] });
    const spring = await tokenFor(agent, "spring tides new moon", SPRING);
    const propose = async (text: string) =>
      structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: (await readNamed(agent, mind.id)).version,
            changes: [{ paragraph: "¶1+", text }],
          },
        }),
      );

    expect((await propose(`Spring tides come twice a month ${spring}.`)).citations).toEqual([
      expect.objectContaining({ cite: spring, check: "found" }),
    ]);
    await client.settled();
    expect(citationsIn(client)).toHaveLength(1);

    // Tides' Folder is no longer shared: the same token cites nothing.
    await core.updateAgent(pairing.id, { folderIds: [notes.id] });
    expect((await propose(`Spring tides again ${spring}.`)).citations).toEqual([
      expect.objectContaining({ cite: spring, check: "unknown", document: null }),
    ]);
    await client.settled();
    expect(citationsIn(client)).toHaveLength(1);
  });

  it("are tracked under the agent's name in a Word export, and IncarnaMind's own changes under its own", async () => {
    const { core, agent, mind, client } = await pairedWithNote([
      paragraph("Tides rise twice a day."),
    ]);
    const { version } = await readNamed(agent, mind.id);
    structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [{ paragraph: "¶1", text: "Tides rise two times a day." }],
        },
      }),
    );
    await client.settled();
    const exported = await core.exportMind(mind.id, { format: "docx" });
    const document = unzip(exported.data).get("word/document.xml")?.toString("utf8") ?? "";
    expect(document).toMatch(/<w:del [^>]*w:author="Claude Code"[^>]*>.*twice/);
    expect(document).toMatch(/<w:ins [^>]*w:author="Claude Code"[^>]*>.*two times/);
    expect(document).not.toContain('w:author="IncarnaMind"');
  });

  it("leave the app as the words read: a bracket they wrote goes to Markdown and Word as the User's would", async () => {
    const { core, agent, mind, client } = await pairedWithNote([
      paragraph("See [1] and [sic] here."),
    ]);
    const { version } = await readNamed(agent, mind.id);
    structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [{ paragraph: "¶1+", text: "See [1] and [sic] here." }],
        },
      }),
    );
    await client.settled();
    decide(client, undoOf(client), () => true, "accept");
    await client.settled();
    // The agent reads its own line back with the word joiners in, and adds it again as it read.
    const again = await readNamed(agent, mind.id);
    const read = again.markdown.split("\n\n")[1]?.replace(/^¶2 /, "") ?? "";
    structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: again.version,
          changes: [{ paragraph: "¶2+", text: read }],
        },
      }),
    );
    await client.settled();
    decide(client, undoOf(client), () => true, "accept");
    await client.settled();
    // In the Note, one word joiner keeps each of the agent's "[" from reading as a marker.
    expect([...readMind(client).children].map((each) => each.textContent)).toEqual([
      "See [1] and [sic] here.",
      "See [\u20601] and [\u2060sic] here.",
      "See [\u20601] and [\u2060sic] here.",
    ]);

    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    const lines = markdown.split("\n").filter((line) => line.startsWith("See "));
    expect(lines).toHaveLength(3);
    expect(new Set(lines).size).toBe(1);
    const word = unzip((await core.exportMind(mind.id, { format: "docx" })).data)
      .get("word/document.xml")
      ?.toString("utf8");
    expect(acceptedParagraphs(word ?? "")).toEqual([
      "See [1] and [sic] here.",
      "See [1] and [sic] here.",
      "See [1] and [sic] here.",
    ]);
    expect(markdown + (word ?? "")).not.toContain("\u2060");
  });

  /** A paragraph of the User's holding a found Citation of Tides at `passageId`. */
  const citedLine = (
    words: string,
    tides: { id: string; contentHash: string },
    passageId: string,
  ): JSONContent => ({
    type: "paragraph",
    attrs: { id: randomUUID() },
    content: [
      { type: "text", text: words },
      {
        type: "citation",
        attrs: {
          passageId,
          documentId: tides.id,
          documentName: "Tides",
          contentHash: tides.contentHash,
          quote: SPRING,
          check: "found",
        },
      },
    ],
  });

  const firstPassage = async (agent: Agent) => {
    const [passage] = structured<{ passages: { passageId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "spring tides new moon" } }),
    ).passages;
    if (!passage) throw new Error("Tides wasn't found.");
    return passage.passageId;
  };

  it("cite anew with a token as often as they like, but keep a Citation they may only keep once", async () => {
    for (const ownWorkings of [false, true]) {
      const { core, agent, mind, client, tides } = await pairedWithNote([]);
      writeMind(client, [
        citedLine("Spring tides come at new moon ", tides, await firstPassage(agent)),
      ]);
      await client.settled();
      if (ownWorkings) await core.setNotCited(tides.id, true);
      const named = await readNamed(agent, mind.id);
      const token = /\[cite:[a-z0-9]+\]/.exec(named.markdown)?.[0] ?? "";
      expect(token).not.toBe("");
      structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: named.version,
            changes: [
              {
                paragraph: "¶1",
                text: `Spring tides come at new moon ${token}. The moon is cheese ${token}. Mars is red ${token}.`,
              },
            ],
          },
        }),
      );
      await client.settled();
      decide(client, undoOf(client), () => true, "accept");
      // Citable, each claim cites it; the User's own workings, only the Citation they had stays.
      expect(citationsIn(client)).toHaveLength(ownWorkings ? 1 : 3);
    }
  });

  it("keep a Citation they have no token for, and a footnote, by its handle, once; a handle the User typed stays words", async () => {
    const { core, agent, mind, client, tides } = await pairedWithNote([]);
    const passageId = await firstPassage(agent);
    writeMind(client, [
      {
        ...citedLine("Spring tides come at new moon ", tides, passageId),
        content: [
          ...(citedLine("Spring tides come at new moon ", tides, passageId).content ?? []),
          { type: "text", text: " as [note:1] says " },
          {
            type: "footnote",
            attrs: { id: randomUUID() },
            content: [{ type: "text", text: "The User's own note." }],
          },
        ],
      },
    ]);
    await client.settled();
    // An agent that can't read Tides gets handles, not tokens.
    const codex = await agentWithoutTides(core, mind.id);
    const named = await readNamed(codex, mind.id);
    expect(named.markdown).toBe(
      "¶1 Spring tides come at new moon [kept:1] as \\[note:1] says [note:1]",
    );
    structured<Proposed>(
      await codex.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: named.version,
          changes: [
            {
              paragraph: "¶1",
              text: "Spring tides come twice a month [kept:1] as \\[note:1] says [note:1]. Twice [kept:1] [note:1].",
            },
          ],
        },
      }),
    );
    await client.settled();
    decide(client, undoOf(client), () => true, "accept");
    expect(citationsIn(client)).toHaveLength(1);
    expect(nodesNamed(client, "footnote")).toBe(1);
    const line = shown(readMind(client).child(0)).replaceAll("\u2060", "");
    expect(line).toBe(
      `Spring tides come twice a month ${CITED} as [note:1] says ‹F›. Twice [kept:1] [note:1].`,
    );
  });

  it("change no word they echo as it was, a bracket or a typed <removed> among them", async () => {
    const { agent, mind, client } = await pairedWithNote([
      paragraph("See [sic] here, and the <removed> tag I typed."),
    ]);
    const named = await readNamed(agent, mind.id);
    expect(named.markdown).toBe("¶1 See [sic] here, and the \\<removed> tag I typed.");
    structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: named.version,
          changes: [
            { paragraph: "¶1", text: "See [sic] here, and the \\<removed> tag I typed, again." },
          ],
        },
      }),
    );
    await client.settled();
    // One change, the words it adds: "[sic]" and the tag the User typed are left as they were.
    expect(pendingProposals(client.blocks)).toHaveLength(1);
    decide(client, undoOf(client), () => true, "accept");
    expect(readMind(client).textContent).toBe(
      "See [sic] here, and the <removed> tag I typed, again.",
    );
  });

  it("cite no source a table's cell names in brackets: the User's Citation doesn't come back on their words", async () => {
    const { core, agent, mind, client, tides, sources } = await pairedWithNote([]);
    writeMind(client, [
      citedLine("Spring tides come at new moon ", tides, await firstPassage(agent)),
    ]);
    await client.settled();
    // Codex can't read Tides, but reads Moon, and cites it with a token of its own.
    const { moon, sky } = await addMoon(core, sources);
    const codex = await agentWithoutTides(core, mind.id, [sky.id]);
    const grey = await tokenFor(codex, "moon rocks grey", ROCKS);
    const named = await readNamed(codex, mind.id);
    expect(named.markdown).toBe("¶1 Spring tides come at new moon [kept:1]");
    structured<Proposed>(
      await codex.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: named.version,
          changes: [
            {
              paragraph: "¶1",
              text: [
                "| Claim | Source |",
                "| --- | --- |",
                "| The moon is cheese | [Tides] |",
                "| Tides rise at noon | [Tides.md] |",
                `| Moon rocks are grey | ${grey} |`,
              ].join("\n"),
            },
          ],
        },
      }),
    );
    await client.settled();
    decide(client, undoOf(client), () => true, "accept");
    await client.settled();

    // The table is made: the cells that name Tides do so in words only, and the token cites Moon.
    expect(nodesNamed(client, "table")).toBe(1);
    const table = readMind(client).textContent;
    expect(table).toContain("The moon is cheese[\u2060Tides]");
    expect(table).toContain("Tides rise at noon[\u2060Tides.md]");
    expect(citationsIn(client)).toEqual([
      expect.objectContaining({ documentId: moon.id, quote: ROCKS }),
    ]);
  });

  it("report the sentences they leave with no Citation as the change bars count them", async () => {
    const { core, agent, mind, client, tides, sources } = await pairedWithNote([]);
    writeMind(client, [
      citedLine("Spring tides come at new moon ", tides, await firstPassage(agent)),
      paragraph("Moon rocks are grey."),
    ]);
    await client.settled();
    const { sky } = await addMoon(core, sources);
    const codex = await agentWithoutTides(core, mind.id, [sky.id]);
    const grey = await tokenFor(codex, "moon rocks grey", ROCKS);
    const named = await readNamed(codex, mind.id);
    const proposed = structured<Proposed>(
      await codex.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: named.version,
          changes: [
            {
              paragraph: "¶1",
              text: "Spring tides come at new moon [kept:1]. The moon is made of green cheese.",
            },
            {
              paragraph: "¶1+",
              text: [
                "## Neap tides come at the quarter moons",
                "| Tide | When |\n| --- | --- |\n| King tides flood the harbour wall | In winter |",
                "Harbour walls flood in winter storms.",
              ].join("\n\n"),
            },
            // Two changes in one sentence: a word, and the Citation that cites it.
            { paragraph: "¶2", text: `Moon rocks are mostly grey ${grey}.` },
          ],
        },
      }),
    );
    // A Citation kept by its handle, or added by another of its changes, cites; a heading or a
    // cell makes no claim.
    expect(pendingProposals(client.blocks).length).toBeGreaterThanOrEqual(6);
    expect(proposed.uncited).toEqual([
      "The moon is made of green cheese.",
      "Harbour walls flood in winter storms.",
    ]);
    await client.settled();
    expect(barUncited(client)).toEqual(proposed.uncited);
  });

  it("are refused, with nothing written, when a token sits where it would be read as a formula, or a table makes no table", async () => {
    const { agent, mind, client } = await pairedWithNote([
      paragraph("Costs rose."),
      paragraph("Neap tides are small."),
    ]);
    const spring = await tokenFor(agent, "spring tides new moon", SPRING);
    const propose = async (changes: object[]) =>
      agent.callTool({
        name: "propose_changes",
        arguments: { mindId: mind.id, version: (await readNamed(agent, mind.id)).version, changes },
      });
    const fine = { paragraph: "¶2", text: "Neap tides are the smallest." };
    expect(
      refusal(await propose([fine, { paragraph: "¶1", text: `Costs were $5 ${spring} and $6.` }])),
    ).toBe(
      "In ¶1, a Citation sits between two dollar signs, which read as a formula: write it outside them.",
    );
    expect(
      refusal(
        await propose([fine, { paragraph: "¶1", text: "Costs rose.\n| a | b |\nnot a row" }]),
      ),
    ).toBe("The text for ¶1 has lines that read as a table’s rows but make no table.");
    expect(pendingProposals(client.blocks)).toEqual([]);
    // Outside the dollar signs, the same token cites.
    structured<Proposed>(
      await propose([fine, { paragraph: "¶1", text: `Costs were $5 and $6 ${spring}.` }]),
    );
    await client.settled();
    decide(client, undoOf(client), () => true, "accept");
    expect(citationsIn(client)).toHaveLength(1);
  });

  it("can't propose until the User allows it: a pairing made without the grant only reads", async () => {
    const { core, mind, coast } = await pairedWithNote([paragraph("Tides rise twice a day.")]);
    const { launch, pairing } = await core.connectAgent({ name: "Codex", folderIds: [coast.id] });
    expect(pairing.propose).toBe(false);
    const codex = await connectLegacyAgent(launch);
    const { version } = await readNamed(codex, mind.id);
    const changes = [{ paragraph: "¶1", text: "Tides rise two times a day." }];
    expect(
      refusal(
        await codex.callTool({
          name: "propose_changes",
          arguments: { mindId: mind.id, version, changes },
        }),
      ),
    ).toMatch(/may only read/);
    expect((await core.updateAgent(pairing.id, { propose: true })).propose).toBe(true);
    expect(
      structured<Proposed>(
        await codex.callTool({
          name: "propose_changes",
          arguments: { mindId: mind.id, version, changes },
        }),
      ).waiting,
    ).toBeGreaterThan(0);
  });
});
