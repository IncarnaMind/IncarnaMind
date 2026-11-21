/**
 * Ask your AI (#3373, #3419): one line for the User to send in their own AI, in their own words,
 * naming IncarnaMind and the Note by its title; the agent's app opens with it typed where its app
 * documents a link for that, and it is copied for the User to paste elsewhere. The rest (the
 * Note's id, the sentences and what the check found, what to change and leave alone) waits in
 * IncarnaMind for that agent alone, which reads it once with `read_request` while it may read the
 * Note.
 */
import { describe, expect, it } from "vitest";
import type { AgentAsk, AgentClientId } from "../../src/core/api";
import { activityWords } from "../../src/renderer/src/components/agents/agentWords";
import { translate } from "../../src/shared/i18n";
import { agentsAdapter, connectLegacyAgent, resultText } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";

const OVERSTATED = "Fuel cost doubled over the year.";
const OTHER = "The board approved a new booking system for 2026.";
const TITLE = "Ferry report for the board";

/** A core with agents on, a Folder of ferry notes and a Note in it; each link it opens is kept. */
async function started({ openLink = true } = {}) {
  const dataDir = await createTempDataFolder();
  const links: string[] = [];
  const core = startCore(dataDir, {
    agents: {
      ...(await agentsAdapter(dataDir)),
      ...(openLink && {
        openLink: async (url: string) => {
          links.push(url);
        },
      }),
    },
  });
  const ferries = await core.createLibraryGroup({ name: "Tallow Sound Ferries", description: "" });
  const mind = await core.createMind({ title: TITLE, folderId: ferries.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(`Tallow Sound Ferries ran 2,816 crossings. ${OVERSTATED}`), note(OTHER)]);
  await core.setAgentsEnabled(true);
  const connect = async (
    name: string,
    client: AgentClientId | undefined,
    folderIds = [ferries.id],
  ) => {
    const made = await core.connectAgent({ name, folderIds, ...(client && { client }) });
    return { ...made.pairing, launch: made.launch };
  };
  return { core, links, mind, ferries, connect };
}

const fix: AgentAsk = {
  kind: "fix",
  sentences: [{ sentence: OVERSTATED, verdict: "overstated", checkId: "check-1" }],
};

const promptOf = (link: string | undefined, parameter: string) =>
  new URL(link ?? "about:blank").searchParams.get(parameter);

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

const readRequest = (agent: Agent, note?: string) =>
  agent.callTool({ name: "read_request", arguments: note === undefined ? {} : { note } });

/** What `read_request` gave, or the refusal in its words. */
async function requestRead(agent: Agent, note?: string) {
  const result = (await readRequest(agent, note)) as {
    isError?: boolean;
    structuredContent?: { mindId: string | null; title: string; request: string };
  };
  return result.isError
    ? { refused: resultText(result) }
    : (result.structuredContent ?? { refused: "nothing" });
}

/** What `read_request` answers when nothing waits: a result, not a refusal. */
const NONE = { mindId: null, title: "", request: translate("en", "agents.request.none") };

const LONG_FIX = (mindId: string) =>
  `In IncarnaMind, the check of my note “${TITLE}” (mindId: ${mindId}) says this sentence is overstated:\n\n“${OVERSTATED}”\n\nFix that sentence from my Documents, and change nothing else in the note. Then check the note again yourself.`;

