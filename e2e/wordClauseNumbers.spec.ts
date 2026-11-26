import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptedParagraphs,
  fieldsOf,
  numbersIn,
  part,
  rejectedParagraphs,
  unzip,
} from "../tests/helpers/docx";
import {
  CHINESE_CONTRACT,
  type Contract,
  contractFile,
  ENGLISH_CONTRACT,
} from "../tests/helpers/wordContracts";
import {
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  focusSettled,
  importWordFile,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useOutputLocation,
} from "./app";

/*
 * A contract whose clauses Word numbers, imported, a clause added with Enter after one clause or
 * before another, and exported to Word from Export (#746). In the file, as Word works its numbers
 * out: the new clause has its number, the clauses after it count on, the cross-reference to the
 * clause it pushed down shows that clause's new number, and the page reference keeps the page the
 * file saved, the file asking Word nothing as it opens.
 */

let dataDir: string;
let home: string;
let files: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  files = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  for (const folder of [dataDir, home, files, out]) await removeDataFolder(folder);
});

interface Case {
  language: "en" | "zh-CN";
  contract: Contract;
  file: string;
  /** Each paragraph before the referring clause, with the number Word draws before it. */
  numbered: string[];
  /** The referring clause's number. */
  referring: string;
}

const CASES: Case[] = [
  {
    language: "en",
    contract: ENGLISH_CONTRACT,
    file: "Services agreement.docx",
    numbered: [
      "1. Services",
      "1.1 Brightwater Studio designs the packaging Alder & Finch Ltd orders.",
      "2. Fees",
      "2.1 Alder & Finch Ltd pays the fee each month.",
      "2.2 Fees are due within 30 days of the invoice.",
      "2.3 Late fees are capped at the fee itself.",
      "2.4 Unpaid fees carry interest at 2% a month.",
      "3. Termination",
    ],
    referring: "3.1",
  },
  {
    language: "zh-CN",
    contract: CHINESE_CONTRACT,
    file: "设计服务合同.docx",
    numbered: [
      "第一条 服务内容",
      "（一） 青禾设计工作室为远帆贸易有限公司设计包装。",
      "第二条 费用",
      "（一） 远帆贸易有限公司按月支付服务费。",
      "（二） 服务费应在发票开具后三十日内支付。",
      "（三） 滞纳金以服务费金额为限。",
      "（四） 逾期未付的服务费按每月百分之二计收利息。",
      "第三条 合同解除",
    ],
    referring: "（一）",
  },
];

async function start(language: "en" | "zh-CN" = "en") {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  return { app, window };
}

/** Exports the Note to Word from Export, once the core holds `typed`, and reads the file it saved. */
async function exportedWith(window: Page, typed: string): Promise<Buffer> {
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  // What was just typed has reached the core before Export reads the Note.
  await expect
    .poll(() =>
      window.evaluate(async (id) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const { data } = await core.exportMind(id ?? "", { format: "markdown" });
        return new TextDecoder().decode(data);
      }, mindId),
    )
    .toContain(typed);
  await exportFromMenu(window, "docx");
  const done = window.getByTestId("export-result").getByTestId("export-done");
  await expect(done).toContainText(".docx", { timeout: 30_000 });
  return readFile((await done.getAttribute("title")) ?? "");
}

