import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ConversationAnswer,
  type MarkedCitation,
  type MarkedFigure,
  MIND_CONTENT_FIELD,
  type SearchScope,
  type UnreadFile,
} from "../../src/core/api";
import { messageReference } from "../../src/core/references";
import type { NoteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  checkedCaveat,
  noteStateOf,
  noteStateParts,
  noteStateUnreadWords,
  nothingLeft,
  readNoteState,
  unreadForCard,
} from "../../src/renderer/src/noteState";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { setOrigins } from "../../src/shared/blockOrigins";
import type { LiveDocument } from "../../src/shared/citations";
import { formatDateTime } from "../../src/shared/dates";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";
import { setMindScope } from "../../src/shared/mindScope";
import { checkUnreadOf, recordCheckUnread } from "../../src/shared/unreadFiles";

const CHECKED_AT = "2026-10-20T14:25:00.000Z";

const health = (parts: Partial<NoteHealth>): NoteHealth => ({
  found: [],
  notFound: [],
  lookClaims: [],
  lookNotFound: [],
  unsupported: [],
  contradicted: [],
  toCheck: [],
  failed: [],
  uncheckable: [],
  notRecalculated: [],
  recheck: [],
  edited: [],
  checking: [],
  kept: [],
  tableCells: [],
  noCitation: [],
  ownNotes: [],
  supportedAt: [],
  notYetCited: [],
  checkable: 0,
  supported: 0,
  checkedAt: null,
  unexamined: [],
  ...parts,
});

