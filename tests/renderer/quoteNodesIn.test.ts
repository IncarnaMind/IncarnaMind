/**
 * Where a Citation's quote is looked for in a Word file's drawn pages: a cited
 * Unit that isn't in the file has nothing to look in, as in every other format,
 * and a section that can't be placed in a file whose Units exist is looked for
 * in the whole Document (#2810). The Range of a placed section is left to the
 * smoke spec `e2e/quoteScope.spec.ts`, which draws real pages.
 */
import { DOMParser, NodeFilter } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { piecesOf, quoteNodesIn } from "../../src/renderer/src/viewer/domQuote";
import { findQuoteInPieces } from "../../src/shared/quoteMatch";

const QUOTE = "The final decision is to retain the harbour.";
const PLACE = "section.docx > article";

const pages = () => {
  const page = new DOMParser().parseFromString(
    `<html><body><div class="docx-wrapper"><section class="docx"><article><h1>Stored</h1><p>The stored place has no quoted decision.</p><h1>Elsewhere</h1><p>${QUOTE}</p></article></section></div></body></html>`,
    "text/html",
  );
  return page.querySelector("div.docx-wrapper") as HTMLElement;
};

const quoteIsFoundIn = (nodes: readonly Text[]) =>
  findQuoteInPieces(piecesOf(nodes), QUOTE) !== null;

beforeEach(() => {
  vi.stubGlobal("NodeFilter", NodeFilter);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the text a Word Citation's quote is looked for in", () => {
  test("a cited Unit that isn't in the file has none, though the quote is elsewhere in the file", () => {
    const body = pages();
    expect(quoteNodesIn(body, null, "")).toEqual([]);
    expect(quoteIsFoundIn(quoteNodesIn(body, null, ""))).toBe(false);
  });

  test("a section that can't be placed, in a file whose cited Units exist, is looked for in the whole Document", () => {
    const body = pages();
    expect(quoteIsFoundIn(quoteNodesIn(body, null, PLACE))).toBe(true);
  });
});
