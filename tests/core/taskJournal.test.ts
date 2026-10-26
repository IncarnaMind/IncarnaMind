/**
 * A Task's journal (#126): the input a Task reads back is JSON, as `create`
 * writes it. `updateInput` writes it the same way whatever the value's shape,
 * so a resumed run reconstructs from a primitive as well as from an object.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { createJournal } from "../../src/core/runs/journal";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";

describe("a Task's journal input", () => {
  test("an update stores JSON of any shape, as create does, and it reads back the same", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const journal = createJournal(db, () => "2026-10-26T00:00:00.000Z");
      const task = journal.create({
        kind: "comparison",
        mindId: null,
        input: { questionIds: ["q1"] },
      });
      const stored = () =>
        db.get<{ input: string }>("SELECT input FROM runs WHERE id = ?", [task.id])?.input;
      const roundTrip = (input: unknown) => {
        journal.update(task.id, { input });
        return { stored: stored(), read: journal.get(task.id)?.input };
      };

      expect(roundTrip("after")).toEqual({ stored: '"after"', read: "after" });
      expect(roundTrip('{"a":1}')).toEqual({ stored: '"{\\"a\\":1}"', read: '{"a":1}' });
      expect(roundTrip(42)).toEqual({ stored: "42", read: 42 });
      expect(roundTrip(true)).toEqual({ stored: "true", read: true });
      expect(roundTrip(["a", "b"])).toEqual({ stored: '["a","b"]', read: ["a", "b"] });
      expect(roundTrip({ a: { b: [1, null] } })).toEqual({
        stored: '{"a":{"b":[1,null]}}',
        read: { a: { b: [1, null] } },
      });

      // Null is the empty input create writes; undefined leaves the row as it was.
      expect(roundTrip(null)).toEqual({ stored: "{}", read: {} });
      journal.update(task.id, { input: { kept: true } });
      const kept = stored();
      journal.update(task.id, { input: undefined });
      expect(stored()).toBe(kept);
      expect(journal.get(task.id)?.input).toEqual({ kept: true });

      // A value create can't store as JSON throws the same way through an update.
      expect(() => journal.create({ kind: "comparison", mindId: null, input: 1n })).toThrow();
      expect(() => roundTrip(1n)).toThrow();
    } finally {
      db.close();
    }
  });
});
