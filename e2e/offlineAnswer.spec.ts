import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  launchApp,
  mindWrittenBefore,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Offline, an Answer says so and shows what the Documents do say, from a search on this
 * computer (#763); online, a lost connection names the company, as before. Try again is the one
 * action both ways. English and Chinese, at 900 and 1,600 px.
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

const QUESTION = "Do the tide tables say no connection?";
const TIDE = "The tide tables are read every spring.";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function shot(window: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}

async function setOnline(page: Page, online: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  }, online);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`offline, the Answer says so and shows what the Documents say, in ${language}`, async () => {
    test.setTimeout(120_000);
    const path = join(sources, "Tide.txt");
    const lease = join(sources, "Lease.txt");
    await writeFile(path, TIDE);
    await writeFile(lease, "The lease tables are read every spring.");
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      home: sources,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 900, 700);
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveChatProvider({
          kind: "openai",
          modelId: "gpt-6.1-sol",
          apiKey: "key-not-real",
        });
      });
      await setLanguage(window, language);
      await addDocuments(window, [path, lease]);
      // The lease is kept inside a walled Folder; the Note is in no Folder, so it is not read.
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const found = (await core.listDocuments()).find((each) => each.name === "Lease");
        const group = await core.createLibraryGroup({
          name: "Client work",
          description: "",
          keepInside: true,
        });
        if (found) await core.assignDocumentGroup(found.id, group.id);
      });
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              const library = await core.getLibrary();
              return library.assignments.filter((each) => each.groupId !== null).length;
            }),
          { timeout: 15_000 },
        )
        .toBe(1);
      await newMind(window);

      // Online, the same lost connection names OpenAI and says what to check.
      const answer = await askInAssistant(window, QUESTION);
      await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
      const error = answer.getByTestId("answer-error");
      await expect(error).toHaveAttribute("data-error-kind", "network");
      await expect(error.getByRole("alert")).toContainText(
        translate(language, "answer.error.network", { service: "OpenAI" }),
      );

      // Offline, it says so, and the passages a search on this computer found.
      await setOnline(window, false);
      await expect(error.getByRole("alert")).toContainText(
        translate(language, "answer.offline.line"),
      );
      await expect(error).toContainText(translate(language, "answer.found"));
      // The lease, kept inside its wall, is not among what the Note's side reads.
      await expect(error.getByTestId("found-passage")).toHaveCount(1);
      const passage = error.getByTestId("found-passage").first();
      await expect(passage.getByTestId("found-passage-document")).toContainText("Tide");
      await expect(passage.getByTestId("found-passage-text")).toContainText("tide tables");
      await expect(error.getByTestId("answer-error-action")).toHaveText(
        translate(language, "answer.error.retry"),
      );
      await shot(window, `offline-${language}-900`);

      // The line and its passages stay inside a wide window too.
      await setWindowSize(app, window, 1600, 900);
      await expect(error.getByRole("alert")).toBeVisible();
      await expect(error.getByTestId("found-passage").first()).toBeVisible();
      const [lineBox, passagesBox, size] = await Promise.all([
        error.getByRole("alert").boundingBox(),
        error.getByTestId("found-passages").boundingBox(),
        window.evaluate(() => ({ width: innerWidth })),
      ]);
      for (const box of [lineBox, passagesBox]) {
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
      }
      await shot(window, `offline-${language}-1600`);

      // Back online, the company is named again, as the failure says when it happened offline.
      await setOnline(window, true);
      await expect(error.getByRole("alert")).toContainText(
        translate(language, "answer.error.network", { service: "OpenAI" }),
      );
      await expect(error.getByTestId("found-passages")).toHaveCount(0);
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "failed");
    } finally {
      await app.close();
    }
  });
}

test("an Answer written into a Note says it is offline, with its own Question's passages", async () => {
  test.setTimeout(150_000);
  const tide = join(sources, "Tide.txt");
  const whale = join(sources, "Whale.txt");
  await writeFile(tide, TIDE);
  await writeFile(whale, "Whales sing in the deep bay.");
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    home: sources,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 900, 700);
    await acceptPlainTextKeys(window);
    const provider = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({
        kind: "openai",
        modelId: "gpt-6.1-sol",
        apiKey: "key-not-real",
      });
    });
    await setLanguage(window, "en");
    await addDocuments(window, [tide, whale]);
    const failedAnswer = {
      errorKind: "network",
      errorMessage: "Cannot connect to API: fetch failed",
      providerId: provider.id,
      modelId: "gpt-6.1-sol",
    };
    // Two Notes with failed Answers: each page must read its own Question, not the other's.
    await mindWrittenBefore(window, "Offline note", [
      {
        question: "Does the tide table have no connection?",
        answer: "",
        failed: failedAnswer,
      },
    ]);
    await mindWrittenBefore(window, "Whale note", [
      { question: "Where do the whales sing?", answer: "", failed: failedAnswer },
    ]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Offline note" }).click();
    const failed = window.getByTestId("mind-editor").getByTestId("answer-error");
    await expect(failed).toHaveAttribute("data-error-kind", "network");
    await setOnline(window, false);
    await expect(failed.getByRole("alert")).toContainText(translate("en", "answer.offline.line"));
    // The tide Question's words find the tide Document, and not the whales the other Note asks about.
    await expect(failed.getByTestId("found-passage")).toHaveCount(1);
    await expect(failed.getByTestId("found-passage-document")).toContainText("Tide");
  } finally {
    await app.close();
  }
});