describe("asking the User's own AI", () => {
  // protects=the line Claude Code opens with is the User's own words, naming IncarnaMind and the Note, with no id, sentence or instruction, and the rest reaches that agent over its connection once; fails_when=the line carries the id or the sentence, or the request is lost, changed or read twice
  it("opens Claude Code with one line, and keeps the rest for it to read once", async () => {
    const { core, links, mind, connect } = await started();
    const pairing = await connect("Claude Code", "claude-code");
    expect(await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix })).toEqual({
      kind: "opened",
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.startsWith("claude-cli://open?q=")).toBe(true);
    const line = promptOf(links[0], "q");
    expect(line).toBe(`Fix the sentence IncarnaMind flagged in “${TITLE}”.`);
    expect(line).not.toContain(mind.id);
    expect(line).not.toContain(OVERSTATED);

    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent, TITLE)).toEqual({
      mindId: mind.id,
      title: TITLE,
      request: LONG_FIX(mind.id),
    });
    const again = await requestRead(agent, TITLE);
    expect(again).toEqual(NONE);
    expect(JSON.stringify(again)).not.toContain(OVERSTATED);
  });

  // protects=the line and the request read in the interface language; fails_when=Chinese gets English words or a verdict out of the dictionary
  it("asks in Chinese when the interface is", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const pairing = await connect("VS Code", "vscode");
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "fix", sentences: [{ sentence: OVERSTATED, verdict: "not-found" }] },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `把 IncarnaMind 在笔记“${TITLE}”里标出来的那句改好。`,
    });
    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent)).toMatchObject({
      request: `在 IncarnaMind 中，我的笔记“${TITLE}”（mindId：${mind.id}）经核对，这句话在我的文档中找不到：\n\n“${OVERSTATED}”\n\n请根据我的文档改正这句话，笔记的其他内容不要改动。改完后请你自己再核对一遍这篇笔记。`,
    });
  });

  // protects=one request names every sentence that needs a look, each with what its check found, and its line says how many; fails_when=a sentence or its verdict is left out, or the line lists them
  it("asks for every flagged sentence in one request", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: {
        kind: "fix",
        sentences: [
          { sentence: OVERSTATED, verdict: "overstated" },
          { sentence: OTHER, verdict: "contradicted" },
        ],
      },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `Fix the 2 sentences IncarnaMind flagged in “${TITLE}”.`,
    });
    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent)).toMatchObject({
      request: `In IncarnaMind, the check of my note “${TITLE}” (mindId: ${mind.id}) says these 2 sentences need a look:\n\n1. This sentence is overstated: “${OVERSTATED}”\n2. This sentence is contradicted by my Documents: “${OTHER}”\n\nFix each of them from my Documents, and change nothing else in the note. Then check the note again yourself.`,
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: {
        kind: "fix",
        sentences: [
          { sentence: OVERSTATED, verdict: "units-may-differ" },
          { sentence: OTHER, verdict: "unsupported" },
        ],
      },
    });
    expect(await requestRead(agent)).toMatchObject({
      request: expect.stringContaining(
        `有 2 句需要留意：\n\n1. 这句话的单位可能与我的文档不同：“${OVERSTATED}”\n2. 这句话没有依据：“${OTHER}”`,
      ),
    });
  });

  // protects=a sentence its check found a quote against takes that quote to the User's AI, to rewrite it to and no more (#3383); fails_when=the quote is left out, or a sentence with none gets the line
  it("takes the quote a check found with the sentence it is about", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const QUOTE = "Sailings ran on time on most days.";
    await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: {
        kind: "fix",
        sentences: [
          { sentence: OVERSTATED, verdict: "overstated", quote: QUOTE },
          { sentence: OTHER, verdict: "not-found" },
        ],
      },
    });
    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent)).toMatchObject({
      request: expect.stringContaining(
        `1. This sentence is overstated: “${OVERSTATED}”\n\nMy Documents say: “${QUOTE}”\nRewrite it to say what that quote says and no more: add no figure, name or claim it doesn’t give.\n2. This sentence isn’t found in my Documents: “${OTHER}”\n\n`,
      ),
    });
  });

  // protects=each agent with a documented prefill link gets the line in it, every other one is copied; fails_when=an agent opens a link its documentation doesn't give, or one with a link is copied
  it.each([
    ["claude-desktop", "claude://claude.ai/new", "q"],
    ["claude-code", "claude-cli://open", "q"],
    ["codex", "codex://new", "prompt"],
    ["cursor", "cursor://anysphere.cursor-deeplink/prompt", "text"],
  ] as const)("opens %s at its own link", async (client, start, parameter) => {
    const { core, links, mind, connect } = await started();
    const pairing = await connect("My agent", client);
    await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    expect(links[0]?.startsWith(`${start}?${parameter}=`)).toBe(true);
    expect(promptOf(links[0], parameter)).toBe(
      `Fix the sentence IncarnaMind flagged in “${TITLE}”.`,
    );
  });

  it.each(["vscode", "gemini-cli", "opencode", "other", undefined] as const)(
    "copies the line for %s, and keeps the same request",
    async (client) => {
      const { core, links, mind, connect } = await started();
      const pairing = await connect("My agent", client);
      const asked = await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
      expect(asked).toEqual({
        kind: "copy",
        text: `Fix the sentence IncarnaMind flagged in “${TITLE}”.`,
      });
      expect(links).toEqual([]);
      const agent = await connectLegacyAgent(pairing.launch);
      expect(await requestRead(agent)).toMatchObject({ request: LONG_FIX(mind.id) });
    },
  );

  // protects=a question too long for an agent's link is copied whole, never cut; fails_when=a link over the documented limit is opened
  it("copies a question too long for the agent's link", async () => {
    const { core, links, mind, connect } = await started();
    const pairing = await connect("Claude Code", "claude-code");
    const long = `${"The ferry ran late. ".repeat(260)}`.trim();
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "question", text: long },
    });
    expect(asked.kind).toBe("copy");
    expect(asked.kind === "copy" && asked.text.endsWith(long)).toBe(true);
    expect(links).toEqual([]);
  });

  // protects=a link no app on this computer takes still reaches the User, copied; fails_when=the failure is thrown at the User or nothing is given
  it("copies the line when no app takes the link", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      agents: {
        ...(await agentsAdapter(dataDir)),
        openLink: async () => {
          throw new Error("No application knows how to open claude-cli links.");
        },
      },
    });
    const folder = await core.createLibraryGroup({ name: "Ferries", description: "" });
    const mind = await core.createMind({ title: "Ferry report", folderId: folder.id });
    await core.setAgentsEnabled(true);
    const { pairing } = await core.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
    });
    const asked = await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    expect(asked).toEqual({
      kind: "copy",
      text: "Fix the sentence IncarnaMind flagged in “Ferry report”.",
    });
  });

  // protects=the User's own words stay in the line and the Note's id goes to the request; fails_when=the typed words are lost, or the id shows in the line
  it("keeps the words typed in the line, and the Note's id in the request", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const agent = await connectLegacyAgent(pairing.launch);
    const question = "What did fuel cost in 2025?";
    const pointer = `My message is about my note “${TITLE}” in IncarnaMind (mindId: ${mind.id}).`;
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: mind.id,
        ask: { kind: "question", text: question },
      }),
    ).toEqual({ kind: "copy", text: `About my note “${TITLE}” in IncarnaMind:\n\n${question}` });
    expect(await requestRead(agent)).toMatchObject({ request: pointer });
    expect(
      await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: { kind: "note" } }),
    ).toEqual({ kind: "copy", text: `About my note “${TITLE}” in IncarnaMind:` });
    expect(await requestRead(agent)).toMatchObject({ request: pointer });
    // A question about no Note says all there is in its line, and leaves nothing to read.
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: question },
      }),
    ).toEqual({ kind: "copy", text: `From my Documents in IncarnaMind:\n\n${question}` });
    expect(await requestRead(agent)).toEqual(NONE);
  });

  // protects=two requests made before either is sent are both delivered, each once, by the Note the line names or else the newest; fails_when=one is lost, read twice, or a Note read already gets another's
  it("delivers two requests made before either is sent, each once", async () => {
    const { core, mind, ferries, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const crossings = await core.createMind({ title: "Crossings", folderId: ferries.id });
    await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    await core.askAgent({
      pairingId: pairing.id,
      mindId: crossings.id,
      ask: { kind: "fix", sentences: [{ sentence: OTHER, verdict: "unsupported" }] },
    });
    // Renamed since: the agent names it as the line did.
    await core.renameMind(mind.id, "Ferry report, final");
    const agent = await connectLegacyAgent(pairing.launch);
    const none = NONE;
    expect(await requestRead(agent, `“${TITLE}”`)).toMatchObject({
      mindId: mind.id,
      title: "Ferry report, final",
    });
    expect(await requestRead(agent, TITLE)).toEqual(none);
    expect(await requestRead(agent, "the crossings note")).toMatchObject({
      mindId: crossings.id,
    });
    expect(await requestRead(agent)).toEqual(none);
  });

  // protects=a request reaches only the agent it was made for, and only while that agent may read the Note; fails_when=another agent reads it, or one whose Folders no longer hold the Note gets its words
  it("refuses the request to another agent, and to one that can't read the Note now", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const asked = await connect("VS Code", "vscode");
    const other = await connect("Codex", "codex");
    await core.askAgent({ pairingId: asked.id, mindId: mind.id, ask: fix });

    const otherAgent = await connectLegacyAgent(other.launch);
    expect(await requestRead(otherAgent)).toEqual(NONE);

    await core.updateAgent(asked.id, { folderIds: [elsewhere.id] });
    const agent = await connectLegacyAgent(asked.launch);
    const refused = await requestRead(agent);
    expect(refused).toEqual({ refused: translate("en", "agents.problem.requestOutOfReach") });
    expect(JSON.stringify(refused)).not.toContain(OVERSTATED);
    expect(JSON.stringify(refused)).not.toContain(mind.id);

    const [waiting] = await core.listAgentRequests(mind.id);
    expect(waiting?.readAt).toBeNull();
    await core.updateAgent(asked.id, { folderIds: [mind.folderId ?? ""] });
    expect(await requestRead(agent)).toMatchObject({ request: LONG_FIX(mind.id) });
  });

  // protects=a request about a Note deleted since says so, and goes, so it doesn't stand in front of the next one; fails_when=the agent is sent to share a Folder that can't help, or the same refusal comes back on every call
  it("says the Note was deleted, and lets that request go", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const asked = await connect("VS Code", "vscode");
    await core.askAgent({ pairingId: asked.id, mindId: mind.id, ask: fix });
    await core.deleteMind(mind.id);

    const agent = await connectLegacyAgent(asked.launch);
    const refused = await requestRead(agent);
    expect(refused).toEqual({ refused: translate("en", "agents.problem.requestNoteDeleted") });
    expect(JSON.stringify(refused)).not.toContain(OVERSTATED);
    expect(await requestRead(agent)).toEqual(NONE);
  });

  // protects=the User can read afterwards what the agent was given, in its activity, and the card knows the request was read; fails_when=the request isn't shown with the call, or its state isn't kept
  it("shows the request read in the agent's activity", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    expect(await core.listAgentRequests(mind.id)).toEqual([
      expect.objectContaining({
        pairingId: pairing.id,
        sentences: [{ sentence: OVERSTATED, checkId: "check-1" }],
        readAt: null,
      }),
    ]);
    const agent = await connectLegacyAgent(pairing.launch);
    await requestRead(agent);
    const [call] = await core.listAgentActivity(pairing.id);
    expect(call).toMatchObject({
      tool: "read_request",
      outcome: "done",
      request: LONG_FIX(mind.id),
    });
    expect(activityWords(call ?? never(), (key, params) => translate("en", key, params))).toBe(
      `Read your request about “${TITLE}”`,
    );
    expect((await core.listAgentRequests(mind.id))[0]?.readAt).not.toBeNull();
    await core.disconnectAgent(pairing.id);
    expect(await core.listAgentRequests(mind.id)).toEqual([]);
  });

  // protects=only an agent that can read the Note now is offered, the one connected or used last first; fails_when=an agent that can't read it, or any while agents are off or in local mode, is offered
  it("offers the agents that read the Note, the latest first, and none while they are off", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const first = await connect("VS Code", "vscode");
    const later = await connect("Claude Code", "claude-code");
    const codex = await connect("Codex", "codex", [elsewhere.id]);
    expect((await core.listAgentsToAsk(mind.id)).map((each) => each.name)).toEqual([
      later.name,
      first.name,
    ]);
    expect((await core.listAgentsToAsk(null)).map((each) => each.name)).toHaveLength(3);
    await expect(core.askAgent({ pairingId: codex.id, mindId: mind.id, ask: fix })).rejects.toThrow(
      "That agent can’t read this note now.",
    );
    expect(await core.listAgentRequests(mind.id)).toEqual([]);
    await core.setLocalOnly(true);
    expect(await core.listAgentsToAsk(mind.id)).toEqual([]);
    await core.setLocalOnly(false);
    await core.setAgentsEnabled(false);
    expect(await core.listAgentsToAsk(mind.id)).toEqual([]);
  });
});