for (const { language, contract, file, numbered, referring } of CASES) {
  test(`a clause added with Enter is numbered in the exported Word file, the later ones count on, and the cross-references follow (${language})`, async () => {
    const { app, window } = await start(language);
    await useOutputLocation(window, out);
    await importWordFile(app, window, files, file, contractFile(contract));

    const editor = window.getByTestId("mind-editor");
    await clickEndOf(window, editor.locator("p", { hasText: contract.after }));
    await window.keyboard.press("Enter");
    await window.keyboard.type(contract.added);
    await expect(editor.locator("p", { hasText: contract.added })).toBeVisible();
    const data = await exportedWith(window, contract.added);

    const lines = numbersIn(data);
    expect(lines.slice(0, numbered.length)).toEqual(numbered);
    expect(lines[numbered.length]?.startsWith(`${referring} `)).toBe(true);
    // As the file reads with the User's edits, which Export tracks, accepted.
    const document = part(unzip(data), "word/document.xml");
    const shown = acceptedParagraphs(document).join("\n");
    expect(shown).toContain(contract.renumbered);
    expect(shown).not.toContain(contract.before);
    // The page reference keeps the page the file saved, and nothing asks Word to work fields out
    // as it opens the file: it does that before laying the pages out.
    const pageRef = fieldsOf(document).find((each) => each.instruction.startsWith("PAGEREF"));
    expect(pageRef).toMatchObject({ result: "1", dirty: false });
    expect(document).not.toContain("w:dirty");
    expect(unzip(data).get("word/settings.xml")?.toString() ?? "").not.toContain("updateFields");
    await app.close();
  });
}

const DEFINITION =
  "Confidential Information means all information disclosed by one party to the other, in any form.";
const ADDED = "Each party names one person to receive Confidential Information.";

test("a clause put before 1.1 with Enter at its start is 1.1 in the exported file, and the cross-reference to the clause it moved down says 1.2", async () => {
  const { app, window } = await start();
  await useOutputLocation(window, out);
  await importWordFile(
    app,
    window,
    files,
    "Mutual confidentiality agreement.docx",
    await readFile(join(__dirname, "../eval/word/documents/synthetic/en-contract-nda.docx")),
  );
  const editor = window.getByTestId("mind-editor");
  const definition = editor.locator("p", { hasText: DEFINITION });
  const box = await definition.boundingBox();
  if (!box) throw new Error("Clause 1.1 isn't showing.");
  // Just before its first word, as a person clicks there.
  await window.mouse.move(box.x + 2, box.y + 8, { steps: 6 });
  await window.mouse.click(box.x + 2, box.y + 8);
  await focusSettled(window, editor);
  await window.keyboard.press("Enter");
  await window.keyboard.press("ArrowUp");
  await window.keyboard.type(ADDED);
  await expect(editor.locator("p", { hasText: ADDED })).toHaveText(ADDED);
  await expect(definition).toHaveText(DEFINITION);
  const data = await exportedWith(window, ADDED);

  const lines = numbersIn(data);
  expect(lines).toContain(`1.1 ${ADDED}`);
  expect(lines).toContain(`1.2 ${DEFINITION}`);
  const document = part(unzip(data), "word/document.xml");
  expect(acceptedParagraphs(document).join("\n")).toContain("as clause 1.2 requires");
  // The clause keeps its own paragraph in the file: nothing of it is struck out.
  expect(rejectedParagraphs(document)).toContain(DEFINITION);
  expect(document).not.toMatch(/<w:delText[^>]*>[^<]*Confidential/);
  expect(document).not.toContain("w:dirty");
  await app.close();
});

test("a heading renamed is renamed in the exported file's contents list, whose pages stay as the file saved them, and the file asks Word nothing as it opens", async () => {
  const { app, window } = await start();
  await useOutputLocation(window, out);
  await importWordFile(
    app,
    window,
    files,
    "Chapters.docx",
    await readFile(join(__dirname, "../eval/word/documents/libreoffice/multi-page-toc.docx")),
  );
  const heading = window.getByTestId("mind-editor").locator("h1", { hasText: "Chapter 2" });
  await clickEndOf(window, heading);
  await window.keyboard.type(": Results");
  await expect(heading).toHaveText("Chapter 2: Results");
  const data = await exportedWith(window, "Chapter 2: Results");

  const document = part(unzip(data), "word/document.xml");
  expect(acceptedParagraphs(document).slice(0, 3)).toEqual([
    "Contents",
    "Chapter 1\t2",
    "Chapter 2: Results\t2",
  ]);
  expect(document).not.toContain("w:dirty");
  expect(unzip(data).get("word/settings.xml")?.toString() ?? "").not.toContain("updateFields");
  await app.close();
});
