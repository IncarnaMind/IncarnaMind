/**
 * A Citation opened in a Word file whose heading style is used inside a table
 * (#2810): the drawn headings agree with the ones the core read, so the cited
 * section is placed, and the quote is washed and brought into view. A file
 * whose headings are drawn otherwise than read still has its quote found, in
 * the whole Document rather than nowhere.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { paragraph, run, table, wordFile } from "../tests/helpers/word";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  openDocumentAt,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";

const QUOTE = "The deposit is returned within fourteen days of the end of the tenancy.";

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** A form's file: "2 Duties" is a Heading 2 paragraph in a table cell, and the quote is after the table. */
function headingInTableFile(): Buffer {
  return wordFile({
    body: [
      table([
        [`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run("2 Duties")}</w:p>`],
        [run("The tenant keeps the garden in good order.")],
      ]),
      paragraph(QUOTE),
    ].join(""),
  });
}

/** A form's file whose heading sits in a text box: docx-preview draws it, the core reads it as body text. */
function textBoxHeadingFile(): Buffer {
  const inner = `<w:txbxContent>${paragraph("2 Duties", { style: "Heading2" })}</w:txbxContent>`;
  const box = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="2000000" cy="600000"/><wp:docPr id="2" name="Text Box 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx>${inner}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>${inner}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
  return wordFile({ body: [box, paragraph(QUOTE)].join("") });
}

/** Keeps a screenshot of the window, once the viewer has settled, when INCARNAMIND_SCREENSHOTS names a folder. */
async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

for (const [name, file] of [
  ["a heading style inside a table", headingInTableFile],
  ["a heading drawn otherwise than read", textBoxHeadingFile],
] as const) {
  test(`${name}: opening the Citation washes the quote and brings it into view`, async () => {
    const path = join(sources, "Reference form.docx");
    await writeFile(path, file());
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setWindowSize(app, window, 1600, 900);
    await addDocuments(window, [path]);

    await openDocumentAt(window, {
      documentId: await documentIdOf(window, "Reference form"),
      pageFrom: 1,
      pageTo: 1,
      quote: QUOTE,
      citation: { check: "found", label: "§ 2 Duties" },
    });

    const docx = window.getByTestId("viewer-docx");
    await expect(docx).toHaveAttribute("data-rendered", "yes");
    await screenshot(window, name.replaceAll(" ", "-"));
    const washed = docx.locator("[data-quote-highlight]");
    await expect(washed).toHaveCount(1);
    expect((await washed.allTextContents()).join("")).toBe(QUOTE);
    await expect(washed.first()).toBeInViewport();
    await app.close();
  });
}
