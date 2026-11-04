/**
 * A comment goes with its Mind (#328): a second window open on the same Mind
 * receives its record and the mark on its words, so both show it in the same
 * place.
 */

import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { COMMENT_MARK, MIND_COMMENTS_FIELD, type MindComment } from "../../src/core/api";
import { mindCommentsOf } from "../../src/shared/mindComments";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const COMMENT: MindComment = {
  id: "comment-sync",
  author: null,
  createdAt: "2026-10-03T09:00:00Z",
  text: "Seen in both windows.",
  resolvedAt: null,
  replies: [],
};

const commentedBlocks = (): JSONContent[] => [
  {
    type: "paragraph",
    content: [
      { type: "text", text: "The same " },
      {
        type: "text",
        text: "words",
        marks: [{ type: COMMENT_MARK, attrs: { id: COMMENT.id } }],
      },
      { type: "text", text: " in both." },
    ],
  },
];

test("a comment stays on its words when its Block moves", async () => {
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Moved" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", content: [{ type: "text", text: "First." }] },
    ...commentedBlocks(),
  ]);
  client.doc.getMap(MIND_COMMENTS_FIELD).set(COMMENT.id, COMMENT);
  await client.settled();

  // The commented paragraph moved above the other, as dragging a Block does.
  writeMind(client, [...commentedBlocks()]);
  await client.settled();
  const moved = readMind(client).toJSON().content as JSONContent[];
  const marks = (moved[0]?.content ?? []).flatMap((node) => node.marks ?? []);
  expect(marks).toContainEqual({ type: COMMENT_MARK, attrs: { id: COMMENT.id } });
  expect(mindCommentsOf(client.doc)).toEqual([COMMENT]);
  core.close();
});

test("a comment made in one window reaches the other, on the same words", async () => {
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Shared" });
  const first = await connectToMind(core, mind.id);
  const second = await connectToMind(core, mind.id);

  writeMind(first, commentedBlocks());
  first.doc.getMap(MIND_COMMENTS_FIELD).set(COMMENT.id, COMMENT);
  await first.settled();
  await expect.poll(() => mindCommentsOf(second.doc).map((each) => each.id)).toEqual([COMMENT.id]);

  const marked = (blocks: JSONContent[]): string =>
    blocks
      .flatMap((block) => block.content ?? [])
      .filter((node) =>
        (node.marks ?? []).some(
          (mark) => mark.type === COMMENT_MARK && mark.attrs?.id === COMMENT.id,
        ),
      )
      .map((node) => node.text ?? "")
      .join("");
  await expect.poll(() => marked(readMind(second).toJSON().content as JSONContent[])).toBe("words");
  core.close();
});
