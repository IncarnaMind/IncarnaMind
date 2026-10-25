import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { GENERATED_MARK, MIND_CONTENT_FIELD, PROPOSAL_INSERT_MARK } from "../../src/core/api";
import { holdsNothing, holdsOnlyAiText } from "../../src/shared/madeMind";
import { recordProposalRequest } from "../../src/shared/proposals";

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

/** A Mind of one line whose runs carry these marks, and the requests its waiting text belongs to. */
function lineOf(
  runs: readonly { text: string; generated?: true; waiting?: "answer" | "word" }[],
): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const line = new Y.XmlElement("paragraph");
  const content = new Y.XmlText();
  line.insert(0, [content]);
  fragment.insert(0, [line]);
  recordProposalRequest(doc, "answer", {
    source: "answer-added",
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    createdAt: "2026-10-24T09:00:00.000Z",
  });
  recordProposalRequest(doc, "word", { source: "word-change", author: "Priya", date: null });
  for (const run of runs) {
    content.insert(content.length, run.text, {
      ...(run.generated && { [GENERATED_MARK]: {} }),
      ...(run.waiting && { [PROPOSAL_INSERT_MARK]: { id: run.text, request: run.waiting } }),
    });
  }
  return fragment;
}

describe("A Mind only an Answer wrote in (#1790)", () => {
  // protects=a Mind whose text is all AI text, applied or still waiting, counts as the assistant's, so the Minds line leaves it out; fails_when=it counts as the User's; no_claim=how the window marks text it applies.
  test.each([
    ["applied AI text", [{ text: "The beta opens in February.", generated: true as const }]],
    ["an Answer's waiting text", [{ text: "The beta opens.", waiting: "answer" as const }]],
  ])("one holding %s is", (_name, runs) => {
    expect(holdsOnlyAiText(lineOf(runs))).toBe(true);
  });

  // protects=a Mind with any word the User or a Word file's author wrote, or with no text at all, counts as the User's, so it stays on the Minds line; fails_when=it is taken for the assistant's and left out; no_claim=none beyond protects.
  test.each([
    ["the User's own words", [{ text: "Mine." }, { text: " Added.", generated: true as const }]],
    ["a Word file's tracked insertion", [{ text: "From Word.", waiting: "word" as const }]],
    ["no text at all", []],
  ])("one holding %s isn't", (_name, runs) => {
    expect(holdsOnlyAiText(lineOf(runs))).toBe(false);
  });
});
