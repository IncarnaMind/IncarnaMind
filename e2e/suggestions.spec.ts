import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  useOutputLocation as chooseOutputLocation,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const TIDES = [
  "# Tides",
  "",
  "The Moon raises two bulges of water on the Earth.",
  "",
  "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
  "",
  "Harbours publish the times of high water every year.",
  "",
].join("\n");

const CHAOXI = [
  "# 潮汐",
  "",
  "大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
  "",
  "港口每年公布高潮时刻表。",
  "",
].join("\n");

/** What the scripted model suggests for a paragraph about spring tides: the Document's line. */
const SPRING =
  "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.";

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

/** The paragraph being written: the last one in the Mind. */
const lastParagraph = (window: Page) =>
  window.getByTestId("mind-editor").locator(":scope > p").last();

test("a pause at the end of a paragraph its Documents support shows grey text with a Citation: Tab accepts it with a found Citation, Esc dismisses it, and typing goes on", async () => {
  await writeFile(join(sources, "Tides.md"), TIDES);
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.md")]);
  await newMind(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  // A checked sentence above the one being written, so its card can be open while Tab accepts (#1762).
  await editor.evaluate((dom) => {
    const note = (dom as unknown as { editor: Editor }).editor;
    note.commands.insertContentAt(0, [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Penguins nest on the harbour cliffs.",
            marks: [
              {
                type: "claimCheck",
                attrs: {
                  id: "check-1",
                  request: "check-1",
                  action: "check-against-documents",
                  state: "unsupported",
                  text: "Penguins nest on the harbour cliffs.",
                  scope: { folderId: null, widened: false },
                  versions: [],
                  excluded: [],
                  checkedAt: "2099-01-01T00:00:00.000Z",
                },
              },
            ],
          },
        ],
      },
    ]);
    note.commands.focus("end");
  });
  const suggestion = window.getByTestId("suggestion");

  // Suggestions are off: after a few sentences, the offer, where the User writes.
  await window.keyboard.type(
    "The harbour survey depends on the tides. Spring tides come twice a month, near the new moon and the full moon.",
  );
  const offer = window.getByTestId("suggestion-offer");
  await expect(offer).toContainText("Suggest the next sentence, cited from your Documents?");
  await expect(suggestion).toHaveCount(0);
  await offer.getByTestId("suggestion-offer-turn-on").click();
  await expect(window.getByTestId("suggestion-offer-on")).toContainText(
    "Suggestions on: Tab accepts, Esc dismisses. Turn them off in Settings.",
  );
  await expect(editor).toBeFocused();

  // A pause: grey text after the caret, from the Document, with the marker of its Citation.
  await window.keyboard.type(" The tides at the harbour");
  await expect(suggestion).toBeVisible();
  await expect(lastParagraph(window)).toContainText(`The tides at the harbour ${SPRING}`);
  const marker = window.getByTestId("suggestion-citation");
  await expect(marker).toHaveText("1");
  await expect(marker).toHaveAttribute("title", /^From Tides, .*: “Spring tides happen/);
  await expect(window.getByTestId("suggestion-offer-on")).toHaveCount(0);

  // Esc dismisses it: nothing of it is in the note.
  await window.keyboard.press("Escape");
  await expect(suggestion).toHaveCount(0);
  await expect(lastParagraph(window)).not.toContainText("Spring tides happen");

  // Typing over a suggestion dismisses it, and the typing goes on as typed.
  await window.keyboard.type(" rise");
  await expect(suggestion).toBeVisible();
  await window.keyboard.type("s");
  await expect(suggestion).toHaveCount(0);
  await expect(lastParagraph(window)).toContainText("The tides at the harbour rises");

  // ⌥→ takes the next word; Tab the rest, with a real Citation whose quote is found. A check
  // card open on a sentence above takes no focus, and Tab still accepts the suggestion.
  await expect(suggestion).toBeVisible();
  await window.keyboard.press("Alt+ArrowRight");
  await expect(lastParagraph(window)).toContainText("harbour rises Spring");
  await expect(suggestion).toContainText("tides happen at new moon");
  await pointAndClick(window, window.getByTestId("claim-mark").first());
  await expect(window.getByTestId("claim-card")).toBeVisible();
  await window.keyboard.press("Tab");
  await expect(suggestion).toHaveCount(0);
  await expect(lastParagraph(window)).toContainText(`harbour rises ${SPRING}`);
  await expect(window.getByTestId("claim-card")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("claim-card")).toHaveCount(0);
  const citation = lastParagraph(window).getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(editor).toBeFocused();
  await citation.getByTestId("citation-chip").click();
  await expect(window.getByTestId("citation-badge")).toHaveAttribute("data-check", "found");
  await expect(window.getByTestId("citation-card")).toContainText("Spring tides happen");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("citation-card")).toHaveCount(0);

  // ⌘Z takes the accepted suggestion back, with its Citation.
  await lastParagraph(window).click({ position: { x: 4, y: 12 } });
  await window.keyboard.press("ControlOrMeta+z");
  await expect(lastParagraph(window).getByTestId("citation")).toHaveCount(0);
  await expect(lastParagraph(window)).not.toContainText("tides happen at new moon");

  // Settings → General: the switch, and today's count.
  await window.getByRole("button", { name: "Settings" }).click();
  const settings = window.getByTestId("settings");
  await settings.getByTestId("settings-nav-general").click();
  const section = settings.getByTestId("suggestion-settings");
  await expect(section.getByTestId("suggestion-switch")).toBeChecked();
  await expect(section.getByTestId("suggestion-counts")).toHaveText(
    /^Today: [1-9]\d* suggested, 1 accepted$/,
  );
});

