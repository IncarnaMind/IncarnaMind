import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  useOutputLocation as chooseOutputLocation,
  useLocalChatModel as connectLocalChatModel,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  interceptOpenDialog,
  interceptOpenPath,
  launchApp,
  motionRunning,
  nameMind,
  newMind,
  pathsOpened,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

const SUPPORTED = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([{ lines: ["Tides", SUPPORTED] }]);
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
const goHome = (window: Page) => window.getByTestId("sidebar-home").click();
const row = (window: Page) => window.getByTestId("home-next-step");
async function picture(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}
async function shown(window: Page, kind: string) {
  const next = row(window);
  await expect(next).toHaveAttribute("data-step", kind);
  const fits = await next.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(button);
    return (
      bounds.width > 80 &&
      bounds.height <= Number.parseFloat(getComputedStyle(button).lineHeight) + 1 &&
      [...range.getClientRects()].every(
        (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
      )
    );
  });
  expect(fits).toBe(true);
  return next;
}
async function keyboard(next: Locator) {
  await next.focus();
  await next.press("Enter");
}
async function palette(window: Page, next: Locator) {
  const label = await next.getAttribute("aria-label");
  if (!label) throw new Error("The next step has no command label.");
  await runCommand(window, "home.nextStep", label);
}
const milestone = async (window: Page) =>
  (await coreOf(window)).evaluate(
    async (core) => (await core.getSettings()).device.gettingStarted.exported,
  );

for (const language of ["en", "zh-CN"] as const)
  for (const width of [900, 1600]) {
    test(`Home performs the first path, then keeps only own-note check states (${language}, ${width}px)`, async () => {
      test.setTimeout(120_000);
      const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
        translate(language, key, values);
      const running = await launchApp(dataDir, { examples: true, fakeChat: true });
      let { app, window } = running;
      try {
        await setWindowSize(app, window, width, 800);
        await dismissChatSetup(window);
        await setLanguage(window, language);
        await connectLocalChatModel(window);
        await chooseOutputLocation(window, sources);
        await goHome(window);
        await picture(window, `home-next-initial-${language}-${width}`);
        await expect(await shown(window, "add")).toHaveText(t("home.next.add"));
        // A first launch reads the example's Documents before its ready Answer can be asked.
        const core = await coreOf(window);
        await expect
          .poll(() =>
            core.evaluate(async (each) =>
              (await each.listDocuments()).every((document) => document.status === "ready"),
            ),
          )
          .toBe(true);
        await core.evaluate((each) => each.askExampleReadyQuestion());
        await expect(await shown(window, "add")).toHaveText(t("home.next.add"));
        await window.getByTestId("mind-tab").first().click();
        await exportFromMenu(window, "markdown");
        await expect(window.getByTestId("export-done")).toBeVisible();
        expect(await milestone(window)).toBe(false);
        await goHome(window);

        const path = join(sources, "Tides.pdf");
        await writeFile(path, TIDES);
        await interceptOpenDialog(app, path);
        await keyboard(await shown(window, "add"));
        await expect
          .poll(async () =>
            (await coreOf(window)).evaluate(async (core) =>
              (await core.listDocuments()).some(
                (document) => document.name === "Tides" && document.status === "ready",
              ),
            ),
          )
          .toBe(true);
        await palette(window, await shown(window, "ask"));
        await expect(window.getByTestId("composer-input")).toBeFocused();
        const answer = await askInAssistant(window, "How do tides work?");
        await goHome(window);
        const write = await shown(window, "write");
        await picture(window, `home-next-write-${language}-${width}`);
        const before = await (await coreOf(window)).evaluate(
          async (core) => (await core.listMinds()).length,
        );
        if (width === 900)
          await write.evaluate((button) => {
            if (!(button instanceof HTMLButtonElement))
              throw new Error("The next step is not a button.");
            button.click();
            button.click();
          });
        else await palette(window, write);
        await expect(window.getByTestId("mind-editor")).toContainText(/answer this/i);
        await expect
          .poll(async () =>
            (await coreOf(window)).evaluate(async (core) => (await core.listMinds()).length),
          )
          .toBe(before + 1);
        await expect(answer).toHaveAttribute("data-status", "done");

        await newMind(window);
        const title =
          language === "en"
            ? "Tides for the quarterly harbour review and planning meeting"
            : "季度港口审阅与规划会议的潮汐笔记".repeat(3);
        await nameMind(window, title);
        await window.keyboard.type(SUPPORTED);
        await goHome(window);
        const check = await shown(window, "check");
        await expect(check).toHaveAttribute(
          "aria-label",
          t("home.next.check", { mind: title, count: t("health.toCheck.one") }),
        );
        await picture(window, `home-next-check-${language}-${width}`);
        await check.click();
        const ask = window.getByTestId("mind-check-ask");
        await expect(ask).toBeVisible();
        await ask.getByTestId("mind-check-check").click();
        await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
        await window.keyboard.press("Escape");
        await goHome(window);
        const exporting = await shown(window, "export");
        await picture(window, `home-next-export-${language}-${width}`);
        await keyboard(exporting);
        await expect(window.getByTestId("export-done")).toBeVisible();
        await expect.poll(() => milestone(window)).toBe(true);
        await interceptOpenPath(app);
        await goHome(window);
        const sent = await shown(window, "exported");
        await picture(window, `home-next-exported-${language}-${width}`);
        await palette(window, sent);
        await expect.poll(() => pathsOpened(app)).toHaveLength(1);
        await expect(row(window)).toHaveCount(0);
        await app.close();

        ({ app, window } = await launchApp(dataDir, { examples: true, fakeChat: true }));
        await setWindowSize(app, window, width, 800);
        await expect(window.getByTestId("home")).toBeVisible();
        await expect.poll(() => milestone(window)).toBe(true);
        await expect(row(window)).toHaveCount(0);
        await window.getByTestId("mind-tab").filter({ hasText: title }).click();
        const editor = window.getByTestId("mind-editor");
        await editor.click();
        await window.keyboard.press("ControlOrMeta+End");
        await window.keyboard.type(" The harbour publishes tide times every 6 months.");
        await window.keyboard.press("ControlOrMeta+z");
        await expect(editor).not.toContainText("every 6 months");
        await goHome(window);
        await expect(row(window)).toHaveCount(0);
        await window.getByTestId("mind-tab").filter({ hasText: title }).click();
        await editor.click();
        await window.keyboard.press("ControlOrMeta+End");
        await window.keyboard.type(" The harbour publishes tide times every 6 months.");
        await goHome(window);
        await palette(window, await shown(window, "check"));
        const again = window.getByTestId("mind-check-ask");
        await expect(again).toBeVisible();
        await again.getByTestId("mind-check-check").click();
        await expect(
          window.locator('[data-testid="claim-mark"][data-check="unsupported"]'),
        ).toHaveCount(1);
        await window.keyboard.press("Escape");
        await goHome(window);
        await picture(window, `home-next-look-${language}-${width}`);
        await keyboard(await shown(window, "look"));
        await expect(window.getByTestId("health-unsupported")).toBeVisible();
      } finally {
        await app.close();
      }
    });
  }

