import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { writtenSentences } from "../../eval/lib/writtenSentences";
import { BLOCK_ID_ATTRIBUTE, CITATION_NODE, CLAIM_CHECK_MARK } from "../../src/core";
import { keyedFormats } from "../../src/shared/markKeys";

/** A paragraph Block `id` of `parts`: text, a Citation, or text under a check's mark. */
function paragraph(
  blocks: Y.XmlFragment,
  id: string,
  parts: (
    | string
    | "citation"
    | { citation: Record<string, string> }
    | { text: string; mark: Record<string, unknown> }
  )[],
) {
  const element = new Y.XmlElement("paragraph");
  element.setAttribute(BLOCK_ID_ATTRIBUTE, id);
  blocks.push([element]);
  for (const part of parts) {
    if (part === "citation" || (typeof part === "object" && "citation" in part)) {
      const citation = new Y.XmlElement(CITATION_NODE);
      citation.setAttribute("marker", "1");
      if (typeof part === "object")
        for (const [name, value] of Object.entries(part.citation))
          citation.setAttribute(name, value);
      element.push([citation]);
      continue;
    }
    const text = new Y.XmlText();
    element.push([text]);
    if (typeof part === "string") text.insert(0, part);
    else {
      text.insert(0, part.text);
      text.format(0, part.text.length, keyedFormats(text, CLAIM_CHECK_MARK, part.mark));
    }
  }
}

describe("the sentences a write added, as the everyday evaluation records them", () => {
  // protects=each sentence a write added is recorded in the Note's order with whether it has a Citation and what its check's mark says, when it was set, and an unmarked one as unmarked, the same on main and on a head that checks later (#2830); fails_when=a sentence another write left is counted, a cited sentence reads as uncited, or a mark's time is lost; no_claim=what a real check finds.
  test("each sentence of the write's Blocks, in order, cited or not, with its mark and when it was set", () => {
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment("content");
    const moon = {
      id: "check-1",
      state: "supported",
      checkedAt: "2026-11-13T06:00:05.000Z",
    };
    const quay = {
      id: "check-2",
      state: "not-checked",
      reason: "stopped",
      checkedAt: "2026-11-13T06:00:09.000Z",
    };
    paragraph(blocks, "before", ["Boats moor by the quay in every season."]);
    paragraph(blocks, "written", [
      { text: "Spring tides come at new and full moon ", mark: moon },
      "citation",
      ". ",
      { text: "The quay is busy in summer.", mark: quay },
      " See below.",
    ]);

    expect(writtenSentences(blocks, new Set(["written"]))).toEqual([
      {
        place: 0,
        text: "Spring tides come at new and full moon .",
        cited: true,
        state: "supported",
        reason: null,
        checkedAt: "2026-11-13T06:00:05.000Z",
      },
      {
        place: 1,
        text: "The quay is busy in summer.",
        cited: false,
        state: "not-checked",
        reason: "stopped",
        checkedAt: "2026-11-13T06:00:09.000Z",
      },
    ]);
  });

  // protects=a claim the write added that its check never marked, as main leaves a sentence with no Citation, is recorded unmarked, never dropped (#2830); fails_when=it is left out, so main's arm reads as having checked every sentence; no_claim=which sentences main checks.
  test("a claim with no mark is recorded unmarked", () => {
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment("content");
    paragraph(blocks, "written", ["The quay is busy in summer."]);

    expect(writtenSentences(blocks, new Set(["written"]))).toEqual([
      {
        place: 0,
        text: "The quay is busy in summer.",
        cited: false,
        state: null,
        reason: null,
        checkedAt: null,
      },
    ]);
  });
});

const SENTENCE = "Spring tides come at new and full moon.";
const FOUND = "Spring tides come twice a month, at new and full moon.";
const OTHER = "The harbour closes at dusk.";

const passage = (passageId: string, quote: string) => ({
  passageId,
  documentId: "tides",
  documentName: "Tides",
  contentHash: "v1",
  quote,
  check: "found",
});

const markOf = (state: string, more: Record<string, unknown> = {}) => ({
  id: "check-1",
  request: "run",
  action: "check-against-documents",
  state,
  text: SENTENCE,
  checkedAt: "2026-11-13T06:00:05.000Z",
  ...more,
});

/** The Passage quoting FOUND as a check's evidence holds it. */
const evidence = {
  ...passage("found", FOUND),
  pageFrom: null,
  pageTo: null,
  location: null,
  checkReason: null,
};

/** A Supported mark whose one part rests on the Passage quoting FOUND, as the check stores it. */
const restingOnFound = markOf("supported", {
  evidence,
  parts: [
    {
      span: { start: 0, end: SENTENCE.length - 1 },
      kind: "fact",
      verdict: "supported",
      evidence: [evidence],
      decidingEvidence: 0,
      says: null,
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      versions: [],
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
    },
  ],
});

describe("a write's sentence as the Note reads its mark", () => {
  // protects=the everyday evaluation records a written sentence's mark as the Note shows it against the sentence's own Citations, through the Note's own reading (#3019, #3052): a stored Supported resting on a Passage the sentence doesn't cite is Not checked, found elsewhere, and Supported once it cites that Passage; a mark with no parts and an Unsupported one read as stored; fails_when=the record counts a ✓ the Note doesn't show, or hides one it shows; no_claim=what the check finds.
  test.each<[string, Record<string, unknown>, Record<string, string>[], [string, string | null]]>([
    [
      "Supported, resting on a Passage it doesn't cite",
      restingOnFound,
      [passage("other", OTHER)],
      ["not-checked", "found-elsewhere"],
    ],
    [
      "the same, once it cites that Passage",
      restingOnFound,
      [passage("other", OTHER), passage("found", FOUND)],
      ["supported", null],
    ],
    [
      "Supported with no parts, on its own Citation",
      markOf("supported", { evidence }),
      [passage("found", FOUND)],
      ["supported", null],
    ],
    ["Unsupported", markOf("unsupported"), [passage("other", OTHER)], ["unsupported", null]],
  ])("%s", (_, mark, citations, [state, reason]) => {
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment("content");
    paragraph(blocks, "written", [
      { text: SENTENCE.slice(0, -1), mark },
      ...citations.map((citation) => ({ citation })),
      ".",
    ]);

    expect(writtenSentences(blocks, new Set(["written"]))).toEqual([
      {
        place: 0,
        text: SENTENCE,
        cited: true,
        state,
        reason,
        checkedAt: "2026-11-13T06:00:05.000Z",
      },
    ]);
  });
});
