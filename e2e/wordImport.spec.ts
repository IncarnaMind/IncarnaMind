import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { unzip } from "../tests/helpers/docx";
import {
  commented,
  field,
  NUMBERING,
  PNG,
  paragraph,
  picture,
  run,
  table,
  textBox,
  tracked,
  wordFile,
} from "../tests/helpers/word";
import {
  askInAssistant,
  closeSettings,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  exportFromMenu,
  frontMindName,
  importWordFromMenu,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  openDocumentMenu,
  openExportOptions,
  openPageMenu,
  openSettings,
  pageMenuButton,
  pointAndClick,
  removeDataFolder,
  savedLine,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * Importing a Word file as a Mind (#104): from the "+" menu and by a drop on a
 * Mind, the import screen that asks whose document it is, the Mind with what
 * is kept as is shown in place, someone else's tracked changes to accept or
 * reject (#108), a section break that goes at once and comes back with ⌘Z, and
 * a file refused with the reason; and the original also added as a Document that Answers
 * cite (#720). Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let home: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  files = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(files);
});

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** The memo on the board Final-30-Word-Import, with someone else's comment and change. */
function memo(): Buffer {
  const comment = commented(0, "Marcus Hale", "Is spring realistic?", run("spring 2027"));
  return wordFile({
    body: [
      paragraph(
        `${run("To: Velomark board")}<w:r><w:br/></w:r>${run("From: Lena Ortiz, Halden Advisory")}<w:r><w:br/></w:r>${run("Date: ")}${field('DATE \\@ "d MMMM yyyy"', "9 October 2026")}`,
      ),
      paragraph("1. Summary", { style: "Heading1" }),
      paragraph(
        `${run("Velomark should enter Germany in 2027 through a ")}${run("distribution partner", { b: true })}${run(" rather than its own sales team. A partner already sells to the specialist bike shops where most e-bikes are bought.")}`,
      ),
      paragraph(
        textBox([
          "At a glance",
          "Market: e-bike batteries and conversion kits, Germany",
          "Route: a distribution partner; Velo Haus and Radwerk shortlisted",
          `First sales: spring 2027`,
        ]),
      ),
      paragraph("2. Options", {
        style: "Heading1",
        sectPr: '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>',
      }),
      paragraph("A direct sales team in Munich", { numId: 2 }),
      paragraph("A distribution partner", { numId: 2 }),
      paragraph(
        `${run("First sales in ")}${comment.inline}${tracked("ins", 4, "Marcus Hale", " at the earliest")}${run(".")}`,
      ),
      table([
        ["Route", "Cost", "Time"],
        ["Partner", "€0.4m", "6 months"],
      ]),
      paragraph(picture("rIdImage", "Velomark logo")),
    ].join(""),
    numbering: NUMBERING,
    comments: comment.comment,
    media: { rIdImage: { name: "media/image1.png", data: PNG } },
  });
}

test("Import a Word file… asks whose it is, then opens the Mind with what is kept as is in place", async () => {
  const path = join(files, "Market entry memo (Velomark).docx");
  await writeFile(path, memo());
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await interceptOpenDialog(app, path);

  const dialog = await importWordFromMenu(window);
  await expect(dialog.getByTestId("word-import-file")).toHaveText(
    "Market entry memo (Velomark).docx",
  );
  // Someone else commented and changed it: their document, by default, and they are named.
  await expect(dialog.getByTestId("word-import-origin-someone-else")).toBeChecked();
  await expect(dialog.getByTestId("word-import-authors")).toHaveText(
    "It has changes or comments by Marcus Hale.",
  );
  await screenshot(dialog, "word-import-dialog");
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();

  const pane = window.getByTestId("mind-pane");
  await expect(frontMindName(window)).toHaveText("Market entry memo (Velomark)");
  // Where it came from, and that export keeps its styles, are in the page's ⋯ menu.
  const pageMenu = await openPageMenu(window);
  const from = pageMenu.getByTestId("page-from");
  await expect(from).toHaveText("From Market entry memo (Velomark).docx");
  await expect(from).toHaveAttribute("title", /Export keeps its styles/);
  await window.keyboard.press("Escape");
  await expect(pageMenu).toBeHidden();
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("h1")).toHaveText(["1. Summary", "2. Options"]);
  await expect(editor.locator("ol li")).toHaveText([
    "A direct sales team in Munich",
    "A distribution partner",
  ]);
  await expect(editor.locator("table td")).toHaveCount(6);
  await expect(editor.locator("img.mind-image")).toHaveAttribute("alt", "Velomark logo");

  // A field is a quiet chip with its result; it says what it is, and that it is kept as is.
  const date = editor.locator('[data-testid="word-atom"][data-kind="field"]');
  await expect(date).toHaveText("9 October 2026");
  await expect(date).toHaveAttribute("title", /^Date field · kept as is/);
  // A text box is a box of its text, its label shown on hover.
  const box = editor.locator('[data-testid="word-atom"][data-kind="textBox"]');
  await expect(box).toContainText("At a glance");
  const label = box.locator(".word-atom-label");
  // Away from where the import screen's Import button was, which may be over the box now.
  await pageMenuButton(window).hover();
  await expect(label).toHaveCSS("opacity", "0");
  await box.hover();
  await expect(label).toHaveText("Text box · kept as is");
  await expect(label).toHaveCSS("opacity", "1");
  // Someone else's change waits to be accepted or rejected (#108); their comment is read-only.
  await expect(editor.locator("ins.proposal-theirs")).toHaveText(" at the earliest");
  await expect(window.getByTestId("their-changes-count")).toHaveText("1 change from Marcus Hale");
  await expect(editor.locator('[data-kind="comment"]')).toHaveAttribute(
    "title",
    /Comment · Marcus Hale · .*\nIs spring realistic\?/,
  );
  await screenshot(pane, "word-import-mind");

  // Typing beside an atom goes beside it, never into it.
  await date.click();
  await window.keyboard.press("ArrowRight");
  await window.keyboard.type("!");
  await expect(date).toHaveText("9 October 2026");
  await expect(editor.locator("p").first()).toContainText("9 October 2026!");
  await app.close();
});

/** A lease clause with Priya's and Lars's tracked changes: words, a replacement and a paragraph added; Priya's deletion as the file has it. */
function redline(): { file: Buffer; kept: string } {
  const priya = 'w:author="Priya Nair" w:date="2026-10-02T09:00:00Z"';
  const lars = 'w:author="Lars Berg" w:date="2026-10-05T16:20:00Z"';
  const kept = `<w:del w:id="2" ${priya}><w:r><w:delText xml:space="preserve"> by cheque</w:delText></w:r></w:del>`;
  return {
    kept,
    file: wordFile({
      body: [
        paragraph("Rent", { style: "Heading1" }),
        paragraph(
          `${run("The Tenant pays rent")}<w:ins w:id="1" ${priya}>${run(" monthly")}</w:ins>${run(" in advance")}${kept}${run(".")}`,
        ),
        paragraph(
          `${run("Notice is ")}<w:del w:id="3" ${lars}><w:r><w:delText xml:space="preserve">one month</w:delText></w:r></w:del><w:ins w:id="4" ${lars}>${run("three months")}</w:ins>${run(".")}`,
        ),
        `<w:p><w:pPr><w:rPr><w:ins w:id="5" ${lars}/></w:rPr></w:pPr><w:ins w:id="6" ${lars}>${run("The Landlord insures the building.")}</w:ins></w:p>`,
      ].join(""),
    }),
  };
}

test("someone else's tracked changes wait in place with who made them and when: accepted and rejected one by one or all of one person's, and the rest exported as they were", async () => {
  const { file, kept } = redline();
  const path = join(files, "Lease redline.docx");
  await writeFile(path, file);
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1600, 660);
  await dismissChatSetup(window);
  const output = join(files, "Exports");
  await mkdir(output);
  await useOutputLocation(window, output);
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();

  // Their changes, struck and underlined in place, and one line at the top saying whose they are.
  const editor = window.getByTestId("mind-editor");
  const bar = window.getByTestId("proposals-bar");
  const counts = bar.getByTestId("their-changes-count");
  await expect(counts).toHaveText("4 changes from Priya Nair and Lars Berg");
  await expect(editor.locator("del.proposal-theirs")).toHaveText([" by cheque", "one month"]);
  await expect(editor.locator("ins.proposal-theirs")).toHaveText([" monthly", "three months"]);
  // Their words are in the User's ink, not the AI's grey.
  const body = await editor
    .locator("p")
    .first()
    .evaluate((each) => getComputedStyle(each).color);
  await expect(editor.locator("ins.proposal-theirs").first()).toHaveCSS("color", body);

  // A change's bar says who made it and when.
  const changeBar = window.getByTestId("change-bar");
  await editor.locator("ins.proposal-theirs", { hasText: "three months" }).hover();
  await expect(changeBar).toContainText("Change 3 of 4");
  await expect(changeBar.getByTestId("change-bar-author")).toHaveText("Lars Berg, 5 Oct 2026");
  await motionSettled(window);
  await screenshot(window, "their-changes");

  // Accepted by its bar: the words are the Mind's, unmarked; the others wait.
  await pointAndClick(window, changeBar.getByTestId("change-accept"));
  await expect(editor.locator("p", { hasText: "Notice is" })).toHaveText("Notice is three months.");
  await expect(counts).toHaveText("3 changes from Priya Nair and Lars Berg");

  // Rejected by the keyboard, with the cursor in it: Priya's word goes.
  await pointAndClick(window, editor.locator("ins.proposal-theirs", { hasText: "monthly" }));
  await expect(window.getByTestId("proposal-spoken")).toContainText("Priya Nair’s change: adds");
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(editor.locator("p", { hasText: "The Tenant" })).toHaveText(
    "The Tenant pays rent in advance by cheque.",
  );
  await expect(counts).toHaveText("2 changes from Priya Nair and Lars Berg");

  // In Chinese.
  await setLanguage(window, "zh-CN");
  await expect(counts).toHaveText("来自 Priya Nair 和 Lars Berg 的 2 处修订");
  await expect(bar.getByTestId("their-changes-review")).toHaveText("审阅");
  await motionSettled(window);
  await screenshot(window, "their-changes-zh");
  // A narrow window: each line stays inside the Mind, its buttons whole.
  await setWindowSize(app, window, 900, 660);
  await motionSettled(window);
  const pane = await window.getByTestId("mind-pane").boundingBox();
  for (const line of await bar.getByTestId("their-changes-line").all()) {
    const box = await line.boundingBox();
    expect(box && pane && box.x >= pane.x && box.x + box.width <= pane.x + pane.width).toBe(true);
  }
  await screenshot(window, "their-changes-zh-narrow");
  await setWindowSize(app, window, 1600, 660);
  await setLanguage(window, "en");

  // All of one person's, from the reviewing pane's ⋯ menu: Lars's paragraph goes, Priya's change waits.
  await pointAndClick(window, bar.getByTestId("their-changes-review"));
  const review = window.getByTestId("review-pane");
  const waiting = review.locator('[data-testid="review-change"][data-state="waiting"]');
  await expect(waiting).toHaveCount(2);
  const rejectLars = async () => {
    await pointAndClick(window, review.getByTestId("review-more"));
    const reject = window
      .getByTestId("review-reject-author")
      .filter({ hasText: "Reject all changes from Lars Berg" });
    await pointAndClick(window, reject);
  };
  await rejectLars();
  await expect(editor).not.toContainText("The Landlord insures the building.");
  await expect(waiting).toHaveCount(1);
  // Undo brings it back, waiting as it was; rejected again, it goes.
  await expect(window.getByTestId("undo-message")).toHaveText("Rejected 1 change");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(waiting).toHaveCount(2);
  await expect(editor).toContainText("The Landlord insures the building.");
  await rejectLars();
  await expect(waiting).toHaveCount(1);
  await pointAndClick(window, review.getByTestId("review-close"));
  await expect(review).toHaveCount(0);
  await expect(counts).toHaveText("1 change from Priya Nair");

  // Export: what was resolved leaves no trace; what waits is in the file as it was.
  await exportFromMenu(window);
  const result = window.getByTestId("export-result");
  await expect(result.getByTestId("export-done")).toContainText(
    savedLine("Lease redline.docx", output),
  );
  await expect(result.getByTestId("export-tracked")).toContainText(
    "1 change waiting, as tracked changes",
  );
  const document =
    unzip(await readFile(join(output, "Lease redline.docx")))
      .get("word/document.xml")
      ?.toString("utf8") ?? "";
  expect(document).toContain(kept);
  expect(document).toContain("three months");
  for (const gone of ["monthly", "one month", "insures", "Lars Berg"])
    expect(document).not.toContain(gone);
  await app.close();
});

