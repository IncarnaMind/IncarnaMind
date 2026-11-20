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
  MAX_CHECKED_CLAIMS,
  MAX_CHECKS_AN_HOUR,
} from "../../src/core/agents/access";
import type { AgentCitation } from "../../src/core/agents/citations";
import { createAgentWorkings } from "../../src/core/agents/workings";
import type { OutsideAnswer } from "../../src/core/answers";
import { createElement } from "../../src/core/answers/blocks";
import type { OutsideCheck } from "../../src/core/answers/checks/mindCheck";
import { recheckCitation } from "../../src/core/answers/citations";
import { type CitationLocation, MIND_CONTENT_FIELD } from "../../src/core/api";
import { transcriptUnits } from "../../src/core/documents/formats/vtt";
import { translate } from "../../src/shared/i18n";
import { recordNoteWriter } from "../../src/shared/noteWriter";

const AT = "2026-11-01T00:00:00.000Z";

function accessAnswering(outcome: OutsideAnswer, overrides: Partial<AgentAccessDeps> = {}) {
  const deps: AgentAccessDeps = {
    sorting: { list: vi.fn(), submit: vi.fn() },
    admit: (pairingId) => ({
      id: pairingId,
      name: "Codex",
      folderIds: ["coast"],
      createdAt: AT,
      propose: false,
    }),
    folders: () => [{ id: "coast", name: "Coast", parentId: null, keepInside: false }],
    wallOf: () => null,
    foldersInScope: (folderIds) => [...folderIds],
    foldersInside: (folderId) => [folderId],
    documentsIn: () => ["tides"],
    noteTranscripts: () => [],
    search: async () => [],
    passage: () => null,
    passagesBetween: () => [],
    citationSource: () => null,
    pageTexts: () => [],
    libraryLists: () => {
      throw new Error("Not called.");
    },
    libraryVersion: () => "",
    citing: { citeQuote: () => null, locate: () => null },
    notCited: () => false,
    recheck: () => {
      throw new Error("Not called.");
    },
    minds: () => [],
    documentsNamed: () => [],
    duplicatedFrom: () => null,
    liveDocuments: () => [],
    mindBlocks: () => {
      throw new Error("Not called.");
    },
    editMind: () => {
      throw new Error("Not called.");
    },
    editOwnMind: () => {
      throw new Error("Not called.");
    },
    checkpoint: () => undefined,
    noteChanged: () => undefined,
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
    checkTask: () => {
      throw new Error("Not called.");
    },
    landJudged: () => {
      throw new Error("Not called.");
    },
    checkRuns: createCheckRuns(),
    workings: createAgentWorkings(),
    versions: new Map(),
    citations: {
      find: () => null,
      mint: () => {
        throw new Error("Not called.");
      },
    },
    requests: { ofPairing: () => [], markRead: () => null },
    record: () => undefined,
    say: (key, params) => translate("en", key, params),
    language: () => "en",
    clock: () => 0,
    now: () => "2026-11-01T09:00:00.000Z",
    newId: () => "id",
    reportError: () => undefined,
    canvases: {
      list: () => [],
      get: () => null,
      version: () => {
        throw new Error("Not called.");
      },
      publish: () => {
        throw new Error("Not called.");
      },
      update: () => {
        throw new Error("Not called.");
      },
    },
    canvasChanged: () => undefined,
    doneSince: () => 0,
    handedAt: () => null,
    handOver: () => Promise.reject(new Error("No file is handed over here.")),
    handedCheck: () => Promise.reject(new Error("No file is handed over here.")),
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
      admit: (pairingId) => ({
        id: pairingId,
        name: "Codex",
        folderIds: ["coast"],
        createdAt: AT,
        propose: true,
      }),
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
          return {
            id: pairingId,
            name: "Codex",
            folderIds: ["coast"],
            createdAt: AT,
            propose: true,
          };
        },
      },
    );
    await expect(gone.checkMind({ mindId: "note" })).rejects.toMatchObject({ problem: "unpaired" });

    const item = {
      kind: "sentence" as const,
      text: "Spring tides come twice a month.",
      origin: "other" as const,
      reason: null,
      row: "supported" as const,
      says: "Rivers says so.",
      evidence: null,
      judgedOn: null,
      toCite: null,
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
              scope: { folderId: "coast", widened: true },
            },
            {
              ...item,
              result: "supported",
              check: { ...checkedAt, scope: { folderId: "coast", widened: false } },
              scope: { folderId: "coast", widened: false },
            },
          ],
        }),
      },
    );
    expect(await wider.checkMind({ mindId: "note" })).toMatchObject({
      supported: 1,
      needLook: 0,
      notChecked: 1,
      canBeCited: 0,
      claims: [
        {
          sentence: "Spring tides come twice a month.",
          group: "notChecked",
          result: "not-checked",
          reason: "beyond-reach",
          says: null,
          cite: null,
        },
      ],
    });
  });

  // protects=a sentence the check found to be the writer's own view is counted as one, never as supported and never as a claim that needs a look (#3322); fails_when=it is listed among the claims to fix or counted as supported
  it("counts the writer's own views apart, never as needing a look", async () => {
    const item = {
      kind: "sentence" as const,
      origin: "other" as const,
      reason: null,
      says: null,
      evidence: null,
      judgedOn: null,
      toCite: null,
      check: {
        model: null,
        at: "2026-11-18T09:00:00.000Z",
        scope: { folderId: "coast", widened: false },
      },
      scope: { folderId: "coast", widened: false },
    };
    const access = accessChecking(
      async () => CHECKED,
      () => 0,
      {
        checkRecord: async () => ({
          models: [],
          sentences: [
            {
              ...item,
              text: "Spring tides come twice a month.",
              result: "supported",
              row: "supported" as const,
            },
            {
              ...item,
              text: "We should survey at the spring tides.",
              result: "ownView",
              row: "ownViews" as const,
            },
            {
              ...item,
              text: "Neap tides are twice as strong.",
              result: "unsupported",
              row: "look" as const,
            },
          ],
        }),
      },
    );
    const checked = await access.checkMind({ mindId: "note" });
    expect(checked).toMatchObject({ supported: 1, needLook: 1, ownViews: 1 });
    expect(checked.claims.map((claim) => claim.sentence)).toEqual([
      "Neap tides are twice as strong.",
    ]);
  });

  // protects=each sentence of a checked Note is told in the group its row of the page's check card puts it in, with the words the page uses: Supported, not yet cited reads Supported and counts as one that can be cited, a supported sentence whose Citation isn't found is one that needs a look, and one counted in no row is told nowhere (#3453); fails_when=a group is counted from the check's verdict instead of the card's row, or a result the groups now list has no words
  it("tells each sentence in the group the page counts it in", async () => {
    const item = {
      kind: "sentence" as const,
      origin: "other" as const,
      says: null,
      evidence: null,
      judgedOn: null,
      toCite: null,
      check: {
        model: null,
        at: "2026-11-18T09:00:00.000Z",
        scope: { folderId: "coast", widened: false },
      },
      scope: { folderId: "coast", widened: false },
    };
    const access = accessChecking(
      async () => CHECKED,
      () => 0,
      {
        checkRecord: async () => ({
          models: [],
          sentences: [
            { ...item, text: "Cited.", result: "supported", reason: null, row: "supported" },
            { ...item, text: "Own view.", result: "ownView", reason: null, row: "ownViews" },
            {
              ...item,
              text: "Quote gone.",
              result: "supported",
              reason: null,
              row: "look",
            },
            {
              ...item,
              text: "Elsewhere.",
              result: "notChecked",
              reason: "found-elsewhere",
              row: "notYetCited",
            },
            {
              ...item,
              text: "Stopped.",
              result: "notChecked",
              reason: "rate-limit",
              row: "toCheck",
            },
            {
              ...item,
              text: "Conclusion.",
              result: "notChecked",
              reason: "assistant-conclusion",
              row: null,
            },
          ],
        }),
      },
    );
    const checked = await access.checkMind({ mindId: "note" });
    expect(checked).toMatchObject({
      supported: 1,
      needLook: 1,
      notChecked: 1,
      canBeCited: 1,
      ownViews: 1,
    });
    expect(
      checked.claims.map(({ sentence, group, result, reason }) => [
        sentence,
        group,
        result,
        reason,
      ]),
    ).toEqual([
      ["Quote gone.", "needLook", "citation-not-found", null],
      ["Stopped.", "notChecked", "not-checked", "rate-limit"],
      ["Elsewhere.", "canBeCited", "supported", null],
    ]);
  });

  // protects=a sentence the User's wider check left a mark on is told as not checked whatever row of the page's check card counts it in, also when the record keeps no check for it (a sentence with no verdict, as one found supported elsewhere or one the check couldn't read), so nothing of what a Document beyond the agent's Folders holds is passed on (#3453); fails_when=a row's sentence is told with its own result, reason, quote or cite, or counted outside not checked
  it("tells every sentence of a wider check as not checked, whatever row it is in", async () => {
    const item = {
      kind: "sentence" as const,
      origin: "other" as const,
      says: "Rivers says so.",
      evidence: {
        name: "Rivers",
        file: "Rivers.md",
        deleted: false,
        size: null,
        sha256: null,
        location: "§ Rivers",
        quote: "Gulls nest on the cliffs.",
      },
      judgedOn: null,
      toCite: null,
      check: null,
      scope: { folderId: "coast", widened: true },
    };
    const rows = [
      ["Elsewhere.", "notYetCited", "found-elsewhere"],
      ["Stopped.", "toCheck", "rate-limit"],
      ["Quote gone.", "look", "found-elsewhere"],
      ["Conclusion.", null, "assistant-conclusion"],
    ] as const;
    const access = accessChecking(
      async () => CHECKED,
      () => 0,
      {
        checkRecord: async () => ({
          models: [],
          sentences: rows.map(([text, row, reason]) => ({
            ...item,
            text,
            result: "notChecked" as const,
            reason,
            row,
          })),
        }),
      },
    );
    const checked = await access.checkMind({ mindId: "note" });
    expect(checked).toMatchObject({
      supported: 0,
      needLook: 0,
      notChecked: rows.length,
      canBeCited: 0,
      ownViews: 0,
    });
    expect(
      checked.claims.map(({ group, result, reason, says, document, quote, cite }) => [
        group,
        result,
        reason,
        says,
        document,
        quote,
        cite,
      ]),
    ).toEqual(
      rows.map(() => ["notChecked", "not-checked", "beyond-reach", null, null, null, null]),
    );
  });

  // protects=the claims an agent is given list what needs a look first, then what isn't checked, then what can be cited, each in the Note's order, so the cap on them never hides a sentence that needs a look behind sentences that can be cited (#3453); fails_when=claims keeps the Note's order across the groups, and a long Note's unsupported sentence is counted in needLook but not listed
  it("lists what needs a look before what can be cited, whatever the Note's order", async () => {
    const item = {
      kind: "sentence" as const,
      origin: "other" as const,
      reason: null,
      says: null,
      evidence: null,
      judgedOn: null,
      toCite: null,
      check: {
        model: null,
        at: "2026-11-18T09:00:00.000Z",
        scope: { folderId: "coast", widened: false },
      },
      scope: { folderId: "coast", widened: false },
    };
    const access = accessChecking(
      async () => CHECKED,
      () => 0,
      {
        checkRecord: async () => ({
          models: [],
          sentences: [
            ...Array.from({ length: MAX_CHECKED_CLAIMS + 1 }, (_, index) => ({
              ...item,
              text: `Uncited ${index + 1}.`,
              result: "supported" as const,
              row: "notYetCited" as const,
            })),
            { ...item, text: "Not found.", result: "unsupported" as const, row: "look" as const },
            {
              ...item,
              text: "Stopped.",
              result: "notChecked" as const,
              reason: "rate-limit" as const,
              row: "toCheck" as const,
            },
          ],
        }),
      },
    );
    const checked = await access.checkMind({ mindId: "note" });
    expect(checked).toMatchObject({
      needLook: 1,
      notChecked: 1,
      canBeCited: MAX_CHECKED_CLAIMS + 1,
    });
    expect(checked.claims).toHaveLength(MAX_CHECKED_CLAIMS);
    expect(checked.claims.slice(0, 3).map(({ sentence, group }) => [sentence, group])).toEqual([
      ["Not found.", "needLook"],
      ["Stopped.", "notChecked"],
      ["Uncited 1.", "canBeCited"],
    ]);
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
          createdAt: AT,
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
