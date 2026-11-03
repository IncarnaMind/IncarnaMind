/**
 * Typing in a Note imported from Word takes the file's look, as typing in Word does, and export
 * writes it back as Word properties while every part the User didn't type in stays the file's own
 * bytes (#746, against #105's export). The assistant's Proposals are drawn in the paragraph's look
 * on screen, and an accepted one goes out in its run's own colour.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, onTestFinished, test } from "vitest";
import { WORD_LOOK_ATTRIBUTE } from "../../src/core";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { unzip } from "../helpers/docx";
import { boundEditor, typeText } from "../helpers/editor";
import { readMind, resolveChanges } from "../helpers/minds";
import { streamedReply } from "../helpers/models";
import { NUMBERING, paragraph, run, wordFile } from "../helpers/word";
import { contractFile } from "../helpers/wordLookFiles";
import { importWordBytes } from "../helpers/wordMinds";

async function opened(bytes: Buffer) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const { client, mindId } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
  return { core, client, mindId, editor: boundEditor(client) };
}

/** A position in the editor's text: just after `text`, or its start with `start`. */
function placeOf(editor: Editor, text: string, { start = false } = {}): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText || !node.text) return;
    const index = node.text.indexOf(text);
    if (index >= 0) at = pos + index + (start ? 0 : text.length);
  });
  if (at < 0) throw new Error(`No "${text}".`);
  return at;
}

function select(editor: Editor, from: number, to = from): void {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

/** The body's top-level elements of a document part, each as its exact text. */
function bodyChildren(xml: string): string[] {
  const body = xml.slice(xml.indexOf("<w:body>") + 8, xml.lastIndexOf("<w:sectPr"));
  const children: string[] = [];
  let at = 0;
  while (at < body.length) {
    const name = /^<(w:[a-zA-Z]+)/.exec(body.slice(at))?.[1];
    if (!name) break;
    let depth = 0;
    let end = at;
    const open = new RegExp(`<${name}[\\s>/]|</${name}>`, "g");
    open.lastIndex = at;
    for (let match = open.exec(body); match; match = open.exec(body)) {
      depth += match[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = match.index + match[0].length;
        break;
      }
    }
    children.push(body.slice(at, end));
    at = end;
  }
  return children;
}

const documentOf = (data: Uint8Array) =>
  unzip(Buffer.from(data)).get("word/document.xml")?.toString("utf8") ?? "";

const pPrOf = (xml: string) => /<w:pPr>.*?<\/w:pPr>/.exec(xml)?.[0] ?? "";

function nodeWith(doc: ProseMirrorNode, text: string): ProseMirrorNode | undefined {
  let found: ProseMirrorNode | undefined;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isTextblock && node.textContent.includes(text)) found = node;
    return !found;
  });
  return found;
}

