import { describe, expect, test } from "vitest";
import type { ConversationAnswer } from "../../src/core/api";
import type { NoteHealth } from "../../src/renderer/src/editor/healthCounts";
import { chooseHomeNextStep, type HomeNote, ownAnswer } from "../../src/renderer/src/homeNextStep";
import { noteStateOf } from "../../src/renderer/src/noteState";
import { translate } from "../../src/shared/i18n";

const health = (parts: Partial<NoteHealth> = {}): NoteHealth => ({
  found: [],
  notFound: [],
  lookClaims: [],
  lookNotFound: [],
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
  supported: 0,
  checkedAt: null,
  unexamined: [],
  ...parts,
});

const note = (
  parts: Partial<NoteHealth> = {},
  mind: Partial<HomeNote["mind"]> = {},
  unread = 0,
  narrowUnread = 0,
): HomeNote => {
  const readings = health(parts);
  return {
    mind: {
      id: "own",
      title: "Tides",
      autoTitle: "",
      kind: "mind",
      folderId: null,
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-20T09:10:00.000Z",
      ...mind,
    },
    health: readings,
    state: noteStateOf(readings, unread, narrowUnread),
  };
};

const initial = { hasDocuments: false, answers: [], note: null, exported: false, saved: null };
const answer = (id: string, updatedAt: string) => ({
  id,
  conversationId: "conversation",
  updatedAt,
});
const choose = (over: Partial<Parameters<typeof chooseHomeNextStep>[0]>) =>
  chooseHomeNextStep({ ...initial, ...over });

