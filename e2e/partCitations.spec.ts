import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor, JSONContent } from "@tiptap/core";
import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckPart,
  CoreBridge,
} from "../src/core/api";
import { part as docxPart, unzip } from "../tests/helpers/docx";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";
import { pdfText } from "./pdfText";

/**
 * Add as Citation on a part's row (#2174): a supported part's Passage is cited right after that
 * part's words, never on the whole sentence, one Undo for each add; Add all cites the rest; and
 * a Word or PDF export carries each Citation where the Note has it.
 */
const CASES = {
  en: {
    first: "Revenue rose 8% in May",
    second: "costs fell in June",
    sentence: "Revenue rose 8% in May; costs fell in June.",
    sources: ["Revenue rose 8% in May.", "Costs fell in June."],
    quotes: ["Revenue rose 8% in May.", "Costs fell in June."],
  },
  "zh-CN": {
    first: "五月收入增长了8%",
    second: "六月成本下降了",
    sentence: "五月收入增长了8%；六月成本下降了。",
    sources: ["五月收入增长了8%。", "六月成本下降了。"],
    quotes: ["五月收入增长了8%。", "六月成本下降了。"],
  },
} as const;

const supported = (start: number, end: number, evidence: CitationAttributes): ClaimCheckPart => ({
  span: { start, end },
  kind: "fact",
  verdict: "supported",
  evidence: [evidence],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

async function setContent(window: Page, content: JSONContent[]) {
  await window.getByTestId("mind-editor").evaluate((dom, blocks) => {
    const editor = (dom as unknown as { editor: Editor }).editor;
    editor.commands.setContent(blocks);
    editor.commands.setTextSelection(1);
  }, content);
}

/** The Note's paragraph as text, each Citation written as [its Passage]. */
function written(window: Page) {
  return window.getByTestId("mind-editor").evaluate((dom) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    let text = "";
    state.doc.firstChild?.forEach((node) => {
      text += node.type.name === "citation" ? `[${node.attrs.passageId}]` : (node.text ?? "");
    });
    return text;
  });
}

/** A Word file's body text, each footnote reference written as [n]. */
const wordText = (xml: string) =>
  xml
    .replace(/<w:footnoteReference w:id="(\d+)"\/>/g, "[$1]")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&");

let data: string;
let sources: string;
let out: string;
test.beforeEach(async () => {
  data = await createDataFolder();
  sources = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(data);
  await removeDataFolder(sources);
  await removeDataFolder(out);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`each part's Citation goes after its words, one Undo an add, and Word and PDF cite it there (${language})`, async () => {
    test.setTimeout(180_000);
    const { first, second, sentence, sources: texts, quotes } = CASES[language];
    await writeFile(join(sources, "Revenue.txt"), texts[0]);
    await writeFile(join(sources, "Costs.txt"), texts[1]);
    const { app, window } = await launchApp(data, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Revenue.txt"), join(sources, "Costs.txt")]);
    const documents = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const cite = (passageId: string, name: string, quote: string): CitationAttributes => {
      const document = documents.find((each) => each.name === name);
      if (!document) throw new Error(`${name} was not added.`);
      return {
        id: `receipt-${passageId}`,
        passageId,
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        quote,
        pageFrom: null,
        pageTo: null,
        location: null,
        check: "found",
        checkReason: null,
      };
    };
    await newMind(window);
    await nameMind(window, "Memo");
    await setWindowSize(app, window, 1440, 900);
    const at = sentence.indexOf(second);
    const check: ClaimCheckAttributes = {
      id: "parts-check",
      request: "parts-citations",
      action: "check-against-documents",
      state: "supported",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      text: sentence,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: documents.map(({ id, contentHash }) => ({ documentId: id, contentHash })),
      excluded: [],
      checkedAt: "2026-10-29T20:00:00.000Z",
      parts: [
        supported(0, first.length, cite("first", "Revenue", quotes[0])),
        supported(at, at + second.length, cite("second", "Costs", quotes[1])),
      ],
    };
    await setContent(window, [
      {
        type: "paragraph",
        attrs: { id: "memo" },
        content: [{ type: "text", text: sentence, marks: [{ type: "claimCheck", attrs: check }] }],
      },
    ]);
    const mark = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");
    const between = sentence.slice(first.length, at);
    const end = sentence.slice(at + second.length);
    await expect(mark).toContainText("+");

    // One row's add: its Passage after its own words, and ⌘Z takes back that add alone.
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-parts-add-all")).toBeVisible();
    await pointAndClick(
      window,
      card.getByTestId("claim-part").first().getByTestId("claim-part-add-citation"),
    );
    await expect.poll(() => written(window)).toBe(`${first}[first]${between}${second}${end}`);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => written(window)).toBe(sentence);

    // Add all: each part's Passage after its words, as one step of Undo.
    await pointAndClick(window, mark);
    await pointAndClick(window, card.getByTestId("claim-parts-add-all"));
    const cited = `${first}[first]${between}${second}[second]${end}`;
    await expect.poll(() => written(window)).toBe(cited);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => written(window)).toBe(sentence);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => written(window)).toBe(cited);
    await expect(mark).toHaveAttribute("data-check", "supported");
    await expect(mark).not.toContainText("+");

    await useOutputLocation(window, out);
    await exportFromMenu(window, "docx");
    await expect
      .poll(async () => (await readFile(join(out, "Memo.docx")).catch(() => null)) !== null)
      .toBe(true);
    const word = unzip(await readFile(join(out, "Memo.docx")));
    expect(wordText(docxPart(word, "word/document.xml"))).toContain(
      `${first}[1]${between}${second}[2]${end}`,
    );

    await exportFromMenu(window, "pdf");
    await expect
      .poll(async () => (await readFile(join(out, "Memo.pdf")).catch(() => null)) !== null)
      .toBe(true);
    const page = (await pdfText(await readFile(join(out, "Memo.pdf"))))
      .join(" ")
      .replace(/\s+/g, "");
    expect(page).toContain(`${first}1${between}${second}2${end}`.replace(/\s+/g, ""));
    await app.close();
  });
}