describe("typing in a Word Note keeps the file's look, and export writes the rest as it was", () => {
  test("Enter in a justified clause makes one with its properties; every other part is the file's own bytes", async () => {
    const bytes = contractFile();
    const { core, client, mindId, editor } = await opened(bytes);
    select(editor, placeOf(editor, "45 days’ notice."));
    editor.commands.splitBlock();
    typeText(editor, "2.2\tDeliveries are made within five working days.");
    const typed = nodeWith(editor.state.doc, "Deliveries are made");
    expect(typed?.attrs[WORD_LOOK_ATTRIBUTE]).toBe(
      nodeWith(editor.state.doc, "Prices are fixed")?.attrs[WORD_LOOK_ATTRIBUTE],
    );
    await client.settled();

    const before = bodyChildren(documentOf(bytes));
    const after = bodyChildren(
      documentOf((await core.exportMind(mindId, { format: "docx" })).data),
    );
    expect(after).toHaveLength(before.length + 1);
    const added = after.filter((each) => !before.includes(each));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("Deliveries are made within five working days.");
    const clause = before.find((each) => each.includes("Prices are fixed")) ?? "";
    expect(pPrOf(added[0] ?? "")).toBe(pPrOf(clause));
    // Every part of the file but the new paragraph, in its place.
    expect(after.filter((each) => before.includes(each))).toEqual(before);
    expect(readMind(client).textContent).toContain("Deliveries are made");
  });

  test("text typed over a selection takes the look of what it replaces, and exports with its run's properties", async () => {
    const { core, client, mindId, editor } = await opened(contractFile());
    const term = nodeWith(editor.state.doc, "“Products”");
    const marksBefore = term?.firstChild?.marks.map((mark) => mark.type.name).sort();
    const from = placeOf(editor, "Products", { start: true });
    select(editor, from, from + "Products".length);
    typeText(editor, "Goods");
    const replaced = nodeWith(editor.state.doc, "“Goods”");
    expect(replaced?.firstChild?.text).toBe("“Goods”");
    expect(replaced?.firstChild?.marks.map((mark) => mark.type.name).sort()).toEqual(marksBefore);
    expect(marksBefore).toContain("bold");
    await client.settled();
    const xml = documentOf((await core.exportMind(mindId, { format: "docx" })).data);
    const goods = /<w:r>(?:(?!<\/w:r>).)*Goods(?:(?!<\/w:r>).)*<\/w:r>/.exec(xml)?.[0] ?? "";
    expect(goods).toContain('<w:rStyle w:val="Defined"/>');
  });

  test("a new list item takes its neighbour's look and its numbering", async () => {
    const indented = '<w:ind w:left="720" w:hanging="360"/>';
    const item = (text: string) =>
      paragraph(run(text), { numId: 2 }).replace("</w:numPr>", `</w:numPr>${indented}`);
    const bytes = wordFile({
      numbering: NUMBERING,
      body: [paragraph("Terms"), item("Payment within 30 days."), item("Delivery by road.")].join(
        "",
      ),
    });
    const { core, client, mindId, editor } = await opened(bytes);
    const neighbour = nodeWith(editor.state.doc, "Payment within")?.attrs[WORD_LOOK_ATTRIBUTE];
    expect(neighbour).toEqual(expect.any(String));
    select(editor, placeOf(editor, "Payment within 30 days."));
    editor.commands.splitListItem("listItem");
    typeText(editor, "Prices in pounds.");
    expect(nodeWith(editor.state.doc, "Prices in pounds.")?.attrs[WORD_LOOK_ATTRIBUTE]).toBe(
      neighbour,
    );
    await client.settled();
    const after = bodyChildren(
      documentOf((await core.exportMind(mindId, { format: "docx" })).data),
    );
    const added = after.find((each) => each.includes("Prices in pounds.")) ?? "";
    expect(added).toContain('<w:numId w:val="2"/>');
    expect(pPrOf(added)).toBe(pPrOf(after.find((each) => each.includes("Payment within")) ?? ""));
  });
});

const COLOURED = wordFile({
  styles:
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Book Antiqua" w:hAnsi="Book Antiqua"/><w:sz w:val="22"/></w:rPr></w:style>',
  body: `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:color w:val="1F3864"/></w:rPr><w:t xml:space="preserve">Prices are fixed for the first twelve months at the rates in Schedule 2.</w:t></w:r></w:p>`,
});

describe("the assistant's Proposals in a Word Note", () => {
  test("accepting one in a justified Book Antiqua paragraph exports it in the run's own colour and font", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ tags: [] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
      doStream: async ({ abortSignal }) => ({
        stream: streamedReply(
          "Prices are held for the first twelve months at the rates in Schedule 2.",
          abortSignal,
        ),
      }),
    });
    const { core, dataDir } = await setUpWithDocuments(model, []);
    onTestFinished(() => core.close());
    const { client, mindId } = await importWordBytes(core, dataDir, COLOURED, { origin: "own" });
    const clause = readMind(client).firstChild;
    const text = clause?.textContent ?? "";
    const result = await core.editWithAi({
      requestId: "edit-1",
      mindId,
      from: { blockId: String(clause?.attrs.id), offset: 0 },
      to: { blockId: String(clause?.attrs.id), offset: text.length },
      text,
      action: "improve",
    });
    expect(result.kind).toBe("proposed");
    await resolveChanges(client, "accept");
    expect(readMind(client).textContent).toContain("Prices are held");
    const xml = documentOf((await core.exportMind(mindId, { format: "docx" })).data);
    const held = /<w:r>(?:(?!<\/w:r>).)*held(?:(?!<\/w:r>).)*<\/w:r>/.exec(xml)?.[0] ?? "";
    expect(held).toContain('<w:color w:val="1F3864"/>');
    expect(xml).toContain('<w:jc w:val="both"/>');
    // The run's look stays its own: no font or colour of the app's is written.
    expect(held).not.toMatch(/3B4048/i);
  });
});
