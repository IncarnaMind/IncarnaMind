import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { holdsNothing } from "../../src/shared/madeMind";

type Child = { node: string; text?: string; children?: Child[] };

function mindOf(blocks: readonly Child[]): Y.XmlFragment {
  const fragment = new Y.Doc().getXmlFragment(MIND_CONTENT_FIELD);
  const build = (child: Child): Y.XmlElement | Y.XmlText => {
    if (child.node === "text") {
      const text = new Y.XmlText();
      text.insert(0, child.text ?? "");
      return text;
    }
    const element = new Y.XmlElement(child.node);
    element.insert(0, (child.children ?? []).map(build));
    return element;
  };
  fragment.insert(0, blocks.map(build));
  return fragment;
}

const paragraph = (...children: Child[]): Child => ({ node: "paragraph", children });
const text = (value: string): Child => ({ node: "text", text: value });
const heading = (value: string): Child => ({ node: "heading", children: [text(value)] });

describe("A Mind that holds nothing yet (#1559)", () => {
  // protects=New Mind under an Answer and the assistant agree on an empty Mind: nothing, empty lines, typed-then-deleted text and a title heading; fails_when=one of them reads as holding something, so a new Mind is made beside it; no_claim=how the editor writes a Mind.
  test.each([
    ["nothing at all", []],
    ["empty lines", [paragraph(), paragraph()]],
    ["a line whose text was typed and deleted", [paragraph(text(""))]],
    ["its title alone", [heading("Lease summary"), paragraph()]],
  ])("%s is empty", (_name, blocks) => {
    expect(holdsNothing(mindOf(blocks))).toBe(true);
  });

  // protects=a Mind holding only an image, a chart, a divider, a table or an inline formula isn't empty, so New Mind makes a new Mind rather than writing into it (#1576's review); fails_when=any reads as empty; no_claim=none beyond protects.
  test.each([
    ["an image", [{ node: "image" }]],
    ["a chart", [{ node: "chart" }]],
    ["a divider", [{ node: "horizontalRule" }]],
    ["an empty table", [{ node: "table", children: [{ node: "tableRow" }] }]],
    ["a formula in a line", [paragraph({ node: "formula" })]],
    ["a line of text", [paragraph(text("Rent is due monthly."))]],
    ["a heading after a line", [paragraph(), heading("Risks")]],
  ])("one holding %s isn't", (_name, blocks) => {
    expect(holdsNothing(mindOf(blocks))).toBe(false);
  });
});
