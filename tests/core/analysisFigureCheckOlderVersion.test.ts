import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_FIGURE_RUNS_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before an Analysis figure kept the check IncarnaMind made of it when the Analysis
 * ran (#2378): its core is this one with the newest content schema it understands set back to 46.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 46,
}));

/** The content schema version the check came with: what a Note written since records. */
const FIGURE_CHECK = 47;

const KEY = JSON.stringify(["run-1", "total"]);

/** The kept value as this version writes it, with the check the core made. */
const VALUE = {
  kind: "figure",
  name: "total",
  label: "Total revenue",
  unit: "USD",
  value: 350.5,
  of: { input: "sales", columns: ["Revenue"], rows: [[2, 5]], count: 4, how: "sum" },
  check: { kind: "same", value: 350.5 },
};

/** The same value as the version before reads it and keeps it again: its check gone. */
const { check: _check, ...STRIPPED } = VALUE;

function noteWithFigureCheck(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap(MIND_FIGURE_RUNS_FIELD).set(KEY, VALUE);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, FIGURE_CHECK);
  return doc;
}

describe("a version from before Analysis figures kept their check", () => {
  test("opens a Note whose Analysis figure keeps its check read-only, so its write can't drop it", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(46);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Revenue" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(noteWithFigureCheck()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).get(KEY)).toEqual(VALUE);

    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    doc.getMap(MIND_FIGURE_RUNS_FIELD).set(KEY, STRIPPED);
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    const again = new Y.Doc();
    Y.applyUpdate(again, (await core.openMind(mind.id)).state);
    expect(again.getMap(MIND_FIGURE_RUNS_FIELD).get(KEY)).toEqual(VALUE);
    core.close();
  });
});
