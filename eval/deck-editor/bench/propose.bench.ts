/**
 * Measure 8, arm B only: an AI's change made on a copy and handed back with
 * propose(), while the person has typed into the deck; and the tools() a
 * model would be given. What an undo step is, and whether the hand edit lives.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { armB } from "./arms";
import { lane } from "./bench";

type Page = import("@playwright/test").Page;

const call = <T>(window: Page, script: string): Promise<T> => window.evaluate(script) as Promise<T>;

async function typeInto(arm: Awaited<ReturnType<typeof armB>>, shapeId: string, words: string) {
  const shape = await arm.shape(shapeId);
  const box = await shape.boundingBox();
  if (!box) throw new Error("no shape");
  await arm.window.mouse.dblclick(box.x + 8, box.y + box.height / 2);
  await arm.window.waitForFunction(() => {
    let element: Element | null = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element instanceof HTMLElement && element.isContentEditable;
  });
  await arm.window.keyboard.press("Meta+ArrowRight");
  await arm.window.keyboard.insertText(words);
  await arm.close();
}

test("arm B: an AI's change through propose, beside a hand edit", async () => {
  const arm = await armB("propose-b");
  const { window } = arm;
  const results: Record<string, unknown> = {};
  await arm.open(join(lane, "decks/test-deck.pptx"), 2);
  const part = "/ppt/slides/slide2.xml";
  const text = (id: number) =>
    call<string>(window, `benchB.shapeText(${JSON.stringify(part)}, ${id})`);

  // 1. The AI works on a copy of the deck as it was; meanwhile the person types into another shape.
  await call(window, "(async () => { window.base = await benchB.state.editor.snapshot(); })()");
  await typeInto(arm, "10", "（手改）");
  await call(
    window,
    `(async () => { window.edited = await benchB.agentCopy(window.base, ${JSON.stringify(part)}, 11, "（AI改）"); })()`,
  );
  results.differentShapes = await call(
    window,
    "(async () => benchB.state.editor.propose(window.base, window.edited, { label: 'Tighten the wording' }))()",
  );
  results.afterProposeHand = await text(10);
  results.afterProposeAgent = await text(11);
  // One undo takes back the AI's step only.
  await window.keyboard.press("Meta+z");
  await window.waitForTimeout(300);
  results.afterOneUndoHand = await text(10);
  results.afterOneUndoAgent = await text(11);
  await window.keyboard.press("Meta+Shift+z");
  await window.waitForTimeout(300);

  // 2. The same shape changed on both sides: nothing is applied until the person chooses.
  await call(window, "(async () => { window.base2 = await benchB.state.editor.snapshot(); })()");
  await typeInto(arm, "12", " (by hand)");
  await call(
    window,
    `(async () => { window.edited2 = await benchB.agentCopy(window.base2, ${JSON.stringify(part)}, 12, " (by the AI)"); })()`,
  );
  await call(
    window,
    "(() => { window.pending = benchB.state.editor.propose(window.base2, window.edited2, { label: 'Same shape' }); window.pending.then((r) => { window.settled = r; }); })()",
  );
  await window.waitForTimeout(800);
  results.collisionPrompt = await window.evaluate(() => {
    const root = document.querySelector("office-kit-pptx-editor")?.shadowRoot;
    const buttons = [...(root?.querySelectorAll("button") ?? [])].map(
      (each) => each.textContent?.trim() ?? "",
    );
    return {
      buttons: buttons.filter((each) => /mine|agent|keep|use/i.test(each)),
      text: [
        ...(root?.querySelectorAll("[role=alert], [role=status], .conflict, .proposal") ?? []),
      ].map((each) => each.textContent?.trim().slice(0, 200)),
    };
  });
  results.whileAsking = await text(12);
  const keep = window.locator("button", { hasText: /Keep my edits/i }).first();
  if (await keep.count()) await keep.click();
  await window
    .waitForFunction(() => "settled" in window, null, { timeout: 5000 })
    .catch(() => undefined);
  results.collisionSettled = await window.evaluate(
    () => (window as unknown as { settled?: unknown }).settled ?? null,
  );
  results.afterKeepMine = await text(12);

  // 3. The tools a model would be given.
  results.tools = await window.evaluate(async () => {
    const tools = await (
      window as unknown as {
        benchB: {
          state: {
            editor: {
              tools: () => Promise<{ name: string; description: string; input_schema: unknown }[]>;
            };
          };
        };
      }
    ).benchB.state.editor.tools();
    const json = JSON.stringify(tools);
    return {
      count: tools.length,
      characters: json.length,
      has: ["setShapeText", "setShapeBounds", "listShapes", "setShapeTextFormat"].map(
        (name) => `${name}:${tools.some((each) => each.name === name)}`,
      ),
      setShapeText: JSON.stringify(tools.find((each) => each.name === "setShapeText")).slice(
        0,
        600,
      ),
    };
  });
  results.violations = await window.evaluate(
    () => (window as unknown as { violations: unknown[] }).violations,
  );
  writeFileSync(join(lane, "logs/propose-b.json"), JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results, null, 1).slice(0, 3000));
  await arm.app.close();
  console.log(
    "requests not from files:",
    readFileSync(arm.requests, "utf8")
      .split("\n")
      .filter((line) => line && !line.includes('"url":"file')).length,
  );
});