describe("Home's next step", () => {
  test("starts with files, then a question, once the User has their own", () => {
    expect(choose({})).toEqual({ kind: "add" });
    expect(choose({ hasDocuments: true })).toEqual({ kind: "ask" });
    expect(choose({ exported: true })).toBeNull();
    expect(choose({ exported: true, hasDocuments: true })).toBeNull();
  });

  test("follows the newer of an unfiled Answer and the most recently updated note", () => {
    const latest = answer("new", "2026-10-20T09:20:00.000Z");
    expect(
      choose({ answers: [latest, answer("old", "2026-10-20T09:00:00.000Z")], note: note() }),
    ).toEqual({ kind: "write", answer: latest });
    expect(
      choose({
        answers: [answer("old", "2026-10-20T09:05:00.000Z")],
        note: note({ checkable: 1, toCheck: [2] }),
      }),
    ).toMatchObject({ kind: "check", count: 1 });
    expect(
      choose({
        answers: [answer("same", "2026-10-20T09:10:00.000Z")],
        note: note({ checkable: 1, toCheck: [2] }),
      })?.kind,
    ).toBe("check");
  });

  test("counts the claims the badge counts, table cells and duplicates included", () => {
    expect(choose({ note: note({ checkable: 1, toCheck: [2] }) })).toMatchObject({
      kind: "check",
      count: 1,
    });
    expect(choose({ note: note({ checkable: 3, toCheck: [1, 10, 24] }) })).toMatchObject({
      kind: "check",
      count: 3,
    });
    expect(
      choose({ note: note({ checkable: 3, toCheck: [1, 10, 24], tableCells: [24] }) }),
    ).toMatchObject({ kind: "check", count: 3 });
  });

  test("something that needs a look comes before anything not checked, and is named by its count", () => {
    expect(
      choose({
        note: note({
          checkable: 4,
          unsupported: [1],
          contradicted: [10],
          notFound: [20],
          lookClaims: [1, 10, 20],
          toCheck: [30],
        }),
      }),
    ).toMatchObject({ kind: "look", count: 3 });
    expect(choose({ note: note({ checkable: 1, toCheck: [1] }) })?.kind).toBe("check");
    expect(choose({ note: note({ checkable: 1, contradicted: [1], lookClaims: [1] }) })?.kind).toBe(
      "look",
    );
  });

  test("every claim covered: ready to export, or done", () => {
    expect(choose({ note: note({ checkable: 2, found: [1, 2] }) })).toEqual({
      kind: "export",
      note: note({ checkable: 2, found: [1, 2] }),
      count: 0,
    });
    // A note a check reads nothing in has no export step: there is nothing it checked.
    expect(choose({ note: note() })).toBeNull();
    expect(choose({ note: note({ checkable: 1, checking: [1] }) })).toBeNull();
  });

  test("an own export ends the first path: only the latest note's check states, and none when it is done", () => {
    expect(
      choose({ exported: true, answers: [answer("new", "2026-10-20T09:20:00.000Z")] }),
    ).toBeNull();
    expect(
      choose({
        exported: true,
        answers: [answer("new", "2026-10-20T09:20:00.000Z")],
        note: note({ checkable: 1, toCheck: [2] }),
      }),
    ).toMatchObject({ kind: "check" });
    expect(
      choose({ exported: true, note: note({ checkable: 1, unsupported: [2], lookClaims: [2] }) }),
    ).toMatchObject({
      kind: "look",
    });
    expect(choose({ exported: true, note: note({ checkable: 1, found: [1] }) })).toBeNull();
    expect(choose({ exported: true, note: note() })).toBeNull();
  });

  test("this session's saved Word export stands in until Open, then falls back to the check state", () => {
    const saved = { mindId: "own", path: "/output/Tides.docx", at: 1 };
    expect(choose({ exported: true, note: note({ checkable: 1, toCheck: [2] }), saved })).toEqual({
      kind: "exported",
      saved,
    });
    // Home passes only a saved Word export of the User's own note here.
    expect(
      choose({ exported: true, note: note({ checkable: 1, toCheck: [2] }), saved: null }),
    ).toMatchObject({ kind: "check" });
  });

  test("a check running, or one that gave no marks, leaves the row to the note's card", () => {
    expect(choose({ note: { ...note({ checkable: 1, toCheck: [1] }), busy: true } })).toBeNull();
    expect(choose({ note: { ...note({ checkable: 1, toCheck: [1] }), problem: true } })).toBeNull();
    expect(choose({ note: { ...note({ checkable: 1, found: [1] }), problem: true } })).toBeNull();
  });

  test("a file that couldn't be read inside the check's own scope keeps the note amber, before and after the first export", () => {
    // Every claim holds, but the narrowed check (a Folder, a Tag, or picked Documents) could not
    // read a file that may hold the evidence: the shared state is amber, with no claim to look at.
    const narrowed = note(
      { checkable: 1, found: [1], checkedAt: "2026-10-20T09:00:00.000Z" },
      {},
      1,
      1,
    );
    expect(narrowed.state).toMatchObject({
      kind: "needs-look",
      look: 0,
      unread: 1,
      unreadMatters: true,
    });
    expect(choose({ note: narrowed })).toMatchObject({ kind: "look", count: 0 });
    expect(choose({ note: narrowed, exported: true })).toMatchObject({ kind: "look", count: 0 });
    expect(
      translate("en", "home.next.unread", {
        mind: "Tides",
        files: translate("en", "unread.count.one", { count: "1" }),
      }),
    ).toBe("“Tides” · 1 file couldn’t be read");
    expect(
      translate("zh-CN", "home.next.unread", {
        mind: "Tides",
        files: translate("zh-CN", "unread.count.one", { count: "1" }),
      }),
    ).toBe("“Tides” · 1 个文件未能读取");
  });

  test("all Documents searched: an unread file leaves the note green, ready before the first export and done after it", () => {
    const allDocuments = note(
      { checkable: 1, found: [1], checkedAt: "2026-10-20T09:00:00.000Z" },
      {},
      1,
      0,
    );
    expect(allDocuments.state).toMatchObject({ kind: "checked", unread: 1, unreadMatters: false });
    expect(choose({ note: allDocuments })).toMatchObject({ kind: "export" });
    expect(choose({ note: allDocuments, exported: true })).toBeNull();
  });

  test("without the shared state the row never calls the note ready", () => {
    const onlyHealth = { mind: note().mind, health: health({ checkable: 1, found: [1] }) };
    expect(choose({ note: onlyHealth })).toMatchObject({ kind: "look" });
  });
});

describe("An own Answer", () => {
  const base = { id: "a", status: "done", steps: null } satisfies Pick<
    ConversationAnswer,
    "id" | "status" | "steps"
  >;

  test("is one that arrived, not the example's and not one that failed", () => {
    expect(ownAnswer(base, new Set())).toBe(true);
    expect(ownAnswer({ ...base, status: "failed" }, new Set())).toBe(false);
    expect(ownAnswer({ ...base, status: "streaming" }, new Set())).toBe(false);
    expect(ownAnswer(base, new Set(["a"]))).toBe(false);
    expect(
      ownAnswer(
        {
          ...base,
          steps: { sentAt: null, finishedAt: null, phases: [], reasoning: null, example: true },
        },
        new Set(),
      ),
    ).toBe(false);
  });
});
