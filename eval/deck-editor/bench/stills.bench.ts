/**
 * The stills page's pictures: the test deck (invented content, test names
 * only) edited in each arm, a text box with Chinese being composed, a shape
 * being dragged with its handles, and the saved copy opened again in our
 * renderer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { type Arm, armA, armB } from "./arms";
import { workDir } from "./bench";

const stills = join(workDir, "stills");

async function slideArea(arm: Arm) {
  if (arm.name === "A") {
    const box = await arm.window.locator("#bench-slide").boundingBox();
    if (!box) throw new Error("no slide");
    return box;
  }
  const svgs = arm.window.locator("svg[viewBox]");
  let best = { x: 0, y: 0, width: 0, height: 0 };
  for (let index = 0; index < (await svgs.count()); index++) {
    const box = await svgs.nth(index).boundingBox();
    if (box && box.width * box.height > best.width * best.height) best = box;
  }
  return best;
}

async function pictures(arm: Arm) {
  mkdirSync(stills, { recursive: true });
  const deck = join(workDir, "decks/test-deck.pptx");
  await arm.open(deck, 2);
  const area = await slideArea(arm);
  const clip = { x: area.x - 8, y: area.y - 8, width: area.width + 16, height: area.height + 16 };

  const shape = await arm.shape("10");
  const box = await shape.boundingBox();
  if (!box) throw new Error("no shape");
  await arm.window.mouse.dblclick(box.x + 8, box.y + box.height / 2);
  await arm.window.keyboard.press("Meta+ArrowRight");
  const cdp = await arm.window.context().newCDPSession(arm.window);
  await cdp.send("Input.insertText", { text: "（第三季度）" });
  await cdp.send("Input.imeSetComposition", { text: "hedui", selectionStart: 5, selectionEnd: 5 });
  await cdp.send("Input.imeSetComposition", {
    text: "核对完毕",
    selectionStart: 4,
    selectionEnd: 4,
  });
  await arm.window.waitForTimeout(200);
  await arm.window.screenshot({ path: join(stills, `${arm.name}-1-typing.png`), clip });
  await cdp.send("Input.insertText", { text: "核对完毕" });
  await arm.close();

  const rect = await arm.shape("20");
  const at = await rect.boundingBox();
  if (!at) throw new Error("no rectangle");
  const from = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
  await arm.window.mouse.move(from.x, from.y);
  await arm.window.mouse.down();
  await arm.window.mouse.move(from.x - 60, from.y + 100, { steps: 6 });
  await arm.window.mouse.move(from.x - 120, from.y + 200, { steps: 6 });
  await arm.window.waitForTimeout(200);
  await arm.window.screenshot({ path: join(stills, `${arm.name}-2-dragging.png`), clip });
  await arm.window.mouse.up();
  await arm.window.waitForTimeout(400);
  const saved = join(stills, `${arm.name}-test-deck-edited.pptx`);
  writeFileSync(saved, await arm.bytes());
  return saved;
}

test("stills of both arms", async () => {
  const savedCopies: string[] = [];
  for (const make of [armA, armB]) {
    const arm = await make(`stills-${make === armA ? "a" : "b"}`);
    savedCopies.push(await pictures(arm));
    await arm.app.close();
  }
  // Each saved copy opened again in our renderer, as the viewer on main draws it.
  for (const [index, copy] of savedCopies.entries()) {
    const viewer = await armA(`stills-view-${index}`);
    await viewer.window.evaluate(
      (path) =>
        (
          window as unknown as {
            benchA: { open: (p: string, s: number, e: boolean) => Promise<void> };
          }
        ).benchA.open(path, 2, false),
      copy,
    );
    await viewer.window.locator("[data-testid=viewer-slide-canvas]").waitFor();
    const box = await viewer.window.locator("#bench-slide").boundingBox();
    if (box) {
      await viewer.window.screenshot({
        path: join(stills, `${index === 0 ? "A" : "B"}-3-reopened.png`),
        clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
      });
    }
    await viewer.app.close();
  }
});