/** A Document the agent reads in the ferries' Folder, another it reads in a second, and one it doesn't. */
async function withDocuments() {
  const base = await started({ openLink: false });
  const { core, ferries } = base;
  const fares = await core.createLibraryGroup({ name: "Fares", description: "" });
  const secret = await core.createLibraryGroup({ name: "Private", description: "" });
  const sources = await createSourceFolder();
  const [summary, tariffs, diary] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Annual summary 2025.md",
      "# Summary\n\nIn 2025 the company ran 2,816 crossings.",
    ),
    await writeSourceFile(sources, "Tariffs.md", "# Tariffs\n\nA return fare costs 14 pounds."),
    await writeSourceFile(sources, "Diary.md", "# Diary\n\nThe captain's private notes."),
  ]);
  if (!summary || !tariffs || !diary) throw new Error("The Documents weren't added.");
  await core.assignDocumentGroup(summary.id, ferries.id);
  await core.assignDocumentGroup(tariffs.id, fares.id);
  await core.assignDocumentGroup(diary.id, secret.id);
  const pairing = await base.connect("Claude Code", "claude-code", [ferries.id, fares.id]);
  const agent = await connectLegacyAgent(pairing.launch);
  return { ...base, fares, secret, summary, tariffs, diary, pairing, agent };
}

