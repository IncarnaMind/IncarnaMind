import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  addDocuments,
  askFirstQuestion,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  exportFromMenu,
  launchApp,
  newMind,
  openSetupSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * The newcomer path runs unaided (#763): a first run, a model chosen, files added, an Answer, a
 * draft checked against the Documents and an export, each with a way on and none of the
 * glossary's left-column words. The example's own Documents are in place, as on a first run.
 */

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

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const CLAIM = "Harbours publish the times of high water every 12 months.";

/**
 * The words a newcomer must never meet on these screens (glossary's left column, #763). A
 * Passage in lowercase is allowed in a sentence, so only its capital form fails.
 */
const CAPITAL_JARGON = /\bPassages?\b/;
const JARGON =
  /\bIndex(?:ing|ed)?\b|\bembeddings?\b|\bre-?rank(?:ing|ed)?\b|chat model|\bmodel ID\b|\bMCP\b|\bstdio\b|OAuth client|\bOCR\b|\bRevoke\b|\bproviders?\b|local mode/i;

/** What each screen of the path says, read from the window. */
async function screens(window: Page): Promise<string> {
  const ids = ["assistant", "sidebar", "mind-editor", "composer"];
  const parts: string[] = [];
  for (const id of ids) {
    const locator = window.getByTestId(id);
    if ((await locator.count()) === 0) continue;
    parts.push((await locator.first().innerText()).trim());
  }
  return parts.join("\n");
}

test("a newcomer walks the hero path unaided, with no refusal and no jargon, in English and Chinese", async () => {
  test.setTimeout(240_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    examples: true,
    home: sources,
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "en");

    // 1. First run: the first own Question waits, with the way to choose a model beside it;
    // the pasted key is used at once.
    const card = await askFirstQuestion(window);
    await expect(window.getByTestId("assistant-waiting-model")).toContainText("Waiting for an AI model");
    await expect(window.getByTestId("assistant-waiting-choose")).toBeVisible();
    await card.getByTestId("setup-key").fill(ANTHROPIC_KEY);
    await card.getByTestId("setup-key").press("Enter");
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });

    // Steps 2 and 3 take one click each.
    await openSetupSteps(window);
    await expect(card.getByTestId("setup-transcription-use")).toBeEnabled({ timeout: 15_000 });
    await pointAndClick(window, card.getByTestId("setup-transcription-use"));
    await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
    await pointAndClick(window, card.getByTestId("setup-sorting-use"));
    await expect(card).toHaveCount(0);

    // 2. Add Documents, then ask about them.
    await addDocuments(window, [join(sources, "Tides.pdf")]);

    // 3. Checking a draft: the sentence the Document states is found.
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(CLAIM);
    const line = editor.locator(":scope > p").first();
    await slideSelect(window, line, "Harbours", { line, words: "months." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported", {
      timeout: 30_000,
    });

    // 4. An Answer about the file, written into the Note.
    const answer = await askInAssistant(window, "What do the tide tables say?");
    await expect(answer).toHaveAttribute("data-status", "done");
    await answer.getByTestId("answer-write-note").click();
    await expect(answer.getByTestId("answer-added-undo")).toBeVisible();

    // 5. Export: the first save asks nothing, and its line says it is saved.
    await exportFromMenu(window, "docx");
    await expect(window.getByTestId("export-result").getByTestId("export-saved")).toContainText(
      ".docx",
      { timeout: 30_000 },
    );

    // No refusal without a button, and no word the glossary says to leave out, on the screens walked.
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      const text = await screens(window);
      expect(text, `${language}: ${text}`).not.toMatch(JARGON);
      expect(text, `${language}: ${text}`).not.toMatch(CAPITAL_JARGON);
      const alerts = window.locator('[data-testid="assistant"], [data-testid="mind-editor"]');
      for (const alert of await alerts.all()) {
        const lines = alert.locator('[role="alert"]');
        for (const line of await lines.all()) {
          if (!(await line.isVisible())) continue;
          await expect(line.locator("button")).not.toHaveCount(0);
        }
      }
    }
  } finally {
    await app.close();
  }
});
