/**
 * The check of a write reads the sentences it holds (#1909), never an Analysis's own table's cells
 * or caption (#2378): they are the run's, so they never count among the claims a write left.
 */
import { expect, test } from "vitest";
import { checkableSentences } from "../../src/core/answers/checks/written";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";

const BINDING = { id: "run-1", table: { result: "region_totals" } };
const text = (value: string): NodeJSON => ({ type: "text", text: value });
const cell = (type: "tableHeader" | "tableCell", value: string): NodeJSON => ({
  type,
  content: [{ type: "paragraph", content: [text(value)] }],
});
const table = (bound: boolean): NodeJSON => ({
  type: "table",
  ...(bound && { attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: BINDING } }),
  content: [
    { type: "tableRow", content: [cell("tableHeader", "region"), cell("tableHeader", "busiest")] },
    {
      type: "tableRow",
      content: [cell("tableCell", "Central"), cell("tableCell", "Brightside placed most orders")],
    },
  ],
});
const caption: NodeJSON = {
  type: "paragraph",
  content: [
    text("Busiest customer by region"),
    { type: ANALYSIS_TABLE_NODE, attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: BINDING } },
  ],
};

test("an Analysis's table and its caption hold no sentence a write's check reads; a typed table's words do", () => {
  const said = (blocks: NodeJSON[]) => checkableSentences(blocks).map((each) => each.text);
  expect(said([caption, table(true)])).toEqual([]);
  expect(said([table(false)])).toEqual(["Brightside placed most orders"]);
});

test("a sentence or a figure written into a caption line is read as any is, by the same rule as Check's", () => {
  const said = (blocks: NodeJSON[]) => checkableSentences(blocks).map((each) => each.text);
  const captionWith = (words: string): NodeJSON => ({
    ...caption,
    content: [text(words), ...(caption.content ?? []).slice(1)],
  });
  expect(said([captionWith("Central had the busiest customer. By region"), table(true)])).toContain(
    "Central had the busiest customer.",
  );
  expect(said([captionWith("Central leads with 9,450"), table(true)]).join(" ")).toContain("9,450");
  expect(said([captionWith("Busiest customer vs. last year by region"), table(true)])).toEqual([]);
});
