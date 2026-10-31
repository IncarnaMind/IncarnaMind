import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { elementMarkdown } from "../../src/core/answers/contextText";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

/*
 * A numbered list's scheme as text (#1419): the assistant reads each item's marker as the User
 * sees it, so "clause (b)" names the item marked "(b)"; Markdown, which has only "1." lists,
 * writes numbers, a list that starts deeper indented to its level, and reads that back.
 */

const item = (text: string, ...lists: JSONContent[]): JSONContent => ({
  type: "listItem",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...lists],
});
const ordered = (attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent => ({
  type: "orderedList",
  attrs,
  content: items,
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const bullet = (...items: JSONContent[]): JSONContent => ({ type: "bulletList", content: items });

async function mindWith(blocks: JSONContent[]) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Lease" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, blocks);
  await client.settled();
  return { core, mind, client };
}

const LEASE = [
  ordered(
    { numbering: "clauses" },
    item("Rent", ordered({}, item("Monthly"), item("In advance"))),
    item("Deposit"),
  ),
  paragraph("Then the repairs."),
  ordered({ numbering: "clauses", continues: true }, item("Repairs")),
  ordered({ numbering: "chinese", startLevel: 1 }, item("押金")),
];

describe("A numbered list's scheme as text", () => {
  // protects=the assistant reads each item with the marker the editor draws, nested ones in the outer list's scheme a level deeper, a list that goes on with the numbers before, and one that starts deeper at that level's format; fails_when=it reads "1." for a clause, or numbers a continued list from 1; no_claim=what the model makes of them.
  test("the assistant reads each item's marker as the User sees it", async () => {
    const { client } = await mindWith(LEASE);
    const lists = client.blocks
      .toArray()
      .filter((each): each is Y.XmlElement => each instanceof Y.XmlElement)
      .filter((each) => each.nodeName === "orderedList");
    expect(lists.map((list) => elementMarkdown(list))).toEqual([
      "(a) Rent\n\n    (i) Monthly\n    (ii) In advance\n(b) Deposit",
      "(c) Repairs",
      "（一） 押金",
    ]);
  });

  // protects=the assistant reads a numbered list under a bullet, or under a bullet in a numbered list, by the markers the editor draws — its own scheme's first level, a level in — and the list nested in it goes a level on; fails_when=it reads the outer list's scheme or level for it, or drops its depth; no_claim=the model's reading of the shapes.
  test("the assistant reads a numbered list under a bullet as the editor draws it", async () => {
    const { client } = await mindWith([
      bullet(
        item("Bullet", ordered({ numbering: "chinese" }, item("押金", ordered({}, item("租金"))))),
      ),
      bullet(item("Also", ordered({}, item("Rent", ordered({}, item("Monthly")))))),
    ]);
    const lists = client.blocks
      .toArray()
      .filter((each): each is Y.XmlElement => each instanceof Y.XmlElement);
    expect(lists.map((list) => elementMarkdown(list))).toEqual([
      "- Bullet\n\n  一、 押金\n\n     （一） 租金",
      "- Also\n\n  1. Rent\n\n     a. Monthly",
    ]);
  });

  // protects=Markdown export writes numbers, a continued list's from where the one before ended, and a list that starts deeper indented three spaces a level with its level marked above it, which the Markdown reader takes back; fails_when=a deeper list loses its level on the way back, a continued list starts again at 1, or a first-level list indented three spaces (as other Markdown may write it) reads as deeper; no_claim=other Markdown apps, which show an indented list of three spaces as an ordinary list and deeper ones as indented text.
  test("Markdown writes numbers, marks a deeper list's level, and reads it back", async () => {
    const { core, mind } = await mindWith(LEASE);
    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(markdown).toContain("1. Rent\n   1. Monthly\n   2. In advance\n2. Deposit");
    expect(markdown).toContain("3. Repairs");
    expect(markdown).toContain("<!-- start-level: 1 -->\n   1. 押金");

    // Three spaces alone is a first-level list in other Markdown; the marker says ours is deeper.
    expect(markdownToBlocks("   1. 押金\n   2. 维修")[0]?.attrs).toEqual({ start: 1 });
    expect(markdownToBlocks("<!-- start-level: 1 -->\n   1. 押金")[0]).toMatchObject({
      type: "orderedList",
      attrs: { start: 1, startLevel: 1 },
    });
    expect(markdownToBlocks("1. Rent")[0]?.attrs).toEqual({ start: 1 });
  });

  // protects=a model's reply indented four spaces or more stays the text it is, a list only under the export's level comment, nested items and all; fails_when="Intro:\n    - a" or an indented "1." line reads as a list; no_claim=CommonMark's indented code, which the reader doesn't draw.
  test("an indented line in a reply is a list only under the export's level comment", () => {
    expect(markdownToBlocks("Intro:\n    - a").map((block) => block.type)).toEqual(["paragraph"]);
    expect(markdownToBlocks("Steps:\n\n      1. Rent").map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);

    const [deeper, after] = markdownToBlocks(
      "<!-- start-level: 2 -->\n      1. 租金\n         1. 月付\n      2. 押金\n\nThen.",
    );
    expect(deeper).toMatchObject({ type: "orderedList", attrs: { start: 1, startLevel: 2 } });
    expect(deeper?.content?.length).toBe(2);
    expect(deeper?.content?.[0]?.content?.[1]?.type).toBe("orderedList");
    expect(after?.type).toBe("paragraph");
  });
});
