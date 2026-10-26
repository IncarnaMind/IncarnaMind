import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Documents added since a Mind's checks (#993): a sentence nothing in the
 * Mind's Folder supported is offered a check again once a Document that
 * could support it is added there. The scripted model supports a sentence
 * that shares three words with a line of a Document. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const MOON = "Spring tides come at new moon and at full moon.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";

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

async function fileInto(window: Page, names: readonly string[], adding?: string) {
  await window.evaluate(async (path) => {
    if (path)
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([path]);
  }, adding ?? null);
  await expect
    .poll(() =>
      window.evaluate(
        async (wanted) =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
          ).filter((each) => wanted.includes(each.name) && each.status === "ready").length,
        names,
      ),
    )
    .toBe(names.length);
  await window.evaluate(async (wanted) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const library = await core.getLibrary();
    const folder =
      library.groups.find((group) => group.name === "Harbours") ??
      (await core.createLibraryGroup({ name: "Harbours", description: "" }));
    const documents = (await core.listDocuments()).filter((each) => wanted.includes(each.name));
    const minds = (await core.listMinds()).filter((each) => each.title === "Harbour notes");
    await core.moveToFolder({
      documentIds: documents.map((each) => each.id),
      mindIds: minds.map((each) => each.id),
      folderId: folder.id,
    });
  }, names);
}

test("a sentence nothing supported is offered a check again once a Document is added to the Mind's Folder, and is then supported; in English and Chinese at 1,100 px", async () => {
  await writeFile(join(sources, "Tides.pdf"), buildPdf([{ lines: ["Harbour times", MOON] }]));
  await writeFile(
    join(sources, "Seabirds.pdf"),
    buildPdf([{ lines: ["Seabirds", "Penguins nest on the cliffs above the harbour in spring."] }]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1100, 860);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await mindWrittenBefore(window, "Harbour notes", [{ note: `${MOON} ${PENGUINS}` }]);
  await window.getByTestId("mind-list-item").filter({ hasText: "Harbour notes" }).click();
  await fileInto(window, ["Tides"]);
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toContainText(PENGUINS);

  await window.getByTestId("mind-tab").first().click({ button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "Check", exact: true }));
  const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(2);
  await expect(marks.and(window.locator('[data-check="unsupported"]'))).toHaveCount(1);
  const line = window.getByTestId("check-card").getByTestId("checks-added");
  await checkCard(window);
  await expect(line).toHaveCount(0);
  await window.keyboard.press("Escape");

  await fileInto(window, ["Seabirds"], join(sources, "Seabirds.pdf"));
  await expect
    .poll(async () => {
      await checkCard(window);
      return line.count();
    })
    .toBe(1);
  await expect(line).toHaveText(
    /^1 Document added since these checks\s*·\s*Check again\s*·\s*Close$/,
  );
  await motionSettled(window);
  await screenshot(window, "added-line-en");
  await window.keyboard.press("Escape");
  const unsupported = marks.and(window.locator('[data-check="unsupported"]'));
  await pointAndClick(window, unsupported);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-added")).toHaveText(
    /^1 Document added since this check\s*·\s*Check again$/,
  );
  await motionSettled(window);
  await screenshot(window, "added-card-en");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await setLanguage(window, "zh-CN");
  await checkCard(window);
  await expect(line).toHaveText(/^核对之后新增了 1 个文档\s*·\s*重新核对\s*·\s*关闭$/);
  const box = await line.boundingBox();
  const lineHeight = await line.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(2 * lineHeight);
  await motionSettled(window);
  await screenshot(window, "added-line-zh");
  await setLanguage(window, "en");

  await checkCard(window);
  await pointAndClick(window, line.getByTestId("checks-added-check"));
  await expect(marks.and(window.locator('[data-check="supported"]'))).toHaveCount(2);
  await expect(marks).toHaveCount(2);
  await expect(line).toHaveCount(0);
});

