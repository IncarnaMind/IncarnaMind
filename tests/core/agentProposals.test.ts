/**
 * An outside agent proposes changes to a Note (#352): through the shim the app ships, with the
 * MCP SDK's own client, it reads the Note with its paragraphs named and names the paragraph
 * each change is for. The changes wait in the Note as Proposals marked with the agent's name,
 * which the User accepts, rejects and takes back with Undo in the editor's copy of the Note.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import {
  CITATION_NODE,
  MIND_PROPOSAL_REQUESTS_FIELD,
  MIND_TEXT_ORIGINS_FIELD,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core/api";
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

const undoOf = (client: MindClient) =>
  new Y.UndoManager([client.blocks, client.doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD)], {
    trackedOrigins: new Set(["user"]),
  });

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
    // Its text is third-party text, as an imported file's or a web page's is.
    expect(Object.values(client.doc.getMap(MIND_TEXT_ORIGINS_FIELD).toJSON())).toContain(
      "outside-agent",
    );
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
    expect(first.match(/\[\u2060/g)).toHaveLength(3);
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
      [[{ paragraph: "¶9", text: "x" }], "¶9 isn't in the Note: its paragraphs are ¶1 to ¶2."],
      [[{ paragraph: "¶2a", text: "x" }], /"¶2a" isn't a paragraph's name/],
      [[{ paragraph: "¶+", text: "x" }], "¶+ adds after the change before it: name one first."],
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
});
