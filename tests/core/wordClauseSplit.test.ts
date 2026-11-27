/**
 * Enter in a Note imported from a Word file, typed as the User types it, and what the exported
 * file shows for it (#746). Words typed at the start of a paragraph and then Enter make a new
 * paragraph before it, and the paragraph goes on as itself: its Block keeps its id, and the file
 * neither strikes its words out nor writes them again. A paragraph edited in place with a new one
 * added after it is that edit and that new paragraph, whatever the new one says.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, onTestFinished, test } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import { WordMarkerKeys } from "../../src/renderer/src/editor/wordMarkerKeys";
import { createTempDataFolder, startCore } from "../helpers/core";
import { acceptedParagraphs, part, rejectedParagraphs, unzip } from "../helpers/docx";
import { boundEditor, clickIn, pressEnter, typeText } from "../helpers/editor";
import { paragraph, run, table, wordFile } from "../helpers/word";
import { CHINESE_CONTRACT, contractFile, ENGLISH_CONTRACT } from "../helpers/wordContracts";
import { importWordBytes } from "../helpers/wordMinds";

async function opened(bytes: Buffer) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
  const editor = boundEditor(client, [WordMarkerKeys]);
  const exported = async (trackChanges: boolean) => {
    await client.settled();
    const { data } = await core.exportMind(mindId, { format: "docx", trackChanges });
    expect((await inspectPackage(data)).problems).toEqual([]);
    return part(unzip(data), "word/document.xml");
  };
  return { editor, exported };
}

/** The id of the Block of the line whose words are `words`. */
function idOf(editor: Editor, words: string): unknown {
  let id: unknown;
  editor.state.doc.descendants((node) => {
    if (id === undefined && node.isTextblock && node.textContent === words) id = node.attrs.id;
    return id === undefined;
  });
  return id;
}

/** Selects `words` in the line that holds them, as a drag over them does. */
function selectWords(editor: Editor, words: string): void {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    const at = from < 0 && node.isText ? (node.text ?? "").indexOf(words) : -1;
    if (at >= 0) from = pos + at;
    return from < 0;
  });
  if (from < 0) throw new Error(`No "${words}".`);
  const { doc } = editor.state;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(doc, from, from + words.length)),
  );
}

const struck = (document: string) =>
  [...document.matchAll(/<w:delText[^>]*>([^<]*)<\/w:delText>/g)].map((each) => each[1]);