const SUMMARISE = "Summarise this document";

describe("asking the User's own AI about what they are looking at (#3533)", () => {
  // protects=a question asked with a Document open names that Document in the line, as a Note is named, and its id waits for the agent; fails_when=the line is the one for no Note, or nothing is kept for the agent
  it("names the Document that is open in the line, and keeps its id for the agent", async () => {
    const { core, summary, pairing, agent } = await withDocuments();
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: SUMMARISE },
        onScreen: [summary.id],
      }),
    ).toEqual({
      kind: "copy",
      text: `About my document “Annual summary 2025” in IncarnaMind:\n\n${SUMMARISE}`,
    });
    expect(await requestRead(agent, "Annual summary 2025")).toEqual({
      mindId: null,
      title: "Annual summary 2025",
      request: `My message is about the document I have open in IncarnaMind: “Annual summary 2025” (documentId: ${summary.id}).`,
    });
    expect(await requestRead(agent, "Annual summary 2025")).toEqual(NONE);
    const calls = await core.listAgentActivity(pairing.id);
    expect(calls.map((each) => [each.tool, each.outcome])).toEqual([
      ["read_request", "done"],
      ["read_request", "done"],
    ]);
  });

  // protects=the line and the request read in the interface language; fails_when=Chinese gets English words
  it("asks about the open Document in Chinese when the interface is", async () => {
    const { core, summary, pairing, agent } = await withDocuments();
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: "总结一下这个文档" },
        onScreen: [summary.id],
      }),
    ).toEqual({
      kind: "copy",
      text: "关于我在 IncarnaMind 中的文档“Annual summary 2025”：\n\n总结一下这个文档",
    });
    expect(await requestRead(agent)).toMatchObject({
      request: `我这条消息说的是我在 IncarnaMind 中打开的文档：“Annual summary 2025”（documentId：${summary.id}）。`,
    });
  });

  // protects=with a Note and a Document both in front the line names both, and the request holds the Note's id and the Document's; fails_when=either is lost, or the Document's id is in the line
  it("names the Note and the Document together, the one in front first in the request", async () => {
    const { core, mind, summary, tariffs, pairing, agent } = await withDocuments();
    const line = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "question", text: SUMMARISE },
      onScreen: [tariffs.id, summary.id],
    });
    expect(line).toEqual({
      kind: "copy",
      text: `About my note “${TITLE}” and my document “Tariffs” in IncarnaMind:\n\n${SUMMARISE}`,
    });
    expect(JSON.stringify(line)).not.toContain(tariffs.id);
    expect(await requestRead(agent)).toEqual({
      mindId: mind.id,
      title: TITLE,
      request: `My message is about my note “${TITLE}” in IncarnaMind (mindId: ${mind.id}).\n\nMy message is about the documents I have open in IncarnaMind, the one in front first: “Tariffs” (documentId: ${tariffs.id}); “Annual summary 2025” (documentId: ${summary.id}).`,
    });
  });

  // protects=a Search scope set on the chat box reaches the agent in the ids its Tools take, and a Document open is not named twice; fails_when=the Folder or Document is left out, or named by an id no Tool takes
  it("keeps the Search scope, as Folder and Document ids", async () => {
    const { core, ferries, summary, tariffs, pairing, agent } = await withDocuments();
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: "What do fares cost?" },
        scope: { folderIds: [ferries.id], tagIds: [], documentIds: [tariffs.id, summary.id] },
        onScreen: [summary.id],
      }),
    ).toEqual({
      kind: "copy",
      text: "About my document “Annual summary 2025” in IncarnaMind:\n\nWhat do fares cost?",
    });
    expect(await requestRead(agent)).toMatchObject({
      request: [
        `My message is about the document I have open in IncarnaMind: “Annual summary 2025” (documentId: ${summary.id}).`,
        `I limited this question to these folders and documents in IncarnaMind: “Tallow Sound Ferries” (folderId: ${ferries.id}); “Tariffs” (documentId: ${tariffs.id}). Look only there.`,
      ].join("\n\n"),
    });
  });

  // protects=a scope alone, with no Note and nothing open, is named in a line of its own and kept; fails_when=the line is the one for no scope, or the scope isn't kept
  it("asks across a scope with nothing open", async () => {
    const { core, ferries, pairing, agent } = await withDocuments();
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: "How many crossings?" },
        scope: { folderIds: [ferries.id], tagIds: [], documentIds: [] },
      }),
    ).toEqual({
      kind: "copy",
      text: "From the Documents in my search scope in IncarnaMind:\n\nHow many crossings?",
    });
    expect(await requestRead(agent)).toEqual({
      mindId: null,
      title: "",
      request: `I limited this question to these folders and documents in IncarnaMind: “Tallow Sound Ferries” (folderId: ${ferries.id}). Look only there.`,
    });
  });

  // protects=with nothing open and no scope the line is as it was and nothing is kept; fails_when=a request is kept for a question that says all there is in its line
  it("keeps nothing when nothing is open and no scope is set", async () => {
    const { core, pairing, agent } = await withDocuments();
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: "How many crossings?" },
        onScreen: [],
        scope: { folderIds: [], tagIds: [], documentIds: [] },
      }),
    ).toEqual({ kind: "copy", text: "From my Documents in IncarnaMind:\n\nHow many crossings?" });
    expect(await requestRead(agent)).toEqual(NONE);
  });

  // protects=only what the asked agent can read now is named or kept, so the name of a Document it can't read never leaves IncarnaMind; fails_when=an unreadable Document or Folder is named in the line or the request
  it("names nothing the agent can't read, and keeps nothing for it", async () => {
    const { core, diary, secret, pairing, agent } = await withDocuments();
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: null,
      ask: { kind: "question", text: SUMMARISE },
      onScreen: [diary.id],
      scope: { folderIds: [secret.id], tagIds: [], documentIds: [diary.id] },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `From my Documents in IncarnaMind:\n\n${SUMMARISE}`,
    });
    expect(JSON.stringify(asked)).not.toContain("Diary");
    expect(await requestRead(agent)).toEqual(NONE);
  });

  // protects=an agent that can read one of two open Documents is told of that one alone; fails_when=the other's name is in its line or request
  it("names the open Documents the agent can read, and not the others", async () => {
    const { core, summary, diary, pairing, agent } = await withDocuments();
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: null,
      ask: { kind: "question", text: SUMMARISE },
      onScreen: [diary.id, summary.id],
    });
    expect(asked).toMatchObject({ text: expect.stringContaining("“Annual summary 2025”") });
    const read = await requestRead(agent);
    expect(JSON.stringify(read)).toContain(summary.id);
    expect(JSON.stringify(read)).not.toContain("Diary");
    expect(JSON.stringify(read)).not.toContain(diary.id);
  });

  // protects=the words of a fix, a Note or a meeting don't change with a Document open; fails_when=a Document is added to a request that asks for no question
  it("leaves the other asks as they were", async () => {
    const { core, mind, summary, pairing } = await withDocuments();
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: mind.id,
        ask: { kind: "note" },
        onScreen: [summary.id],
      }),
    ).toEqual({ kind: "copy", text: `About my note “${TITLE}” in IncarnaMind:` });
  });
});

