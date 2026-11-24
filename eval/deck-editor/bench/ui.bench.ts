/**
 * Measures 2 and 3 through each arm's own editor, as a person edits, on ten
 * decks of the corpus: the same text targets as the corpus run (the words
 * typed at the end of the shape's first paragraph with words, the caret
 * moved there by keys), and the same shapes moved by a drag and sized by a
 * corner. The copies go to out/<arm>-ui for the comparison, and a folder of
 * them for a person to open in PowerPoint.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { drawPptx, type SlideDrawing } from "../../../src/core/documents/formats/pptxDrawing";
import { CORPUS } from "../../pptx/corpus";
import { CHINESE_DECKS } from "../corpus";
import type { DeckTargets } from "../targets";
import { type Arm, armA, armB } from "./arms";
import { lane } from "./bench";

const DECKS = ["c84", "c73", "c32", "c25", "c44", "c22", "c00", "z04", "z05", "c71"];
const EMU_PER_PX = 9525;

async function editDeck(
  arm: Arm,
  id: string,
  kind: "text" | "box",
  targets: DeckTargets,
  log: string[],
) {
  const pin = [...CORPUS, ...CHINESE_DECKS].find((each) => each.id === id);
  if (!pin) return;
  const path = join(lane, "decks/cache", `${pin.sha256}.pptx`);
  const drawing = await drawPptx(new Uint8Array(readFileSync(path)));
  const first = kind === "text" ? targets.text[0] : targets.box[0];
  await arm.open(path, first?.slide ?? 1);
  if (kind === "text") {
    for (const target of targets.text) {
      const slide = drawing.slides.find(
        (each): each is SlideDrawing => "items" in each && each.number === target.slide,
      );
      const item = slide?.items.find((each) => each.shapeId === target.shapeId);
      if (item?.kind !== "shape" || !item.text) continue;
      const paragraphs = item.text.paragraphs.map((paragraph) =>
        paragraph.runs.map((run) => (run.lineBreak ? "\n" : run.text)).join(""),
      );
      const steps =
        paragraphs.slice(0, target.paragraph).reduce((sum, each) => sum + [...each].length + 1, 0) +
        [...target.before].length;
      await arm.goTo(target.slide);
      const shape = await arm.shape(target.shapeId);
      const box = await shape.boundingBox();
      if (!box) {
        log.push(`${id} slide ${target.slide}: shape ${target.shapeId} not on screen`);
        continue;
      }
      await arm.window.mouse.dblclick(
        box.x + Math.min(12, box.width / 4),
        box.y + Math.min(box.height / 2, 20),
      );
      const opened = await arm.window
        .waitForFunction(
          () => {
            let element: Element | null = document.activeElement;
            while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
            return element instanceof HTMLElement && element.isContentEditable;
          },
          null,
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        log.push(`${id} slide ${target.slide}: shape ${target.shapeId} didn't open for typing`);
        continue;
      }
      await arm.window.keyboard.press("Meta+ArrowUp");
      for (let step = 0; step < steps; step++) await arm.window.keyboard.press("ArrowRight");
      await arm.window.keyboard.insertText(target.added);
      await arm.close();
    }
  } else {
    for (const target of targets.box) {
      await arm.goTo(target.slide);
      const shape = await arm.shape(target.shapeId);
      const box = await shape.boundingBox();
      if (!box) {
        log.push(`${id} slide ${target.slide}: shape ${target.shapeId} not on screen`);
        continue;
      }
      const scale = box.width / (target.from.w / EMU_PER_PX);
      // A point of the shape that no shape above it covers, as a person would grab it.
      const grab = await arm.window.evaluate(
        ({ id, rect, name }) => {
          const root: Document | ShadowRoot | null | undefined =
            name === "A" ? document : document.querySelector("office-kit-pptx-editor")?.shadowRoot;
          const owner = (element: Element | null) =>
            name === "A"
              ? element?.closest(".slide-editor-hit")?.getAttribute("data-shape-id")
              : element?.closest("[data-pptx-shape-id]")?.getAttribute("data-pptx-shape-id");
          for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) {
            for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
              const x = rect.x + rect.width * fx;
              const y = rect.y + rect.height * fy;
              if (owner(root?.elementFromPoint(x, y) ?? null) === id) return { x, y };
            }
          }
          return null;
        },
        { id: target.shapeId, rect: box, name: arm.name },
      );
      // B hit-tests shapes in its own layer over the drawing, which the page can't ask: its shape's middle.
      if (!grab && arm.name === "A") {
        log.push(`${id} slide ${target.slide}: shape ${target.shapeId} is covered by others`);
        continue;
      }
      const point = grab ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      if (arm.name === "B") {
        // A click opens a text shape for typing; Escape leaves it selected, to be dragged.
        await arm.window.mouse.click(point.x, point.y);
        await arm.window.keyboard.press("Escape");
      }
      await arm.window.mouse.move(point.x, point.y);
      await arm.window.mouse.down();
      await arm.window.mouse.move(point.x + 12 * scale, point.y + 6 * scale, { steps: 4 });
      await arm.window.mouse.move(point.x + 24 * scale, point.y + 12 * scale, { steps: 4 });
      await arm.window.mouse.up();
      await arm.window.waitForTimeout(250);
      if (arm.name === "A") await arm.shape(target.shapeId);
      const grow = ((target.to.w - target.from.w) / EMU_PER_PX) * scale;
      const handle =
        arm.name === "A"
          ? arm.window.locator(".slide-editor-handle--se")
          : arm.window.locator('button[aria-label="Resize se"]');
      const corner = (await handle.count()) > 0 ? await handle.first().boundingBox() : null;
      if (!corner) {
        log.push(`${id} slide ${target.slide}: no corner handle`);
        continue;
      }
      const at = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
      await arm.window.mouse.move(at.x, at.y);
      await arm.window.mouse.down();
      await arm.window.mouse.move(at.x + grow / 2, at.y, { steps: 4 });
      await arm.window.mouse.move(at.x + grow, at.y, { steps: 4 });
      await arm.window.mouse.up();
      await arm.window.waitForTimeout(250);
      await arm.window.mouse.click(5, 5);
    }
  }
  const out = join(lane, "out", `${arm.name}-ui`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${id}-${kind}.pptx`), await arm.bytes());
}

for (const name of ["A", "B"] as const) {
  for (const id of DECKS) {
    test(`arm ${name}: edits made in its editor, ${id}`, async () => {
      const targets = JSON.parse(
        readFileSync(join(lane, "out/targets.json"), "utf8"),
      ) as DeckTargets[];
      const deck = targets.find((each) => each.id === id);
      if (!deck) return;
      const log: string[] = [];
      for (const kind of ["text", "box"] as const) {
        if (existsSync(join(lane, "out", `${name}-ui`, `${id}-${kind}.pptx`))) continue;
        const arm =
          name === "A"
            ? await armA(`ui-${name}-${id}-${kind}`)
            : await armB(`ui-${name}-${id}-${kind}`);
        try {
          await editDeck(arm, id, kind, deck, log);
        } catch (error) {
          log.push(
            `${id} ${kind}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          );
        }
        await arm.app.close();
      }
      appendFileSync(join(lane, `logs/ui-${name}.log`), log.map((line) => `${line}\n`).join(""));
    });
  }
}
