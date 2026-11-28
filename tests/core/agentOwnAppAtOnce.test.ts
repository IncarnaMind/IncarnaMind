/**
 * Outside-app AI changes to any Note (User-written or AI-written) apply at once with Checkpoints,
 * 1-step Undo, lossless mounted-editor / IME protection (D1), >50% User-text hold (D2),
 * `#3866` `uncheckedBlocks` tracking with `own`-only `next` (D4), and consent copy (D5) (#3839).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import type { OpenNoteEditor } from "../../src/core/adapters";
import { type AgentNoteChange, BLOCK_ID_ATTRIBUTE, MIND_SETTINGS_FIELD } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { readMindCheck, writeMindCheck } from "../../src/shared/mindCheck";
import {
  pendingProposals,
  proposalRequestOf,
  resolveProposals,
  waitingChanges,
} from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, note, readMind } from "../helpers/minds";
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
    "D1: refuses with changedByUser when openNoteEditor reports busy or changed, rolling back cleanly with 0 words lost (%s)",
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
    "D2: holds >50% User-text rewrites with held: true persisted and 0 Checkpoints saved (%s)",
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
    "D4: updates #3866 uncheckedBlocks immediately on already-checked User Note and AI Note while keeping next own-only (%s)",
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
      // D4: next stays null on User-written Note (check_mind_yourself remains own-only).
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
      // D4: own === true still reports unchecked sentences in next AND updates uncheckedBlocks.
      expect(aiEdit.next).not.toBeNull();
      await expect
        .poll(() => readMindCheck(aiClient.doc.getMap(MIND_SETTINGS_FIELD))?.uncheckedBlocks)
        .toContain(aiBlockId);
    },
  );
});