describe("a request that names Documents and Folders, read after a wait (#3533)", () => {
  const ask = (
    core: Awaited<ReturnType<typeof withDocuments>>["core"],
    id: string,
    input: object,
  ) =>
    core.askAgent({
      pairingId: id,
      mindId: null,
      ask: { kind: "question", text: SUMMARISE },
      ...input,
    });
  const calls = async (core: Awaited<ReturnType<typeof withDocuments>>["core"], id: string) =>
    (await core.listAgentActivity(id)).map((each) => ({
      outcome: each.outcome,
      problem: each.problem,
      summary: each.summary,
      request: each.request,
    }));

  // protects=a request made while the agent could read a Document, and read after the Folder was unshared, is refused as a Note's is, tells the agent none of its names, and waits; fails_when=the agent is handed the Document's name, its activity line or request text carries it, or the request is lost for good
  it("is refused with no name when its Folder was unshared since, and waits for it to be shared again", async () => {
    const { core, fares, ferries, tariffs, pairing, agent } = await withDocuments();
    await ask(core, pairing.id, { onScreen: [tariffs.id] });
    await core.updateAgent(pairing.id, { folderIds: [ferries.id] });
    const refused = await requestRead(agent);
    expect(refused).toEqual({ refused: translate("en", "agents.problem.requestOutOfReach") });
    expect(JSON.stringify(refused)).not.toContain("Tariffs");
    expect(JSON.stringify(refused)).not.toContain(tariffs.id);
    const [call] = await calls(core, pairing.id);
    expect(call).toMatchObject({
      outcome: "refused",
      problem: "outside-scope",
      summary: "",
      request: null,
    });
    expect(JSON.stringify(await calls(core, pairing.id))).not.toContain("Tariffs");

    await core.updateAgent(pairing.id, { folderIds: [ferries.id, fares.id] });
    expect(await requestRead(agent)).toMatchObject({
      title: "Tariffs",
      request: `My message is about the document I have open in IncarnaMind: “Tariffs” (documentId: ${tariffs.id}).`,
    });
  });

  // protects=a Folder of the scope is read again too; fails_when=an unshared Folder's name goes to the agent
  it("is refused when a Folder it named is no longer shared", async () => {
    const { core, fares, ferries, pairing, agent } = await withDocuments();
    await ask(core, pairing.id, {
      scope: { folderIds: [fares.id], tagIds: [], documentIds: [] },
    });
    await core.updateAgent(pairing.id, { folderIds: [ferries.id] });
    const refused = await requestRead(agent);
    expect(refused).toEqual({ refused: translate("en", "agents.problem.requestOutOfReach") });
    expect(JSON.stringify(refused)).not.toContain("Fares");
  });

  // protects=a Document renamed since is named as it is now, in the text the agent reads and in its activity; fails_when=the old name comes back
  it("names a Document as it is when read, not as when asked", async () => {
    const { core, tariffs, pairing, agent } = await withDocuments();
    await ask(core, pairing.id, { onScreen: [tariffs.id] });
    await core.renameDocument(tariffs.id, "Tariffs 2026");
    const read = await requestRead(agent);
    expect(read).toEqual({
      mindId: null,
      title: "Tariffs 2026",
      request: `My message is about the document I have open in IncarnaMind: “Tariffs 2026” (documentId: ${tariffs.id}).`,
    });
    const [call] = await calls(core, pairing.id);
    expect(call).toMatchObject({ outcome: "done", summary: "Tariffs 2026" });
    expect(JSON.stringify(call)).not.toContain("“Tariffs”");
  });

  // protects=a Document deleted since is left out of what the agent reads; a request left with nothing it named goes, as one about a deleted Note does; fails_when=a deleted Document is named, or the request stays in front of the next
  it("leaves out what was deleted, and goes when nothing is left", async () => {
    const { core, summary, tariffs, pairing, agent } = await withDocuments();
    await ask(core, pairing.id, { onScreen: [tariffs.id, summary.id] });
    await core.deleteDocument(tariffs.id);
    const read = await requestRead(agent);
    expect(read).toEqual({
      mindId: null,
      title: "Annual summary 2025",
      request: `My message is about the document I have open in IncarnaMind: “Annual summary 2025” (documentId: ${summary.id}).`,
    });
    expect(JSON.stringify(read)).not.toContain("Tariffs");

    await ask(core, pairing.id, { onScreen: [summary.id] });
    await core.deleteDocument(summary.id);
    const gone = await requestRead(agent);
    expect(gone).toEqual({ refused: translate("en", "agents.problem.requestNoteDeleted") });
    expect(JSON.stringify(gone)).not.toContain("Annual summary");
    expect(await requestRead(agent)).toEqual(NONE);
  });

  // protects=a request with a Note keeps the Note's sentence, and the Documents it named come after it, named now; a Note's own reach is read again as before; fails_when=the Document is lost from a Note's request, or a Document the agent can no longer read is named
  it("keeps a Note's sentence and names the Documents beside it when read", async () => {
    const { core, mind, summary, tariffs, pairing, agent } = await withDocuments();
    await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "question", text: SUMMARISE },
      onScreen: [summary.id],
    });
    await core.renameDocument(summary.id, "Annual summary");
    expect(await requestRead(agent)).toEqual({
      mindId: mind.id,
      title: TITLE,
      request: `My message is about my note “${TITLE}” in IncarnaMind (mindId: ${mind.id}).\n\nMy message is about the document I have open in IncarnaMind: “Annual summary” (documentId: ${summary.id}).`,
    });
    expect(tariffs.id).toBeTruthy();
  });
});

