import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  COMMENT_MARK,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../src/core/api";
import type { Core } from "../../src/core/core";
import { checkKeyOf, markKeyOf } from "../../src/shared/markKeys";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { boundEditorTo } from "../helpers/editor";

/*
 * A Note saved before #2996 kept every check, comment and change under its mark's name. The core
 * moves them to their own keys wherever the old keys come back: when it opens the Note, and when a
 * Checkpoint saved before is restored. Not an edit of the User's: the Note keeps its edited time
 * and its versions, and opening it again writes nothing. A Note a newer version wrote is left as
 * it is.
 */

const first = "五月收入为10亿元。";
const second = "五月成本为8亿元。";

function check(
  id: string,
  text: string,
  state: ClaimCheckAttributes["state"],
): ClaimCheckAttributes {
  return {
    id,
    request: "check-note",
    action: "check-against-documents",
    state,
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-12T09:00:00.000Z",
  };
}

/** The Note as one saved before kept it: two touching checked sentences and a comment, by name. */
function savedBefore(version?: number): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push([
    createElement({
      type: "paragraph",
      attrs: { id: "p" },
      content: [{ type: "text", text: first + second }],
    }),
  ]);
  const text = (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.format(0, first.length, { [CLAIM_CHECK_MARK]: check("first", first, "supported") });
  text.format(first.length, second.length, {
    [CLAIM_CHECK_MARK]: check("second", second, "supported"),
  });
  text.format(0, 4, { [COMMENT_MARK]: { id: "comment-1" } });
  if (version !== undefined)
    doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, version);
  return Y.encodeStateAsUpdate(doc);
}

/** The format keys of the Note's text as the core holds it, by run. */
function keysIn(state: Uint8Array): string[][] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = (doc.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  return text
    .toDelta()
    .map((run: { attributes?: Record<string, unknown> }) =>
      Object.keys(run.attributes ?? {}).sort(),
    );
}

const KEYED = [
  [checkKeyOf("first"), markKeyOf(COMMENT_MARK, "comment-1")].sort(),
  [checkKeyOf("first")],
  [checkKeyOf("second")],
];
const OLD = [[CLAIM_CHECK_MARK, COMMENT_MARK], [CLAIM_CHECK_MARK], [CLAIM_CHECK_MARK]];

/** A Note stored as one saved before, through the core, and no longer in its memory. */
async function stored(core: Core, update: Uint8Array): Promise<string> {
  const mind = await core.createMind({ title: "Results" });
  await core.applyMindUpdate(mind.id, update);
  await core.closeMind(mind.id);
  return mind.id;
}

const rowsOf = (dataDir: string, mindId: string) =>
  queryDatabase<{ n: number }>(
    dataDir,
    "SELECT count(*) AS n FROM mind_updates WHERE mind_id = ? AND deleted_at IS NULL",
    [mindId],
  )[0]?.n;

describe("a Note saved before", () => {
  test("is moved to its own keys when the core opens it, not as an edit, and once", async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock("2026-11-12T09:00:00.000Z");
    const core = startCore(dataDir, { now: clock.now });
    const mindId = await stored(core, savedBefore());
    const before = (await core.listMinds()).find((mind) => mind.id === mindId);
    const versions = (await core.listCheckpoints(mindId)).checkpoints.length;
    clock.advance(60 * 60 * 1000);

    const opened = await core.openMind(mindId);
    expect(keysIn(opened.state)).toEqual(KEYED);
    const after = (await core.listMinds()).find((mind) => mind.id === mindId);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect((await core.listCheckpoints(mindId)).checkpoints).toHaveLength(versions);

    await core.closeMind(mindId);
    const rows = rowsOf(dataDir, mindId);
    const again = await core.openMind(mindId);
    expect(keysIn(again.state)).toEqual(KEYED);
    expect(rowsOf(dataDir, mindId)).toBe(rows);
    await core.close();
  });

  test("that a newer version wrote is left as it is, read-only", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mindId = await stored(core, savedBefore(CONTENT_SCHEMA_VERSION + 1));
    const opened = await core.openMind(mindId);
    expect(opened.access).toBe("read-only");
    expect(keysIn(opened.state)).toEqual(OLD);
    await core.close();
  });

  test("restored from a Checkpoint saved before is moved again, and its touching sentences keep their own checks", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Results" });
    await core.applyMindUpdate(mind.id, savedBefore());
    const saved = await core.saveCheckpoint(mind.id, "export");
    await core.closeMind(mind.id);
    expect(keysIn((await core.openMind(mind.id)).state)).toEqual(KEYED);

    await core.restoreCheckpoint(mind.id, saved.id);
    const restored = (await core.openMind(mind.id)).state;
    expect(keysIn(restored)).toEqual(KEYED);

    // The core's Note, with a keep on the first sentence in the editor while a Contradicted lands
    // on the second, in both of Yjs's orders.
    for (const copyId of [1, 3]) {
      const note = new Y.Doc();
      Y.applyUpdate(note, restored);
      const copy = new Y.Doc();
      Y.applyUpdate(copy, restored);
      copy.clientID = copyId;
      note.clientID = 2;
      const editor = boundEditorTo(copy);
      const landing = markedSentences(note.getXmlFragment(MIND_CONTENT_FIELD)).find(
        (each) => each.check.id === "second",
      );
      if (!landing) throw new Error("The second sentence has no check.");
      markSentence(
        landing.element,
        landing.from,
        landing.to,
        check("second", second, "contradicted"),
      );
      const type = editor.schema.marks[CLAIM_CHECK_MARK];
      if (!type) throw new Error("No check mark.");
      let at = -1;
      editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText) at = pos;
      });
      editor.view.dispatch(
        editor.state.tr.addMark(
          at,
          at + first.length,
          type.create({ ...check("first", first, "supported"), kept: true }),
        ),
      );
      Y.applyUpdate(note, Y.encodeStateAsUpdate(copy));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(note));
      for (const each of [note, copy])
        expect(
          markedSentences(each.getXmlFragment(MIND_CONTENT_FIELD)).map((marked) => [
            marked.check.id,
            marked.check.state,
            marked.check.kept === true,
          ]),
        ).toEqual([
          ["first", "supported", true],
          ["second", "contradicted", false],
        ]);
    }
    await core.close();
  });
});
