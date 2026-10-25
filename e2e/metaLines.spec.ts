import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  expectDotsBetweenParts,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

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

test("a line of parts joined by dots wraps between parts and never starts or ends with a dot, in English and Chinese at a narrow width", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 700);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://a-long-service-name-that-fills-the-line.example.com/v1",
      modelId: "example-model",
    });
    await core.setLocalOnly(true);
  });
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is IncarnaMind?");
  await window.keyboard.press("Enter");
  const line = window.getByTestId("composer-not-ready");

  for (const value of ["en", "zh-CN"] as const) {
    await setLanguage(window, value);
    {
      const row = line.locator(".meta-line").first();
      await expect(row).toBeVisible();
      // The line wraps here: some part begins a line, and its dot is not shown.
      expect(await expectDotsBetweenParts(row)).toBe(true);
    }
  }
  await app.close();
});

const HARBOUR = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 6 months."] },
]);
const CLAIM = "Harbours publish the times of high water every 6 months.";
const LONG_FOLDER =
  "Supplier agreements and framework contracts reviewed by legal in the second half";

for (const value of ["en", "zh-CN"] as const) {
  test(`a problem line in the check badge's card wraps between its parts and never starts or ends with a dot, at 1,100 and 1,440 px (${value}, #887)`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Harbour.pdf"), HARBOUR);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, value);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Harbour.pdf")]);
    await newMind(window);
    await nameMind(window, "Deal memo");
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(CLAIM);
    const line = editor.locator(":scope > p").first();
    await slideSelect(window, line, "Harbours publish", { line, words: "6 months." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const mark = window.getByTestId("claim-mark");
    await expect(mark).toHaveAttribute("data-check", "supported");
    await pointAndClick(window, mark);
    await pointAndClick(window, window.getByTestId("claim-card").getByTestId("claim-add-citation"));
    await expect(line.getByTestId("citation")).toHaveAttribute("data-check", "found");
    // Its Folder, with a long name, holds only the Document the claim cites: a contradiction check
    // has nothing else to check against.
    await window.evaluate(async (name) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await core.createLibraryGroup({ name, description: "" });
      const documentIds = (await core.listDocuments()).map((each) => each.id);
      const mindIds = (await core.listMinds()).map((each) => each.id);
      await core.moveToFolder({ documentIds, mindIds, folderId: folder.id });
    }, LONG_FOLDER);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(value === "en" ? "contradictions" : "矛盾");
    await pointAndClick(
      window,
      window
        .getByTestId("palette-item")
        .filter({ hasText: value === "en" ? "Check for contradictions" : "检查矛盾" })
        .first(),
    );
    // A check that can't run opens the card to say why.
    const problem = window.getByTestId("check-card").getByTestId("checks-problem");
    await expect(problem).toBeVisible();

    for (const width of [1100, 1440]) {
      await setWindowSize(app, window, width, 900);
      // The long Folder name doesn't fit the card's width: its words and actions wrap between parts.
      expect(await expectDotsBetweenParts(problem.locator(".meta-line").first())).toBe(true);
    }
    await app.close();
  });
}
