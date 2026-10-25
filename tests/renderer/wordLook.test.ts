import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, onTestFinished, test } from "vitest";
import { PARAGRAPH_FORMAT_ATTRIBUTE, WORD_LOOK_ATTRIBUTE, WORD_RUN_MARK } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, typeText } from "../helpers/editor";
import { readMind } from "../helpers/minds";
import { paragraph, run, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

async function editorOnImport() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const centred = '<w:pPr><w:jc w:val="center"/></w:pPr>';
  const right = '<w:pPr><w:jc w:val="right"/></w:pPr>';
  const bytes = wordFile({
    body: [
      paragraph(run("Mostly plain text, then ") + run("bold", { b: true })).replace(
        "<w:p>",
        `<w:p>${centred}`,
      ),
      paragraph(run("Second paragraph")).replace("<w:p>", `<w:p>${right}`),
    ].join(""),
  });
  const { client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
  return { editor: boundEditor(client), client };
}

const lookOf = (node: ProseMirrorNode | undefined) => ({
  look: node?.attrs[WORD_LOOK_ATTRIBUTE] ?? null,
  format: node?.attrs[PARAGRAPH_FORMAT_ATTRIBUTE] ?? null,
});

const runsOf = (node: ProseMirrorNode | undefined) => {
  const runs: [string, string | null][] = [];
  node?.forEach((child) => {
    const mark = child.marks.find((each) => each.type.name === WORD_RUN_MARK);
    runs.push([child.text ?? "", mark ? String(mark.attrs.k) : null]);
  });
  return runs;
};

function cursorAfter(editor: Editor, text: string): void {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText || !node.text) return;
    const index = node.text.indexOf(text);
    if (index >= 0) at = pos + index + text.length;
  });
  if (at < 0) throw new Error(`No "${text}".`);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
}

describe("typing in a Mind imported from Word keeps the file's look", () => {
  test("Enter gives the new paragraph the look of the one it came from, and Undo takes it back", async () => {
    const { editor } = await editorOnImport();
    const first = lookOf(editor.state.doc.child(0));
    expect(first.format).toEqual({ align: "center" });
    expect(first.look).not.toBeNull();
    cursorAfter(editor, "bold");
    editor.commands.splitBlock();
    typeText(editor, "Typed");
    expect(editor.state.doc.childCount).toBe(3);
    expect(lookOf(editor.state.doc.child(1))).toEqual(first);

    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
  });

  test("text typed at a marked run's end takes its look; Undo takes it back", async () => {
    const { editor, client } = await editorOnImport();
    const bold = runsOf(editor.state.doc.child(0)).at(-1)?.[1];
    expect(bold).not.toBeNull();
    cursorAfter(editor, "bold");
    typeText(editor, "er");
    expect(runsOf(editor.state.doc.child(0)).at(-1)).toEqual(["bolder", bold]);
    await client.settled();
    expect(runsOf(readMind(client).child(0)).at(-1)).toEqual(["bolder", bold]);

    editor.commands.undo();
    expect(runsOf(editor.state.doc.child(0)).at(-1)).toEqual(["bold", bold]);
  });

  test("joining two paragraphs keeps the first one's look, and the moved text its own marks", async () => {
    const { editor } = await editorOnImport();
    const first = lookOf(editor.state.doc.child(0));
    const second = editor.state.doc.child(1);
    expect(lookOf(second)).not.toEqual(first);
    cursorAfter(editor, "bold");
    editor.commands.joinForward();
    expect(editor.state.doc.childCount).toBe(1);
    expect(lookOf(editor.state.doc.child(0))).toEqual(first);
    expect(runsOf(editor.state.doc.child(0)).at(-1)).toEqual(runsOf(second).at(-1));

    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
    expect(lookOf(editor.state.doc.child(1))).toEqual(lookOf(second));
  });
});
