/**
 * Driving each arm's editor the way a person does, for the bench runs: open
 * a deck at a slide, open a text box for typing, move the caret by keys,
 * close the box, and read the deck as the arm would save it.
 */
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { openBench, workDir } from "./bench";

export interface Arm {
  name: "A" | "B";
  app: ElectronApplication;
  window: Page;
  requests: string;
  open(path: string, slide: number): Promise<void>;
  goTo(slide: number): Promise<void>;
  /** The shape's drawing in the main view. */
  shape(id: string): Promise<Locator>;
  /** The element taking the typing, once a box is open. */
  editing(): Promise<boolean>;
  close(): Promise<void>;
  bytes(): Promise<Uint8Array>;
}

const pick = async (locator: Locator) => {
  let best: Locator | null = null;
  let area = 0;
  for (let index = 0; index < (await locator.count()); index++) {
    const box = await locator.nth(index).boundingBox();
    if (box && box.width * box.height > area) {
      area = box.width * box.height;
      best = locator.nth(index);
    }
  }
  if (!best) throw new Error("no such shape on screen");
  return best;
};

export async function armA(name: string): Promise<Arm> {
  const { app, window, requests } = await openBench(join(workDir, "bench/A/index.html"), name);
  await window.waitForFunction(() => "benchA" in window);
  const settled = () =>
    window.waitForFunction(
      () =>
        (window as unknown as { benchA: { state: { pending: number } } }).benchA.state.pending ===
        0,
    );
  return {
    name: "A",
    app,
    window,
    requests,
    async open(path, slide) {
      await window.evaluate(
        ([p, s]) =>
          (
            window as unknown as { benchA: { open: (p: string, s: number) => Promise<void> } }
          ).benchA.open(p, s),
        [path, slide] as const,
      );
      await window.locator("[data-testid=viewer-slide-editor]").waitFor();
    },
    async goTo(slide) {
      await settled();
      await window.evaluate(
        (s) =>
          (window as unknown as { benchA: { goTo: (s: number) => Promise<void> } }).benchA.goTo(s),
        slide,
      );
    },
    async shape(id) {
      await settled();
      return pick(window.locator(`.slide-editor-hit[data-shape-id="${id}"]`));
    },
    async editing() {
      return window.locator("[data-testid=viewer-slide-text-editor]:focus").isVisible();
    },
    async close() {
      await window.keyboard.press("Escape");
      await settled();
    },
    async bytes() {
      await settled();
      return new Uint8Array(
        await window.evaluate(() =>
          Array.from(
            (window as unknown as { benchA: { state: { bytes: Uint8Array } } }).benchA.state.bytes,
          ),
        ),
      );
    },
  };
}

export async function armB(name: string): Promise<Arm> {
  const { app, window, requests } = await openBench(join(workDir, "armB/page/index.html"), name);
  await window.waitForFunction(() => "benchB" in window);
  const goTo = async (slide: number) => {
    await window
      .locator(".thumb-row")
      .nth(slide - 1)
      .click();
    await window.waitForTimeout(250);
  };
  return {
    name: "B",
    app,
    window,
    requests,
    async open(path, slide) {
      await window.evaluate(
        (p) =>
          (window as unknown as { benchB: { open: (p: string) => Promise<void> } }).benchB.open(p),
        path,
      );
      await goTo(slide);
    },
    goTo,
    async shape(id) {
      return pick(window.locator(`g[data-pptx-shape-id="${id}"]`));
    },
    async editing() {
      return window.evaluate(() => {
        let element: Element | null = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        return element instanceof HTMLElement && element.isContentEditable;
      });
    },
    async close() {
      await window.keyboard.press("Escape");
      await window.waitForTimeout(200);
    },
    async bytes() {
      return new Uint8Array(
        await window.evaluate(async () => {
          const editor = (
            window as unknown as {
              benchB: { state: { editor: { snapshot: () => Promise<Uint8Array> } } };
            }
          ).benchB.state.editor;
          return Array.from(await editor.snapshot());
        }),
      );
    },
  };
}