describe("A note's state (D266)", () => {
  test("is nothing when a check reads nothing", () => {
    expect(noteStateOf(health({}))).toBeNull();
    expect(noteStateOf(health({ kept: [0] }))).toBeNull();
  });

  test("is Not checked while a claim has no check", () => {
    const state = noteStateOf(health({ checkable: 2, toCheck: [0, 6] }));
    expect(state).toMatchObject({
      kind: "not-checked",
      look: 0,
      tone: "neutral",
      mark: "notChecked",
    });
  });

  test.each<[string, Partial<NoteHealth>, string]>([
    ["a check that failed", { failed: [0], toCheck: [0] }, "notChecked"],
    ["a check that no longer holds", { recheck: [0], toCheck: [0] }, "recheck"],
  ])("is Not checked after %s: nothing has checked it since its last edit", (_, parts, mark) => {
    expect(noteStateOf(health({ checkable: 1, ...parts }))).toMatchObject({
      kind: "not-checked",
      look: 0,
      tone: "neutral",
      mark,
    });
  });

  test("is needs-a-look with a contradiction, in red", () => {
    const state = noteStateOf(
      health({ checkable: 2, contradicted: [0], lookClaims: [0], checkedAt: CHECKED_AT }),
    );
    expect(state).toMatchObject({
      kind: "needs-look",
      look: 1,
      tone: "error",
      mark: "contradicted",
    });
  });

  test.each<[string, Partial<NoteHealth>, string]>([
    ["an unsupported claim", { unsupported: [0], lookClaims: [0] }, "unsupported"],
    ["a Citation not found", { notFound: [0], lookClaims: [0] }, "notFound"],
  ])("is needs-a-look, in amber, with %s", (_, parts, mark) => {
    expect(noteStateOf(health({ checkable: 1, ...parts }))).toMatchObject({
      kind: "needs-look",
      look: 1,
      tone: "warning",
      mark,
    });
  });

  test("counts every claim that needs a look in one number, from noteHealth (#1909)", () => {
    const state = noteStateOf(
      health({
        checkable: 6,
        contradicted: [0],
        unsupported: [6],
        notFound: [12],
        lookClaims: [0, 6, 12],
        lookNotFound: [12],
        failed: [18],
        toCheck: [18, 24],
        recheck: [24],
      }),
    );
    expect(state).toMatchObject({ kind: "needs-look", look: 3, tone: "error" });
  });

  test("is Checked once every claim holds, with the newest check's time and the files that couldn't be read", () => {
    const state = noteStateOf(health({ checkable: 2, found: [3], checkedAt: CHECKED_AT }), 3);
    expect(state).toEqual({
      kind: "checked",
      look: 0,
      tone: "success",
      mark: "checked",
      checkedAt: CHECKED_AT,
      unread: 3,
      unreadMatters: false,
      checkable: 2,
      cantCheck: 0,
      notRecalculated: 0,
      needsCheck: 0,
      notYetCited: 0,
    });
  });

  test("is never Checked while a check runs: a claim still checking is not done", () => {
    const state = noteStateOf(health({ checkable: 2, checking: [6], checkedAt: CHECKED_AT }));
    expect(state).toMatchObject({
      kind: "not-checked",
      look: 0,
      tone: "neutral",
      mark: "notChecked",
    });
  });

  test("stays amber, and names them, when the files it couldn't read could hold the evidence", () => {
    const state = noteStateOf(health({ checkable: 2, found: [3], checkedAt: CHECKED_AT }), 3, 3);
    expect(state).toMatchObject({
      kind: "needs-look",
      look: 0,
      tone: "warning",
      mark: "notChecked",
      unread: 3,
      unreadMatters: true,
    });
  });

  test("counts the card's list in an amber or Not checked state, though a wide search's stay out of the state's line", () => {
    const words = (state: Parameters<typeof noteStateParts>[0]) =>
      noteStateUnreadWords(state, (key, params) => translate("en", key, params), "en");
    const parts = (state: Parameters<typeof noteStateParts>[0]) =>
      noteStateParts(state, (key, params) => translate("en", key, params), "en");
    // A Contradicted claim whose check searched all Documents: the card names the file, so the Saved line counts it.
    const wide =
      noteStateOf(health({ checkable: 1, contradicted: [0], lookClaims: [0] }), 1) ?? fail();
    expect(wide).toMatchObject({ kind: "needs-look", unread: 1, unreadMatters: false });
    expect(words(wide)).toBe("1 file couldn’t be read");
    expect(parts(wide)).toEqual(["1 needs a look"]);
    // A narrow check's file keeps the amber line's count, as before.
    const narrow =
      noteStateOf(health({ checkable: 1, contradicted: [0], lookClaims: [0] }), 3, 1) ?? fail();
    expect(narrow).toMatchObject({ kind: "needs-look", unread: 1, unreadMatters: true });
    expect(words(narrow)).toBe("1 file couldn’t be read");
    // Not checked: the state's line says only that, and the card still names the files.
    const unchecked = noteStateOf(health({ checkable: 1, toCheck: [0] }), 2) ?? fail();
    expect(unchecked).toMatchObject({ kind: "not-checked", unread: 2, unreadMatters: false });
    expect(words(unchecked)).toBe("2 files couldn’t be read");
    expect(parts(unchecked)).toEqual(["Not checked"]);
  });

  test("a figure an Analysis gave that couldn't be worked out again leaves the Note Checked, naming it (#2378)", () => {
    const now = new Date("2026-10-20T18:00:00.000Z");
    const slope = health({
      checkable: 2,
      supported: 1,
      checkedAt: CHECKED_AT,
      toCheck: [9],
      failed: [9],
      notRecalculated: [9],
    });
    const state = noteStateOf(slope) ?? fail();
    expect(state).toMatchObject({ kind: "checked", tone: "success", notRecalculated: 1 });
    const words = (language: "en" | "zh-CN") =>
      noteStateParts(state, (key, params) => translate(language, key, params), language, now);
    expect(words("en").slice(1)).toEqual(["1 figure not recalculated"]);
    expect(words("zh-CN").slice(1)).toEqual(["1 个数字未重新计算"]);
    const two =
      noteStateOf(health({ ...slope, toCheck: [4, 9], failed: [4, 9], notRecalculated: [4, 9] })) ??
      fail();
    expect(
      noteStateParts(two, (key, params) => translate("en", key, params), "en", now).slice(1),
    ).toEqual(["2 figures not recalculated"]);
    // Only alone: a sentence a check could still settle keeps the Note Not checked.
    expect(noteStateOf(health({ ...slope, toCheck: [4, 9], failed: [4, 9] }))?.kind).toBe(
      "not-checked",
    );
    // Under 400 px the green line's short form names it, as the export's line does.
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    expect(checkedCaveat(state, t, String)).toBe("1 figure not recalculated");
    expect(nothingLeft(state)).toBe(false);
    expect(nothingLeft({ ...state, notRecalculated: 0 })).toBe(true);
  });

  test("✓ needs a verdict earned: a Note whose only figures weren't recalculated rests on them, with no ✓ and no amber", () => {
    const only = health({ checkable: 1, toCheck: [9], failed: [9], notRecalculated: [9] });
    const state = noteStateOf(only) ?? fail();
    expect(state).toMatchObject({ kind: "not-checked", tone: "neutral", notRecalculated: 1 });
    const words = (language: "en" | "zh-CN") =>
      noteStateParts(state, (key, params) => translate(language, key, params), language);
    expect(words("en")).toEqual(["1 figure not recalculated"]);
    expect(words("zh-CN")).toEqual(["1 个数字未重新计算"]);
  });

  test("says the words of each state in English and Chinese, the times from dates.ts", () => {
    const now = new Date("2026-10-20T18:00:00.000Z");
    const when = formatDateTime(CHECKED_AT, "en", { now });
    const en = (state: Parameters<typeof noteStateParts>[0]) =>
      noteStateParts(state, (key, params) => translate("en", key, params), "en", now).join(" · ");
    const zh = (state: Parameters<typeof noteStateParts>[0]) =>
      noteStateParts(state, (key, params) => translate("zh-CN", key, params), "zh-CN", now).join(
        " · ",
      );
    const fresh = noteStateOf(health({ checkable: 1, toCheck: [0] })) ?? fail();
    const one = noteStateOf(health({ checkable: 1, contradicted: [0], lookClaims: [0] })) ?? fail();
    const two =
      noteStateOf(health({ checkable: 2, unsupported: [0, 6], lookClaims: [0, 6] })) ?? fail();
    const done = noteStateOf(health({ checkable: 1, checkedAt: CHECKED_AT }), 3) ?? fail();
    expect(en(fresh)).toBe("Not checked");
    expect(zh(fresh)).toBe("未核对");
    expect(en(one)).toBe("1 needs a look");
    expect(zh(one)).toBe("需要留意 1 处");
    expect(en(two)).toBe("2 need a look");
    expect(zh(two)).toBe("需要留意 2 处");
    expect(en(done)).toBe(`Checked ${when} · 3 files couldn’t be read`);
    expect(zh(done)).toBe(
      `已核对 ${formatDateTime(CHECKED_AT, "zh-CN", { now })} · 3 个文件未能读取`,
    );
    const unread = noteStateOf(health({ checkable: 1, checkedAt: CHECKED_AT }), 3, 3) ?? fail();
    expect(en(unread)).toBe("3 files couldn’t be read");
    expect(zh(unread)).toBe("3 个文件未能读取");
  });
});

function fail(): never {
  throw new Error("The state is null.");
}