test("deleting a section break asks nothing, and ⌘Z brings it back", async () => {
  const path = join(files, "Two sections.docx");
  await writeFile(
    path,
    wordFile({
      body: [
        paragraph("Section one ends here.", {
          sectPr: '<w:sectPr><w:pgSz w:orient="landscape"/></w:sectPr>',
        }),
        paragraph("Section two."),
      ].join(""),
    }),
  );
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await expect(dialog.getByTestId("word-import-origin-own")).toBeChecked();
  await dialog.getByTestId("word-import-confirm").click();

  const editor = window.getByTestId("mind-editor");
  const first = editor.locator("p").first();
  await expect(first).toHaveText("Section one ends here.");
  const sectionBreak = editor.locator('[data-kind="sectionBreak"]');
  await expect(sectionBreak).toHaveCount(1);
  // The whole paragraph, its break too, selected and deleted.
  await first.click({ clickCount: 3 });
  await expect
    .poll(() => window.evaluate(() => getSelection()?.toString()))
    .toContain("Section one ends here.");
  await window.keyboard.press("Backspace");
  await expect(sectionBreak).toHaveCount(0);
  await expect(editor).not.toContainText("Section one ends here.");
  await expect(editor).toContainText("Section two.");
  await expect(window.locator("dialog[open]")).toHaveCount(0);
  await screenshot(window, "section-break-deleted");

  await window.keyboard.press("ControlOrMeta+z");
  await expect(sectionBreak).toHaveCount(1);
  await expect(first).toHaveText("Section one ends here.");
  await expect(editor).toContainText("Section two.");
  await app.close();
});

