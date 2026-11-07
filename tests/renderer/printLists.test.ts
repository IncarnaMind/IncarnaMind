/**
 * A list in the PDF reads as the Note shows it: each item's marker, then its text (#2663). The
 * print window is Chromium, which draws a positioned box after the in-flow text around it (CSS 2.1,
 * Appendix E), so a marker drawn by one comes after its item's text in the PDF's text, the order
 * copying, search and a screen reader take it in: "Clause one.1.". Each item here is read in that
 * drawing order, from the page the PDF export prints and print.css.
 */
import { readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { apartAtBreaks } from "../../src/renderer/print/pageBreaks";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

const SHEET = readFileSync(new URL("../../src/renderer/print/print.css", import.meta.url), "utf8");

interface Rule {
  selector: string;
  pseudoElement: string;
  /** Its specificity, then its place in the sheet: a heavier rule wins. */
  weight: number;
  declarations: [string, string][];
}

function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!(?:not|is|has)\()[\w-]+/g)?.length ?? 0;
  const types = selector.replace(/\[[^\]]*\]|[.#:][\w-]+/g, "").match(/[a-z][\w-]*/gi)?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
}

const RULES: Rule[] = SHEET.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("}")
  .flatMap((block, order) => {
    const [head = "", body] = block.split("{");
    if (body === undefined) return [];
    const declarations = body.split(";").flatMap((each): [string, string][] => {
      const colon = each.indexOf(":");
      return colon < 0 ? [] : [[each.slice(0, colon).trim(), each.slice(colon + 1).trim()]];
    });
    return head.split(",").map((each) => {
      const [, selector = "", pseudoElement = ""] =
        /^(.*?)(?:::([\w-]+))?$/s.exec(each.trim()) ?? [];
      return {
        selector,
        pseudoElement,
        weight: specificity(selector) * 1000 + order,
        declarations,
      };
    });
  });

/** What print.css sets on an element, or on one of its pseudo-elements. */
function styleOf(element: Element, pseudoElement = ""): Map<string, string> {
  const matching = RULES.filter(
    (rule) => rule.pseudoElement === pseudoElement && element.matches(rule.selector || "*"),
  );
  return new Map(matching.sort((a, b) => a.weight - b.weight).flatMap((rule) => rule.declarations));
}

/**
 * An item's list-style-type: print.css's for it or its list, else the browser's, which sets one on
 * every list, so none is inherited from further out.
 */
function listStyleType(item: Element): string {
  const list = item.parentElement;
  for (const at of list ? [item, list] : [item]) {
    const style = styleOf(at);
    const type = style.get("list-style-type") ?? style.get("list-style")?.split(/\s+/)[0];
    if (type) return type;
  }
  return list?.localName === "ul" ? "disc" : "decimal";
}

/** The text a `content` value draws: its strings and `attr()`s; null for `normal`. */
function contentOf(item: Element, value = "normal"): string | null {
  if (value === "normal") return null;
  return [...value.matchAll(/attr\(([\w-]+)\)|"([^"]*)"/g)]
    .map(([, name, words]) => (name ? (item.getAttribute(name) ?? "") : (words ?? "")))
    .join("");
}

/**
 * An item's line in the PDF's drawing order: its marker, which the browser draws with the first
 * line, its own text, and then what a positioned ::before draws.
 */
function lineOf(item: Element, number: number): string {
  const type = listStyleType(item);
  const marker =
    contentOf(item, styleOf(item, "marker").get("content")) ??
    (type === "none" ? "" : type === "decimal" ? `${number}. ` : "• ");
  const before = styleOf(item, "before");
  const drawn = contentOf(item, before.get("content")) ?? "";
  const own = [...item.children]
    .filter((child) => child.localName !== "ol" && child.localName !== "ul")
    .map((child) => child.textContent ?? "")
    .join(" ");
  const positioned = ["absolute", "fixed"].includes(before.get("position") ?? "static");
  return (positioned ? `${marker}${own}${drawn}` : `${marker}${drawn}${own}`)
    .replace(/\s+/g, " ")
    .trim();
}

/** The printed page as the PDF reads, cut at its page breaks: a line to each block and list item. */
function read(body: string): string[] {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  const blocks = [...document.body.children].flatMap((child) =>
    apartAtBreaks(child as unknown as HTMLElement),
  );
  const page = document.createElement("div");
  page.className = "page-body";
  page.append(...blocks);
  document.body.replaceChildren(page);
  return blocks.flatMap((block) => {
    if (block.classList.contains("page-break")) return ["(page break)"];
    if (block.localName !== "ol" && block.localName !== "ul") return [block.textContent ?? ""];
    const start = Number(block.getAttribute("start") ?? "1");
    return [...block.children].map((item, at) => lineOf(item, start + at));
  });
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const item = (...content: JSONContent[]): JSONContent => ({
  type: "listItem",
  content: [paragraph(...content)],
});
const list = (type: string, attrs: Record<string, unknown>, ...items: JSONContent[]) => ({
  type,
  attrs,
  content: items,
});
const PAGE_BREAK: JSONContent = { type: "pageBreak" };

const WORDS = {
  en: {
    one: "Clause one.",
    two: "Clause two.",
    point: "Point one.",
    other: "Point two.",
    begins: "Clause two begins.",
    ends: "Clause two ends.",
    three: "Clause three.",
  },
  "zh-CN": {
    one: "第一条。",
    two: "第二条。",
    point: "要点一。",
    other: "要点二。",
    begins: "第二条前半。",
    ends: "第二条后半。",
    three: "第三条。",
  },
};

describe("a list in the PDF", () => {
  for (const language of ["en", "zh-CN"] as const) {
    // protects=a numbered list (in its scheme), a bulleted list and a list a page break cuts each print the marker before the item's text, and the numbering goes on after the break (#2663); fails_when=the marker is drawn by a positioned box, which the PDF puts after the text; no_claim=how wide a marker is laid out.
    test(`draws each item's marker before its text, and goes on counting after a page break (${language})`, async () => {
      const { one, two, point, other, begins, ends, three } = WORDS[language];
      const { printed, printer } = fakePrinter();
      const core = startCore(await createTempDataFolder(), { now: manualClock().now, printer });
      await core.updateSettings({ user: { language } });
      const mind = await core.createMind({ title: "Lists 列表" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [
        list("orderedList", { numbering: "clauses" }, item(text(one)), item(text(two))),
        list("bulletList", {}, item(text(point)), item(text(other))),
        list(
          "orderedList",
          {},
          item(text(one)),
          item(text(begins), PAGE_BREAK, text(ends)),
          item(text(three)),
        ),
      ]);
      await client.settled();

      await core.exportMind(mind.id, { format: "pdf" });

      expect(read(printed[0]?.body ?? "")).toEqual([
        `(a) ${one}`,
        `(b) ${two}`,
        `• ${point}`,
        `• ${other}`,
        `1. ${one}`,
        `2. ${begins}`,
        "(page break)",
        ends,
        `3. ${three}`,
      ]);
    });
  }
});
