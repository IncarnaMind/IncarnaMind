import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
  PROPOSAL_INSERT_MARK,
} from "../../src/core/api";
import { setProposal } from "../../src/core/proposals/write";
import { messageReference } from "../../src/core/references";
import { setOrigins } from "../../src/shared/blockOrigins";
import { holdsNothing, madeByAnswer } from "../../src/shared/madeMind";
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

interface Line {
  runs: readonly { text: string; generated?: true; waiting?: "answer" | "word" }[];
  /** Added from an Answer in a conversation: its origin is that Answer. */
  fromAnswer?: true;
  /** The whole line is an Answer's waiting insert. */
  inserted?: true;
  heading?: true;
}

/** A Mind of these lines, and the requests its waiting text belongs to. */
function mindOfLines(lines: readonly Line[]): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(MIND_CONTENT_FIELD);
  recordProposalRequest(doc, "answer", {
    source: "answer-added",
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    createdAt: "2026-10-24T09:00:00.000Z",
  });
  recordProposalRequest(doc, "word", { source: "word-change", author: "Priya", date: null });
  lines.forEach((line, index) => {
    const block = new Y.XmlElement(line.heading ? "heading" : "paragraph");
    block.setAttribute(BLOCK_ID_ATTRIBUTE, `block-${index}`);
    if (line.inserted) {
      setProposal(block, { id: `p-${index}`, request: "answer", kind: "insert" });
    }
    const content = new Y.XmlText();
    block.insert(0, [content]);
    fragment.insert(fragment.length, [block]);
    for (const run of line.runs) {
      content.insert(content.length, run.text, {
        ...(run.generated && { [GENERATED_MARK]: {} }),
        ...(run.waiting && { [PROPOSAL_INSERT_MARK]: { id: run.text, request: run.waiting } }),
      });
    }
    if (line.fromAnswer) {
      setOrigins(doc, [`block-${index}`], {
        from: messageReference("conversation-1", "answer-1"),
        question: "Write a launch brief.",
      });
    }
  });
  return fragment;
}

const ai = (text: string) => ({ text, generated: true as const });

describe("A Mind an Answer made (#1790)", () => {
  // protects=a Mind whose every Block came from an Answer and holds no word of the User's counts as the Answer's, so the Minds line leaves it out; fails_when=it counts as the User's; no_claim=how the window marks text it applies.
  test.each<[string, Line[]]>([
    ["its applied text", [{ runs: [ai("The beta opens in February.")], fromAnswer: true }]],
    [
      "its waiting Blocks",
      [{ runs: [{ text: "The beta opens." }], fromAnswer: true, inserted: true }],
    ],
    [
      "a title heading first, then its text",
      [
        { runs: [{ text: "Launch brief" }], heading: true },
        { runs: [{ text: "The beta opens.", waiting: "answer" }], fromAnswer: true },
      ],
    ],
  ])("one holding %s is", (_name, lines) => {
    expect(madeByAnswer(mindOfLines(lines))).toBe(true);
  });

  // protects=a Mind with a word the User or a Word file's author wrote, AI text from anywhere but an Answer (a Meeting's notes filled after Stop, a Research report), or nothing, counts as the User's, so it stays on the Minds line; fails_when=it is taken for an Answer's and left out; no_claim=none beyond protects.
  test.each<[string, Line[]]>([
    [
      "a word the User typed",
      [{ runs: [ai("The beta opens."), { text: " Mine." }], fromAnswer: true }],
    ],
    [
      "a Word file's tracked insertion",
      [{ runs: [{ text: "From Word.", waiting: "word" }], fromAnswer: true }],
    ],
    [
      "AI text not from an Answer, as a Meeting's notes",
      [{ runs: [ai("Decisions: hire a designer.")] }],
    ],
    [
      "a Block of its own beside an Answer's",
      [{ runs: [ai("The beta opens.")], fromAnswer: true }, { runs: [ai("Filled after Stop.")] }],
    ],
    ["nothing", []],
  ])("one holding %s isn't", (_name, lines) => {
    expect(madeByAnswer(mindOfLines(lines))).toBe(false);
  });
});
