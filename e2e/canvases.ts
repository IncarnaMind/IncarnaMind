/**
 * What the Canvas specs share (#3406): Claude Code connected through the agent connection, as
 * Settings connects it, a Canvas published through it, its tab shown, and its page read from the
 * main process, which alone reaches into it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { type CoreBridge, NOT_IN_A_FOLDER_ID } from "../src/core/api";
import { acceptPlainTextKeys } from "./app";

/** Claude Code, connected with leave to write in no Folder (and so to read the Documents there). */
export async function connectCanvasAgent(window: Page): Promise<Client> {
  await acceptPlainTextKeys(window);
  const launch = await window.evaluate(async (unfiled) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setAgentsEnabled(true);
    return (await bridge.connectAgent({ name: "Claude Code", folderIds: [unfiled], propose: true }))
      .launch;
  }, NOT_IN_A_FOLDER_ID);
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return agent;
}

type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };

/** A Tool call's typed result, once it is known not to be a refusal. */
export async function callTool<T>(agent: Client, name: string, args: Record<string, unknown>) {
  const result = (await agent.callTool({ name, arguments: args })) as ToolResult;
  expect(result.isError ?? false, result.content?.[0]?.text).toBe(false);
  return result.structuredContent as T;
}

export async function publishCanvas(
  agent: Client,
  title: string,
  html: string,
  files: string[] = [],
) {
  return (await callTool<{ canvasId: string }>(agent, "publish_canvas", { title, html, files }))
    .canvasId;
}

const frameOf = (window: Page, canvasId: string) =>
  window.locator(
    `[data-testid="canvas-view"][data-canvas-id="${canvasId}"] [data-testid="canvas-frame"]`,
  );

/** Shows a Canvas's tab, opened behind, and gives its page's address once it is drawn. */
export async function showCanvasTab(window: Page, canvasId: string): Promise<string> {
  await window.locator(`[data-testid="canvas-tab"][data-canvas-id="${canvasId}"]`).click();
  const frame = frameOf(window, canvasId);
  await expect(frame).toBeAttached();
  return (await frame.getAttribute("src")) ?? "";
}

/** What a Canvas's page says of itself, read from the main process; null until it is drawn. */
export const inCanvas = (app: ElectronApplication, url: string, expression: string) =>
  app.evaluate(
    async ({ webContents }, { url, expression }) => {
      const guest = webContents
        .getAllWebContents()
        .find((each) => each.getType() === "webview" && each.getURL() === url);
      return guest ? ((await guest.executeJavaScript(expression)) as unknown) : null;
    },
    { url, expression },
  );

/** Where an element of a Canvas's page is in the window, by its selector, for the mouse. */
export async function pointInCanvas(
  app: ElectronApplication,
  window: Page,
  canvasId: string,
  url: string,
  selector: string,
): Promise<{ x: number; y: number }> {
  const box = await frameOf(window, canvasId).boundingBox();
  const inside = (await inCanvas(
    app,
    url,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  )) as { x: number; y: number } | null;
  if (!box || !inside) throw new Error(`No ${selector} in the Canvas.`);
  return { x: box.x + inside.x, y: box.y + inside.y };
}
