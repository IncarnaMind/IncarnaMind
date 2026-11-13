import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { writtenSentences } from "../../eval/lib/writtenSentences";
import { BLOCK_ID_ATTRIBUTE, CITATION_NODE, CLAIM_CHECK_MARK } from "../../src/core";
import { keyedFormats } from "../../src/shared/markKeys";

/** A paragraph Block `id` of `parts`: text, a Citation, or text under a check's mark. */
function paragraph(
  blocks: Y.XmlFragment,
  id: string,
  parts: (string | "citation" | { text: string; mark: Record<string, unknown> })[],
) {
  const element = new Y.XmlElement("paragraph");
  element.setAttribute(BLOCK_ID_ATTRIBUTE, id);
  blocks.push([element]);
  for (const part of parts) {
    if (part === "citation") {
      const citation = new Y.XmlElement(CITATION_NODE);
      citation.setAttribute("marker", "1");
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