describe("asking the User's own AI to check a Note, with no model set up in IncarnaMind (#3533)", () => {
  // protects=the line asks for a check of the Note by its name, with no id, and the request names the Tools to check it with; fails_when=the id is in the line, or the request doesn't name check_mind_yourself and report_check
  it("asks for a check of the Note by name, and keeps the Tools to do it with", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("Claude Code", "claude-code");
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "check" },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `Check my note “${TITLE}” in IncarnaMind against my Documents.`,
    });
    expect(JSON.stringify(asked)).not.toContain(mind.id);
    const agent = await connectLegacyAgent(pairing.launch);
    const read = await requestRead(agent, TITLE);
    expect(read).toMatchObject({ mindId: mind.id, title: TITLE });
    expect(read).toMatchObject({
      request: expect.stringContaining(`(mindId: ${mind.id})`),
    });
    expect(JSON.stringify(read)).toContain("check_mind_yourself");
    expect(JSON.stringify(read)).toContain("report_check");
    expect(await requestRead(agent, TITLE)).toEqual(NONE);
  });

  // protects=the same ask in Chinese; fails_when=Chinese gets English words
  it("asks for the check in Chinese when the interface is", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const pairing = await connect("Claude Code", "claude-code");
    expect(
      await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: { kind: "check" } }),
    ).toEqual({ kind: "copy", text: `对照我在 IncarnaMind 中的文档，核对笔记“${TITLE}”。` });
    const read = await requestRead(await connectLegacyAgent(pairing.launch));
    expect(JSON.stringify(read)).toContain("check_mind_yourself");
  });

  // protects=an agent that can't read the Note isn't asked and nothing is kept; fails_when=a request is kept for it
  it("asks no agent that can't read the Note", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const codex = await connect("Codex", "codex", [elsewhere.id]);
    await expect(
      core.askAgent({ pairingId: codex.id, mindId: mind.id, ask: { kind: "check" } }),
    ).rejects.toThrow("That agent can’t read this note now.");
    expect(await core.listAgentRequests(mind.id)).toEqual([]);
  });
});

describe("read_request with nothing waiting (#3533)", () => {
  // protects=an agent that looks for a request when none waits gets an answer, not a failed call, and its activity says it looked; fails_when=the call comes back as an error or is recorded as refused
  it("answers that none is waiting, and is no refusal", async () => {
    const { core, connect } = await started({ openLink: false });
    const pairing = await connect("Claude Code", "claude-code");
    const agent = await connectLegacyAgent(pairing.launch);
    const result = await readRequest(agent);
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual(NONE);
    expect(JSON.parse(resultText(result))).toEqual(NONE);
    const [call] = await core.listAgentActivity(pairing.id);
    expect(call).toMatchObject({ tool: "read_request", outcome: "done", problem: null });
    expect(activityWords(call ?? never(), (key, params) => translate("en", key, params))).toBe(
      "Looked for a request from you",
    );
    // Even when it names a note: nothing was read, and the line says so.
    await readRequest(agent, "the ferry report");
    const [named] = await core.listAgentActivity(pairing.id);
    expect(named).toMatchObject({ outcome: "done", summary: "" });
  });
});

function never(): never {
  throw new Error("No call was listed.");
}
