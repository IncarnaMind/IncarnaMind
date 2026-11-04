/**
 * A version from before comments (#328) meets a Mind written with them: the
 * comment mark and its record would be stripped by its editor, so the Mind
 * opens read-only, refuses every write, and stays exactly as stored.
 */
import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_COMMENTS_FIELD,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { mindCommentsOf } from "../../src/shared/mindComments";
import { createTempDataFolder, startCore } from "../helpers/core";

vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 48,
}));

/** The version comments came with: what a Mind written since records. */
const COMMENTS = 50;

const COMMENT = {
  id: "comment-1",
  author: null,
  createdAt: "2026-10-03T09:00:00Z",
  text: "Make this clearer.",
  resolvedAt: null,
  replies: [],
};

const WORDS = "Commented words.";

function mindWithComment(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  const text = new Y.XmlText(WORDS);
  text.format(0, WORDS.length, { comment: { id: COMMENT.id } });
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  doc.getMap(MIND_COMMENTS_FIELD).set(COMMENT.id, COMMENT);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, COMMENTS);
  return doc;
}

const docOf = (state: Uint8Array): Y.Doc => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
};

test("a Mind written with comments opens read-only here, and its stored content is never touched", async () => {
  expect(CONTENT_SCHEMA_VERSION).toBe(48);
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Newer" });
  await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithComment()));

  const opened = await core.openMind(mind.id);
  expect(opened.access).toBe("read-only");
  const doc = docOf(opened.state);
  expect(mindCommentsOf(doc)).toEqual([COMMENT]);
  expect(doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(COMMENTS);

  // Its editor's write, which this version would make without the comment mark, is refused.
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
  const text = paragraph.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("No text.");
  text.insert(text.length, " More.");
  await expect(core.applyMindUpdate(mind.id, updates[0] as Uint8Array)).rejects.toThrow(
    MindReadOnlyError,
  );

  const again = await core.openMind(mind.id);
  expect(again.state).toEqual(opened.state);
  const kept = docOf(again.state);
  expect(mindCommentsOf(kept)).toEqual([COMMENT]);
  const keptParagraph = kept.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  if (!(keptParagraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
  expect((keptParagraph.get(0) as Y.XmlText).toDelta()).toEqual([
    { insert: WORDS, attributes: { comment: { id: COMMENT.id } } },
  ]);
  core.close();
});
