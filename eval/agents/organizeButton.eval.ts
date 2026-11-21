import { expect, test } from "vitest";
import type { SortingBatch } from "../../src/core/agents/sorting";
import { agentsAdapter } from "../../tests/helpers/agents";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../../tests/helpers/documents";
import { agentSession, agentUsd } from "../lib/agentSession";

test.skipIf(!process.env.INCARNAMIND_SORTING_EVAL_KEY && !process.env.SORTING_DRY_RUN)(
  "Organize opens the connected agent with the Library's chosen scope",
  async () => {
    for (const language of ["en", "zh-CN"] as const) {
      const data = await createTempDataFolder();
      const core = startCore(data, { agents: await agentsAdapter(data) });
      try {
        await core.updateSettings({ user: { language } });
        const folder = (name: string, parentId?: string) =>
          core.createLibraryGroup({ name, description: "", ...(parentId && { parentId }) });
        const shared = await folder(language === "en" ? "Fieldwork" : "考察");
        const source = await folder(language === "en" ? "Incoming" : "待整理", shared.id);
        const right = await folder(language === "en" ? "Invoices" : "发票", source.id);
        await folder(language === "en" ? "Minutes" : "纪要", source.id);
        const files = await createSourceFolder();
        const [requested, decoy] = await addAndProcess(core, [
          await writeSourceFile(
            files,
            "A.md",
            language === "en"
              ? "# Invoice 317\n\nInvoice for sail repairs. Amount due: 320 pounds. Payment within 30 days."
              : "# 维修发票\n\n发票编号 317，维修船帆共 320 元，30 天内付款。",
          ),
          await writeSourceFile(
            files,
            "B.md",
            language === "en"
              ? "# Meeting minutes\n\nThe team agreed to visit the north inlet on Monday."
              : "# 会议纪要\n\n大家决定周一前往北湾，周五提交观察记录。",
          ),
        ]);
        if (!requested || !decoy) throw new Error("The test Documents are missing.");
        await core.assignDocumentGroup(requested.id, source.id);
        await core.assignDocumentGroup(decoy.id, language === "en" ? source.id : shared.id);
        await core.setAgentsEnabled(true);
        const setup = {
          chat: {
            kind: "anthropic" as const,
            modelId: "claude-haiku-5-5",
            apiKey: process.env.INCARNAMIND_SORTING_EVAL_KEY || "dry-run",
          },
        };
        const session = await agentSession(
          core,
          setup,
          agentUsd(setup),
          "Field assistant",
          shared.id,
          null,
        );
        try {
          const target = language === "en" ? { ids: [requested.id] } : { folderId: source.id };
          const [agent] = (await core.agentsForOrganize(target)).eligible;
          if (!agent) throw new Error("Organize did not offer the connected agent.");
          const handoff = await core.askAgent({
            pairingId: agent.id,
            mindId: null,
            ask: { kind: "organize", target },
          });
          if (handoff.kind !== "copy")
            throw new Error("Expected a line to paste into the test agent.");
          const original = await core.getLibrary();
          const originalTags = (await core.listDocuments()).map((d) => d.tags);
          if (!process.env.INCARNAMIND_SORTING_EVAL_KEY) {
            const saved = await session.agent.callTool({ name: "read_request", arguments: {} });
            expect(saved.structuredContent).toMatchObject({
              request: expect.stringContaining(language === "en" ? requested.id : source.id),
            });
            const listed = await session.agent.callTool({ name: "list_sorting", arguments: {} });
            const batch = listed.structuredContent as unknown as SortingBatch;
            expect(batch.documents.map((d) => d.id).sort()).toEqual(
              [requested.id, decoy.id].sort(),
            );
            const doc = batch.documents.find((d) => d.id === requested.id);
            if (!doc) throw new Error("Missing requested Document");
            const sent = await session.agent.callTool({
              name: "propose_sorting",
              arguments: {
                proposals: [{ documentId: doc.id, version: doc.version, folderId: right.id }],
              },
            });
            expect(sent.isError).not.toBe(true);
          } else {
            const turn = await session.converse([{ role: "user", content: handoff.text }]);
            const calls = session.calls.map((c) => c.name);
            console.log(
              JSON.stringify({
                language,
                cost: turn.cost,
                tools: calls,
                finish: turn.done.finishReason,
              }),
            );
            expect(turn.done.finishReason).toBe("stop");
            if (session.refusals().length) {
              const rows = (await core.getOrganizeReview()).items;
              console.log(
                JSON.stringify({
                  language,
                  refusals: session.refusals().length,
                  finalRows: rows.length,
                  onlyRequested: rows.every((r) => r.documentId === requested.id),
                  correctFolder: rows.some(
                    (r) => r.placement.kind === "folder" && r.placement.folderId === right.id,
                  ),
                }),
              );
            }
            expect(session.refusals()).toEqual([]);
            expect(calls.indexOf("read_request")).toBeGreaterThanOrEqual(0);
            expect(calls.indexOf("propose_sorting")).toBeGreaterThan(calls.indexOf("read_request"));
          }
          const items = (await core.getOrganizeReview()).items;
          expect(items).toHaveLength(1);
          expect(items[0]).toMatchObject({
            documentId: requested.id,
            agent: agent.name,
            placement: { kind: "folder", folderId: right.id },
          });
          expect((await core.getLibrary()).assignments).toEqual(original.assignments);
          expect((await core.listDocuments()).map((d) => d.tags)).toEqual(originalTags);
          await core.confirmOrganizeReview(items.map((i) => i.id));
          expect(
            (await core.getLibrary()).assignments.find((a) => a.documentId === requested.id)
              ?.groupId,
          ).toBe(right.id);
        } finally {
          await session.close();
        }
      } finally {
        core.close();
      }
    }
  },
  10 * 60_000,
);