test("a file that can't be imported says why, and no Mind is made", async () => {
  const path = join(files, "Old minutes.doc");
  await writeFile(path, "not really a Word 97 file");
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await interceptOpenDialog(app, path);
  const minds = async () =>
    (await coreOf(window)).evaluate((bridge) => bridge.listMinds().then((list) => list.length));
  const before = await minds();

  const dialog = await importWordFromMenu(window);
  await expect(dialog.getByTestId("word-import-refusal")).toContainText(
    "“Old minutes.doc” is an older .doc file. Save it as .docx in Word, then import.",
  );
  await expect(dialog.getByTestId("word-import-confirm")).toHaveCount(0);
  await screenshot(dialog, "word-import-refused");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await minds()).toBe(before);
  await app.close();
});

test("a Word file dropped on a Mind opens the import screen, which can add it as a Document instead", async () => {
  const path = join(files, "Dropped memo.docx");
  await writeFile(path, wordFile({ body: paragraph("Dropped on a Mind.") }));
  const { window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-mind").click();
  await expect(window.getByTestId("mind-pane")).toBeVisible();

  // A file from the disk, as a drag from Finder or Explorer carries one.
  await window.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.dataset.testid = "drop-source";
    input.hidden = true;
    document.body.append(input);
  });
  await window.getByTestId("drop-source").setInputFiles(path);
  const dispatch = (types: string[]) =>
    window.evaluate((sent) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="drop-source"]');
      const file = input?.files?.[0];
      const target = document.querySelector('[data-testid="mind-pane"]');
      if (!file || !target) throw new Error("No file or no Mind to drop on.");
      const holder = globalThis as { heldTransfer?: DataTransfer };
      if (!holder.heldTransfer) {
        holder.heldTransfer = new DataTransfer();
        holder.heldTransfer.items.add(file);
      }
      for (const type of sent) {
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: holder.heldTransfer,
          }),
        );
      }
    }, types);
  // Held over the Mind, it lights and says it imports, in place of the window's "add" overlay.
  await dispatch(["dragenter", "dragover"]);
  await expect(window.getByTestId("mind-scroller")).toHaveAttribute("data-drop-target", "true");
  await expect(window.getByTestId("drop-label")).toHaveText("Import the Word file");
  await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
  await dispatch(["drop"]);
  await expect(window.getByTestId("drop-label")).toHaveCount(0);

  const dialog = window.getByTestId("word-import-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("word-import-file")).toHaveText("Dropped memo.docx");
  await dialog.getByTestId("word-import-as-document").click();
  await expect(dialog).toBeHidden();
  await expect(window.getByTestId("sidebar")).toContainText("Dropped memo");
});

