import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";
import {
  callTool,
  connectCanvasAgent,
  inCanvas,
  MOD,
  pointInCanvas,
  pressInCanvas,
  publishCanvas,
  showCanvasTab,
} from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * A Canvas in its tab (#3406), with Chromium's sandbox on: a Citation's marker opens its Passage
 * beside the Canvas when the User presses it, and never when the page's own script does; the
 * window's own shortcuts work with the focus inside the page, every other key is the page's; and
 * Tab and Shift+Tab leave the page at its ends. It says it isn't checked against the User's files,
 * and once deleted it waits in Recently deleted. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save stills there.
 */

let dataDir: string;
let home: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
});

const logLines = async (event: string) =>
  (await readFile(join(dataDir, "logs", "incarnamind.log"), "utf8"))
    .split("\n")
    .filter((line) => line.includes(event));

/** Tides.md in no Folder, which the agent given Not in a Folder reads. */
async function withTides(window: Page): Promise<void> {
  const tides = join(sources, "Tides.md");
  await writeFile(tides, "# Tides\n\nSpring tides come twice a month, at new and full moon.\n");
  await window.evaluate(async (path) => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([path]);
  }, tides);
  await expectReadyDocuments(window, 1);
}

test("a Citation's marker opens its Passage beside the Canvas at the User's press, never at the page's script", async () => {
  test.setTimeout(90_000);
  const { app, window } = await launchApp(dataDir, { home, sandboxed: true });
  try {
    await dismissChatSetup(window);
    await withTides(window);
    const agent = await connectCanvasAgent(window);
    const found = await callTool<{ passages: { cite: string | null }[] }>(agent, "search", {
      query: "spring tides twice a month",
    });
    const cite = found.passages.find((each) => each.cite)?.cite ?? "";
    expect(cite).toMatch(/^\[cite:[a-z0-9]+\]$/);
    const canvasId = await publishCanvas(
      agent,
      "Tides",
      `<!doctype html><meta charset="utf-8"><p>Spring tides come twice a month ${cite}.</p>
<p id="made"></p>
<script>
const made = document.createElement("incarnamind-cite");
made.id = "imitation";
made.setAttribute("data-token", "${cite.slice(6, -1)}");
made.textContent = "[9]";
document.getElementById("made").append(made);
setTimeout(() => {
  made.click();
  document.querySelector("incarnamind-cite").click();
  made.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  window.tried = true;
}, 200);
</script>`,
    );
    const url = await showCanvasTab(window, canvasId);
    await expect.poll(() => inCanvas(app, url, "window.tried ?? null")).toBe(true);
    // The page's own presses, of its marker and of one it made, opened nothing.
    await expect(window.getByTestId("document-tab")).toHaveCount(0);
    expect(await logLines("canvas.citationAsked")).toEqual([]);

    const marker = await pointInCanvas(
      app,
      window,
      canvasId,
      url,
      "incarnamind-cite[data-token]:not(#imitation)",
    );
    await window.mouse.move(marker.x, marker.y);
    await window.mouse.down();
    await window.mouse.up();
    const opened = window.getByTestId("document-tab");
    await expect(opened).toBeVisible();
    const canvasTab = window.locator(`[data-testid="canvas-tab"][data-canvas-id="${canvasId}"]`);
    expect(await opened.getAttribute("data-group-id")).not.toBe(
      await canvasTab.getAttribute("data-group-id"),
    );
    expect(await logLines("canvas.citationAsked")).toHaveLength(1);
    await agent.close();
  } finally {
    await app.close();
  }
});

