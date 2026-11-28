/**
 * Outside-app AI changes to any Note (User-written or AI-written) apply at once with Checkpoints,
 * 1-step Undo, lossless mounted-editor and IME protection, >50% User-text hold, `#3866`
 * `uncheckedBlocks` tracking with `own`-only `next`, AI use recording, timeout doc confirmation,
 * and pre-existing AI Note title handling (#3839).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { OpenNoteEditor } from "../../src/core/adapters";
import { createElement } from "../../src/core/answers/blocks";
import {
  type AgentNoteChange,
  BLOCK_ID_ATTRIBUTE,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../src/core/api";
import { changeFact } from "../../src/renderer/src/changeFacts";
import { INLINE_CODE_MARK } from "../../src/shared/aiText";
import { ownTextRemoved } from "../../src/shared/askedChanges";
import { summarizeProposalChanges } from "../../src/shared/changeSummary";
import { translate } from "../../src/shared/i18n";
import { readMindCheck, writeMindCheck } from "../../src/shared/mindCheck";
import { recordNoteWriter } from "../../src/shared/noteWriter";
import {
  cleanStagedProposals,
  decideProposals,
  pendingProposals,
  proposalRequestOf,
  recordProposalRequest,
  resolveProposals,
  targetHash,
  waitingChanges,
} from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, heading, note, readMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const TIDES = "# Tides\n\nSpring tides happen twice a month, at new moon and full moon.\n";
const EN_P1 = "Tides rise and fall twice a day along the coast.";
const EN_P2 = "The range between high and low water changes through the month.";
const ZH_P1 = "潮水每天沿着海岸涨落两次，时间十分规律。";
const ZH_P2 = "高低潮之间的水位差会在一个月内随着月相不断变化。";

interface Proposed {
  status: "applied" | "waiting";
  waiting: number;
  waitingInNote: number;
  markdown: string;
  version: string;
  next: string | null;
  why?: string;
}

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

const linesOf = (client: MindClient) => {
  const lines: string[] = [];
  readMind(client).forEach((block) => {
    if (block.textContent !== "") lines.push(block.textContent);
  });
  return lines;
};

async function paired(language: "en" | "zh-CN", openNoteEditor?: OpenNoteEditor) {
  const started = await startAgentsCore(
    replyingModel(),
    openNoteEditor ? { agents: { openNoteEditor } } : {},
  );
  const { core } = started;
  if (language !== "en") await core.updateSettings({ user: { language } });
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const told: AgentNoteChange[] = [];
  core.on("agents.noteChanged", (change) => told.push(change));
  const { launch, pairing } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(launch);
  return { ...started, core, coast, agent, pairing, told };
}

describe("outside-app changes to any Note apply at once (#3839)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it.each([
    [
      "en",
      EN_P1,
      EN_P2,
      "Tides rise and fall twice a day.",
      "Neap tides come at the quarter moons.",
    ],
    ["zh-CN", ZH_P1, ZH_P2, "潮水每天沿着海岸涨落两次。", "小潮出现在上弦月和下弦月时。"],
  ] as const)(
    "applies rewrite, addition and removal at once on a User Note with Checkpoints, summary facts, and 1-step Undo (%s)",
    async (language, p1, p2, rewrittenP1, addedP3) => {
      const { core, agent, coast, told } = await paired(language);
      const mind = await core.createMind({ title: "Field notes", folderId: coast.id });
      const client = await connectToMind(core, mind.id);
      editMind(client, () => [note(p1), note(p2)]);
      await client.settled();

      const firstRead = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
      );
      const rewrite = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: firstRead.version,
            changes: [{ paragraph: "¶1", text: rewrittenP1 }],
          },
        }),
      );
      expect(rewrite).toMatchObject({ status: "applied", waiting: 0, next: null });

      const added = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: rewrite.version,
            changes: [{ paragraph: "¶2+", text: addedP3 }],
          },
        }),
      );
      expect(added).toMatchObject({ status: "applied", waiting: 0, next: null });

      const removed = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: added.version,
            changes: [{ paragraph: "¶3", remove: true }],
          },
        }),
      );
      expect(removed).toMatchObject({ status: "applied", waiting: 0, next: null });

      await client.settled();
      expect(linesOf(client)).toEqual([rewrittenP1, p2]);
      expect(pendingProposals(client.blocks)).toEqual([]);

      const { checkpoints } = await core.listCheckpoints(mind.id);
      expect(checkpoints.filter((each) => each.reason === "accept")).toHaveLength(3);

      expect(told).toHaveLength(3);
      expect(told[0]).toMatchObject({
        kind: "changed",
        changed: 1,
        added: 0,
        named: { added: false },
      });
      expect(told[0]?.named?.start).toBeTruthy();
      expect(told[0]?.firstBlockId).toBeTruthy();
      expect(told[1]).toMatchObject({
        kind: "changed",
        changed: 0,
        added: 1,
        named: { added: true },
      });
      expect(told[2]).toMatchObject({
        kind: "changed",
        changed: 1,
        added: 0,
        removed: { paragraphs: 1, sentences: 1 },
      });

      const steps = told.flatMap((each) => (each.step ? [each.step] : []));
      expect(steps).toHaveLength(3);
      expect(await core.undoAgentChange(steps[2] ?? "")).toBe("done");
      await expect.poll(() => linesOf(client)).toEqual([rewrittenP1, p2, addedP3]);
      expect(await core.undoAgentChange(steps[1] ?? "")).toBe("done");
      await expect.poll(() => linesOf(client)).toEqual([rewrittenP1, p2]);
      expect(await core.undoAgentChange(steps[0] ?? "")).toBe("done");
      await expect.poll(() => linesOf(client)).toEqual([p1, p2]);
      expect(await core.redoAgentChange(steps[0] ?? "")).toBe("done");
      await expect.poll(() => linesOf(client)).toEqual([rewrittenP1, p2]);
    },
  );

  it.each(["en", "zh-CN"] as const)(
    "refuses with changedByUser when openNoteEditor reports busy or changed, rolling back cleanly with 0 words lost (%s)",
    async (language) => {
      let prepareMode: "busy" | "ready" = "busy";
      let acceptMode: "changed" | "applied" | "not-open" = "changed";
      const acceptCalls: string[] = [];
      let acceptHook: ((mindId: string, request: string) => Promise<void>) | null = null;

      const adapter: OpenNoteEditor = {
        prepareWrite: async () =>
          prepareMode === "busy"
            ? { open: true, busy: true }
            : { open: true, busy: false, token: `tok-${randomUUID()}` },
        acceptInEditor: async (input) => {
          acceptCalls.push(input.request);
          if (acceptMode === "applied" && acceptHook) {
            await acceptHook(input.mindId, input.request);
          }
          return acceptMode;
        },
      };

      const { core, agent, coast, told } = await paired(language, adapter);
      const mind = await core.createMind({ title: "Live note", folderId: coast.id });
      const client = await connectToMind(core, mind.id);
      const original = language === "en" ? EN_P1 : ZH_P1;
      const second = language === "en" ? EN_P2 : ZH_P2;
      const updated =
        language === "en" ? "Tides rise and fall twice a day." : "潮水每天沿着海岸涨落两次。";
      editMind(client, () => [note(original), note(second)]);
      await client.settled();

      const read = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
      );

      // 1. User typing or composing IME during prepareWrite -> refused with changedByUser, 0 proposals, 0 checkpoints.
      expect(
        refusal(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId: mind.id,
              version: read.version,
              changes: [{ paragraph: "¶1", text: updated }],
            },
          }),
        ),
      ).toBe(translate(language, "agents.problem.changedByUser"));
      await client.settled();
      expect(linesOf(client)).toEqual([original, second]);
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(acceptCalls).toEqual([]);
      expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(0);

      // 2. Editor becomes busy/stale between prepareWrite and acceptInEditor -> rolls back staged Proposals cleanly.
      prepareMode = "ready";
      acceptMode = "changed";
      expect(
        refusal(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId: mind.id,
              version: read.version,
              changes: [{ paragraph: "¶1", text: updated }],
            },
          }),
        ),
      ).toBe(translate(language, "agents.problem.changedByUser"));
      await client.settled();
      expect(linesOf(client)).toEqual([original, second]);
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(acceptCalls).toHaveLength(1);
      expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(0);

      // 3. Mounted editor accepts cleanly on UI thread -> appliedInEditor: true, step: null.
      acceptMode = "applied";
      acceptHook = async (_mindId, request) => {
        await client.settled();
        await core.saveCheckpoint(mind.id, "accept");
        client.doc.transact(() => {
          resolveProposals(client.blocks, (ref) => ref.request === request, "accept");
        }, "editor");
        await client.settled();
      };
      const applied = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: read.version,
            changes: [{ paragraph: "¶1", text: updated }],
          },
        }),
      );
      expect(applied).toMatchObject({ status: "applied", waiting: 0 });
      await client.settled();
      expect(linesOf(client)).toEqual([updated, second]);
      expect(told.at(-1)).toMatchObject({
        mindId: mind.id,
        kind: "changed",
        appliedInEditor: true,
        step: null,
      });

      // 4. Editor unmounts between prepareWrite and acceptInEditor ("not-open") -> falls back to core accept safely.
      acceptMode = "not-open";
      const fallback = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: applied.version,
            changes: [
              {
                paragraph: "¶2+",
                text: language === "en" ? "Added after close." : "关闭后补充一段。",
              },
            ],
          },
        }),
      );
      expect(fallback).toMatchObject({ status: "applied", waiting: 0 });
      expect(told.at(-1)?.step).toBeTruthy();
      expect(told.at(-1)?.appliedInEditor).toBeUndefined();
    },
  );

  it.each([
    ["en", EN_P1, "Harbour ferries cross every hour through the winter season."],
    ["zh-CN", ZH_P1, "渡轮整个冬季每小时往返港口一次，载客量创新高。"],
  ] as const)(
    "holds >50% User-text rewrites with held: true persisted and 0 Checkpoints saved (%s)",
    async (language, original, rewrite) => {
      const { core, agent, coast, told } = await paired(language);
      const mind = await core.createMind({ title: "Draft", folderId: coast.id });
      const client = await connectToMind(core, mind.id);
      editMind(client, () => [note(original)]);
      await client.settled();

      const read = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
      );
      const result = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: read.version,
            changes: [{ paragraph: "¶1", text: rewrite }],
          },
        }),
      );
      expect(result).toMatchObject({
        status: "waiting",
        why: translate(language, "agents.propose.heldMostText"),
      });
      expect(result.waiting).toBeGreaterThan(0);
      expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(0);
      expect(told).toEqual([]);

      await client.settled();
      const pending = pendingProposals(client.blocks);
      expect(pending.length).toBeGreaterThan(0);
      const reqId = pending[0]?.request ?? "";
      expect(proposalRequestOf(client.doc, reqId)).toMatchObject({
        source: "outside-agent",
        held: true,
      });

      // Persists across reopening a fresh client from SQLite (simulating closed-Note reopen).
      await core.closeMind(mind.id);
      const reopened = await connectToMind(core, mind.id);
      const reopenedPending = pendingProposals(reopened.blocks);
      expect(reopenedPending.length).toBeGreaterThan(0);
      expect(proposalRequestOf(reopened.doc, reopenedPending[0]?.request ?? "")).toMatchObject({
        source: "outside-agent",
        held: true,
      });
      expect(waitingChanges(reopened.blocks)).toBeGreaterThan(0);
    },
  );

  it.each([
    ["en", EN_P1, EN_P2, "Tides rise and fall twice a day."],
    ["zh-CN", ZH_P1, ZH_P2, "潮水每天沿着海岸涨落两次。"],
  ] as const)(
    "updates #3866 uncheckedBlocks immediately on already-checked User Note and AI Note while keeping next own-only (%s)",
    async (language, p1, p2, rewrittenP1) => {
      const { core, agent, coast } = await paired(language);

      // 1. User-written Note, already checked completely (stop: null, 0 uncheckedBlocks).
      const userNote = await core.createMind({ title: "User note", folderId: coast.id });
      const userClient = await connectToMind(core, userNote.id);
      editMind(userClient, () => [note(p1), note(p2)]);
      await userClient.settled();
      const userBlockId = (userClient.blocks.get(0) as Y.XmlElement | undefined)?.getAttribute(
        BLOCK_ID_ATTRIBUTE,
      );
      expect(typeof userBlockId).toBe("string");
      userClient.doc.transact(() => {
        writeMindCheck(userClient.doc.getMap(MIND_SETTINGS_FIELD), {
          at: "2026-11-28T09:00:00.000Z",
          sentences: 2,
          stop: null,
          skipped: [],
          unexamined: [],
        });
      });
      await userClient.settled();
      expect(
        readMindCheck(userClient.doc.getMap(MIND_SETTINGS_FIELD))?.uncheckedBlocks,
      ).toBeUndefined();

      const userRead = structured<{ version: string }>(
        await agent.callTool({
          name: "read_mind",
          arguments: { mindId: userNote.id, named: true },
        }),
      );
      const userEdit = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: userNote.id,
            version: userRead.version,
            changes: [{ paragraph: "¶1", text: rewrittenP1 }],
          },
        }),
      );
      expect(userEdit.status).toBe("applied");
      // next stays null on User-written Note (check_mind_yourself remains own-only).
      expect(userEdit.next).toBeNull();
      await expect
        .poll(() => readMindCheck(userClient.doc.getMap(MIND_SETTINGS_FIELD))?.uncheckedBlocks)
        .toContain(userBlockId);

      // 2. AI-written Note (own === true), already checked completely.
      const made = structured<{ mindId: string }>(
        await agent.callTool({
          name: "create_mind",
          arguments: { title: "AI note", markdown: `${p1}\n\n${p2}` },
        }),
      );
      const aiClient = await connectToMind(core, made.mindId);
      await aiClient.settled();
      const aiBlockId = (aiClient.blocks.get(1) as Y.XmlElement | undefined)?.getAttribute(
        BLOCK_ID_ATTRIBUTE,
      );
      expect(typeof aiBlockId).toBe("string");
      aiClient.doc.transact(() => {
        writeMindCheck(aiClient.doc.getMap(MIND_SETTINGS_FIELD), {
          at: "2026-11-28T09:00:00.000Z",
          sentences: 2,
          stop: null,
          skipped: [],
          unexamined: [],
        });
      });
      await aiClient.settled();

      const aiRead = structured<{ version: string }>(
        await agent.callTool({
          name: "read_mind",
          arguments: { mindId: made.mindId, named: true },
        }),
      );
      const aiEdit = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: made.mindId,
            version: aiRead.version,
            changes: [{ paragraph: "¶1", text: rewrittenP1 }],
          },
        }),
      );
      expect(aiEdit.status).toBe("applied");
      // own === true still reports unchecked sentences in next AND updates uncheckedBlocks.
      expect(aiEdit.next).not.toBeNull();
      await expect
        .poll(() => readMindCheck(aiClient.doc.getMap(MIND_SETTINGS_FIELD))?.uncheckedBlocks)
        .toContain(aiBlockId);
    },
  );

  // protects=when openNoteEditor.acceptInEditor throws/rejects, staged Proposals are cleanly rolled back in core so zero orphaned Proposals leak (#3839); fails_when=staged Proposals remain pending after acceptInEditor throws
  it("rolls back staged Proposals in core when acceptInEditor throws", async () => {
    const throwingEditor: OpenNoteEditor = {
      async prepareWrite() {
        return { open: true, busy: false, token: "tok-throw" };
      },
      async acceptInEditor() {
        throw new Error("IPC channel broke");
      },
    };
    const { core, agent, coast } = await paired("en", throwingEditor);
    const mind = await core.createMind({ title: "Rollback test", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    editMind(client, () => [note(EN_P1), note(EN_P2)]);
    await client.settled();

    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    const failed = await agent.callTool({
      name: "propose_changes",
      arguments: {
        mindId: mind.id,
        version: read.version,
        changes: [{ paragraph: "¶1", text: "Tides rise twice daily." }],
      },
    });
    expect(refusal(failed)).toBe(translate("en", "agents.problem.failed"));

    await client.settled();
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(waitingChanges(client.blocks)).toBe(0);
    expect(linesOf(client)).toEqual([EN_P1, EN_P2]);
  });

  // protects=removing a whole table counts as 1 table (tablesRemoved: true) so the inline summary says "Changed 1 table" / "修改了 1 个表格" rather than "Changed 0 paragraphs" or "Added a table" (#3839); fails_when=tables is 0 or summary says 0 paragraphs / Added
  it.each([
    ["en", "Changed 1 table"],
    ["zh-CN", "修改了 1 个表格"],
  ] as const)("summarizes whole-table removal accurately (%s)", (language, expectedLine) => {
    const doc = new Y.Doc();
    try {
      const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
      const keep = new Y.XmlElement("paragraph");
      keep.setAttribute(BLOCK_ID_ATTRIBUTE, "keep-1");
      keep.insert(0, [new Y.XmlText(EN_P1)]);

      const table = createElement({
        type: "table",
        attrs: {
          [BLOCK_ID_ATTRIBUTE]: "tbl-1",
          [PROPOSAL_ATTRIBUTE]: {
            id: "prop-tbl-del",
            request: "req-tbl-del",
            kind: "delete",
            target: targetHash("Port"),
          },
        },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Port" }] }],
              },
            ],
          },
        ],
      });
      blocks.insert(0, [keep, table]);

      const summary = summarizeProposalChanges(blocks, (ref) => ref.request === "req-tbl-del");
      expect(summary).toMatchObject({
        changed: 0,
        added: 0,
        tables: 1,
        tablesRemoved: true,
      });
      const rendered = changeFact(
        (key, params) => translate(language, key, params),
        {
          created: false,
          changed: summary.changed,
          wrote: summary.added,
          tables: summary.tables,
          ...(summary.tablesRemoved && { tablesRemoved: true }),
        },
        null,
      );
      expect(rendered).toBe(expectedLine);
    } finally {
      doc.destroy();
    }
  });

  // protects=outside-agent edits applied on the core path (closed or hidden Note) record outside-agent-change-accepted so the AI use statement lists them (#3839); fails_when=AI use record or statement misses the outside-agent edit
  it.each([
    [
      "en",
      EN_P1,
      EN_P2,
      "Tides rise and fall twice daily along the coast.",
      "Changes from a connected agent accepted",
    ],
    [
      "zh-CN",
      ZH_P1,
      ZH_P2,
      "潮水每日沿着海岸涨落两次，时间十分规律。",
      "接受已连接智能体提出的修订",
    ],
  ] as const)(
    "records AI use on the core path so the AI use statement lists Claude Code edits to a closed User Note (%s)",
    async (language, p1, p2, rewrittenP1, expectedRow) => {
      const { core, agent, coast } = await paired(language);
      const mind = await core.createMind({ title: "Closed draft", folderId: coast.id });
      const client = await connectToMind(core, mind.id);
      editMind(client, () => [note(p1), note(p2)]);
      await client.settled();
      // Close the Note so the outside-agent edit takes the core-accept path.
      await core.closeMind(mind.id);

      const read = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
      );
      const edited = structured<Proposed>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: read.version,
            changes: [{ paragraph: "¶1", text: rewrittenP1 }],
          },
        }),
      );
      expect(edited.status).toBe("applied");

      const entries = await core.listAiUse(mind.id);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mindId: mind.id,
            kind: "outside-agent-change-accepted",
            agent: "Claude Code",
          }),
        ]),
      );

      const statement = await core.createAiUseStatement(mind.id);
      const statementClient = await connectToMind(core, statement.id);
      const rows: string[][] = [];
      readMind(statementClient).descendants((node) => {
        if (node.type.name === "tableRow") {
          const row: string[] = [];
          node.forEach((cell) => void row.push(cell.textContent));
          rows.push(row);
        }
      });
      expect(rows).toContainEqual([expectedRow, expect.stringContaining("Claude Code"), "1"]);
    },
  );

  // protects=when openNoteEditor applies on the editor thread, core does not duplicate AI use recording because applyArrived records it (#3839); fails_when=core records AI use on appliedInEditor path
  it("does not double-record AI use in core when the open editor applied the write", async () => {
    let clientRef: MindClient | null = null;
    const editorAdapter: OpenNoteEditor = {
      async prepareWrite() {
        return { open: true, busy: false, token: `tok-${randomUUID()}` };
      },
      async acceptInEditor(input) {
        const current = clientRef;
        if (current) {
          await current.settled();
          current.doc.transact(() => {
            decideProposals(current.blocks, (ref) => ref.request === input.request, "accept");
          }, "editor");
          await current.settled();
        }
        return "applied";
      },
    };
    const { core, agent, coast } = await paired("en", editorAdapter);
    const mind = await core.createMind({ title: "Open note", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    clientRef = client;
    editMind(client, () => [note(EN_P1), note(EN_P2)]);
    await client.settled();

    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    const edited = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [{ paragraph: "¶1", text: "Tides rise twice daily." }],
        },
      }),
    );
    expect(edited.status).toBe("applied");
    // Renderer's applyArrived owns core.recordAiUse on the open-editor path; core itself writes 0 entries here.
    expect(await core.listAiUse(mind.id)).toEqual([]);
  });

  // protects=when acceptInEditor times out, core confirms against the doc instead of guessing: rolls back and refuses if still pending, or confirms applied if the renderer already accepted (#3839); fails_when=timeout guesses changed when already applied or leaves pending Proposals behind
  it("confirms against the document on acceptInEditor timeout (rolls back if pending, confirms if already applied)", async () => {
    let applyBeforeTimeout = false;
    let clientRef: MindClient | null = null;
    const timeoutEditor: OpenNoteEditor = {
      async prepareWrite() {
        return { open: true, busy: false, token: `tok-${randomUUID()}` };
      },
      async acceptInEditor(input) {
        const current = clientRef;
        if (applyBeforeTimeout && current) {
          await current.settled();
          current.doc.transact(() => {
            decideProposals(current.blocks, (ref) => ref.request === input.request, "accept");
          }, "editor");
          await current.settled();
        }
        return "timeout";
      },
    };
    const { core, agent, coast, told } = await paired("en", timeoutEditor);
    const mind = await core.createMind({ title: "Timeout confirmation", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    clientRef = client;
    editMind(client, () => [note(EN_P1), note(EN_P2)]);
    await client.settled();

    // Case 1: renderer never applied before timeout -> core rolls back and refuses with changedByUser.
    const r1 = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    const timedOutPending = await agent.callTool({
      name: "propose_changes",
      arguments: {
        mindId: mind.id,
        version: r1.version,
        changes: [{ paragraph: "¶1", text: "Tides rise twice daily." }],
      },
    });
    expect(refusal(timedOutPending)).toBe(translate("en", "agents.problem.changedByUser"));
    await client.settled();
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(linesOf(client)).toEqual([EN_P1, EN_P2]);
    expect(told).toEqual([]);

    // Case 2: renderer already accepted before IPC timed out -> core confirms applied, no refusal, no duplicate write!
    applyBeforeTimeout = true;
    const confirmed = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: r1.version,
          changes: [{ paragraph: "¶1", text: "Tides rise twice daily." }],
        },
      }),
    );
    expect(confirmed).toMatchObject({ status: "applied", waiting: 0 });
    await client.settled();
    expect(linesOf(client)).toEqual(["Tides rise twice daily.", EN_P2]);
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ mindId: mind.id, appliedInEditor: true, step: null });
  });

  // protects=pre-existing AI-written Notes whose synthetic title heading lacks GENERATED_MARK do not hold a title rewrite as removing User text, while a User-written Note's heading still counts as User text (#3839); fails_when=rewriting an older AI Note's title holds or a User Note's heading stops counting
  it("treats a pre-existing AI Note's unmarked first title heading as generated while keeping User Note headings as User text", async () => {
    const { core, agent, coast, pairing } = await paired("en");

    // Simulate a pre-existing AI-written Note whose opening heading 1 has NO GENERATED_MARK.
    const aiMind = await core.createMind({ title: "Harbour Draft", folderId: coast.id });
    const aiClient = await connectToMind(core, aiMind.id);
    editMind(aiClient, () => [
      heading(1, "Harbour Draft"),
      {
        type: "paragraph",
        attrs: { id: randomUUID() },
        content: [{ type: "text", text: EN_P1, marks: [{ type: GENERATED_MARK }] }],
      },
    ]);
    aiClient.doc.transact(() => {
      recordNoteWriter(aiClient.doc, {
        source: "outside-agent",
        agent: pairing.name,
        pairingId: pairing.id,
        mindId: aiMind.id,
        createdAt: "2026-11-28T09:00:00.000Z",
      });
    });
    await aiClient.settled();

    const rAi = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: aiMind.id, named: true } }),
    );
    const titleRewrite = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: aiMind.id,
          version: rAi.version,
          changes: [{ paragraph: "¶0", text: "# Revised Coastal Briefing" }],
        },
      }),
    );
    expect(titleRewrite.status).toBe("applied");

    // Contrast: a User-written Note with only an unmarked heading 1 holds when rewritten (>50% User text).
    const userMind = await core.createMind({ title: "My Private Title", folderId: coast.id });
    const userClient = await connectToMind(core, userMind.id);
    editMind(userClient, () => [heading(1, "My Private Title")]);
    await userClient.settled();
    const rUser = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: userMind.id, named: true } }),
    );
    const heldUserTitle = structured<Proposed>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: userMind.id,
          version: rUser.version,
          changes: [{ paragraph: "¶0", text: "# Completely Different Words" }],
        },
      }),
    );
    expect(heldUserTitle.status).toBe("waiting");

    // Inline code inside an AI-written paragraph is not miscounted as User text.
    const codeDoc = new Y.Doc();
    try {
      const blocks = codeDoc.getXmlFragment(MIND_CONTENT_FIELD);
      const para = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Run ", { [GENERATED_MARK]: {} });
      text.insert(4, "npm test", {
        [INLINE_CODE_MARK]: {},
        [PROPOSAL_DELETE_MARK]: { id: "p-code", request: "req-code" },
      });
      text.insert(12, "npm check", {
        [INLINE_CODE_MARK]: {},
        [PROPOSAL_INSERT_MARK]: { id: "p-code", request: "req-code" },
      });
      para.insert(0, [text]);
      blocks.insert(0, [para]);
      expect(ownTextRemoved(blocks, new Set(["req-code"]))).toBe(0);
    } finally {
      codeDoc.destroy();
    }
  });

  // protects=temporary staging Proposals left behind by a crash before accept are rolled back on load while held Proposals persist (#3839); fails_when=staged Proposals leak on reload or held Proposals are wiped
  it("cleans up leftover staged Proposals on reload without touching held Proposals", () => {
    const doc = new Y.Doc();
    try {
      const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
      const p1 = new Y.XmlElement("paragraph");
      p1.setAttribute(BLOCK_ID_ATTRIBUTE, "b-staged");
      const t1 = new Y.XmlText();
      t1.insert(0, "old", { [PROPOSAL_DELETE_MARK]: { id: "prop-s", request: "req-s" } });
      t1.insert(3, "new", { [PROPOSAL_INSERT_MARK]: { id: "prop-s", request: "req-s" } });
      p1.insert(0, [t1]);

      const p2 = new Y.XmlElement("paragraph");
      p2.setAttribute(BLOCK_ID_ATTRIBUTE, "b-held");
      const t2 = new Y.XmlText();
      t2.insert(0, "kept", { [PROPOSAL_DELETE_MARK]: { id: "prop-h", request: "req-h" } });
      t2.insert(4, "rewritten", { [PROPOSAL_INSERT_MARK]: { id: "prop-h", request: "req-h" } });
      p2.insert(0, [t2]);

      blocks.insert(0, [p1, p2]);
      recordProposalRequest(doc, "req-s", {
        source: "outside-agent",
        agent: "Claude Code",
        pairingId: "pair-1",
        createdAt: "2026-11-28T09:00:00.000Z",
        staging: true,
      });
      recordProposalRequest(doc, "req-h", {
        source: "outside-agent",
        agent: "Claude Code",
        pairingId: "pair-1",
        createdAt: "2026-11-28T09:00:00.000Z",
        held: true,
      });

      expect(cleanStagedProposals(blocks)).toBe(true);
      expect(pendingProposals(blocks).map((ref) => ref.request)).toEqual(["req-h"]);
      expect(t1.toString()).toBe("old");
      expect(cleanStagedProposals(blocks)).toBe(false);
    } finally {
      doc.destroy();
    }
  });
});
