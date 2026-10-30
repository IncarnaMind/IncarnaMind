import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  launchApp,
  leaveFirstOpen,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const editorOf = (window: import("@playwright/test").Page) =>
  window.getByTestId("mind-pane").getByTestId("mind-editor");

for (const language of ["en", "zh-CN"] as const) {
  test(`probe shift-click across a citation ${language}`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
      await setLanguage(window, language);
      await leaveFirstOpen(window);
      const chip = editorOf(window).getByTestId("citation-chip").first();
      await expect(chip).toHaveAttribute("data-check", "found", { timeout: 60_000 });
      const card = window.getByTestId("citation-card");
      await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await pointAndClick(window, chip);
      await expect(card).toBeVisible();
      await pointAndClick(window, card.getByTestId("sign-off-toggle"));
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);

      const lines: string[] = [];
      let misses = 0;
      for (let index = 0; index < 25; index++) {
        await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
        const box = await chip.boundingBox();
        if (!box) throw new Error("no chip box");
        const y = box.y + box.height / 2;
        const view = await window.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        await window.mouse.dblclick(box.x - 15, y);
        const afterDouble = await window.evaluate(() => {
          const selection = getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          return {
            text: String(selection?.toString()).slice(0, 30),
            anchor: `${range?.startContainer.nodeName}:${range?.startOffset}`,
            focus: `${range?.endContainer.nodeName}:${range?.endOffset}`,
            held: document.querySelectorAll(".held-selection").length,
          };
        });
        if (index % 2 === 0) await window.waitForTimeout(300);
        const beforeShift = await window.evaluate(
          ([x, y]) => {
            const selection = getSelection();
            const first = document.elementsFromPoint(x as number, y as number)[0];
            const menu = document.querySelector('[data-testid="selection-menu"]');
            const rect = menu?.getBoundingClientRect();
            return {
              text: String(selection?.toString()).slice(0, 30),
              at: `${first?.tagName}${first?.closest('[data-testid="citation-chip"]') ? "[chip]" : ""}`,
              menu: rect ? `${Math.round(rect.top)}..${Math.round(rect.bottom)}@${Math.round(rect.left)}` : "none",
              focus: !!document.activeElement?.closest('[data-testid="mind-editor"]'),
              held: document.querySelectorAll(".held-selection").length,
            };
          },
          [box.x + box.width + 4, y],
        );
        await window.keyboard.down("Shift");
        await window.mouse.click(box.x + box.width + 4, y);
        await window.keyboard.up("Shift");
        await window.waitForTimeout(150);
        const after = await window.evaluate(() => {
          const selection = getSelection();
          return {
            text: String(selection?.toString()).slice(0, 40),
            covered: [...document.querySelectorAll('[data-testid="citation"]')].filter((each) =>
              selection?.containsNode(each, true),
            ).length,
          citations: document.querySelectorAll('[data-testid="citation"]').length,
            focus: !!document.activeElement?.closest('[data-testid="mind-editor"]'),
            held: document.querySelectorAll(".held-selection").length,
          };
        });
        if (after.covered === 0) misses++;
        lines.push(
          `${index}${index % 2 === 0 ? "p" : "n"}: box=${Math.round(box.x)},${Math.round(box.y)} view=${view.w}x${view.h} dbl=${JSON.stringify(afterDouble.text)}/${afterDouble.held} pre=${JSON.stringify(beforeShift.text)} at=${beforeShift.at} menu=${beforeShift.menu} focus=${beforeShift.focus} -> ${after.covered > 0 ? "OK" : "MISS"} (${after.covered}/${after.citations}) ${JSON.stringify(after.text)} focus=${after.focus} held=${after.held}`,
        );
      }
      console.log(`\n== probe ${language} misses=${misses}/25\n${lines.join("\n")}`);
    } finally {
      await app.close();
    }
  });
}
