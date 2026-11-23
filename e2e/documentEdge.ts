import { expect, type Locator, type Page } from "@playwright/test";
import { pointAndClick } from "./app";

export async function expectDocumentEdge(
  window: Page,
  from: Locator,
  destination: Locator,
  edge: "start" | "end",
) {
  await pointAndClick(window, from);
  await expect(from).toBeInViewport();
  await expect
    .poll(() => from.evaluate((line) => line.contains(document.getSelection()?.focusNode ?? null)))
    .toBe(true);
  const offscreen = await destination.evaluate((line) => {
    const pane = line.closest(".mind-scroller")?.getBoundingClientRect();
    if (!pane) throw new Error("The Note's scrolling pane is missing.");
    const rect = line.getBoundingClientRect();
    return { above: rect.bottom < pane.top, below: rect.top > pane.bottom };
  });
  expect(edge === "start" ? offscreen.above : offscreen.below).toBe(true);

  const keys =
    process.platform === "darwin"
      ? { start: "Meta+ArrowUp", end: "Meta+ArrowDown" }
      : { start: "Control+Home", end: "Control+End" };
  await window.keyboard.press(keys[edge]);
  await expect
    .poll(() =>
      destination.evaluate((target, edge) => {
        const selection = target.ownerDocument.getSelection();
        const scroller = target.closest(".mind-scroller");
        if (
          !scroller ||
          !selection?.isCollapsed ||
          !target.contains(selection.focusNode) ||
          !selection.rangeCount
        )
          return null;
        const caret = selection.getRangeAt(0).cloneRange();
        const prefix = caret.cloneRange();
        prefix.selectNodeContents(target);
        prefix.setEnd(caret.endContainer, caret.endOffset);
        let rect = caret.getBoundingClientRect();
        // Chromium draws an empty paragraph's caret on its filler line break.
        if (!rect.height && !target.textContent && target.firstElementChild?.tagName === "BR") {
          caret.selectNode(target.firstElementChild);
          rect = caret.getBoundingClientRect();
        }
        const paneTop = scroller.getBoundingClientRect().top + scroller.clientTop;
        const top = Math.max(0, paneTop);
        const bottom = Math.min(innerHeight, paneTop + scroller.clientHeight);
        return {
          atEdge: prefix.toString().length === (edge === "start" ? 0 : target.textContent?.length),
          visible: rect.height > 0 && rect.top >= top - 1 && rect.bottom <= bottom + 1,
        };
      }, edge),
    )
    .toEqual({ atEdge: true, visible: true });
}
