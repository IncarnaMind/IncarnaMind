/**
 * The core interface outside agents use (#351), on its own: how `ask` says
 * why IncarnaMind's Answer wasn't written. Local mode can come on between
 * the pairing's check and the chat model's, and then `ask` is paused like
 * every Tool, never "no chat model".
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import {
  type AgentAccessDeps,
  AgentRefusedError,
  createAgentAccess,
  createCheckRuns,
  MAX_CHECKS_AN_HOUR,
} from "../../src/core/agents/access";
import type { AgentCitation } from "../../src/core/agents/citations";
import type { OutsideAnswer } from "../../src/core/answers";
import { createElement } from "../../src/core/answers/blocks";
import type { OutsideCheck } from "../../src/core/answers/checks/mindCheck";
import { recheckCitation } from "../../src/core/answers/citations";
import { type CitationLocation, MIND_CONTENT_FIELD } from "../../src/core/api";
import { transcriptUnits } from "../../src/core/documents/formats/vtt";
import { translate } from "../../src/shared/i18n";
import { recordNoteWriter } from "../../src/shared/noteWriter";

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
    createMind: () => {
      throw new Error("Not called.");
    },
    notesWrittenSince: () => 0,
    answer: async () => outcome,
    checkNote: () => {
      throw new Error("Not called.");
    },
    checkRecord: async () => ({ models: [], sentences: [] }),
    checkRuns: createCheckRuns(),
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

/** An agent that may write, with one Note of its own in its Folder, whose Check `checkNote` runs. */
function accessChecking(
  checkNote: AgentAccessDeps["checkNote"],
  clock: () => number = () => 0,
  overrides: Partial<AgentAccessDeps> = {},
) {
  const doc = new Y.Doc();
  recordNoteWriter(doc, {
    source: "outside-agent",
    agent: "Codex",
    pairingId: "pairing",
    createdAt: "2026-11-01T09:00:00.000Z",
  });
  const mind = { id: "note", title: "Tide notes", folderId: "coast" };
  return accessAnswering(
    { asked: false, reason: "not-ready" },
    {
      admit: (pairingId) => ({ id: pairingId, name: "Codex", folderIds: ["coast"], propose: true }),
      minds: () => [mind] as ReturnType<AgentAccessDeps["minds"]>,
      mindBlocks: (_mindId, look) => look(doc.getXmlFragment(MIND_CONTENT_FIELD)),
      checkNote,
      checkWaitMs: 20,
      clock,
      ...overrides,
    },
  );
}

const CHECKED: OutsideCheck = {
  asked: true,
  result: { kind: "checked", sentences: 3, checked: 3, smallModel: false, stop: null },
};