test("with the focus in a Canvas, the window's own shortcuts work, other keys are the page's, and Tab leaves it at its ends", async () => {
  test.setTimeout(90_000);
  const { app, window } = await launchApp(dataDir, { home, sandboxed: true });
  try {
    await dismissChatSetup(window);
    // A model set up, so ⌘J has Ask's composer to focus: with only the User's own AI, the
    // assistant is folded and ⌘J asks that AI instead (#3612).
    await useLocalChatModel(window);
    await newMind(window);
    await enterContent(window);
    const agent = await connectCanvasAgent(window);
    const canvasId = await publishCanvas(
      agent,
      "Keys",
      `<!doctype html><meta charset="utf-8"><p id="here">Keys</p>
<button id="first">First</button> <button id="last">Last</button>
<script>
window.keys = [];
addEventListener("keydown", (event) => window.keys.push((event.metaKey || event.ctrlKey ? "mod+" : "") + event.key));
</script>`,
    );
    // Each showing of the tab draws the page afresh, at an address of its own.
    let url = await showCanvasTab(window, canvasId);
    const inside = () => inCanvas(app, url, "document.hasFocus() && document.activeElement?.id");
    let here = await pointInCanvas(app, window, canvasId, url, "#here");
    const focusPage = async () => {
      await window.mouse.move(here.x, here.y);
      await window.mouse.down();
      await window.mouse.up();
      await expect.poll(() => inCanvas(app, url, "document.hasFocus()")).toBe(true);
    };

    await focusPage();
    await pressInCanvas(app, url, "x");
    await expect.poll(() => inCanvas(app, url, "window.keys.join(' ')")).toBe("x");

    // The command palette, and Esc, which the palette takes once it has the focus.
    await pressInCanvas(app, url, "K", [MOD]);
    await expect(window.getByTestId("palette")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("palette")).toBeHidden();

    // Ask's composer.
    await focusPage();
    await pressInCanvas(app, url, "J", [MOD]);
    await expect(window.getByTestId("composer-input")).toBeFocused();
    expect(await inCanvas(app, url, "window.keys.join(' ')")).toBe("x");

    // The next tab, the Note, and back.
    await focusPage();
    await pressInCanvas(app, url, "Tab", ["control"]);
    await expect(window.locator('[data-testid="mind-tab"][aria-selected="true"]')).toBeVisible();
    url = await showCanvasTab(window, canvasId);
    here = await pointInCanvas(app, window, canvasId, url, "#here");

    // Tab through the page's two buttons, and out of it; Shift+Tab back in, and out at its start.
    // Back from outside the page, Shift+Tab is the window's key.
    await focusPage();
    await pressInCanvas(app, url, "Tab");
    await expect.poll(inside).toBe("first");
    await pressInCanvas(app, url, "Tab");
    await expect.poll(inside).toBe("last");
    await pressInCanvas(app, url, "Tab");
    await expect.poll(() => inCanvas(app, url, "document.hasFocus()")).toBe(false);
    await window.keyboard.press("Shift+Tab");
    await expect.poll(inside).toBe("last");
    await pressInCanvas(app, url, "Tab", ["shift"]);
    await expect.poll(inside).toBe("first");
    await pressInCanvas(app, url, "Tab", ["shift"]);
    await expect.poll(() => inCanvas(app, url, "document.hasFocus()")).toBe(false);
    await agent.close();
  } finally {
    await app.close();
  }
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** A report as an agent would write it: light and dark, a chart drawn inline, one Citation. */
const report = (cite: string, summary: string) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; --ink: #1d2126; --soft: #5b6470; --bar: #3b6ea8; --sheet: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e7e9ec; --soft: #a3abb5; --bar: #7aa7dc; --sheet: #1b1e22; } }
  body { margin: 0; padding: 32px 40px; font: 15px/1.55 system-ui, sans-serif; color: var(--ink); background: var(--sheet); }
  h1 { font-size: 24px; margin: 0 0 4px; } .meta { color: var(--soft); margin: 0 0 20px; }
  .figures { display: flex; gap: 24px; } .figure { flex: 1; max-width: 480px; } svg text { fill: var(--soft); font-size: 11px; }
</style></head><body>
<h1>Tide report</h1><p class="meta">Prepared for the harbour office</p>
<p id="summary">${summary} Spring tides come twice a month, at new and full moon ${cite}.</p>
<div class="figures"><div class="figure"><svg viewBox="0 0 240 120" width="100%" role="img" aria-label="Tidal range by week">
  <rect x="10" y="20" width="40" height="90" fill="var(--bar)"/><rect x="65" y="60" width="40" height="50" fill="var(--bar)"/>
  <rect x="120" y="25" width="40" height="85" fill="var(--bar)"/><rect x="175" y="62" width="40" height="48" fill="var(--bar)"/>
  <text x="10" y="14">Tidal range, metres, by week</text></svg></div></div>
</body></html>`;

test("a Canvas says it is not checked against the User's files, follows the window's dark, and waits in Recently deleted once deleted", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { home, sandboxed: true, systemColours: true });
  try {
    await dismissChatSetup(window);
    await withTides(window);
    const agent = await connectCanvasAgent(window);
    const found = await callTool<{ passages: { cite: string | null }[] }>(agent, "search", {
      query: "spring tides twice a month",
    });
    const cite = found.passages.find((each) => each.cite)?.cite ?? "";
    const canvasId = await publishCanvas(agent, "Tide report", report(cite, "The first draft."));
    await callTool(agent, "update_canvas", {
      canvasId,
      version: 1,
      html: report(cite, "Shorter."),
    });

    const row = window.locator(`[data-testid="canvas-row"][data-canvas-id="${canvasId}"]`);
    await pointAndClick(window, row.getByTestId("canvas-list-item"));
    const url = await showCanvasTab(window, canvasId);
    await expect
      .poll(() => inCanvas(app, url, "document.getElementById('summary')?.textContent ?? null"))
      .toContain("Shorter.");
    const unchecked = window.getByTestId("canvas-unchecked");
    await expect(unchecked).toHaveText(/Not checked against your files/);
    await expect(unchecked).toContainText("Claude Code");
    await shot(window, "canvas-light-en");

    await runCommand(window, "appearance.switch", "Switch to Dark");
    await expect
      .poll(() => inCanvas(app, url, "matchMedia('(prefers-color-scheme: dark)').matches"))
      .toBe(true);
    await shot(window, "canvas-dark-en");
    await runCommand(window, "appearance.switch", "Switch to Light");
    await expect
      .poll(() => inCanvas(app, url, "matchMedia('(prefers-color-scheme: dark)').matches"))
      .toBe(false);

    await setLanguage(window, "zh-CN");
    await expect(unchecked).toHaveText(/未对照你的文件核对/);
    await shot(window, "canvas-light-zh");
    await setWindowSize(app, window, 900, 660);
    await shot(window, "canvas-narrow-zh");

    // Deleted from its tab's menu: the tab closes, and it waits in Recently deleted.
    const tab = window.locator(`[data-testid="canvas-tab"][data-canvas-id="${canvasId}"]`);
    await pointAndClick(window, tab, { button: "right" });
    await pointAndClick(
      window,
      window.getByTestId("tab-actions").filter({ visible: true }).getByTestId("canvas.delete"),
    );
    await expect(tab).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await pointAndClick(window, window.getByTestId("open-library"));
    const head = window.getByTestId("deleted-section-head");
    if ((await head.getAttribute("data-open")) === "false") {
      await pointAndClick(window, head.getByTestId("deleted-heading"));
    }
    const deleted = window
      .getByTestId("recently-deleted")
      .getByTestId("deleted-item")
      .filter({ hasText: "Tide report" });
    await expect(deleted).toBeVisible();
    await shot(window, "canvas-deleted-zh");
    await agent.close();
  } finally {
    await app.close();
  }
});
