/**
 * Comments on a Mind's text and Word (#328): a file's comments, replies and
 * resolved state import onto their words; the export writes them back as
 * Word's own, with replies as threads and resolved ones done; and a comment
 * made here goes into a file imported from Word, or into a new one, with its
 * range on its words.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { convertToPdf, findLibreOffice } from "../../eval/word/libreoffice";
import type { Core } from "../../src/core";
import { MIND_COMMENTS_FIELD } from "../../src/core/api";
import { mindCommentsOf } from "../../src/shared/mindComments";
import { wordFileOf, wordImportProgressOf } from "../../src/shared/wordFiles";
import { createTempDataFolder, startCore } from "../helpers/core";
import { checkWellFormed, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { commented, paragraph, run, type WordFileInput, wordFile } from "../helpers/word";

const W15 = "http://schemas.microsoft.com/office/word/2012/wordml";
const EXTENDED_REL = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const ROOT_PARA = "1A2B3C4D";
const REPLY_PARA = "1A2B3C4E";
const OPEN_PARA = "1A2B3C4F";

/** A Word file whose first paragraph carries a resolved comment with a reply, its second an open one. */
function commentedFile(): Buffer {
  // Word's own layout for a reply: the parent's range starts first, then the reply's, and the
  // reply's ends last, so the reply's words are the parent's (#328).
  const words = run("Revenue grew 12%.");
  const replyRange =
    '<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>' +
    words +
    '<w:commentRangeEnd w:id="0"/>' +
    '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>' +
    '<w:commentRangeEnd w:id="1"/>' +
    '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>';
  const open = commented(2, "Luis Ortega", "Looks right.", run("Costs fell 3%."));
  const comments = [
    `<w:comment w:id="0" w:author="Dana Kim" w:date="2026-10-02T09:00:00"><w:p w14:paraId="${ROOT_PARA}"><w:r><w:annotationRef/></w:r>${run("Check this number.")}</w:p></w:comment>`,
    `<w:comment w:id="1" w:author="Dana Kim" w:date="2026-10-02T10:00:00Z"><w:p w14:paraId="${REPLY_PARA}"><w:r><w:annotationRef/></w:r>${run("Fixed it.")}</w:p></w:comment>`,
    `<w:comment w:id="2" w:author="Luis Ortega" w:date="2026-10-02T11:00:00Z"><w:p w14:paraId="${OPEN_PARA}"><w:r><w:annotationRef/></w:r>${run("Looks right.")}</w:p></w:comment>`,
  ].join("");
  const extended =
    `${DECLARATION}<w15:commentsEx xmlns:w15="${W15}">` +
    `<w15:commentEx w15:paraId="${ROOT_PARA}" w15:done="1"/>` +
    `<w15:commentEx w15:paraId="${REPLY_PARA}" w15:paraIdParent="${ROOT_PARA}"/>` +
    `<w15:commentEx w15:paraId="${OPEN_PARA}"/>` +
    "</w15:commentsEx>";
  const input: WordFileInput = {
    body: `${paragraph(`${replyRange}${run(" The rest.")}`)}${paragraph(open.inline)}`,
    comments,
    rels: `<Relationship Id="rIdCommentsExtended" Type="${EXTENDED_REL}" Target="commentsExtended.xml"/>`,
    parts: [{ name: "word/commentsExtended.xml", data: extended }],
  };
  return wordFile(input);
}

async function importFile(core: Core, bytes: Buffer) {
  const folder = await createTempDataFolder();
  const path = join(folder, "Comments.docx");
  await writeFileSync(path, bytes);
  const result = await core.importWordFile({ path, origin: "someone-else" });
  if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
  const client = await connectToMind(core, result.mind.id);
  await new Promise<void>((resolve) => {
    const check = () => {
      if (wordFileOf(client.doc) && wordImportProgressOf(client.doc) === null) {
        client.doc.off("update", check);
        resolve();
      }
    };
    client.doc.on("update", check);
    check();
  });
  return { mindId: result.mind.id, client };
}

/** The text a comment's mark is on, in the Mind's Blocks. */
function wordsOf(client: MindClient, id: string): string {
  const words: string[] = [];
  const visit = (node: JSONContent) => {
    if (
      node.type === "text" &&
      (node.marks ?? []).some((mark) => mark.type === "comment" && mark.attrs?.id === id)
    ) {
      words.push(node.text ?? "");
    }
    for (const each of node.content ?? []) visit(each);
  };
  visit({ type: "doc", content: readMind(client).toJSON().content as JSONContent[] });
  return words.join("");
}

