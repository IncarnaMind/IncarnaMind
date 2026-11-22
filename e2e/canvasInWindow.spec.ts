import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
} from "./app";
import { connectCanvasAgent, publishCanvas } from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * A Canvas the User's own agent publishes (#3406) shows where Notes do: its row is under Canvases
 * until there is a Folder, and under Not in a Folder after; a click on it shows its tab; its tab's
 * menu ends with its Delete. Its row's menu, ⌘K and Delete with Undo are conformance.spec.ts's.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save stills there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

test("a Canvas an agent publishes is listed where Notes are, and opens from its row", async () => {
  const { window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  // Day one: no Canvas, so no Canvases heading.
  await expect(window.getByTestId("canvases-section")).toHaveCount(0);
  await shot(window, "sidebar-day-one-en");
  const agent = await connectCanvasAgent(window);
  try {
    const id = await publishCanvas(agent, "Tide chart", "<p>Spring tides follow the Moon.</p>");

    // Until there is a Folder, a list of its own between Notes and Documents, counting its rows.
    const section = window.getByTestId("canvases-section");
    await expect(section.getByTestId("canvases-title")).toContainText("Canvases");
    const row = section.locator(`[data-testid="canvas-row"][data-canvas-id="${id}"]`);
    await expect(row).toHaveText("Tide chart");
    await setLanguage(window, "zh-CN");
    await expect(section.getByTestId("canvases-title")).toContainText("页面");
    await setLanguage(window, "en");

    // A Note in front, then a click on its row shows its tab, and the row lights, as a Note's does.
    await newMind(window);
    const tab = window.locator(`[data-testid="canvas-tab"][data-canvas-id="${id}"]`);
    await expect(tab).toHaveAttribute("aria-selected", "false");
    await pointAndClick(window, row.getByTestId("canvas-list-item"));
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(row.getByTestId("canvas-list-item")).toHaveAttribute("aria-selected", "true");
    await shot(window, "canvas-row-en");

    // Its tab's menu: the tab's own items, then its Delete, none of a Note's.
    await pointAndClick(window, tab, { button: "right" });
    const menu = window.getByTestId("tab-actions").filter({ visible: true });
    await expect(menu.getByRole("menuitem").last()).toHaveAttribute("data-testid", "canvas.delete");
    await expect(menu.locator('[data-testid^="mind."]')).toHaveCount(0);
    await shot(window, "canvas-tab-menu-en");
    await window.keyboard.press("Escape");

    // Once there is a Folder, Not in a Folder holds it, after the Notes.
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createLibraryGroup({ name: "Coast", description: "" });
    });
    await expect(section).toHaveCount(0);
    await expect(
      window
        .getByTestId("not-in-a-folder-section")
        .locator(`[data-testid="canvas-row"][data-canvas-id="${id}"]`),
    ).toBeVisible();
    await shot(window, "canvas-not-in-a-folder-en");
  } finally {
    await agent.close();
  }
});