test("Export writes back into the Word file: the User's edits tracked under their name, or, untracked, what it can't keep said first", async () => {
  const kept = paragraph("Keep this paragraph as it is.", { paraId: "0A0B0C0D" });
  const comment = commented(0, "Marcus Hale", "Is spring realistic?", run("spring 2027"));
  const path = join(files, "Memo.docx");
  await writeFile(
    path,
    wordFile({
      body: [
        kept,
        paragraph(`${run("First sales in ")}${comment.inline}${run(".")}`),
        paragraph("The end."),
      ].join(""),
      comments: comment.comment,
    }),
  );
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  const output = join(files, "Exports");
  await mkdir(output);
  await useOutputLocation(window, output);

  // The name the User's edits go under, set once in Settings › General.
  const settings = await openSettings(window, "general");
  const name = settings.getByTestId("author-name");
  await expect(name).not.toHaveValue("");
  await name.fill("Priya Raman");
  await name.press("Enter");
  await expect(name).toHaveValue("Priya Raman");
  await settings.getByTestId("author-name-settings").scrollIntoViewIfNeeded();
  await screenshot(window, "settings-your-name");
  await closeSettings(window);

  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-confirm").click();

  // The paragraph with the comment goes.
  const editor = window.getByTestId("mind-editor");
  const commentedParagraph = editor.locator("p", { hasText: "First sales in" });
  await commentedParagraph.click({ clickCount: 3 });
  await expect
    .poll(() => window.evaluate(() => getSelection()?.toString()))
    .toContain("First sales in");
  await window.keyboard.press("Backspace");
  await window.keyboard.press("Backspace");
  await expect(editor).not.toContainText("First sales in");

  // The sheet: the User's edits tracked, on for a Word file, under their name.
  await openExportOptions(window);
  const sheet = window.getByTestId("export-dialog");
  const track = sheet.getByTestId("export-track-changes");
  await expect(track).toBeChecked();
  await expect(sheet).toContainText("Your edits since import, tracked as Priya Raman.");
  // The name is a link to where it is changed, over the sheet.
  await sheet.getByTestId("export-author-name").click();
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "general");
  await expect(window.getByTestId("author-name")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();
  await expect(sheet).toBeVisible();
  await motionSettled(window);
  await screenshot(window, "word-export-options");
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Export: the deleted paragraph stays as Priya's deletion, the comment with it; nothing to say first.
  const result = window.getByTestId("export-result");
  await exportFromMenu(window);
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Memo.docx", output));
  const tracked =
    unzip(await readFile(join(output, "Memo.docx")))
      .get("word/document.xml")
      ?.toString("utf8") ?? "";
  expect(tracked).toContain(kept);
  expect(tracked).toMatch(
    /<w:del w:id="\d+" w:author="Priya Raman" w:date="[^"]+"><w:r><w:delText xml:space="preserve">First sales in <\/w:delText>/,
  );
  expect(tracked).toContain('<w:commentRangeStart w:id="0"/>');
  await pointAndClick(window, result.getByTestId("export-dismiss"));

  // Untracked, the file can't keep the comment: that is said before anything is saved.
  await openExportOptions(window);
  await track.click();
  await expect(track).not.toBeChecked();
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();
  await exportFromMenu(window);
  await expect(result.getByTestId("export-review")).toHaveText(
    "1 thing in the Word file can’t be kept: Marcus Hale’s comment “Is spring realistic?” is on text you deleted · Export anyway",
  );
  await expect(result.getByTestId("export-review-items")).toHaveText(
    "Marcus Hale’s comment “Is spring realistic?” is on text you deleted",
  );
  expect(await readdir(output)).toEqual(["Memo.docx"]);
  await motionSettled(window);
  await screenshot(window, "word-export-review");
  // A narrow window: the line and its list wrap by word, inside the tab.
  await setWindowSize(app, window, 900, 660);
  await motionSettled(window);
  const line = await result.boundingBox();
  const pane = await window.getByTestId("mind-pane").boundingBox();
  expect(line && pane && line.x >= pane.x && line.x + line.width <= pane.x + pane.width).toBe(true);
  await screenshot(window, "word-export-review-narrow");
  await setWindowSize(app, window, 1600, 660);
  await setLanguage(window, "zh-CN");
  await expect(result.getByTestId("export-review")).toContainText("Word 文件中有 1 处无法保留");
  await expect(result.getByTestId("export-anyway")).toHaveText("仍然导出");
  await motionSettled(window);
  await screenshot(window, "word-export-review-zh");
  await setLanguage(window, "en");

  // Export anyway: saved, the paragraph kept byte for byte, the comment's marks gone with its text.
  await result.getByTestId("export-anyway").click();
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Memo 2.docx", output));
  await motionSettled(window);
  await screenshot(window, "word-export-saved");
  const document =
    unzip(await readFile(join(output, "Memo 2.docx")))
      .get("word/document.xml")
      ?.toString("utf8") ?? "";
  expect(document).toContain(kept);
  expect(document).toContain("The end.");
  expect(document).not.toContain("First sales in");
  expect(document).not.toContain("comment");
  await app.close();
});

