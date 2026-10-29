import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Tie out figures (#1932): ⌘K runs the note's one Check and opens the Figure schedule beside
 * the note. Each figure shows its source value, its Document and Location, the Difference
 * ("Rounded from …" or the signed amount) and the one vocabulary's status; a total that agrees
 * with its source but doesn't add up names the source row the table leaves out. A row
 * outlines its figure in the note, Keep as my view acts on the chosen figure only, Esc
 * clears the selection, and Not a total takes a total's footing away, each with Undo.
 * English and Chinese, each wide and narrow.
 */

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const shot = async (window: Page, name: string) => {
  if (!SHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
};

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

const MEMO =
  "Revenue was £4,980m, up from £4,860m a year earlier. Net finance cost over the last 12 months was £402m. Capital expenditure was £212m in the quarter.";

/** Puts the segment table into the note as the editor stores one, through the core. */
async function addSegments(window: Page, mindId: string) {
  await window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const cell = (text: string, header = false) => ({
      type: header ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const row = (cells: string[], header = false) => ({
      type: "tableRow",
      content: cells.map((text) => cell(text, header)),
    });
    await bridge.addToNote({
      mindId: id,
      blocks: [
        {
          type: "table",
          content: [
            row(["Segment", "Q3 2026"], true),
            row(["Groceries", "£3,100m"]),
            row(["Fuel", "£1,750m"]),
            row(["Total", "£4,980m"]),
          ],
        },
      ],
      origin: null,
      model: null,
    });
  }, mindId);
}

/**
 * Clicks a tab as a person does. A strip with room for fewer tabs than it holds keeps the rest
 * out of sight behind its fade, so the wheel over the strip brings this one into view first.
 */
async function clickTab(window: Page, tab: Locator) {
  const strip = window.getByRole("tablist").filter({ has: tab });
  let point = { x: 0, y: 0 };
  await expect(async () => {
    await motionSettled(window);
    const seen = await tab.evaluate((element) => {
      const at = element.getBoundingClientRect();
      const list = element.parentElement?.getBoundingClientRect() ?? at;
      const x = (Math.max(at.left, list.left) + Math.min(at.right, list.right)) / 2;
      const y = at.top + at.height / 2;
      const hit = document.elementFromPoint(x, y);
      const inView = hit !== null && element.contains(hit);
      return { x, y, inView, later: at.left >= list.right - 1 };
    });
    if (!seen.inView) {
      const box = await strip.boundingBox();
      if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await window.mouse.wheel(0, seen.later ? 120 : -120);
    }
    expect(seen.inView).toBe(true);
    point = seen;
  }).toPass();
  await window.mouse.move(point.x, point.y, { steps: 8 });
  await window.mouse.click(point.x, point.y);
}

/**
 * Runs Tie out figures from ⌘K. Billed per token, the one Check asks first, in the note's card;
 * in a window too narrow for groups side by side the schedule comes to the front once the User
 * has answered.
 */
async function tieOut(window: Page, schedule: Locator, title: string, label: string) {
  await runCommand(window, "mind.tieOut", label);
  const ask = window.getByTestId("mind-check-ask");
  await expect(ask.or(schedule).first()).toBeVisible({ timeout: 30_000 });
  if (!(await ask.isVisible())) return;
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect(schedule).toBeVisible({ timeout: 30_000 });
  await expect(window.getByRole("tab", { name: new RegExp(`^${title}`) })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

/** The contradicted figure's card names the number its source gives, and where (#1932). */
async function contradictedCard(window: Page, language: "en" | "zh-CN") {
  const mark = window.locator('[data-testid="claim-mark"][data-check="contradicted"]').first();
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-figure-source")).toContainText("£392m");
  await expect(card.getByTestId("claim-figure-source")).toContainText(
    language === "en" ? "p. 1" : "第 1 页",
  );
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
}

for (const [language, width] of [
  ["en", 1440],
  ["en", 1100],
  ["zh-CN", 1100],
  ["zh-CN", 1440],
] as const) {
  test(`Tie out figures opens the schedule beside the note and works row by row (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    await writeFile(
      join(sources, "Northwind Q3 2026 results.pdf"),
      buildPdf([
        {
          lines: [
            "Northwind Retail Q3 2026 results",
            "Revenue was £4,979.6m in Q3 2026, against £4,860m in Q3 2025.",
            "Net finance cost over the last 12 months was £392m.",
          ],
        },
      ]),
    );
    await writeFile(
      join(sources, "Segments Q3.xlsx"),
      xlsxOf([
        {
          name: "Segments",
          rows: [
            ["All figures in £m"],
            ["Segment", "Q3 2026"],
            ["Groceries", 3100],
            ["Fuel", 1750],
            ["Other", 130],
            ["Total", 4980],
          ],
        },
      ]),
    );
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
      });
      await addDocuments(window, [
        join(sources, "Northwind Q3 2026 results.pdf"),
        join(sources, "Segments Q3.xlsx"),
      ]);
      await setLanguage(window, language);
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.type(MEMO);
      const mindId = await window.evaluate(
        () =>
          document.activeElement
            ?.closest('[data-testid="mind-pane"]')
            ?.getAttribute("data-mind-id") ?? "",
      );
      await addSegments(window, mindId);

      const schedule = window.getByTestId("figure-schedule");
      const checked = t("figures.checked", { time: "" }).trim();
      await tieOut(window, schedule, t("figures.title"), t("figures.command"));
      await expect(schedule.getByTestId("figure-when")).toContainText(checked, {
        timeout: 60_000,
      });
      // Beside the note, named after it: in a wide window the note stays in view.
      if (width >= 1440) await expect(editor).toBeVisible();
      await expect(schedule.locator(".figure-name")).toHaveText(/^Revenue was £4,980m, up from/);
      await expect(schedule.getByTestId("figure-counts")).toHaveText(
        [
          t("figures.count", { count: 7 }),
          t("figures.supported", { count: 4 }),
          t("figures.look", { count: 3 }),
          t("figures.notChecked", { count: 0 }),
        ].join(" · "),
      );
      const rows = schedule.locator("tbody tr[data-figure-id]");
      await expect(rows).toHaveCount(7);
      const rowOf = (index: number) => rows.nth(index);
      await expect(rowOf(0).locator(".figure-difference")).toHaveText(
        t("figures.roundedFrom", { value: "£4,979.6m" }),
      );
      await expect(rowOf(0).locator(".figure-status")).toContainText(t("claim.state.supported"));
      await expect(rowOf(2).locator(".figure-difference")).toHaveText("+£10m");
      await expect(rowOf(2).locator(".figure-status")).toContainText(t("claim.why.contradicted"));
      await expect(rowOf(3).locator(".figure-status")).toContainText(t("claim.why.notFound"));
      const total = rowOf(6);
      await expect(total.locator(".figure-status")).toContainText(t("claim.why.doesntAddUp"));
      const why = total.locator(".figure-why");
      await expect(why).toContainText(t("figures.foot.agrees"));
      await expect(why).toContainText(t("figures.foot.rows", { value: "£4,850m" }));
      await expect(why).toContainText(t("figures.foot.omitted", { rows: "Other £130m" }));
      await shot(window, `tieout-all-${language}-${width}`);

      // Needs a look: only the figures to fix.
      await pointAndClick(window, schedule.locator('[data-filter="look"]'));
      await expect(rows).toHaveCount(3);
      await shot(window, `tieout-look-${language}-${width}`);
      await pointAndClick(window, schedule.locator('[data-filter="all"]'));
      await expect(rows).toHaveCount(7);

      // A row outlines its figure in the note; Esc clears the selection and keeps the row's
      // focus. In a narrow window the note is behind the schedule: Space shows it there.
      const outline = window.locator(".claim-outline");
      await pointAndClick(window, rowOf(2).locator("[data-tree-row]"));
      await expect(rowOf(2)).toHaveAttribute("aria-selected", "true");
      if (width >= 1440) {
        await expect(outline.first()).toBeVisible();
        await shot(window, `tieout-outline-${language}-${width}`);
        await window.keyboard.press("Escape");
        await expect(rowOf(2)).toHaveAttribute("aria-selected", "false");
        await expect(outline).toHaveCount(0);
        await expect(rowOf(2).locator("[data-tree-row]")).toBeFocused();
      } else {
        await window.keyboard.press(" ");
        await expect(editor).toBeVisible();
        await expect(outline.first()).toBeVisible();
        await shot(window, `tieout-outline-${language}-${width}`);
        await contradictedCard(window, language);
        const tab = window.getByRole("tab", { name: new RegExp(`^${t("figures.title")}`) });
        await clickTab(window, tab);
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(schedule).toBeVisible({ timeout: 30_000 });
        await pointAndClick(window, rowOf(2).locator("[data-tree-row]"));
        await window.keyboard.press("Escape");
        await expect(rowOf(2)).toHaveAttribute("aria-selected", "false");
        await expect(rowOf(2).locator("[data-tree-row]")).toBeFocused();
      }

      if (width >= 1440) await contradictedCard(window, language);

      // Two figures of one sentence: Keep as my view acts on the one chosen, the other keeps
      // its own result, and Undo takes it back.
      await pointAndClick(window, rowOf(1).locator("[data-tree-row]"));
      await pointAndClick(window, rowOf(1).locator("[data-figure-more]"));
      const menu = rowOf(1).getByRole("menu");
      await expect(menu).toBeVisible();
      await shot(window, `tieout-menu-${language}-${width}`);
      await pointAndClick(window, menu.getByRole("menuitem", { name: t("claim.keepAsView") }));
      await expect(rowOf(1).locator(".figure-status")).toContainText(t("claim.keptAsView"));
      await expect(rowOf(0).locator(".figure-status")).toContainText(t("claim.state.supported"));
      await window.keyboard.press("ControlOrMeta+z");
      await expect(rowOf(1).locator(".figure-status")).toContainText(t("claim.state.supported"));

      // The total isn't one: its footing goes, and Undo brings it back.
      await pointAndClick(window, total.locator("[data-tree-row]"));
      await pointAndClick(window, total.locator("[data-figure-more]"));
      await pointAndClick(
        window,
        total.getByRole("menu").getByRole("menuitem", { name: t("figures.notTotal") }),
      );
      await expect(why).toHaveCount(0);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(why).toContainText(t("figures.foot.agrees"));
    } finally {
      await app.close();
    }
  });
}