async function reopenFromPalette(window: Page, name: string) {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(name);
  const found = window
    .getByTestId("palette")
    .locator('[data-testid="palette-group"][data-group="conversations"]')
    .getByTestId("palette-item")
    .first();
  await expect(found).toContainText(name);
  await found.click();
  await expect(window.getByTestId("palette")).toBeHidden();
  await expect.poll(() => motionRunning(window)).toBe(0);
}

for (const language of ["en", "zh-CN"] as const)
  test(`Home offers to write an Answer only while the assistant shows it, across a relaunch (${language})`, async () => {
    test.setTimeout(120_000);
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    const question = language === "en" ? "Payment terms" : "付款条件";
    const minds = async (window: Page) =>
      (await coreOf(window)).evaluate(async (core) => (await core.listMinds()).length);
    let { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await connectLocalChatModel(window);
      const path = join(sources, "Tides.pdf");
      await writeFile(path, TIDES);
      await addDocuments(window, [path]);
      await goHome(window);
      const answer = await askInAssistant(window, question);
      const answerId = await answer.getAttribute("data-answer-id");
      await expect(await shown(window, "write")).toHaveText(t("home.next.write"));

      // The Answer leaves the assistant, folded or for a new chat, and the offer goes with it.
      await runCommand(window, "assistant.fold", t("command.assistant.fold"));
      await expect(answer).toBeHidden();
      await expect(await shown(window, "ask")).toHaveText(t("home.next.ask"));
      await runCommand(window, "assistant.fold", t("command.assistant.unfold"));
      await expect(answer).toBeVisible();
      await shown(window, "write");
      await runCommand(window, "assistant.newChat", t("assistant.newChat"));
      await expect(assistantAnswers(window)).toHaveCount(0);
      await shown(window, "ask");
      await app.close();

      ({ app, window } = await launchApp(dataDir, { fakeChat: true }));
      await expect(window.getByTestId("home")).toBeVisible();
      await expect(window.getByTestId("assistant-title")).toHaveText(t("conversation.untitled"));
      await expect(assistantAnswers(window)).toHaveCount(0);
      await expect
        .poll(async () =>
          (await coreOf(window)).evaluate(async (core) => (await core.listConversations()).length),
        )
        .toBe(1);
      await picture(window, `home-offer-relaunch-${language}`);
      await expect(await shown(window, "ask")).toHaveText(t("home.next.ask"));
      const before = await minds(window);

      // Opened again, the Answer is on screen, and the offer writes exactly that one.
      await reopenFromPalette(window, question);
      const again = window
        .getByTestId("assistant")
        .locator(`[data-testid="assistant-answer"][data-answer-id="${answerId}"]`);
      await expect(again).toBeVisible();
      const write = await shown(window, "write");
      await picture(window, `home-offer-reopened-${language}`);
      await write.click();
      await expect.poll(() => minds(window)).toBe(before + 1);
      await expect(window.getByTestId("mind-editor")).toContainText(
        `scripted Answer to: ${question}`,
      );
      await expect(again).toBeVisible();
    } finally {
      await app.close();
    }
  });