describe("check_mind, on a Note the agent wrote (#3317)", () => {
  // protects=a long Note's check outlasts an agent's Tool time limit without a second check being started or paid for; fails_when=a call still waiting blocks past the bound, or a second call starts another check
  it("answers running while the check goes on, and a second call joins it", async () => {
    let finish: (outcome: OutsideCheck) => void = () => undefined;
    const checkNote = vi.fn(
      () =>
        new Promise<OutsideCheck>((resolve) => {
          finish = resolve;
        }),
    );
    const access = accessChecking(checkNote);
    expect(await access.checkMind({ mindId: "note" })).toMatchObject({ status: "running" });
    const second = access.checkMind({ mindId: "note" });
    finish(CHECKED);
    expect(await second).toMatchObject({ status: "checked", stopped: null });
    expect(checkNote).toHaveBeenCalledTimes(1);
    // Once it has ended, the next call starts a check of what changed since.
    await access.checkMind({ mindId: "note" });
    expect(checkNote).toHaveBeenCalledTimes(2);
  });

  // protects=an agent that stopped waiting still learns the User stopped the check, and doesn't start it again by asking; fails_when=a check that ended between two calls is forgotten and the next call runs a new one
  it("tells how a check ended to the call after it, once", async () => {
    let finish: (outcome: OutsideCheck) => void = () => undefined;
    const checkNote = vi.fn(
      () =>
        new Promise<OutsideCheck>((resolve) => {
          finish = resolve;
        }),
    );
    const access = accessChecking(checkNote);
    expect(await access.checkMind({ mindId: "note" })).toMatchObject({ status: "running" });
    finish({ asked: true, result: { kind: "cancelled" } });
    expect(await access.checkMind({ mindId: "note" })).toMatchObject({
      status: "stopped",
      stopped: "It was stopped in IncarnaMind before it finished.",
    });
    expect(checkNote).toHaveBeenCalledTimes(1);
    void access.checkMind({ mindId: "note" });
    expect(checkNote).toHaveBeenCalledTimes(2);
  });

  // protects=what the User took from an agent while a check ran isn't handed to it when the check ends, and a verdict from the User's own wider check says nothing of Documents the agent can't read; fails_when=the reply is built on the grant as it was before the wait, or lists a widened mark's verdict
  it("gives back only what the agent may read when the check ends", async () => {
    let admitted = 0;
    const gone = accessChecking(
      async () => CHECKED,
      () => 0,
      {
        admit: (pairingId) => {
          if (admitted++ > 0)
            throw new AgentRefusedError("unpaired", "This agent isn’t connected.");
          return { id: pairingId, name: "Codex", folderIds: ["coast"], propose: true };
        },
      },
    );
    await expect(gone.checkMind({ mindId: "note" })).rejects.toMatchObject({ problem: "unpaired" });

    const item = {
      kind: "sentence" as const,
      text: "Spring tides come twice a month.",
      origin: "other" as const,
      reason: null,
      says: "Rivers says so.",
      evidence: null,
      judgedOn: null,
    };
    const checkedAt = { model: null, at: "2026-11-01T09:00:00.000Z" };
    const wider = accessChecking(
      async () => CHECKED,
      () => 0,
      {
        checkRecord: async () => ({
          models: [],
          sentences: [
            {
              ...item,
              result: "supported",
              check: { ...checkedAt, scope: { folderId: "coast", widened: true } },
            },
            {
              ...item,
              result: "supported",
              check: { ...checkedAt, scope: { folderId: "coast", widened: false } },
            },
          ],
        }),
      },
    );
    expect(await wider.checkMind({ mindId: "note" })).toMatchObject({
      supported: 1,
      needLook: 1,
      claims: [
        {
          sentence: "Spring tides come twice a month.",
          result: "not-checked",
          reason: "beyond-reach",
          says: null,
          cite: null,
        },
      ],
    });
  });

  // protects=a check an agent starts never raises a dialog, and what stopped it is said in plain words; fails_when=a model not allowed yet is asked about, or a stop at the cap reads as a finished check
  it("says why nothing was sent, and why a check stopped early", async () => {
    const refusedWith = (outcome: OutsideCheck) =>
      accessChecking(async () => outcome).checkMind({ mindId: "note" });
    await expect(refusedWith({ asked: false, reason: "consent-needed" })).rejects.toMatchObject({
      problem: "chat-not-ready",
      message: /isn’t allowed to check yet/,
    });
    await expect(refusedWith({ asked: false, reason: "not-ready" })).rejects.toMatchObject({
      problem: "chat-not-ready",
    });
    await expect(refusedWith({ asked: false, reason: "local-mode" })).rejects.toMatchObject({
      problem: "local-mode",
    });
    await expect(
      refusedWith({ asked: true, result: { kind: "no-documents", folderId: "coast" } }),
    ).rejects.toMatchObject({ message: "The note’s Folder has no Documents to check it against." });
    await expect(refusedWith({ asked: false, reason: "no-documents" })).rejects.toMatchObject({
      message: "The note’s Folder has no Documents to check it against.",
    });
    await expect(refusedWith({ asked: false, reason: "beyond-reach" })).rejects.toMatchObject({
      problem: "outside-scope",
      message: /outside the Folders shared with this agent/,
    });
    expect(
      await refusedWith({
        asked: true,
        result: {
          kind: "checked",
          sentences: 3,
          checked: 1,
          smallModel: false,
          stop: { reason: "cost-cap" },
        },
      }),
    ).toMatchObject({
      status: "stopped",
      stopped: "It stopped at the monthly spending cap set in IncarnaMind.",
    });
    expect(await refusedWith({ asked: true, result: { kind: "cancelled" } })).toMatchObject({
      status: "stopped",
      stopped: "It was stopped in IncarnaMind before it finished.",
    });
  });

  // protects=a connected agent can't run the User's model without end; fails_when=more checks than the hour's limit are started
  it("starts no more checks in an hour than the limit, and again an hour on", async () => {
    let now = 0;
    const access = accessChecking(
      async () => CHECKED,
      () => now,
    );
    for (let started = 0; started < MAX_CHECKS_AN_HOUR; started++) {
      await access.checkMind({ mindId: "note" });
    }
    await expect(access.checkMind({ mindId: "note" })).rejects.toMatchObject({
      problem: "too-many",
      message: `This agent has started ${MAX_CHECKS_AN_HOUR} checks in the last hour, which is the most it may. Try again later.`,
    });
    now = 3_600_001;
    expect(await access.checkMind({ mindId: "note" })).toMatchObject({ status: "checked" });

    // A call that sent nothing, as while the window's own Check holds the Note, isn't counted.
    const waiting = accessChecking(async () => ({ asked: true, result: { kind: "running" } }));
    for (let asked = 0; asked <= MAX_CHECKS_AN_HOUR; asked++) {
      expect(await waiting.checkMind({ mindId: "note" })).toMatchObject({ status: "running" });
    }
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
