import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  capture,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * "The source is the lease, p. 3" (#1554): the assistant opens the Document it names at the page
 * it names, beside the Note, with the sentence waiting for its Citation; with no page it opens at
 * the start, as before, and with a page past the last it opens at the last page.
 */

const ABSENT = "Whales sing in the deep bay.";

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

const LEASE = buildPdf([
  { lines: ["Lease", "Parties and premises."] },
  { lines: ["Term", "The term is five years."] },
  { lines: ["Rent", "Rent is due on the first of each month."] },
]);

/** The Note's one sentence, checked and unsupported, with the caret in it. */
async function checkedAbsent(window: Page, editor: Locator): Promise<void> {
  await editor.click();
  await window.keyboard.type(ABSENT);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Whales sing", { line, words: "deep bay." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
  await motionSettled(window);
}

for (const [language, asked, page] of [
  ["en", "The source is the Lease, p. 3", 3],
  ["zh-CN", "出处是“Lease”，第3页", 3],
  ["en", "The source is the Lease", 1],
  // A page past the Document's last opens at the last page, with no notice: a page named by a
  // User or a model that miscounts is not an error of the command.
  ["en", "The source is the Lease, p. 40", 3],
] as const) {
  test(`the assistant opens the source at ${page === 1 ? "its start" : `page ${page}`} (${language}, “${asked}”)`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Lease.pdf"), LEASE);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await dismissChatSetup(window);
    await chooseScriptedModel(window, "fake-model");
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Lease.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await checkedAbsent(window, editor);
    await window.keyboard.press("Escape");
    await pointAndClick(window, editor.getByText("deep bay"));
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type(asked);
    await window.keyboard.press("Enter");
    const viewer = window.getByTestId("viewer").filter({ visible: true });
    await expect(viewer.getByTestId("viewer-header")).toContainText("Lease");
    await expect(viewer.locator(`[data-page-number="${page}"]`)).toBeInViewport();
    if (page > 1) await expect(viewer.locator('[data-page-number="1"]')).not.toBeInViewport();
    await expect(window.getByTestId("citation-pick-line")).toBeVisible();
    await capture(window, `source-page-${language}-${page}`);
    await app.close();
  });
}