const CAP =
  "Each party's total liability is capped at the fees paid in the twelve months before the claim.";

/** A counterparty's draft: two clauses, the liability cap in clause 9. */
function contract(): Buffer {
  return wordFile({
    body: [
      paragraph("Supply agreement", { style: "Title" }),
      paragraph("Clause 8 Payment", { style: "Heading1" }),
      paragraph("The Buyer pays each invoice within 30 days of receiving it."),
      paragraph("Clause 9 Limitation of liability", { style: "Heading1" }),
      paragraph(CAP),
    ].join(""),
  });
}

test("the original is also a Document: an Answer beside the Mind cites its clause, which opens there, and each finds the other", async () => {
  const path = join(files, "Supply agreement.docx");
  await writeFile(path, contract());
  const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 860);
  await interceptOpenDialog(app, path);

  const dialog = await importWordFromMenu(window);
  const tick = dialog.getByTestId("word-import-add-original");
  await expect(tick).toBeChecked();
  await expect(tick.locator("xpath=..")).toHaveText(
    "Also add the original to the Library, so Answers can cite it",
  );
  await expect(dialog.getByTestId("word-import-new-version")).toHaveCount(0);
  await screenshot(dialog, "word-import-original");
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(frontMindName(window)).toHaveText("Supply agreement");
  await expectReadyDocuments(window, 1);

  // "From Supply agreement.docx", in the page's ⋯ menu, opens the original beside the Mind.
  const from = (await openPageMenu(window)).getByTestId("page-from");
  await expect(from).toHaveText("From Supply agreement.docx");
  await pointAndClick(window, from);
  await expect(window.getByTestId("viewer-title")).toHaveText("Supply agreement");
  await expect(window.getByTestId("mind-pane")).toBeVisible();

  // A Question beside the Mind cites the clause, by its section.
  const answer = await askInAssistant(window, "Is total liability capped?");
  const chip = answer.getByTestId("citation-chip");
  await expect(chip).toHaveAttribute(
    "aria-label",
    "Citation 1: Supply agreement, § Clause 9 Limitation of liability. Quote found in § Clause 9 Limitation of liability",
  );
  await pointAndClick(window, chip);
  const card = window.getByTestId("citation-card");
  if (await card.isVisible()) await card.getByTestId("citation-open").click();
  const viewer = window.getByTestId("viewer");
  await expect(window.getByTestId("viewer-title")).toHaveText("Supply agreement");
  const docx = viewer.getByTestId("viewer-docx");
  await expect(docx).toHaveAttribute("data-rendered", "yes");
  await expect(docx.locator("[data-quote-highlight]").first()).toBeInViewport();
  expect((await docx.locator("[data-quote-highlight]").allTextContents()).join("")).toContain(
    "total liability is capped",
  );
  await expect(viewer.getByTestId("viewer-quote-mark-label")).toHaveText(
    "§ Clause 9 Limitation of liability",
  );
  await motionSettled(window);
  await screenshot(window, "word-original-cited");

  // In the sidebar: Get info names its Mind, and its menu opens it.
  const row = window.getByTestId("document-list-item").filter({ hasText: "Supply agreement" });
  await row.getByTestId("open-document").focus();
  await window.keyboard.press("ControlOrMeta+i");
  const panel = window.getByTestId("info-panel");
  await expect(panel.getByTestId("info-imported-as")).toContainText("Imported as a note");
  await expect(panel.getByTestId("info-open-mind")).toHaveText("Supply agreement");
  await screenshot(panel, "word-original-info");
  await window.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  const mindTab = window.getByTestId("mind-tab").filter({ hasText: "Supply agreement" });
  await mindTab.hover();
  await mindTab.getByTestId("tab-close").click();
  await expect(window.getByTestId("mind-pane")).toHaveCount(0);
  await openDocumentMenu(row);
  const menu = row.getByTestId("document-file-actions");
  await expect(menu.getByTestId("document.openMind")).toHaveText("Open its note");
  await pointAndClick(window, menu.getByTestId("document.openMind"));
  await expect(frontMindName(window)).toHaveText("Supply agreement");

  await setLanguage(window, "zh-CN");
  await expect((await openPageMenu(window)).getByTestId("page-from")).toHaveText(
    "来自“Supply agreement.docx”",
  );
  await app.close();
});

