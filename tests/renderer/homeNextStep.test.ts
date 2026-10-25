import { describe, expect, test } from "vitest";
import type { ConversationAnswer } from "../../src/core/api";
import type { NoteHealth } from "../../src/renderer/src/editor/healthCounts";
import { chooseHomeNextStep, type HomeNote, ownAnswer } from "../../src/renderer/src/homeNextStep";

const empty: NoteHealth = {
  found: [],
  notFound: [],
  unsupported: [],
  contradicted: [],
  toCheck: [],
  tableCells: [],
  citable: [],
  noCitation: [],
  checkable: 0,
};
const note = (health: Partial<NoteHealth> = {}): HomeNote => ({
  mind: {
    id: "own",
    title: "Tides",
    autoTitle: "",
    kind: "mind",
    folderId: null,
    createdAt: "1",
    updatedAt: "2",
  },
  health: { ...empty, ...health },
});
const initial = { hasDocuments: false, answers: [], note: null, exported: false, saved: null };
const answer = (id: string, updatedAt: string) => ({
  id,
  updatedAt,
  conversationId: "conversation",
});
const choose = (over: Partial<Parameters<typeof chooseHomeNextStep>[0]>) =>
  chooseHomeNextStep({ ...initial, ...over });

describe("Home's next step", () => {
  test("starts with files, then a question, without example progress", () => {
    expect(choose({})?.kind).toBe("add");
    expect(choose({ hasDocuments: true })?.kind).toBe("ask");
    const minimal = { id: "a", status: "done", steps: null } satisfies Pick<
      ConversationAnswer,
      "id" | "status" | "steps"
    >;
    expect(ownAnswer(minimal, new Set(["a"]))).toBe(false);
    expect(ownAnswer({ ...minimal, status: "failed" }, new Set())).toBe(false);
    expect(
      ownAnswer(
        {
          ...minimal,
          steps: { sentAt: null, finishedAt: null, phases: [], reasoning: null, example: true },
        },
        new Set(),
      ),
    ).toBe(false);
    expect(ownAnswer(minimal, new Set())).toBe(true);
  });

  test("follows the newer unfiled Answer or note, independent of answer order", () => {
    const latest = answer("new", "3");
    expect(choose({ answers: [latest, answer("old", "1")], note: note() })).toEqual({
      kind: "write",
      answer: latest,
    });
    expect(
      choose({ answers: [answer("old", "1")], note: note({ toCheck: [2, 9], checkable: 2 }) }),
    ).toMatchObject({ kind: "check", count: 2 });
    expect(
      choose({ answers: [answer("same", "2")], note: note({ toCheck: [2], checkable: 1 }) })?.kind,
    ).toBe("check");
  });

  test("uses shared health's claim counts, and problems precede the unchecked claims", () => {
    expect(
      choose({ note: note({ toCheck: [1, 10, 24], tableCells: [24], checkable: 3 }) }),
    ).toMatchObject({ kind: "check", count: 3 });
    expect(
      choose({
        note: note({ unsupported: [1], contradicted: [10], notFound: [20], toCheck: [30] }),
      }),
    ).toMatchObject({ kind: "look", count: 3 });
    expect(choose({ note: note() })).toBeNull();
    expect(choose({ note: { ...note({ toCheck: [1] }), busy: true } })).toBeNull();
    expect(choose({ note: { ...note({ checkable: 1 }), problem: true } })).toBeNull();
    expect(choose({ note: note({ checkable: 1, found: [2] }) })?.kind).toBe("export");
  });

  test("an export ends the first path across launches, keeping only the latest note's check states", () => {
    expect(choose({ exported: true })).toBeNull();
    expect(choose({ exported: true, answers: [answer("new", "3")] })).toBeNull();
    expect(
      choose({ exported: true, answers: [answer("new", "3")], note: note({ toCheck: [1] }) })?.kind,
    ).toBe("check");
    expect(choose({ exported: true, note: note({ unsupported: [1] }) })?.kind).toBe("look");
    expect(choose({ exported: true, note: note({ checkable: 1 }) })).toBeNull();
  });

  test("Open is session-only, and its dismissal falls back to the current check state", () => {
    const saved = { mindId: "own", path: "/output/Tides.docx", at: 1 };
    expect(choose({ exported: true, note: note({ toCheck: [1] }), saved })?.kind).toBe("exported");
    expect(choose({ exported: true, note: note({ toCheck: [1] }), saved: null })?.kind).toBe(
      "check",
    );
    expect(
      choose({ exported: true, note: note(), saved: { ...saved, mindId: "example" } }),
    ).toBeNull();
  });
});