for (const widened of [false, true]) {
  test(`closed, the line stays closed until another Document is added; asks with the ${widened ? "all Documents" : "Folder"} scope`, async () => {
    await writeFile(join(sources, "Tides.pdf"), buildPdf([{ lines: ["Harbour times", MOON] }]));
    await writeFile(
      join(sources, "Ferries.pdf"),
      buildPdf([{ lines: ["Ferries", "The ferry leaves twice a day."] }]),
    );
    await writeFile(
      join(sources, "Cranes.pdf"),
      buildPdf([{ lines: ["Cranes", "Two cranes unload the ships."] }]),
    );
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
      if (provider.service) {
        for (const flow of ["chat", "tagging", "checks"] as const) {
          await core.allowDataFlow(flow, provider.service.id);
        }
      }
      // A cap, so a run under a dollar still shows its estimate (#1941).
      await core.updateSettings({ user: { monthlyCap: { amount: 20, currency: "USD" } } });
    });
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await mindWrittenBefore(window, "Harbour notes", [{ note: `${MOON} ${PENGUINS}` }]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Harbour notes" }).click();
    await fileInto(window, ["Tides"]);
    await window.getByTestId("mind-tab").first().click({ button: "right" });
    await pointAndClick(window, window.getByRole("menuitem", { name: "Check", exact: true }));
    await pointAndClick(
      window,
      window
        .getByTestId("check-card")
        .getByTestId("mind-check-ask")
        .getByTestId("mind-check-check"),
    );
    await expect(
      window.getByTestId("claim-mark").and(window.locator('[data-check="unsupported"]')),
    ).toHaveCount(1);

    if (widened) {
      const unsupported = window
        .getByTestId("claim-mark")
        .and(window.locator('[data-check="unsupported"]'));
      await pointAndClick(window, unsupported);
      const card = window.getByTestId("claim-card");
      await pointAndClick(window, card.getByTestId("claim-search-all"));
      await expect(window.getByTestId("badge-stop")).toHaveCount(0);
      await expect(unsupported).toHaveCount(1);
      await pointAndClick(window, unsupported);
      await expect(card).toBeVisible();
      await expect(card.getByTestId("claim-search-all")).toHaveCount(0);
      await window.keyboard.press("Escape");
    }

    await fileInto(window, ["Ferries"], join(sources, "Ferries.pdf"));
    const line = window.getByTestId("check-card").getByTestId("checks-added");
    await expect
      .poll(async () => {
        await checkCard(window);
        return line.count();
      })
      .toBe(1);
    await pointAndClick(window, line.getByTestId("checks-added-close"));
    await expect(line).toHaveCount(0);
    await window.keyboard.press("Escape");

    await fileInto(window, ["Cranes"], join(sources, "Cranes.pdf"));
    await expect
      .poll(async () => {
        await checkCard(window);
        return line.count();
      })
      .toBe(1);
    await expect(line).toHaveText(/^2 Documents added since these checks/);
    await window.keyboard.press("Escape");

    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("check again with");
    await pointAndClick(
      window,
      window
        .getByTestId("palette-item")
        .filter({ hasText: "Check again with the Documents added since" }),
    );
    const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
    await expect(ask).toContainText(
      widened
        ? "Check this Note’s claim against your Documents?"
        : "Check this Note’s claim against this Folder’s Documents?",
    );
    await expect(ask).toContainText("About $");
    await motionSettled(window);
    await screenshot(window, widened ? "ask-all-en" : "ask-folder-en");
    if (widened) {
      await setLanguage(window, "zh-CN");
      await expect(ask).toContainText("要对照你的文档，核对这篇笔记中的这条说法吗？");
      await motionSettled(window);
      await screenshot(window, "ask-all-zh");
      await setLanguage(window, "en");
    }
    await pointAndClick(window, ask.getByTestId("mind-check-check"));
    await expect(window.getByTestId("badge-stop")).toHaveCount(0);
    await checkCard(window);
    await expect(line).toHaveCount(0);
    await expect(
      window.getByTestId("claim-mark").and(window.locator('[data-check="unsupported"]')),
    ).toHaveCount(1);
  });
}