const schema = getSchema(noteExtensions());
const paragraph = (content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function checked(
  sentence: string,
  state: ClaimCheckAttributes["state"],
  more: Partial<ClaimCheckAttributes> = {},
): JSONContent {
  const check: ClaimCheckAttributes = {
    id: `check-${sentence.length}-${state}`,
    request: "r1",
    action: "check-against-documents",
    state,
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text: sentence,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: CHECKED_AT,
    ...more,
  };
  return { type: "text", text: sentence, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] };
}

function source(content: JSONContent[]): Y.Doc {
  const doc = new Y.Doc();
  const root = schema.nodeFromJSON({ type: "doc", content });
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(MIND_CONTENT_FIELD));
  return doc;
}

const read = (doc: Y.Doc) =>
  readNoteState({
    footing: [],
    cellFigures: [],
    doc,
    documents: [],
    keptCitationTexts: [],
    folderId: null,
  });

const unreadFile = (name: string): UnreadFile => ({
  id: name,
  name,
  reason: "password",
  extension: null,
  documentId: null,
  pages: [],
});

describe("Reading a note's state from its Yjs document (Home and Export)", () => {
  test("reads what the badge reads: a fresh claim leaves it Not checked", () => {
    const doc = source([
      paragraph([{ type: "text", text: "Spring tides happen at new and full moon." }]),
      paragraph([checked("Neap tides happen twice a month.", "supported")]),
    ]);
    const { health: readHealth, state } = read(doc);
    expect(readHealth.toCheck).toHaveLength(1);
    expect(state).toMatchObject({ kind: "not-checked", checkable: 2 });
    doc.destroy();
  });

  test("is Checked with every claim covered, naming the files the check couldn't read (D261)", () => {
    const doc = source([
      paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
    ]);
    recordCheckUnread(
      doc,
      "r1",
      [
        {
          id: "a",
          name: "Locked.pdf",
          reason: "password",
          extension: null,
          documentId: null,
          pages: [],
        },
        { id: "b", name: "Scan.pdf", reason: "scan", extension: null, documentId: null, pages: [] },
      ],
      new Set(["r1"]),
    );
    const { state } = read(doc);
    expect(state).toMatchObject({ kind: "checked", checkedAt: CHECKED_AT, unread: 2 });
    doc.destroy();
  });

  test("is needs-a-look with an unsupported claim, after the check's time", () => {
    const doc = source([paragraph([checked("Penguins nest on the cliffs.", "unsupported")])]);
    const { state } = read(doc);
    expect(state).toMatchObject({ kind: "needs-look", look: 1, tone: "warning" });
    doc.destroy();
  });

  test("is Not checked while a check its document holds is still running", () => {
    const doc = source([
      paragraph([checked("Spring tides happen at new and full moon.", "checking")]),
    ]);
    const { health: readHealth, state } = read(doc);
    expect(readHealth.checking).toHaveLength(1);
    expect(state).toMatchObject({ kind: "not-checked", mark: "notChecked" });
    doc.destroy();
  });

  // protects=#2313: a Note whose only sentence left is one a re-run cannot settle — its Citation is kept inside another Folder — reads Checked and names it, in English and Chinese; fails_when=the whole Note reads Not checked, the line leaves the sentence out, or a retryable failure turns it green; no_claim=the card's row that moves to it.
  test("is Checked with a sentence a re-run cannot settle named, in English and Chinese", () => {
    const sentences = [
      paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
      paragraph([
        checked("Harbours publish the times of high water every week.", "not-checked", {
          reason: "kept-inside",
          detail: "Other Folder",
        }),
      ]),
    ];
    for (const [language, said] of [
      ["en", "Checked"],
      ["zh-CN", "已核对"],
    ] as const) {
      const doc = source(sentences);
      const { health: readHealth, state } = read(doc);
      expect(readHealth.uncheckable).toHaveLength(1);
      expect(state).toMatchObject({ kind: "checked", cantCheck: 1, needsCheck: 0 });
      const when = formatDateTime(CHECKED_AT, language);
      const parts = noteStateParts(
        state ?? fail(),
        (key, params) => translate(language, key, params),
        language,
      );
      expect(parts).toEqual([
        `${said} ${when}`,
        language === "en" ? "1 sentence can’t be checked" : "1 句无法核对",
      ]);
      doc.destroy();
    }
    // A retryable failure — a provider error, a rate limit, a cap — could be settled next time, and
    // an edit does not upgrade one: Not checked.
    for (const reason of ["failed", "rate-limit", "cost-cap", "no-evidence"] as const) {
      const held = source([
        paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
        paragraph([
          checked("Harbours publish the times of high water every week.", "not-checked", {
            reason,
          }),
        ]),
      ]);
      expect(read(held).health.uncheckable).toHaveLength(0);
      expect(read(held).state).toMatchObject({ kind: "not-checked" });
      held.destroy();
    }
    // A file a narrow check couldn't read could hold the evidence: the unread reading wins.
    const narrow = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          scope: { folderId: "tides", widened: false },
        }),
      ]),
      paragraph([
        checked("Harbours publish the times of high water every week.", "not-checked", {
          reason: "kept-inside",
          detail: "Other Folder",
          scope: { folderId: "tides", widened: false },
        }),
      ]),
    ]);
    recordCheckUnread(narrow, "r1", [unreadFile("Locked.pdf")], new Set(["r1"]));
    expect(
      readNoteState({
        footing: [],
        cellFigures: [],
        doc: narrow,
        documents: [],
        keptCitationTexts: [],
        folderId: "tides",
      }).state,
    ).toMatchObject({
      kind: "needs-look",
      tone: "warning",
      unreadMatters: true,
      cantCheck: 0,
    });
    narrow.destroy();
  });

  // protects=#2313: through the editor's own mark (every attribute set, an unread Document list as []), a quoted result holds after a Folder move and an Unsupported re-checks; fails_when=the empty list reads as a whole-Folder check, or an Unsupported is kept in a Folder never read.
  test("a quoted result holds after a Folder move through the editor's mark, and an Unsupported re-checks", () => {
    const quote = {
      passageId: "p1",
      documentId: "d1",
      documentName: "Tides.md",
      contentHash: "h1",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Spring tides happen at new moon and at full moon.",
      check: "found" as const,
      checkReason: null,
    };
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          evidence: quote,
          versions: [{ documentId: "d1", contentHash: "h1" }],
          scope: { folderId: "folder-a", widened: false },
        }),
      ]),
      paragraph([
        checked("Penguins nest on the cliffs above the harbour.", "unsupported", {
          unsupported: { reason: null, covered: null, uncovered: null, found: true },
          scope: { folderId: "folder-a", widened: false },
        }),
      ]),
    ]);
    const { health: readHealth, state } = readNoteState({
      footing: [],
      cellFigures: [],
      doc,
      documents: [{ id: "d1", contentHash: "h1" }],
      keptCitationTexts: [],
      folderId: "folder-b",
    });
    expect(readHealth.supported).toBe(1);
    expect(readHealth.toCheck).toHaveLength(1);
    expect(state).toMatchObject({ kind: "not-checked" });
    doc.destroy();
  });

  // protects=#2313: an edit of a sentence whose Document changed since does not become the green's caveat; fails_when=an edited-and-superseded check counts as one a re-run would settle, so the Note reads Checked.
  test("an edit beside a Document's new version keeps the Note Not checked", () => {
    const quote = {
      passageId: "p1",
      documentId: "d1",
      documentName: "Tides.md",
      contentHash: "old",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Spring tides happen at new moon and at full moon.",
      check: "found" as const,
      checkReason: null,
    };
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          evidence: quote,
          versions: [{ documentId: "d1", contentHash: "old" }],
          scope: { folderId: "folder-a", widened: false },
        }),
      ]),
      paragraph([
        checked("Harbours publish the times of high water every week.", "supported", {
          evidence: quote,
          text: "Harbours publish the times of high water every year.",
          versions: [{ documentId: "d1", contentHash: "old" }],
          scope: { folderId: "folder-a", widened: false },
        }),
      ]),
    ]);
    const { health: readHealth, state } = readNoteState({
      footing: [],
      cellFigures: [],
      doc,
      documents: [{ id: "d1", contentHash: "new" }],
      keptCitationTexts: [],
      folderId: "folder-a",
    });
    expect(readHealth.edited).toHaveLength(0);
    expect(state).toMatchObject({ kind: "not-checked" });
    doc.destroy();
  });

  // protects=#2313: a sentence a change made need a check leaves the Note Checked, naming it, while a sentence whose check never ran stays Not checked after an edit; fails_when=the pill turns the whole Note back while other claims keep their checks, or an edit upgrades one that never ran; no_claim=the run that checks it.
  test("is Checked while a changed sentence needs a check, naming it, in English and Chinese", () => {
    const sentences = [
      paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
      paragraph([
        checked("Harbours publish the times of high water every week.", "supported", {
          text: "Harbours publish the times of high water every year.",
        }),
      ]),
    ];
    for (const [language, said] of [
      ["en", "Checked"],
      ["zh-CN", "已核对"],
    ] as const) {
      const doc = source(sentences);
      const { health: readHealth, state } = read(doc);
      expect(readHealth.recheck).toHaveLength(1);
      expect(state).toMatchObject({ kind: "checked", cantCheck: 0, needsCheck: 1 });
      const when = formatDateTime(CHECKED_AT, language);
      const parts = noteStateParts(
        state ?? fail(),
        (key, params) => translate(language, key, params),
        language,
      );
      expect(parts).toEqual([
        `${said} ${when}`,
        language === "en" ? "1 sentence needs a check" : "1 句待核对",
      ]);
      doc.destroy();
    }
    // A claim no check ever read keeps the Note Not checked, as before.
    const fresh = source([
      paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
      paragraph([{ type: "text", text: "Harbours publish the times of high water every week." }]),
    ]);
    expect(read(fresh).state).toMatchObject({ kind: "not-checked" });
    fresh.destroy();
    // Nor does an edit upgrade a check that never ran: it still reads Not checked.
    for (const reason of ["cost-cap", "rate-limit", "stopped", "too-many", "failed"] as const) {
      const neverRan = source([
        paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
        paragraph([
          checked("Harbours publish the times of high water every week.", "not-checked", {
            reason,
            text: "Harbours publish the times of high water every year.",
          }),
        ]),
      ]);
      expect(read(neverRan).state).toMatchObject({ kind: "not-checked" });
      neverRan.destroy();
    }
  });

  test("stays amber when the note's Folder was searched and a file in it couldn't be read (D261)", () => {
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          scope: { folderId: "tides", widened: false },
        }),
      ]),
    ]);
    recordCheckUnread(
      doc,
      "r1",
      [
        {
          id: "a",
          name: "Locked.pdf",
          reason: "password",
          extension: null,
          documentId: null,
          pages: [],
        },
      ],
      new Set(["r1"]),
    );
    const { state } = readNoteState({
      footing: [],
      cellFigures: [],
      doc,
      documents: [],
      keptCitationTexts: [],
      folderId: "tides",
    });
    expect(state).toMatchObject({
      kind: "needs-look",
      look: 0,
      tone: "warning",
      unread: 1,
      unreadMatters: true,
    });
    doc.destroy();
  });

  test("stays amber when a Tag was searched and a file it couldn't read could hold the evidence (D266)", () => {
    const scope: SearchScope = { folderIds: [], tagIds: ["tag-tides"], documentIds: [] };
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          scope: { folderId: null, widened: false, chosen: scope },
        }),
      ]),
    ]);
    setMindScope(doc, scope);
    recordCheckUnread(
      doc,
      "r1",
      [
        {
          id: "a",
          name: "Locked.pdf",
          reason: "password",
          extension: null,
          documentId: null,
          pages: [],
        },
      ],
      new Set(["r1"]),
    );
    const { state } = readNoteState({
      footing: [],
      cellFigures: [],
      doc,
      documents: [],
      keptCitationTexts: [],
      folderId: null,
    });
    expect(state).toMatchObject({
      kind: "needs-look",
      look: 0,
      tone: "warning",
      unread: 1,
      unreadMatters: true,
    });
    const words = (language: "en" | "zh-CN") =>
      noteStateParts(state ?? fail(), (key, params) => translate(language, key, params), language);
    expect(words("en")).toEqual(["1 file couldn’t be read"]);
    expect(words("zh-CN")).toEqual(["1 个文件未能读取"]);
    doc.destroy();
  });

  test("stays amber when Documents the User picked were searched and one couldn't be read (D266)", () => {
    const scope: SearchScope = { folderIds: [], tagIds: [], documentIds: ["doc-tides"] };
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          scope: { folderId: null, widened: false, chosen: scope },
        }),
      ]),
    ]);
    setMindScope(doc, scope);
    recordCheckUnread(
      doc,
      "r1",
      [
        {
          id: "a",
          name: "Locked.pdf",
          reason: "password",
          extension: null,
          documentId: null,
          pages: [],
        },
      ],
      new Set(["r1"]),
    );
    const { state } = readNoteState({
      footing: [],
      cellFigures: [],
      doc,
      documents: [],
      keptCitationTexts: [],
      folderId: null,
    });
    expect(state).toMatchObject({
      kind: "needs-look",
      look: 0,
      tone: "warning",
      unread: 1,
      unreadMatters: true,
    });
    const words = (language: "en" | "zh-CN") =>
      noteStateParts(state ?? fail(), (key, params) => translate(language, key, params), language);
    expect(words("en")).toEqual(["1 file couldn’t be read"]);
    expect(words("zh-CN")).toEqual(["1 个文件未能读取"]);
    doc.destroy();
  });

  test("the Saved line counts what the card names for a Contradicted claim that searched all Documents, and when the Note is Not checked", () => {
    const words = (state: Parameters<typeof noteStateUnreadWords>[0]) =>
      noteStateUnreadWords(state, (key, params) => translate("en", key, params), "en");
    const wide = source([
      paragraph([
        checked("Penguins nest on the cliffs above the harbour.", "contradicted", {
          scope: { folderId: null, widened: true },
        }),
      ]),
    ]);
    recordCheckUnread(wide, "r1", [unreadFile("Locked.pdf")], new Set(["r1"]));
    const contradicted = read(wide).state;
    expect(contradicted).toMatchObject({ kind: "needs-look", unread: 1, unreadMatters: false });
    expect(words(contradicted ?? fail())).toBe("1 file couldn’t be read");
    expect(
      unreadForCard(checkUnreadOf(wide, ["r1"]), [], contradicted).map((file) => file.name),
    ).toEqual(["Locked.pdf"]);
    wide.destroy();

    const stale = source([
      paragraph([checked("Penguins nest on the cliffs.", "not-checked", { reason: "failed" })]),
    ]);
    recordCheckUnread(stale, "r1", [unreadFile("Locked.pdf")], new Set(["r1"]));
    const unchecked = read(stale).state;
    expect(unchecked).toMatchObject({ kind: "not-checked", unread: 1, unreadMatters: false });
    expect(words(unchecked ?? fail())).toBe("1 file couldn’t be read");
    expect(
      unreadForCard(checkUnreadOf(stale, ["r1"]), [], unchecked).map((file) => file.name),
    ).toEqual(["Locked.pdf"]);
    stale.destroy();
  });

  test("a file only a wide search couldn't read stays out of the amber card line; the Folder claim's own names only itself (D266)", () => {
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          id: "folder-check",
          scope: { folderId: "tides", widened: false },
        }),
      ]),
      paragraph([
        checked("Neap tides happen twice a month as well.", "supported", {
          id: "wide-check",
          request: "r2",
          scope: { folderId: null, widened: true },
        }),
      ]),
    ]);
    const requests = ["r1", "r2"];
    const readFolder = () =>
      readNoteState({
        footing: [],
        cellFigures: [],
        doc,
        documents: [],
        keptCitationTexts: [],
        folderId: "tides",
      }).state;
    recordCheckUnread(
      doc,
      "r2",
      [unreadFile("Outside.pdf"), unreadFile("Missing.pdf")],
      new Set(requests),
    );
    const green = readFolder();
    expect(green).toMatchObject({ kind: "checked", unread: 2, unreadMatters: false });
    // A green Note's card lists every file its checks couldn't read (D261).
    expect(
      unreadForCard(checkUnreadOf(doc, requests), checkUnreadOf(doc, ["r1"]), green).map(
        (file) => file.name,
      ),
    ).toEqual(["Outside.pdf", "Missing.pdf"]);
    // Locked.pdf is in the Folder claim's own search: the badge and the card name only it.
    recordCheckUnread(doc, "r1", [unreadFile("Locked.pdf")], new Set(requests));
    const amber = readFolder();
    expect(amber).toMatchObject({ kind: "needs-look", look: 0, unread: 1, unreadMatters: true });
    const all = checkUnreadOf(doc, requests);
    const narrow = checkUnreadOf(doc, ["r1"]);
    expect(all.map((file) => file.name)).toEqual(["Locked.pdf", "Outside.pdf", "Missing.pdf"]);
    expect(narrow.map((file) => file.name)).toEqual(["Locked.pdf"]);
    expect(unreadForCard(all, narrow, amber).map((file) => file.name)).toEqual(["Locked.pdf"]);
    expect(
      noteStateParts(amber ?? fail(), (key, params) => translate("en", key, params), "en"),
    ).toEqual(["1 file couldn’t be read"]);
    expect(
      noteStateParts(amber ?? fail(), (key, params) => translate("zh-CN", key, params), "zh-CN"),
    ).toEqual(["1 个文件未能读取"]);
    doc.destroy();
  });

  test("a file only a wide search couldn't read stays out of the amber card line; the Tag claim's own names only itself (D266)", () => {
    const tagScope: SearchScope = { folderIds: [], tagIds: ["tag-tides"], documentIds: [] };
    const doc = source([
      paragraph([
        checked("Spring tides happen at new and full moon.", "supported", {
          id: "tag-check",
          scope: { folderId: null, widened: false, chosen: tagScope },
        }),
      ]),
      paragraph([
        checked("Neap tides happen twice a month as well.", "supported", {
          id: "wide-check",
          request: "r2",
          scope: { folderId: null, widened: true },
        }),
      ]),
    ]);
    setMindScope(doc, tagScope);
    const requests = ["r1", "r2"];
    const readTag = () =>
      readNoteState({
        footing: [],
        cellFigures: [],
        doc,
        documents: [],
        keptCitationTexts: [],
        folderId: null,
      }).state;
    recordCheckUnread(
      doc,
      "r2",
      [unreadFile("Outside.pdf"), unreadFile("Missing.pdf")],
      new Set(requests),
    );
    const green = readTag();
    expect(green).toMatchObject({ kind: "checked", unread: 2, unreadMatters: false });
    expect(
      unreadForCard(checkUnreadOf(doc, requests), checkUnreadOf(doc, ["r1"]), green).map(
        (file) => file.name,
      ),
    ).toEqual(["Outside.pdf", "Missing.pdf"]);
    recordCheckUnread(doc, "r1", [unreadFile("Locked.pdf")], new Set(requests));
    const amber = readTag();
    expect(amber).toMatchObject({ kind: "needs-look", look: 0, unread: 1, unreadMatters: true });
    const all = checkUnreadOf(doc, requests);
    const narrow = checkUnreadOf(doc, ["r1"]);
    expect(all.map((file) => file.name)).toEqual(["Locked.pdf", "Outside.pdf", "Missing.pdf"]);
    expect(narrow.map((file) => file.name)).toEqual(["Locked.pdf"]);
    expect(unreadForCard(all, narrow, amber).map((file) => file.name)).toEqual(["Locked.pdf"]);
    expect(
      noteStateParts(amber ?? fail(), (key, params) => translate("en", key, params), "en"),
    ).toEqual(["1 file couldn’t be read"]);
    expect(
      noteStateParts(amber ?? fail(), (key, params) => translate("zh-CN", key, params), "zh-CN"),
    ).toEqual(["1 个文件未能读取"]);
    doc.destroy();
  });

  test("stays green with the count when all Documents were searched, so an unread file may hold nothing (D266)", () => {
    const doc = source([
      paragraph([checked("Spring tides happen at new and full moon.", "supported")]),
    ]);
    recordCheckUnread(
      doc,
      "r1",
      [
        {
          id: "a",
          name: "Locked.pdf",
          reason: "password",
          extension: null,
          documentId: null,
          pages: [],
        },
      ],
      new Set(["r1"]),
    );
    const { state } = read(doc);
    expect(state).toMatchObject({ kind: "checked", unread: 1, unreadMatters: false });
    doc.destroy();
  });

  test("the Saved line's words for unread files are singular, plural, and nothing when none", () => {
    const checked = (unread: number) =>
      noteStateOf(health({ checkable: 2, supported: 2, checkedAt: CHECKED_AT }), unread);
    const words = (language: "en" | "zh-CN", unread: number) =>
      noteStateUnreadWords(
        checked(unread) ?? fail(),
        (key, params) => translate(language, key, params),
        language,
      );
    expect(words("en", 1)).toBe("1 file couldn’t be read");
    expect(words("en", 3)).toBe("3 files couldn’t be read");
    expect(words("zh-CN", 1)).toBe("1 个文件未能读取");
    expect(words("zh-CN", 3)).toBe("3 个文件未能读取");
    expect(words("en", 0)).toBeNull();
    expect(words("zh-CN", 0)).toBeNull();
  });

  test("names the Answers its live Blocks hold, not one whose Block was deleted since", () => {
    const doc = source([
      {
        type: "paragraph",
        attrs: { id: "live" },
        content: [checked("Spring tides happen at new and full moon.", "supported")],
      },
    ]);
    setOrigins(doc, ["live", "deleted"], {
      from: messageReference("conversation", "answer-in-the-note"),
      question: "How do tides work?",
    });
    setOrigins(doc, ["deleted-elsewhere"], {
      from: messageReference("conversation", "answer-no-longer-in-the-note"),
      question: "How do tides work?",
    });
    expect(read(doc).filedAnswers).toEqual(new Set(["answer-in-the-note"]));
    doc.destroy();
  });
});