test("in Chinese: suggestions turned on in Settings give Chinese grey text from a Chinese Document, accepted with a found Citation", async () => {
  await writeFile(join(sources, "潮汐.md"), CHAOXI);
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await connectLocalChatModel(window);
  await addDocuments(window, [join(sources, "潮汐.md")]);

  await window.getByRole("button", { name: "设置" }).click();
  const settings = window.getByTestId("settings");
  await settings.getByTestId("settings-nav-general").click();
  const section = settings.getByTestId("suggestion-settings");
  await expect(section).toContainText("写作时根据我的文档给出建议");
  await section.getByTestId("suggestion-switch").click();
  await expect(section.getByTestId("suggestion-switch")).toBeChecked();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(
    "港口测量要看潮汐的规律，工作人员记录每天的水位变化。每个月有两次大潮出现在新月和满月前后，",
  );
  const suggestion = window.getByTestId("suggestion");
  await expect(suggestion).toBeVisible();
  // No space between Chinese text and the suggestion.
  await expect(lastParagraph(window)).toContainText(
    "新月和满月前后，这时太阳和月亮的引力叠加在一起。",
  );
  await expect(window.getByTestId("suggestion-citation")).toHaveAttribute("title", /^来自潮汐/);
  await expect(suggestion).toHaveAttribute("aria-label", /^建议：/);

  await window.keyboard.press("Tab");
  await expect(suggestion).toHaveCount(0);
  await expect(lastParagraph(window)).toContainText("前后，这时太阳和月亮的引力叠加在一起。");
  await expect(lastParagraph(window).getByTestId("citation")).toHaveAttribute(
    "data-check",
    "found",
  );
});

for (const language of ["en", "zh-CN"] as const) {
  test(`one own note's first export unlocks later offers after restart without Citations (${language})`, async () => {
    await writeFile(join(sources, "Tides.md"), TIDES);
    let { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 900, 800);
      await addDocuments(window, [join(sources, "Tides.md")]);
      await newMind(window);
      await window.keyboard.type("The harbour survey depends on the tides.");
      await expect(window.getByTestId("suggestion-offer")).toHaveCount(0);
      await app.close();
      ({ app, window } = await launchApp(dataDir, { fakeChat: true }));
      await setWindowSize(app, window, 900, 800);
      await window.getByTestId("mind-tab").first().click();
      expect(
        await window.evaluate(
          async () =>
            (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings())
              .device.gettingStarted.exported,
        ),
      ).toBe(false);
      await expect(window.getByTestId("suggestion-offer")).toHaveCount(0);
      await chooseOutputLocation(window, sources);
      await exportFromMenu(window, "markdown");
      await expect(window.getByTestId("export-done")).toBeVisible();
      await expect
        .poll(() =>
          window.evaluate(
            async () =>
              (
                await (
                  globalThis as unknown as { incarnamind: CoreBridge }
                ).incarnamind.getSettings()
              ).device.gettingStarted.exported,
          ),
        )
        .toBe(true);
      await app.close();
      ({ app, window } = await launchApp(dataDir, { fakeChat: true }));
      await setWindowSize(app, window, 1600, 800);
      await window.getByTestId("mind-tab").first().click();
      expect(
        await window.evaluate(
          async () =>
            (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds())
              .length,
        ),
      ).toBe(1);
      const editor = window.getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.press("ControlOrMeta+End");
      await window.keyboard.type(
        " Spring tides come twice a month, near the new moon and the full moon.",
      );
      await expect(window.getByTestId("suggestion-offer")).toBeVisible();
    } finally {
      await app.close();
    }
  });
}
