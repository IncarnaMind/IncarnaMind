import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { undoStackOf } from "../../src/renderer/src/editor/editorUndo";
import { tidyNote } from "../../src/renderer/src/editor/tidyNote";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, headlessEditor } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

const text = (value: string, marks?: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks: marks.map((type) => ({ type })) }),
});

const marked = (
  value: string,
  marks: { type: string; attrs?: Record<string, unknown> }[],
): JSONContent => ({ type: "text", text: value, marks });

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const editorWith = (content: JSONContent[]) => {
  const editor = headlessEditor();
  editor.commands.setContent({ type: "doc", content });
  return editor;
};

const paragraphsIn = (editor: ReturnType<typeof headlessEditor>) => {
  const paragraphs: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "paragraph") paragraphs.push(node.textContent);
  });
  return paragraphs;
};

const marksIn = (editor: ReturnType<typeof headlessEditor>) => {
  const runs: { text: string; marks: string[] }[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText)
      runs.push({ text: node.text ?? "", marks: node.marks.map((m) => m.type.name) });
  });
  return runs;
};

describe("tidying Chinese text in the Note", () => {
  test("reaches lists, quotes, tables and Answers", () => {
    const editor = editorWith([
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(text("导出为Word文件"))] }],
      },
      { type: "blockquote", content: [paragraph(text("引用Word文件"))] },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [paragraph(text("表格Word文件"))] }],
          },
        ],
      },
      { type: "answer", content: [paragraph(text("回答Word文件"))] },
    ]);

    tidyNote(editor);

    expect(paragraphsIn(editor)).toEqual([
      "导出为 Word 文件",
      "引用 Word 文件",
      "表格 Word 文件",
      "回答 Word 文件",
    ]);
  });

  test("keeps each run's marks, and writes one space between runs", () => {
    const bold = editorWith([paragraph(text("潮汐", ["bold"]), text("document"))]);
    tidyNote(bold);
    expect(bold.state.doc.textContent).toBe("潮汐 document");
    expect(marksIn(bold)).toContainEqual({ text: "潮汐", marks: ["bold"] });
    expect(marksIn(bold).find((run) => run.text.includes("document"))?.marks).not.toContain("bold");

    const link = editorWith([
      paragraph(
        marked("例子", [{ type: "link", attrs: { href: "https://example.com" } }]),
        text("document"),
      ),
    ]);
    tidyNote(link);
    expect(link.state.doc.textContent).toBe("例子 document");
    expect(marksIn(link)).toContainEqual({ text: "例子", marks: ["link"] });
    expect(marksIn(link).find((run) => run.text.includes("document"))?.marks).not.toContain("link");

    const checked = editorWith([
      paragraph(
        marked("句子", [{ type: "claimCheck", attrs: { id: "c1", text: "句子" } }]),
        text("document"),
      ),
    ]);
    tidyNote(checked);
    expect(checked.state.doc.textContent).toBe("句子 document");
    expect(marksIn(checked)).toContainEqual({ text: "句子", marks: ["claimCheck"] });
    expect(marksIn(checked).find((run) => run.text.includes("document"))?.marks).not.toContain(
      "claimCheck",
    );
  });

  test("a whole Note is one Undo step", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tidy" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [paragraph(text("导出为Word文件")), paragraph(text("引用Word文件"))]);
    await client.settled();
    const editor = boundEditor(client);

    tidyNote(editor);
    expect(editor.state.doc.textContent).toBe("导出为 Word 文件引用 Word 文件");
    const stack = undoStackOf(editor);
    expect(stack?.undoStack).toHaveLength(1);
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe("导出为Word文件引用Word文件");
  });
});