describe("A Note made from an Answer carries its judgement (#2313)", () => {
  const sentence = "The launch is on the eighteenth of November.";
  const citation: MarkedCitation = {
    marker: 1,
    passageId: "passage-1",
    documentId: "plan",
    documentName: "Plan.pdf",
    contentHash: "hash-1",
    pageFrom: 2,
    pageTo: 2,
    location: null,
    quote: sentence,
    check: "found",
    checkReason: null,
  };
  const judged: MarkedCitation = { ...citation, judgedAt: CHECKED_AT };
  const plan: LiveDocument = { id: "plan", contentHash: "hash-1", name: "Plan.pdf" };
  const costsSheet: LiveDocument = { id: "costs", contentHash: "hash-2", name: "Costs.pdf" };
  const costs: MarkedCitation = {
    ...citation,
    marker: 2,
    passageId: "passage-2",
    documentId: "costs",
    documentName: "Costs.pdf",
    contentHash: "hash-2",
  };
  const answerOf = (
    id: string,
    text: string,
    citations: MarkedCitation[],
    figures: MarkedFigure[] = [],
  ): Pick<ConversationAnswer, "id" | "text" | "citations" | "figures" | "status" | "model"> => ({
    id,
    text,
    citations,
    figures,
    status: "done",
    model: { providerId: "provider", modelId: "model" },
  });
  const answer = (citations: MarkedCitation[]) =>
    answerOf("answer-1", `${sentence} [^1]`, citations);
  const carried = (
    made: ReturnType<typeof answerOf>,
    blocks: readonly NodeJSON[] = pageBlocks(made, ""),
    scope: SearchScope | null = null,
  ): JSONContent[] => withAnswerChecks(blocks, made, "", scope);
  const blocksOf = (citations: MarkedCitation[], scope: SearchScope | null = null) =>
    carried(answer(citations), undefined, scope);
  const noteOf = (blocks: JSONContent[], documents: LiveDocument[] = [plan]) =>
    readNoteState({
      footing: [],
      cellFigures: [],
      doc: source(blocks),
      documents,
      keptCitationTexts: [],
      folderId: null,
    });
  const carriedMarks = (blocks: readonly JSONContent[]) => {
    const marks: Record<string, unknown>[] = [];
    const collect = (nodes: readonly JSONContent[]) =>
      nodes.forEach((node) => {
        for (const mark of node.marks ?? []) {
          if (mark.type === CLAIM_CHECK_MARK) marks.push(mark.attrs as Record<string, unknown>);
        }
        collect(node.content ?? []);
      });
    collect(blocks);
    return marks;
  };

  test("a judged supported sentence makes its Note Checked, at the judgement's time", () => {
    const state = noteOf(blocksOf([judged])).state;
    expect(state).toMatchObject({ kind: "checked", checkedAt: CHECKED_AT, look: 0 });
  });

  test("a quote check alone is no judgement: its Note stays Not checked", () => {
    const state = noteOf(blocksOf([citation])).state;
    expect(state).toMatchObject({ kind: "not-checked", look: 0 });
  });

  test("a judged unsupported sentence makes its Note need a look, never Checked", () => {
    const state = noteOf(
      blocksOf([{ ...judged, check: "unsupported", verdict: "The plan says December." }]),
    ).state;
    expect(state).toMatchObject({ kind: "needs-look", look: 1 });
  });

  test("a Folder-scoped Answer's check names that Folder; a library-wide one says so; both name the Answer", () => {
    const scope = { folderIds: ["folder-a"], tagIds: [], documentIds: [] };
    expect(carriedMarks(blocksOf([judged], scope))[0]).toMatchObject({
      scope: { folderId: "folder-a", widened: false, chosen: scope },
      fromAnswer: "answer-1",
    });
    expect(carriedMarks(blocksOf([judged]))[0]).toMatchObject({
      scope: { folderId: null, widened: true },
    });
  });

  test("a Citation's own attributes, its verdict among them, reach the Note's copy", () => {
    const made = answerOf("answer-verdict", `${sentence} [^1]`, [
      { ...judged, check: "unsupported", verdict: "The plan says December." },
    ]);
    const nodes: JSONContent[] = pageBlocks(made, "");
    const citations: Record<string, unknown>[] = [];
    const collect = (list: readonly JSONContent[]) =>
      list.forEach((node) => {
        if (node.type === "citation") citations.push(node.attrs as Record<string, unknown>);
        collect(node.content ?? []);
      });
    collect(nodes);
    expect(citations[0]).toMatchObject({
      check: "unsupported",
      verdict: "The plan says December.",
    });
    expect(citations[0]).not.toHaveProperty("judgedAt");
  });

  test("the same words, quotes and version, judged differently, carry nothing: no one can say which sentence it is", () => {
    const unsupported: MarkedCitation = {
      ...judged,
      marker: 2,
      check: "unsupported",
      verdict: "The plan says December.",
    };
    const made = answerOf("answer-ambiguous", `${sentence} [^1]\n\n${sentence} [^2]`, [
      judged,
      unsupported,
    ]);
    expect(carriedMarks(carried(made))).toHaveLength(0);
  });

  test("the same words, quotes and version, judged once and stopped before the other, carry nothing: a copy of either reads Not checked", () => {
    // The Answer's limit stopped the judgement between two sentences that read alike.
    const stopped: MarkedCitation = {
      ...citation,
      marker: 2,
      check: "not-checked",
      checkReason: "answer-limit",
    };
    const made = answerOf("answer-stopped", `${sentence} [^1]\n\n${sentence} [^2]`, [
      judged,
      stopped,
    ]);
    const full = pageBlocks(made, "");
    for (const blocks of [full, full.slice(-1), full.slice(0, 1)]) {
      const note = carried(made, blocks);
      expect(carriedMarks(note)).toHaveLength(0);
      expect(noteOf(note).state).toMatchObject({ kind: "not-checked" });
    }
  });

  test("a marker with no Citation carries nothing", () => {
    expect(
      carriedMarks(carried(answerOf("answer-dead-marker", `${sentence} [^1]`, []))),
    ).toHaveLength(0);
  });

  test("a negative judgement wins over a supported one in the same sentence", () => {
    const made = answerOf("answer-negative", `${sentence} [^1][^2]`, [
      judged,
      { ...costs, check: "unsupported", judgedAt: CHECKED_AT, verdict: "The costs sheet says 8%." },
    ]);
    expect(carriedMarks(carried(made))[0]).toMatchObject({ state: "unsupported" });
  });

  test("a marker before its full stop still carries: the common model style", () => {
    const made = answerOf("answer-marker-first", "Revenue rose 10% [^1].", [judged]);
    expect(noteOf(carried(made)).state).toMatchObject({ kind: "checked" });
  });

  test("a selection of a repeated sentence takes its own Citation's verdict, never the first one's", () => {
    // The same Passage and version, quoting different words: only the quote tells them apart.
    const quotedCosts: MarkedCitation = {
      ...judged,
      marker: 2,
      quote: "The costs sheet says 8%.",
      check: "unsupported",
      verdict: "The costs sheet says 8%.",
    };
    const made = answerOf("answer-repeated", `${sentence} [^1]\n\n${sentence} [^2]`, [
      judged,
      quotedCosts,
    ]);
    const note = carried(made, pageBlocks(made, "").slice(-1));
    expect(noteOf(note, [plan, costsSheet]).state).toMatchObject({ kind: "needs-look" });
  });

  test("a Document changed after the judgement asks again", () => {
    const made = answerOf("answer-two-documents", `${sentence} [^1][^2]`, [
      judged,
      { ...costs, judgedAt: CHECKED_AT },
    ]);
    const changed: LiveDocument = { ...costsSheet, contentHash: "hash-changed" };
    expect(noteOf(carried(made), [plan, changed]).state).toMatchObject({ kind: "not-checked" });
  });

  test("a Document the judgement relied on, gone from the Library, asks again; with it there, the Note reads Checked", () => {
    const made = answerOf("answer-removed-document", `${sentence} [^1][^2]`, [
      judged,
      { ...costs, judgedAt: CHECKED_AT },
    ]);
    const note = carried(made);
    expect(noteOf(note, [plan, costsSheet]).state).toMatchObject({ kind: "checked" });
    expect(noteOf(note, [plan]).state).toMatchObject({ kind: "not-checked" });
  });

  test("an old version of a Document cited beside its current one asks again; both current, the Note reads Checked", () => {
    const current: MarkedCitation = {
      ...judged,
      marker: 2,
      passageId: "passage-1b",
      quote: "It opens to the public that day.",
    };
    const old: MarkedCitation = { ...judged, passageId: "passage-0", contentHash: "hash-0" };
    const text = `${sentence} [^1][^2]`;
    expect(
      noteOf(carried(answerOf("answer-old-version", text, [old, current]))).state,
    ).toMatchObject({
      kind: "not-checked",
    });
    expect(
      noteOf(carried(answerOf("answer-current", text, [judged, current]))).state,
    ).toMatchObject({
      kind: "checked",
    });
  });

  test("a judgement of the User's own Note carries “Your note”; one of a Document doesn't", () => {
    const fieldVisit: LiveDocument = {
      id: "field-visit",
      contentHash: "hash-note",
      name: "Field visit",
    };
    const ownNote: MarkedCitation = {
      ...judged,
      passageId: "passage-note",
      documentId: "field-visit",
      documentName: "Field visit",
      contentHash: "hash-note",
      yourNoteAt: "2026-10-12T09:00:00.000Z",
    };
    const fromNote = noteOf(carried(answer([ownNote])), [fieldVisit]);
    expect(fromNote.state).toMatchObject({ kind: "checked" });
    expect(fromNote.health.ownNotes).toHaveLength(1);
    expect(noteOf(carried(answer([judged]))).health.ownNotes).toHaveLength(0);
  });

  test("a sentence of a calculated figure carries nothing, though its Citation was judged in another sentence", () => {
    // The figure has no Analysis behind it in this Answer, so the Note shows its value as words.
    const figure: MarkedFigure = {
      marker: 1,
      label: "Launch budget",
      formula: "",
      inputs: [],
      value: 300,
      unit: { kind: "plain" },
      approximate: false,
      shown: "300",
      show: { language: "en", as: "number", decimals: 0, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      analysis: { analysis: 1, result: "total" },
    };
    const made = answerOf(
      "answer-calculated",
      `${sentence} [^1]\n\nThe launch costs [=1] [^1].`,
      [judged],
      [figure],
    );
    const note = carried(made);
    expect(
      note
        .at(-1)
        ?.content?.map((node) => node.text ?? "")
        .join(""),
    ).toBe("The launch costs 300 .");
    const marks = carriedMarks(note);
    expect(marks).toHaveLength(1);
    expect(String(marks[0]?.text)).toContain(sentence);
    expect(noteOf(note).state).toMatchObject({ kind: "not-checked" });
  });

  test("a Folder-scoped Answer's Note reads Checked: the carried check doesn't depend on where the Note sits", () => {
    const scope = { folderIds: ["folder-a"], tagIds: [], documentIds: [] };
    const state = noteOf(blocksOf([judged], scope)).state;
    expect(state).toMatchObject({ kind: "checked", checkedAt: CHECKED_AT });
  });

  test("a sentence the judgement didn't settle carries nothing", () => {
    const state = noteOf(blocksOf([{ ...judged, check: "not-checked" }])).state;
    expect(state).toMatchObject({ kind: "not-checked" });
  });
});
