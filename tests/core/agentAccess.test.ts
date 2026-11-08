/**
 * The core interface outside agents use (#351), on its own: how `ask` says
 * why IncarnaMind's Answer wasn't written. Local mode can come on between
 * the pairing's check and the chat model's, and then `ask` is paused like
 * every Tool, never "no chat model".
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import { type AgentAccessDeps, createAgentAccess } from "../../src/core/agents/access";
import type { AgentCitation } from "../../src/core/agents/citations";
import type { OutsideAnswer } from "../../src/core/answers";
import { createElement } from "../../src/core/answers/blocks";
import { recheckCitation } from "../../src/core/answers/citations";
import { type CitationLocation, MIND_CONTENT_FIELD } from "../../src/core/api";
import { transcriptUnits } from "../../src/core/documents/formats/vtt";
import { translate } from "../../src/shared/i18n";

function accessAnswering(outcome: OutsideAnswer, overrides: Partial<AgentAccessDeps> = {}) {
  const deps: AgentAccessDeps = {
    admit: (pairingId) => ({ id: pairingId, name: "Codex", folderIds: ["coast"], propose: false }),
    folders: () => [{ id: "coast", name: "Coast", keepInside: false }],
    wallOf: () => null,
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
    newId: () => "id",
    reportError: () => undefined,
    ...overrides,
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

for (const language of ["en", "zh-CN"] as const) {
  const quote = language === "en" ? "We agreed to review the plan." : "我们同意重新审阅计划。";
  const first = language === "en" ? "Alex" : "王芳";
  const second = language === "en" ? "Dana" : "李明";
  const units = transcriptUnits({
    cues: [
      { startMs: 0, endMs: 2000, text: quote, speaker: first },
      {
        startMs: 4000,
        endMs: 6000,
        text: language === "en" ? "Other words." : "其他内容。",
        speaker: second,
      },
      { startMs: 7000, endMs: 10_000, text: quote, speaker: second },
    ],
    gaps: [],
  });
  const cases = [
    {
      name: "the selected second cue",
      location: { kind: "time", from: 7000, to: 10_000, speaker: second },
      check: "found",
      label: `${second} · 0:07`,
    },
    {
      name: "a wrong selected time without falling back to a duplicate",
      location: { kind: "time", from: 4000, to: 6000, speaker: second },
      check: "not-found",
      label: `${second} · 0:04`,
    },
    {
      name: "legacy matching without a stored Location",
      location: null,
      check: "found",
      label: `${first} · 0:00`,
    },
  ] satisfies {
    name: string;
    location: CitationLocation | null;
    check: "found" | "not-found";
    label: string;
  }[];

  function transcriptAccess(location: CitationLocation | null) {
    const kept: AgentCitation = {
      token: "k3x9a2b7",
      pairingId: "pairing",
      passageId: "review",
      documentId: "tides",
      documentName: "Review",
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      location,
      quote,
    };
    const documents = {
      currentVersion: () => "v2",
      documentName: () => "Review",
      pageTexts: () => units,
      passagesCovering: () => [{ id: "review", text: units.map((unit) => unit.text).join("\n") }],
    };
    const doc = new Y.Doc();
    onTestFinished(() => doc.destroy());
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.insert(0, [
      createElement({ type: "paragraph", content: [{ type: "text", text: "Review" }] }),
    ]);
    const show = vi.fn<AgentAccessDeps["show"]>();
    let id = 0;
    const access = accessAnswering(
      { asked: false, reason: "not-ready" },
      {
        admit: (pairingId) => ({
          id: pairingId,
          name: "Codex",
          folderIds: ["coast"],
          propose: true,
        }),
        citations: {
          find: (pairingId, token) =>
            pairingId === kept.pairingId && token === kept.token ? kept : null,
          mint: () => {
            throw new Error("Not called.");
          },
        },
        recheck: (input) => recheckCitation(documents, input),
        minds: () => [
          {
            id: "review-note",
            title: "Review",
            autoTitle: "",
            kind: "mind",
            folderId: "coast",
            createdAt: "2026-11-01T09:00:00.000Z",
            updatedAt: "2026-11-01T09:00:00.000Z",
          },
        ],
        mindBlocks: (_mindId, look) => look(blocks),
        editMind: (_mindId, change) => doc.transact(() => change(blocks)),
        show,
        say: (key, params) => translate(language, key, params),
        newId: () => `id-${++id}`,
      },
    );
    return { access, show, cite: `[cite:${kept.token}]` };
  }

  describe(`outside-agent Transcript Citation rechecks, ${language}`, () => {
    it.each(cases)("checkCitations preserves $name", async ({ location, check, label }) => {
      const { access, cite } = transcriptAccess(location);
      const result = await access.checkCitations({ text: `${quote} ${cite}` });
      expect(result.citations).toEqual([
        { cite, check, document: "Review", location: label, quote, changed: true },
      ]);
    });

    it.each(cases)("showCitation preserves $name", async ({ location, check, label }) => {
      const { access, show, cite } = transcriptAccess(location);
      expect(await access.showCitation({ cite })).toMatchObject({ shown: true, location: label });
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          quote,
          citation: expect.objectContaining({
            check,
            label,
            location: location ?? { kind: "time", from: 0, to: 2000, speaker: first },
          }),
        }),
      );
    });

    it.each(cases)("proposeChanges preserves $name", async ({ location, check, label }) => {
      const { access, cite } = transcriptAccess(location);
      const note = await access.readMind({ mindId: "review-note", named: true });
      if (!note.version) throw new Error("The named Note has no version.");
      const proposed = await access.proposeChanges({
        mindId: note.mindId,
        version: note.version,
        changes: [{ paragraph: "¶1+", text: `${quote} ${cite}` }],
      });
      expect(proposed.waiting).toBe(1);
      expect(proposed.citations).toEqual([
        { cite, check, document: "Review", location: label, quote, changed: true },
      ]);
    });
  });
}