describe("comments in Word, in and out (#328)", () => {
  test("a file's comments, replies and resolved state import onto the same text, with their authors and dates", async () => {
    const core = startCore(await createTempDataFolder());
    const { client } = await importFile(core, commentedFile());
    const comments = mindCommentsOf(client.doc);
    expect(
      comments.map((comment) => ({
        author: comment.author,
        createdAt: comment.createdAt,
        text: comment.text,
        resolved: comment.resolvedAt !== null,
        replies: comment.replies.map((reply) => [reply.author, reply.text]),
      })),
    ).toEqual([
      {
        author: "Dana Kim",
        // No zone in the file: read as UTC, not as this computer's time.
        createdAt: "2026-10-02T09:00:00.000Z",
        text: "Check this number.",
        resolved: true,
        replies: [["Dana Kim", "Fixed it."]],
      },
      {
        author: "Luis Ortega",
        createdAt: "2026-10-02T11:00:00.000Z",
        text: "Looks right.",
        resolved: false,
        replies: [],
      },
    ]);
    expect(wordsOf(client, comments[0]?.id as string)).toBe("Revenue grew 12%.");
    expect(wordsOf(client, comments[1]?.id as string)).toBe("Costs fell 3%.");
    // A reply's range names the thread, not a second mark on the same words.
    expect(wordsOf(client, comments[0]?.replies[0]?.id as string)).toBe("");
    expect(comments[0]?.replies).toHaveLength(1);
    core.close();
  });

  test("exporting it back keeps the comments, the replies and the resolved state, and the package opens in LibreOffice", async () => {
    const core = startCore(await createTempDataFolder());
    const { mindId } = await importFile(core, commentedFile());
    const result = await core.exportMind(mindId, { format: "docx", trackChanges: true });
    expect(result.word?.notKept).toEqual([]);
    const files = unzip(result.data);
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    const extended = files.get("word/commentsExtended.xml")?.toString("utf8") ?? "";
    const rels = files.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "";
    checkWellFormed(comments);
    checkWellFormed(extended);
    expect(comments).toContain('w:author="Dana Kim"');
    expect(comments).toContain("Check this number.");
    expect(comments).toContain("Fixed it.");
    expect(comments).toContain('w:author="Luis Ortega"');
    expect(extended).toContain(`w15:paraId="${ROOT_PARA}" w15:done="1"`);
    expect(extended).toContain(`w15:paraId="${REPLY_PARA}" w15:paraIdParent="${ROOT_PARA}"`);
    expect(extended).toContain(`w15:paraId="${OPEN_PARA}"`);
    expect(rels).toContain(EXTENDED_REL);

    // The file it wrote reads back as the Mind does: comments, reply and resolved state.
    const again = await importFile(core, Buffer.from(result.data));
    const commentsAgain = mindCommentsOf(again.client.doc);
    expect(
      commentsAgain.map((comment) => [
        comment.text,
        comment.resolvedAt !== null,
        comment.replies.map((reply) => reply.text),
      ]),
    ).toEqual([
      ["Check this number.", true, ["Fixed it."]],
      ["Looks right.", false, []],
    ]);

    // Word's repair prompt: LibreOffice opens it headless where it is installed (CI); skipped elsewhere.
    const soffice = findLibreOffice();
    if (soffice) {
      const folder = mkdtempSync(join(tmpdir(), "incarnamind-comments-"));
      try {
        const path = join(folder, "Comments.docx");
        writeFileSync(path, result.data);
        const opened = await convertToPdf(soffice, path);
        expect(opened.opened, opened.problem).toBe(true);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
    core.close();
  }, 120_000);

  test("a comment made on an imported file goes back into it, with its range on its words", async () => {
    const core = startCore(await createTempDataFolder());
    const { mindId, client } = await importFile(core, commentedFile());
    const id = "a-comment-made-here";
    // The words after the file's own comment, which carry no comment mark yet.
    writeMind(client, [
      ...((readMind(client).toJSON().content ?? []) as JSONContent[]).map((block, at) =>
        at === 0
          ? {
              ...block,
              content: (block.content ?? []).map((node) =>
                node.type === "text" && !(node.marks ?? []).some((mark) => mark.type === "comment")
                  ? { ...node, marks: [...(node.marks ?? []), { type: "comment", attrs: { id } }] }
                  : node,
              ),
            }
          : block,
      ),
    ]);
    client.doc.getMap(MIND_COMMENTS_FIELD).set(id, {
      id,
      author: null,
      createdAt: "2026-10-03T09:00:00Z",
      text: "Make this clearer.",
      resolvedAt: null,
      replies: [],
    });
    await client.settled();
    // The file is someone else's: the User asks for their comment to go into it.
    const result = await core.exportMind(mindId, {
      format: "docx",
      trackChanges: true,
      includeMyComments: true,
    });
    expect(result.word?.notKept).toEqual([]);
    const files = unzip(result.data);
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";
    const extended = files.get("word/commentsExtended.xml")?.toString("utf8") ?? "";
    checkWellFormed(comments);
    checkWellFormed(extended);
    expect(comments).toContain("Make this clearer.");
    expect(comments).toContain('w:author="Priya Raman"');
    // Its range is around the commented words, and its mark follows them.
    const start = document.indexOf("The rest.");
    expect(start).toBeGreaterThan(0);
    expect(document.slice(0, start)).toMatch(/<w:commentRangeStart w:id="\d+"\/>/);
    expect(document).toMatch(/<w:commentRangeEnd w:id="\d+"\/>/);
    expect(comments).toContain("Make this clearer.");
    expect([...extended.matchAll(/<w15:commentEx /g)]).toHaveLength(4);
    core.close();
  });

  test("someone else's file leaves the User's comments out unless asked, and keeps the file's own", async () => {
    const core = startCore(await createTempDataFolder());
    const { mindId, client } = await importFile(core, commentedFile());
    const id = "my-comment";
    const blocks = (readMind(client).toJSON().content ?? []) as JSONContent[];
    writeMind(
      client,
      blocks.map((block, at) =>
        at === 0
          ? {
              ...block,
              content: (block.content ?? []).map((node) =>
                node.type === "text" && node.text === " The rest."
                  ? { ...node, marks: [...(node.marks ?? []), { type: "comment", attrs: { id } }] }
                  : node,
              ),
            }
          : block,
      ),
    );
    const map = client.doc.getMap(MIND_COMMENTS_FIELD);
    map.set(id, {
      id,
      author: null,
      createdAt: "2026-10-03T09:00:00Z",
      text: "My own note to self.",
      resolvedAt: null,
      replies: [],
    });
    const root = mindCommentsOf(client.doc)[0];
    const held = root ? (map.get(root.id) as Record<string, unknown>) : undefined;
    map.set(root?.id as string, {
      ...held,
      replies: [
        ...((held?.replies as unknown[]) ?? []),
        {
          id: "my-reply",
          author: null,
          createdAt: "2026-10-03T10:00:00Z",
          text: "My reply to Dana.",
        },
        {
          id: "assistant-reply",
          author: "IncarnaMind",
          createdAt: "2026-10-03T10:01:00Z",
          text: "Answered in the text.",
        },
      ],
    });
    await client.settled();

    const left = await core.exportMind(mindId, { format: "docx" });
    expect(left.myComments).toBe(2);
    expect(left.myCommentsShown).toBe(false);
    expect(left.myCommentsOptional).toBe(true);
    const without = unzip(left.data).get("word/comments.xml")?.toString("utf8") ?? "";
    expect(without).not.toContain("My own note to self.");
    expect(without).not.toContain("My reply to Dana.");
    expect(without).not.toContain("Answered in the text.");
    // The file's own comments and replies always go back.
    expect(without).toContain("Check this number.");
    expect(without).toContain("Fixed it.");

    const asked = await core.exportMind(mindId, { format: "docx", includeMyComments: true });
    expect(asked.myComments).toBe(2);
    expect(asked.myCommentsShown).toBe(true);
    const with_ = unzip(asked.data).get("word/comments.xml")?.toString("utf8") ?? "";
    expect(with_).toContain("My own note to self.");
    expect(with_).toContain("My reply to Dana.");
    expect(with_).toContain("Answered in the text.");
    core.close();
  });

  test("a reply made here on a file's comment goes back with its own range beside the comment's", async () => {
    const core = startCore(await createTempDataFolder());
    const { mindId, client } = await importFile(core, commentedFile());
    const root = mindCommentsOf(client.doc)[0];
    const reply = {
      id: "reply-made-here",
      author: null,
      createdAt: "2026-10-03T12:00:00Z",
      text: "Confirmed against the ledger.",
    };
    const map = client.doc.getMap(MIND_COMMENTS_FIELD);
    const held = root ? (map.get(root.id) as Record<string, unknown>) : undefined;
    expect(held).toBeDefined();
    map.set(root?.id as string, {
      ...held,
      replies: [...((held?.replies as unknown[]) ?? []), reply],
    });
    await client.settled();
    const result = await core.exportMind(mindId, {
      format: "docx",
      trackChanges: true,
      includeMyComments: true,
    });
    expect(result.word?.notKept).toEqual([]);
    const files = unzip(result.data);
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";
    const extended = files.get("word/commentsExtended.xml")?.toString("utf8") ?? "";
    checkWellFormed(document);
    checkWellFormed(comments);
    checkWellFormed(extended);
    expect(comments).toContain("Confirmed against the ledger.");
    // The file's own comments and their reply keep their ids; the new reply gets its own range and mark.
    const replyId = [
      ...comments.matchAll(/<w:comment w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g),
    ].find((each) => (each[2] ?? "").includes("Confirmed against the ledger."))?.[1];
    if (replyId === undefined) throw new Error("The new reply has no comment in the file.");
    expect(replyId).not.toMatch(/^[012]$/);
    expect(document).toContain(`<w:commentRangeStart w:id="${replyId}"/>`);
    expect(document).toContain(`<w:commentRangeEnd w:id="${replyId}"/>`);
    expect(document).toContain(`<w:commentReference w:id="${replyId}"/>`);
    // Its range is on the parent's words, and its paragraph says which comment it answers.
    const start = document.indexOf("Revenue grew 12%.");
    expect(document.slice(0, start)).toContain(`<w:commentRangeStart w:id="${replyId}"/>`);
    expect(extended).toContain(`w15:paraIdParent="${ROOT_PARA}"`);
    core.close();
  });

  test("a comment made here whose words are deleted is reported, even when tracking keeps the deleted paragraph", async () => {
    const core = startCore(await createTempDataFolder());
    const { mindId, client } = await importFile(core, commentedFile());
    const id = "comment-on-later-words";
    const blocks = (readMind(client).toJSON().content ?? []) as JSONContent[];
    const marked = blocks.map((block, at) =>
      at === 0
        ? {
            ...block,
            content: (block.content ?? []).map((node) =>
              node.type === "text" && node.text === " The rest."
                ? { ...node, marks: [...(node.marks ?? []), { type: "comment", attrs: { id } }] }
                : node,
            ),
          }
        : block,
    );
    writeMind(client, marked);
    client.doc.getMap(MIND_COMMENTS_FIELD).set(id, {
      id,
      author: null,
      createdAt: "2026-10-03T09:00:00Z",
      text: "Cut this.",
      resolvedAt: null,
      replies: [],
    });
    await client.settled();
    // Then the words go altogether, as deleting them with tracking off would leave the Mind.
    writeMind(
      client,
      marked.map((block, at) =>
        at === 0
          ? {
              ...block,
              content: (block.content ?? []).filter((node) => node.text !== " The rest."),
            }
          : block,
      ),
    );
    await client.settled();
    const result = await core.exportMind(mindId, {
      format: "docx",
      trackChanges: true,
      includeMyComments: true,
    });
    expect(result.word?.notKept).toMatchObject([{ kind: "comment", text: "Cut this." }]);
    core.close();
  });

  test("an empty comment's text is never written, and leaves no reference in the file", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Empty comment" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Draft.", marks: [{ type: "comment", attrs: { id: "empty" } }] },
        ],
      },
    ]);
    client.doc.getMap(MIND_COMMENTS_FIELD).set("empty", {
      id: "empty",
      author: null,
      createdAt: "2026-10-03T09:00:00Z",
      text: "   ",
      resolvedAt: null,
      replies: [],
    });
    await client.settled();
    const result = await core.exportMind(mind.id, { format: "docx" });
    const files = unzip(result.data);
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    checkWellFormed(document);
    if (comments) checkWellFormed(comments);
    expect(document).toContain("Draft.");
    expect(document).not.toMatch(/<w:commentRange(?:Start|End) /);
    expect(document).not.toContain("<w:commentReference");
    expect(comments).not.toContain("<w:comment ");
    expect(result.word?.notKept ?? []).toEqual([]);
    core.close();
  });

  test("a file's comment with no author is the file's, not the User's (#328)", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Their comment" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Mine.", marks: [{ type: "comment", attrs: { id: "u" } }] },
          { type: "text", text: " " },
          {
            type: "text",
            text: "The file's.",
            marks: [{ type: "comment", attrs: { id: "i" } }],
          },
        ],
      },
    ]);
    const map = client.doc.getMap(MIND_COMMENTS_FIELD);
    map.set("u", {
      id: "u",
      author: null,
      createdAt: "2026-10-03T09:00:00Z",
      text: "Mine.",
      resolvedAt: null,
      replies: [],
    });
    map.set("i", {
      id: "i",
      author: null,
      createdAt: "2026-10-02T09:00:00Z",
      text: "The file's.",
      resolvedAt: null,
      replies: [],
      word: { id: 5, paraId: "1A2B3C4D" },
    });
    await client.settled();
    const result = await core.exportMind(mind.id, { format: "docx", includeMyComments: false });
    expect(result.myComments).toBe(1);
    expect(result.myCommentsShown).toBe(false);
    const comments = unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "";
    expect(comments).toContain("The file's.");
    expect(comments).not.toContain("Mine.");
    core.close();
  });

  test("a new Mind's comments export as Word comments, with a reply linked to its comment", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Comments" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "The figure is 12%.",
            marks: [{ type: "comment", attrs: { id: "c1" } }],
          },
        ],
      },
    ]);
    // A comment whose words were deleted has no range: the file doesn't get a dangling comment.
    client.doc.getMap(MIND_COMMENTS_FIELD).set("c2", {
      id: "c2",
      author: null,
      createdAt: "2026-10-03T11:00:00Z",
      text: "This comment has no words.",
      resolvedAt: null,
      replies: [],
    });
    client.doc.getMap(MIND_COMMENTS_FIELD).set("c1", {
      id: "c1",
      author: null,
      createdAt: "2026-10-03T09:00:00Z",
      text: "Is this the audited figure?",
      resolvedAt: null,
      replies: [
        {
          id: "r1",
          author: null,
          createdAt: "2026-10-03T10:00:00Z",
          text: "Yes, audited.",
        },
      ],
    });
    await client.settled();

    const result = await core.exportMind(mind.id, { format: "docx" });
    // The User's own Note always includes their comments and replies, and offers no choice.
    expect(result.myComments).toBe(2);
    expect(result.myCommentsShown).toBe(true);
    expect(result.myCommentsOptional).toBe(false);
    // The comment with no words left is said before saving, as an imported file's is.
    expect(result.word?.notKept).toMatchObject([
      { kind: "comment", author: null, text: "This comment has no words." },
    ]);
    const files = unzip(result.data);
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    const extended = files.get("word/commentsExtended.xml")?.toString("utf8") ?? "";
    checkWellFormed(document);
    checkWellFormed(comments);
    checkWellFormed(extended);
    const range = document.match(/<w:commentRangeStart w:id="(\d+)"\/>/)?.[1];
    expect(range).toBeDefined();
    expect(document).toContain(`<w:commentRangeStart w:id="${range}"/>`);
    expect(document).toMatch(new RegExp(`<w:commentRangeEnd w:id="${range}"/>`));
    expect(document).toMatch(new RegExp(`<w:commentReference w:id="${range}"/>`));
    expect(comments).toContain("Is this the audited figure?");
    expect(comments).toContain("Yes, audited.");
    expect(comments).not.toContain("This comment has no words.");
    // A new comment's date is UTC, as Word writes it (#328).
    expect(comments).toMatch(/w:date="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z"/);
    // The reply has a range and reference of its own around the comment's words (#328).
    const replyId = [
      ...comments.matchAll(/<w:comment w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g),
    ].find((each) => (each[2] ?? "").includes("Yes, audited."))?.[1];
    if (replyId === undefined) throw new Error("The reply has no comment in the file.");
    expect(document).toContain(`<w:commentRangeStart w:id="${replyId}"/>`);
    expect(document).toContain(`<w:commentRangeEnd w:id="${replyId}"/>`);
    expect(document).toContain(`<w:commentReference w:id="${replyId}"/>`);
    const types = files.get("[Content_Types].xml")?.toString("utf8") ?? "";
    expect(types).toContain("wordprocessingml.comments+xml");
    expect(types).toContain("wordprocessingml.commentsExtended+xml");
    // Two comments, the reply linked to its parent through their paragraph ids.
    const paraIds = [...extended.matchAll(/w15:paraId="([^"]+)"/g)].map((each) => each[1]);
    expect(paraIds).toHaveLength(2);
    expect(extended).toContain(`w15:paraIdParent="${paraIds[0]}"`);
    core.close();
  });
});