test("asked “这份简历讲了什么？” and “What is this résumé about?” beside an imported résumé, an Answer cites the original (#1036)", async () => {
  const path = join(files, "ZW-2026.docx");
  await writeFile(
    path,
    wordFile({
      body: [
        paragraph("张伟", { style: "Title" }),
        paragraph("工作经历", { style: "Heading1" }),
        paragraph("2019 年至今在北京一家物流公司担任数据分析师，负责运输成本模型和周报。"),
        paragraph("教育背景", { style: "Heading1" }),
        paragraph("2015 年至 2019 年就读于武汉大学统计学专业，获学士学位。"),
      ].join(""),
    }),
  );
  const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 860);
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();
  await expectReadyDocuments(window, 1);

  for (const question of ["这份简历讲了什么？", "What is this résumé about?"]) {
    const answer = await askInAssistant(window, question);
    await expect(answer.getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      /ZW-2026.*Quote found/,
    );
    await expect(answer.getByTestId("answer-steps")).not.toContainText("no sources");
  }
  await screenshot(window, "working-copy-cited");
  await app.close();
});

test("an original the Library can't take is said at the top of the page, and Add to Library takes it once it can", async () => {
  test.skip(process.platform === "win32" || process.getuid?.() === 0, "needs file permissions");
  const path = join(files, "Supply agreement.docx");
  await writeFile(path, contract());
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1200, 800);
  await interceptOpenDialog(app, path);

  const dialog = await importWordFromMenu(window);
  await expect(dialog.getByTestId("word-import-confirm")).toBeEnabled();
  // Read for the import screen, then not readable: the import goes on from what it read.
  await chmod(path, 0o000);
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();

  const problem = window.getByTestId("mind-word-not-added");
  await expect(problem).toHaveText(
    "“Supply agreement.docx” couldn’t be added to the Library, so Answers can’t cite it. · Add to Library",
  );
  await motionSettled(window);
  await screenshot(window.getByTestId("mind-pane"), "word-original-not-added");
  // Not in the Library, the original can't be opened from the page's ⋯ menu yet.
  let pageMenu = await openPageMenu(window);
  await expect(pageMenu.getByTestId("page-from")).toHaveAttribute("aria-disabled", "true");
  await expect(pageMenu.getByTestId("page-show-original")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(pageMenu).toBeHidden();

  await chmod(path, 0o644);
  await pointAndClick(window, problem.getByTestId("mind-word-add-original"));
  await expect(problem).toHaveCount(0);
  pageMenu = await openPageMenu(window);
  await expect(pageMenu.getByTestId("page-from")).not.toHaveAttribute("aria-disabled");
  await expect(pageMenu.getByTestId("page-show-original")).toBeVisible();
  await app.close();
});

