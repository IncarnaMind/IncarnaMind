import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
  type SearchScope,
  type UnreadFile,
} from "../../src/core/api";
import type { NoteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  noteStateOf,
  noteStateParts,
  readNoteState,
  unreadForCard,
} from "../../src/renderer/src/noteState";
import { formatDateTime } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";
import { setMindScope } from "../../src/shared/mindScope";
import { checkUnreadOf, recordCheckUnread } from "../../src/shared/unreadFiles";

const CHECKED_AT = "2026-10-20T14:25:00.000Z";

const health = (parts: Partial<NoteHealth>): NoteHealth => ({
  found: [],
  notFound: [],
  unsupported: [],
  contradicted: [],
  toCheck: [],
  failed: [],
  recheck: [],
  checking: [],
  kept: [],
  tableCells: [],
  noCitation: [],
  checkable: 0,
  checkedAt: null,
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
    const state = noteStateOf(health({ checkable: 2, contradicted: [0], checkedAt: CHECKED_AT }));
    expect(state).toMatchObject({
      kind: "needs-look",
      look: 1,
      tone: "error",
      mark: "contradicted",
    });
  });

  test.each<[string, Partial<NoteHealth>, string]>([
    ["an unsupported claim", { unsupported: [0] }, "unsupported"],
    ["a Citation not found", { notFound: [0] }, "notFound"],
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

  test("names only the narrow-scope unread files: a wide search's stay out of an amber state", () => {
    expect(noteStateOf(health({ checkable: 1, contradicted: [0] }), 3)?.unread).toBe(0);
    expect(noteStateOf(health({ checkable: 1, toCheck: [0] }), 3)?.unread).toBe(0);
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
    const one = noteStateOf(health({ checkable: 1, contradicted: [0] })) ?? fail();
    const two = noteStateOf(health({ checkable: 2, unsupported: [0, 6] })) ?? fail();
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
  readNoteState({ doc, documents: [], keptCitationTexts: [], folderId: null });

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
      readNoteState({ doc, documents: [], keptCitationTexts: [], folderId: "tides" }).state;
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
      readNoteState({ doc, documents: [], keptCitationTexts: [], folderId: null }).state;
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
});
