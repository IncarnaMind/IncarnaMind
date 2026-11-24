/**
 * Measures 5 and 7 on ten decks of the corpus: each arm shows slide 1 and the
 * busiest slide (the most items), and is pictured; and page script looks for
 * a quote of 6 to 12 words (10 to 20 Chinese characters) in the slide's DOM
 * while the editor is mounted, as a Citation's highlight would, some quotes
 * crossing from one run into the next.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import {
  drawPptx,
  type Item,
  type SlideDrawing,
} from "../../../src/core/documents/formats/pptxDrawing";
import { CORPUS } from "../../pptx/corpus";
import { CHINESE_DECKS } from "../corpus";
import { type Arm, armA, armB } from "./arms";
import { lane } from "./bench";

const DECKS = ["c84", "c73", "c32", "c25", "c44", "c22", "c00", "z04", "z05", "c71"];

interface Quote {
  slide: number;
  text: string;
  crossesRuns: boolean;
}

const count = (items: readonly Item[]): number =>
  items.reduce((sum, item) => sum + 1 + (item.kind === "group" ? count(item.children) : 0), 0);

const han = /[一-鿿]/;

/** A quote from the slide's text: across two runs when one paragraph has a seam with enough words on both sides. */
function quotesOf(slide: SlideDrawing, wanted: number): Quote[] {
  const paragraphs: { runs: string[] }[] = [];
  const walk = (items: readonly Item[]) => {
    for (const item of items) {
      if (item.origin !== "slide") continue;
      if (item.kind === "group") walk(item.children);
      if (item.kind === "shape" && item.text) {
        for (const paragraph of item.text.paragraphs) {
          paragraphs.push({
            runs: paragraph.runs.filter((run) => !run.lineBreak).map((run) => run.text),
          });
        }
      }
    }
  };
  walk(slide.items);
  const out: Quote[] = [];
  const window = (text: string, from: number): string | null => {
    if (han.test(text)) {
      const piece = text.slice(from, from + 14);
      return [...piece].filter((each) => han.test(each)).length >= 10 ? piece : null;
    }
    const words = text.slice(from).split(/\s+/).filter(Boolean);
    return words.length >= 6 ? words.slice(0, 8).join(" ") : null;
  };
  for (const paragraph of paragraphs) {
    const text = paragraph.runs.join("");
    if (paragraph.runs.length >= 2) {
      const seam = (paragraph.runs[0] ?? "").length;
      for (let back = 1; back <= 40 && out.length < wanted; back++) {
        const start = Math.max(0, seam - back);
        if (!han.test(text) && start > 0 && text[start - 1] !== " ") continue;
        const quote = window(text, start);
        if (quote && start < seam && start + quote.length > seam) {
          out.push({ slide: slide.number, text: quote, crossesRuns: true });
          break;
        }
      }
    }
    if (out.length >= wanted) break;
  }
  for (const paragraph of paragraphs) {
    if (out.length >= wanted) break;
    const text = paragraph.runs.join("");
    const quote = window(text, 0);
    if (quote && !out.some((each) => each.text === quote))
      out.push({ slide: slide.number, text: quote, crossesRuns: false });
  }
  return out;
}

/** Runs in the page: a DOM Range over exactly the quote's words in the shown slide, or why not. */
function findQuote(args: { quote: string; arm: string }): {
  found: boolean;
  exact: boolean;
  text: string;
  why: string;
} {
  const squash = (text: string) => text.replace(/\s+/g, "");
  let root: Node | null = null;
  if (args.arm === "A") root = document.getElementById("bench-slide");
  else {
    const shadow = document.querySelector("office-kit-pptx-editor")?.shadowRoot;
    const svgs = [...(shadow?.querySelectorAll("svg[viewBox]") ?? [])];
    root =
      svgs.sort(
        (a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height,
      )[0] ?? null;
  }
  if (!root) return { found: false, exact: false, text: "", why: "no slide in the page" };
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  // The squashed text, and for each of its characters the node and offset it came from.
  const places: { node: Text; offset: number }[] = [];
  let joined = "";
  for (const node of nodes) {
    for (let offset = 0; offset < node.data.length; offset++) {
      if (/\s/.test(node.data[offset] ?? "")) continue;
      joined += node.data[offset];
      places.push({ node, offset });
    }
  }
  const at = joined.indexOf(squash(args.quote));
  if (at < 0) return { found: false, exact: false, text: "", why: "not in the slide's text" };
  const first = places[at];
  const last = places[at + squash(args.quote).length - 1];
  if (!first || !last) return { found: false, exact: false, text: "", why: "no place" };
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  const text = range.toString();
  return { found: true, exact: squash(text) === squash(args.quote), text, why: "" };
}

async function run(arm: Arm) {
  const shots = join(lane, "shots", "fidelity");
  mkdirSync(shots, { recursive: true });
  const pins = [...CORPUS, ...CHINESE_DECKS];
  const results: Record<string, unknown>[] = [];
  for (const id of DECKS) {
    const pin = pins.find((each) => each.id === id);
    if (!pin) continue;
    const path = join(lane, "decks/cache", `${pin.sha256}.pptx`);
    const drawing = await drawPptx(new Uint8Array(readFileSync(path)));
    const drawn = drawing.slides.filter((slide): slide is SlideDrawing => "items" in slide);
    const busiest = [...drawn].sort((a, b) => count(b.items) - count(a.items))[0]?.number ?? 1;
    const quotes = quotesOf(
      drawn.find((slide) => slide.number === busiest) ?? (drawn[0] as SlideDrawing),
      2,
    );
    if (quotes.length < 2) {
      for (const slide of drawn) {
        if (slide.number === busiest) continue;
        quotes.push(...quotesOf(slide, 2 - quotes.length));
        if (quotes.length >= 2) break;
      }
    }
    await arm.open(path, 1);
    for (const slide of [...new Set([1, busiest])]) {
      await arm.goTo(slide);
      await arm.window.waitForTimeout(400);
      const view =
        arm.name === "A"
          ? arm.window.locator("#bench-slide")
          : arm.window.locator("svg[viewBox]").filter({ has: arm.window.locator("rect") });
      let target = view.first();
      if (arm.name === "B") {
        let area = 0;
        for (let index = 0; index < (await view.count()); index++) {
          const box = await view.nth(index).boundingBox();
          if (box && box.width * box.height > area) {
            area = box.width * box.height;
            target = view.nth(index);
          }
        }
      }
      await target.screenshot({ path: join(shots, `${id}-s${slide}-${arm.name}.png`) });
    }
    for (const quote of quotes) {
      await arm.goTo(quote.slide);
      await arm.window.waitForTimeout(300);
      const found = await arm.window.evaluate(findQuote, { quote: quote.text, arm: arm.name });
      results.push({ deck: id, ...quote, ...found });
    }
    results.push({ deck: id, busiest, pictured: [...new Set([1, busiest])] });
  }
  writeFileSync(join(lane, `logs/fidelity-${arm.name}.json`), JSON.stringify(results, null, 1));
  const quoteResults = results.filter((each) => "quote" in each || "found" in each);
  console.log(
    arm.name,
    "quotes exact",
    quoteResults.filter((each) => each.exact).length,
    "of",
    quoteResults.length,
  );
}

test("arm A: pictures and quotes", async () => {
  const arm = await armA("fidelity-a");
  await run(arm);
  await arm.app.close();
});

test("arm B: pictures and quotes", async () => {
  const arm = await armB("fidelity-b");
  await run(arm);
  await arm.app.close();
});