test("From {file} in the page's ⋯ menu opens the original beside the Mind at the paragraph the caret is in, in English and Chinese", async () => {
  const CAPPED = "Clause 9: each party's total liability is capped at a year's fees.";
  // Every tenth crosses a page, as Word marks it: the viewer draws it as two paragraphs.
  const recitals = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      (from + index) % 10 === 0
        ? paragraph(
            `${run(`Recital ${from + index}: the parties record a fact `)}<w:r><w:lastRenderedPageBreak/><w:t xml:space="preserve">of the background.</w:t></w:r>`,
          )
        : paragraph(`Recital ${from + index}: the parties record a fact of the background.`),
    );
  const path = join(files, "Supply agreement.docx");
  await writeFile(
    path,
    wordFile({
      body: [
        paragraph("Supply agreement", { style: "Title" }),
        // A text box Word saves twice: its newer copy isn't drawn, so the places shift by six.
        paragraph(textBox(["At a glance", "Term", "Two years", "Cap", "A year's fees", "Law"])),
        // Long enough that the pages scroll to it.
        ...recitals(1, 150),
        paragraph(CAPPED),
        ...recitals(151, 150),
      ].join(""),
    }),
  );
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();
  await expectReadyDocuments(window, 1);

  // The caret in clause 9, then ⋯ › From Supply agreement.docx.
  const editor = window.getByTestId("mind-editor");
  await editor.locator("p", { hasText: "Clause 9:" }).click();
  const items = await openPageMenu(window);
  await expect(items.getByTestId("page-from")).toHaveText("From Supply agreement.docx");
  await expect(items.getByTestId("page-show-original")).toHaveText(/^Show in (Finder|folder)$/);
  await motionSettled(window);
  await screenshot(window, "word-original-menu");
  await pointAndClick(window, items.getByTestId("page-from"));

  // Beside the Mind, at clause 9: a third of the way down the pages.
  await expect(window.getByTestId("viewer-title")).toHaveText("Supply agreement");
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  const pages = window.getByTestId("viewer-docx");
  await expect(pages).toHaveAttribute("data-rendered", "yes");
  const capped = pages.locator("section.docx > article p", { hasText: "Clause 9:" });
  await expect(capped).toBeInViewport();
  await expect
    .poll(async () => {
      const [line, view] = await Promise.all([capped.boundingBox(), pages.boundingBox()]);
      return line && view ? Math.abs(line.y - view.y - view.height / 3) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(24);
  await motionSettled(window);
  await screenshot(window, "word-original-at-caret");

  // In Chinese.
  await setLanguage(window, "zh-CN");
  await openPageMenu(window);
  await expect(items.getByTestId("page-from")).toHaveText("来自“Supply agreement.docx”");
  await expect(items.getByTestId("page-show-original")).toHaveText(/^在(访达|文件夹)中显示$/);
  await window.keyboard.press("Escape");
  await app.close();
});

test("unticked, the Word file is imported as a Mind alone", async () => {
  const path = join(files, "Supply agreement.docx");
  await writeFile(path, contract());
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await interceptOpenDialog(app, path);

  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-add-original").uncheck();
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();

  const pageMenu = await openPageMenu(window);
  await expect(pageMenu.getByTestId("page-from")).toHaveText("From Supply agreement.docx");
  await expect(pageMenu.getByTestId("page-from")).toHaveAttribute("aria-disabled", "true");
  await expect(pageMenu.getByTestId("page-show-original")).toHaveCount(0);
  const documents = await (await coreOf(window)).evaluate((bridge) => bridge.listDocuments());
  expect(documents).toEqual([]);
  await app.close();
});
