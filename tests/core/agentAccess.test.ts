/**
 * The core interface outside agents use (#351), on its own: how `ask` says
 * why IncarnaMind's Answer wasn't written. Local mode can come on between
 * the pairing's check and the chat model's, and then `ask` is paused like
 * every Tool, never "no chat model".
 */
import { describe, expect, it } from "vitest";
import { type AgentAccessDeps, createAgentAccess } from "../../src/core/agents/access";
import type { OutsideAnswer } from "../../src/core/answers";
import { translate } from "../../src/shared/i18n";

function accessAnswering(outcome: OutsideAnswer) {
  const deps: AgentAccessDeps = {
    admit: (pairingId) => ({ id: pairingId, name: "Codex", folderIds: ["coast"], propose: false }),
    folders: () => [{ id: "coast", name: "Coast", keepInside: false }],
    foldersInScope: (folderIds) => [...folderIds],
    documentsIn: () => ["tides"],
    search: async () => [],
    passage: () => null,
    passagesBetween: () => [],
    citing: { citeQuote: () => null, locate: () => null },
    notCited: () => false,
    recheck: () => {
      throw new Error("Not called.");
    },
    minds: () => [],
    liveDocuments: () => [],
    mindBlocks: () => {
      throw new Error("Not called.");
    },
    editMind: () => {
      throw new Error("Not called.");
    },
    show: () => undefined,
    mindMarkdown: () => "",
    answer: async () => outcome,
    citations: {
      find: () => null,
      mint: () => {
        throw new Error("Not called.");
      },
    },
    record: () => undefined,
    say: (key, params) => translate("en", key, params),
    clock: () => 0,
    now: () => "2026-11-01T09:00:00.000Z",
    reportError: () => undefined,
  };
  return createAgentAccess(deps, "pairing");
}

describe("ask, when IncarnaMind's Answer isn't written", () => {
  it("is paused in Local mode, as every Tool is", async () => {
    await expect(
      accessAnswering({ asked: false, reason: "local-mode" }).ask({ question: "When?" }),
    ).rejects.toMatchObject({ problem: "local-mode", message: /Agents are paused/ });
  });

  it("says when no chat model is ready, or it isn't allowed yet", async () => {
    await expect(
      accessAnswering({ asked: false, reason: "not-ready" }).ask({ question: "When?" }),
    ).rejects.toMatchObject({ problem: "chat-not-ready", message: /no chat model ready/ });
    await expect(
      accessAnswering({ asked: false, reason: "consent-needed" }).ask({ question: "When?" }),
    ).rejects.toMatchObject({ problem: "chat-not-ready", message: /isn’t allowed yet/ });
  });
});