/** The words of each tracked insertion of text. */
const inserted = (document: string) =>
  [...document.matchAll(/<w:ins\b[^>]*[^/]>(.*?)<\/w:ins>/gs)].map((each) =>
    [...(each[1] ?? "").matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
  );

const FEES = wordFile({
  body: [paragraph(run("Fees"), { style: "Heading1" }), paragraph("Body text.")].join(""),
});

describe("a paragraph edited in place, then a new one added after it", () => {
  // protects=a clause or heading changed in place and a new paragraph typed after it, with Enter at its end, are that change and that new paragraph in the tracked file: the changed word struck and the new one inserted, the new paragraph inserted whole, even when it repeats the clause's own words as the file had them, in English and Chinese; fails_when=the clause is shown as wholly new and the new paragraph as the clause rewritten, or the edited word isn't the only one struck; no_claim=the words typed at a clause's start and then Enter, which the next describe holds.
  const ENGLISH = contractFile(ENGLISH_CONTRACT);
  const CHINESE = contractFile(CHINESE_CONTRACT);
  const OWN_WORDS = "Unpaid fees carry interest at 2% a month.";
  const OWN_CHINESE = "逾期未付的服务费按每月百分之二计收利息。";
  test.each([
    [
      "English",
      ENGLISH,
      ["Unpaid", "Overdue"],
      "Unpaid invoices may be sent to a collection agency.",
    ],
    [
      "English, the new clause in the clause's own words",
      ENGLISH,
      ["Unpaid", "Overdue"],
      OWN_WORDS,
    ],
    [
      "Chinese",
      CHINESE,
      ["逾期未付", "逾期付款", "未付", "付款"],
      "逾期未付超过九十日的，另计违约金。",
    ],
    [
      "Chinese, the new clause in the clause's own words",
      CHINESE,
      ["逾期未付", "逾期付款", "未付", "付款"],
      OWN_CHINESE,
    ],
    ["a heading", FEES, ["Fees", "Charges"], "Fees are due monthly."],
    ["a heading, the new paragraph in its own words", FEES, ["Fees", "Charges"], "Fees"],
  ] as const)("%s", async (_case, bytes, [from, to, gone = from, put = to], added) => {
    const { editor, exported } = await opened(bytes);
    selectWords(editor, from);
    typeText(editor, to);
    const { $head } = editor.state.selection;
    const edited = $head.parent.textContent;
    const id = $head.parent.attrs.id;
    clickIn(editor, edited, { end: true });
    pressEnter(editor);
    typeText(editor, added);
    expect(idOf(editor, edited)).toBe(id);
    const document = await exported(true);
    expect(struck(document)).toEqual([gone]);
    expect(inserted(document)).toEqual(expect.arrayContaining([put, added]));
    expect(acceptedParagraphs(document)).toEqual(expect.arrayContaining([edited, added]));
    expect(rejectedParagraphs(document)).not.toContain(edited);
  });
});

describe("words typed at the start of a paragraph, then Enter", () => {
  const CELL = wordFile({
    body: [
      paragraph("Before."),
      table([
        ["Party", "Alder & Finch Ltd pays the fee."],
        ["Term", "Twelve months."],
      ]),
    ].join(""),
  });

  // protects=words typed at the start of a paragraph and then Enter, in a clause, a heading or a table cell, make the words a new paragraph before it: the paragraph's Block keeps its id, and the file strikes none of its words (only, in a contract, the old number of the cross-reference to the clause, which is now one further on), with the User's edits tracked or not, in English and Chinese; fails_when=the paragraph's words are struck out and written again, or the new words take its Block; no_claim=Enter in the middle of words the file had, which splits there as anywhere else.
  test.each([
    [
      "a clause",
      contractFile(ENGLISH_CONTRACT),
      "Unpaid fees carry interest at 2% a month.",
      "Late fees are capped at the fee itself.",
      true,
      ["2.3"],
    ],
    [
      "a clause, untracked",
      contractFile(ENGLISH_CONTRACT),
      "Unpaid fees carry interest at 2% a month.",
      "Late fees are capped at the fee itself.",
      false,
      [],
    ],
    [
      "a Chinese clause",
      contractFile(CHINESE_CONTRACT),
      "逾期未付的服务费按每月百分之二计收利息。",
      "滞纳金以服务费金额为限。",
      true,
      ["（三）"],
    ],
    ["a heading", FEES, "Fees", "Charges", true, []],
    ["a table cell", CELL, "Alder & Finch Ltd pays the fee.", "New words.", true, []],
    ["a table cell, untracked", CELL, "Alder & Finch Ltd pays the fee.", "New words.", false, []],
  ] as const)("%s", async (_case, bytes, words, typed, tracked, number) => {
    const { editor, exported } = await opened(bytes);
    const id = idOf(editor, words);
    clickIn(editor, words);
    typeText(editor, typed);
    pressEnter(editor);
    expect(idOf(editor, words)).toBe(id);
    expect(idOf(editor, typed)).toEqual(expect.any(String));
    expect(idOf(editor, typed)).not.toBe(id);
    const document = await exported(tracked);
    expect(struck(document)).toEqual(number);
    const accepted = acceptedParagraphs(document);
    expect(accepted.indexOf(typed)).toBeGreaterThanOrEqual(0);
    expect(accepted.indexOf(words)).toBe(accepted.indexOf(typed) + 1);
    if (tracked) expect(rejectedParagraphs(document)).not.toContain(typed);
  });

  // protects=Undo of that Enter gives back the paragraph exactly as it was before it, the words typed at its start and its Block id included, and Redo gives back the two paragraphs with their ids; fails_when=either leaves a Block with another id, or other words; no_claim=Undo of the typing, a step of its own.
  test("Undo and Redo of that Enter give back exactly what was there", async () => {
    const words = "Unpaid fees carry interest at 2% a month.";
    const { editor } = await opened(contractFile(ENGLISH_CONTRACT));
    clickIn(editor, words);
    typeText(editor, "Late fees are capped at the fee itself.");
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
    const before: JSONContent = editor.getJSON();
    pressEnter(editor);
    const after: JSONContent = editor.getJSON();
    expect(after).not.toEqual(before);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
  });

  // protects=typing a prefix at the start of an imported paragraph whose markers begin with a previous bookmark's END followed by a point bookmark and the paragraph's own START, then pressing Enter, leaves END before the inserted paragraph (so the inserted text stays outside the earlier bookmark), moves the point bookmark's START and END together with the clause's own START onto the original paragraph below, and exports cleanly without striking the original words; fails_when=END is moved down onto the original paragraph (pulling the inserted paragraph inside the earlier bookmark) or the point bookmark's START and END are split across paragraphs.
  test.each([true, false])(
    "leading closing bookmark stays above the prefix while opening and paired point markers move below (tracked=%s)",
    async (tracked) => {
      const bytes = wordFile({
        body: [
          `<w:p><w:bookmarkStart w:id="10" w:name="EarlierClause"/>${run("First clause.")}</w:p>`,
          `<w:p><w:bookmarkEnd w:id="10"/><w:bookmarkStart w:id="11" w:name="_GoBack"/><w:bookmarkEnd w:id="11"/><w:bookmarkStart w:id="12" w:name="SecondClause"/>${run("Second clause.")}<w:bookmarkEnd w:id="12"/></w:p>`,
        ].join(""),
      });
      const { editor, exported } = await opened(bytes);
      const id = idOf(editor, "Second clause.");
      clickIn(editor, "Second clause.");
      typeText(editor, "Inserted clause.");
      pressEnter(editor);
      expect(idOf(editor, "Second clause.")).toBe(id);

      const document = await exported(tracked);
      expect(struck(document)).toEqual([]);
      const endEarlier = document.indexOf('<w:bookmarkEnd w:id="10"');
      const insertedAt = document.indexOf("Inserted clause.");
      const startGoBack = document.indexOf('<w:bookmarkStart w:id="11"');
      const endGoBack = document.indexOf('<w:bookmarkEnd w:id="11"');
      const startSecond = document.indexOf('<w:bookmarkStart w:id="12"');
      const secondAt = document.indexOf("Second clause.");
      expect(endEarlier).toBeGreaterThan(-1);
      expect(endEarlier).toBeLessThan(insertedAt);
      expect(insertedAt).toBeLessThan(startGoBack);
      expect(startGoBack).toBeLessThan(endGoBack);
      expect(endGoBack).toBeLessThan(startSecond);
      expect(startSecond).toBeLessThan(secondAt);
    },
  );
});
