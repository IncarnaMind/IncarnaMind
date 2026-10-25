import { describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment, LibrarySnapshot } from "../../src/core/api";
import {
  applyAssignments,
  applyDocumentChanges,
  createDocumentUpdates,
  type DocumentChanges,
  type UpdateClock,
} from "../../src/renderer/src/documentUpdates";

/** A Document with only what these tests look at; `version` tells copies apart. */
const doc = (id: string, version = 0) => ({ id, name: `${id} v${version}` }) as unknown as Document;

const assignment = (
  documentId: string,
  status: DocumentGroupAssignment["status"] = "pending",
): DocumentGroupAssignment => ({
  documentId,
  groupId: null,
  source: "automatic",
  suggested: false,
  status,
  error: null,
  model: null,
});

/** The store's list as the events used to change it, one at a time. */
function oneByOne(documents: Document[], ops: (["upsert", Document] | ["remove", string])[]) {
  let list = documents;
  for (const [kind, value] of ops) {
    if (kind === "upsert") {
      list = list.some((each) => each.id === value.id)
        ? list.map((each) => (each.id === value.id ? value : each))
        : [value, ...list];
    } else list = list.filter((each) => each.id !== value);
  }
  return list;
}

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const clock: UpdateClock = {
    now: () => now,
    setTimeout(run, ms) {
      const timer = { at: now + ms, run, id: ++ids };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      timers = timers.filter((each) => each.id !== id);
    },
  };
  return {
    clock,
    /** Moves time on, running each timer that comes due, in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((each) => each.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((each) => each !== due);
        now = due.at;
        due.run();
      }
      now = until;
    },
    pending: () => timers.length,
  };
}

describe("applying gathered changes to the Document list", () => {
  test("a changed Document stays in its place, a new one comes first, a removed one goes", () => {
    const list = [doc("a"), doc("b"), doc("c")];
    const next = applyDocumentChanges(
      list,
      new Map([
        ["b", doc("b", 1)],
        ["x", doc("x")],
        ["y", doc("y")],
      ]),
      new Set(["c"]),
    );
    expect(next.map((each) => each.name)).toEqual(["y v0", "x v0", "a v0", "b v1"]);
    // The others are the same objects, so their rows aren't drawn again.
    expect(next[2]).toBe(list[0]);
  });

  test("with nothing to change, the list is the same array", () => {
    const list = [doc("a")];
    expect(applyDocumentChanges(list, new Map(), new Set())).toBe(list);
  });

  test("gives what the events, one at a time, gave: in any order, removals and re-adds included", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 200; round++) {
      const start = Array.from({ length: 6 }, (_, i) => doc(`d${i}`));
      const ops: (["upsert", Document] | ["remove", string])[] = [];
      const updates = new Map<string, Document>();
      const removed = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const id = `d${Math.floor(random() * 10)}`;
        if (random() < 0.3) {
          ops.push(["remove", id]);
          updates.delete(id);
          removed.add(id);
        } else {
          const copy = doc(id, i + 1);
          ops.push(["upsert", copy]);
          updates.set(id, copy);
        }
      }
      expect(applyDocumentChanges(start, updates, removed)).toEqual(oneByOne(start, ops));
    }
  });
});

describe("applying gathered assignments to the Library", () => {
  const library: LibrarySnapshot = {
    groups: [
      {
        id: "g",
        name: "Research",
        description: "",
        countsOwnFiles: false,
        createdAt: "",
        updatedAt: "",
      },
    ],
    deletedGroups: [],
    assignments: [assignment("a"), assignment("b")],
    settings: {
      classifier: { kind: "automatic" },
      automatic: false,
      organizeWith: null,
      taggingStopped: [],
    },
    automaticDefault: false,
  };

  test("each changes in place, a Document without one yet gets it at the end, the rest stay", () => {
    const next = applyAssignments(
      library,
      new Map([
        ["b", assignment("b", "classified")],
        ["c", assignment("c")],
      ]),
    );
    expect(next.assignments.map((each) => [each.documentId, each.status])).toEqual([
      ["a", "pending"],
      ["b", "classified"],
      ["c", "pending"],
    ]);
    expect(next.assignments[0]).toBe(library.assignments[0]);
    expect(next.groups).toBe(library.groups);
    expect(next.settings).toBe(library.settings);
    expect(library.assignments[1]?.status).toBe("pending");
  });

  test("with nothing to change, the snapshot is the same object", () => {
    expect(applyAssignments(library, new Map())).toBe(library);
  });
});

describe("gathering the core's events", () => {
  const gather = () => {
    const time = manualClock();
    const applied: DocumentChanges[] = [];
    const updates = createDocumentUpdates((changes) => applied.push(changes), {
      interval: 100,
      clock: time.clock,
    });
    return { time, applied, updates };
  };

  test("the first after a quiet spell goes on the next task, without waiting", () => {
    const { time, applied, updates } = gather();
    updates.upsert([doc("a", 1)]);
    expect(applied).toHaveLength(0);
    time.advance(0);
    expect(applied).toHaveLength(1);
    expect([...(applied[0]?.upserted.values() ?? [])]).toEqual([doc("a", 1)]);
  });

  test("a burst is handed over once per interval, the latest copy of each Document winning", () => {
    const { time, applied, updates } = gather();
    updates.upsert([doc("a", 1)]);
    time.advance(0);
    // A thousand events within the next interval: one update, when it ends.
    for (let i = 0; i < 1000; i++) {
      updates.upsert([doc(`d${i % 10}`, i)]);
      updates.assign([assignment(`d${i % 10}`, i % 2 ? "classified" : "classifying")]);
      time.advance(0.05);
    }
    expect(applied).toHaveLength(1);
    time.advance(100);
    expect(applied).toHaveLength(2);
    const second = applied[1];
    expect(second?.upserted.size).toBe(10);
    expect(second?.upserted.get("d9")).toEqual(doc("d9", 999));
    expect(second?.assignments.get("d9")?.status).toBe("classified");
    expect(time.pending()).toBe(0);
  });

  test("nothing is lost: what comes after a hand-over goes in the next one", () => {
    const time = manualClock();
    const at: number[] = [];
    const seen = new Map<string, string>();
    const updates = createDocumentUpdates(
      (changes) => {
        at.push(time.clock.now());
        for (const [id, each] of changes.upserted) seen.set(id, each.name);
      },
      { interval: 100, clock: time.clock },
    );
    for (let i = 0; i < 500; i++) {
      updates.upsert([doc(`d${i % 37}`, i)]);
      if (i % 3 === 0) time.advance(7);
    }
    time.advance(1000);
    // Each Document's last copy arrived, in some hand-over.
    for (let k = 0; k < 37; k++) {
      const last = 499 - ((499 - k) % 37);
      expect(seen.get(`d${k}`)).toBe(`d${k} v${last}`);
    }
    // Never more often than once an interval.
    expect(at.length).toBeGreaterThan(5);
    for (let i = 1; i < at.length; i++) {
      expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(100);
    }
  });

  test("a removal cancels an earlier change in the same batch; a later change brings it back", () => {
    const { time, applied, updates } = gather();
    updates.upsert([doc("a", 1)]);
    updates.remove(["a"]);
    time.advance(0);
    expect(applied[0]?.upserted.has("a")).toBe(false);
    expect(applied[0]?.removed.has("a")).toBe(true);
    updates.remove(["b"]);
    updates.upsert([doc("b", 2)]);
    time.advance(100);
    expect(applied[1]?.removed.has("b")).toBe(true);
    expect(applied[1]?.upserted.get("b")).toEqual(doc("b", 2));
  });

  test("flush hands over what waits at once, and only once", () => {
    const { time, applied, updates } = gather();
    updates.flush();
    expect(applied).toHaveLength(0);
    updates.upsert([doc("a", 1)]);
    updates.flush();
    expect(applied).toHaveLength(1);
    expect(time.pending()).toBe(0);
    time.advance(1000);
    expect(applied).toHaveLength(1);
  });
});
