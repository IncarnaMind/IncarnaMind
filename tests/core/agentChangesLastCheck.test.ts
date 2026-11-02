/**
 * The last check on what an outside agent's change writes (#352): every Citation, footnote and
 * figure the Note holds once it is accepted is one IncarnaMind placed, whatever the readings
 * before made of the agent's text. A node the writing adds that IncarnaMind didn't place
 * refuses the whole change, and nothing waits.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { citingKey, holdsOnlyPlaced } from "../../src/core/agents/proposals";
import { createElement } from "../../src/core/answers/blocks";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  type ProposalAttribute,
} from "../../src/core/api";
import { setProposal } from "../../src/core/proposals/write";
import { pendingProposals, targetHash } from "../../src/shared/proposals";
import { citingIn, propose, REQUEST, SPRING, tides, userNote } from "../helpers/agentChanges";

/** Whether the writing below the check adds a Citation of Tides of its own, as a reader that drifted would. */
const drift = vi.hoisted(() => ({ on: false }));

vi.mock("../../src/core/proposals/write", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/proposals/write")>();
  return {
    ...real,
    proposeRewrite: (...args: Parameters<typeof real.proposeRewrite>) => {
      const written = real.proposeRewrite(...args);
      const paragraph = args[0].segments[0]?.element;
      if (drift.on && paragraph) paragraph.insert(paragraph.length, [hostile(CITATION_NODE)]);
      return written;
    },
  };
});

const change = (kind: ProposalAttribute["kind"], id = "p1"): ProposalAttribute => ({
  id,
  request: REQUEST,
  target: targetHash(""),
  kind,
});

/** A node of `name` citing Tides, as a change of the agent's adds it. */
function hostile(name: string): Y.XmlElement {
  const node = createElement({ type: name, attrs: tides });
  setProposal(node, change("insert"));
  return node;
}

describe("the last check on what an agent's change writes (#352)", () => {
  it("refuses the whole change when the writing adds a Citation IncarnaMind didn't place", () => {
    // As written, the rewrite waits.
    expect(propose("rewrite", "The moon is made of green cheese.").outcome).toBe("accepted");

    drift.on = true;
    try {
      const { blocks, outcome } = propose("rewrite", "The moon is made of green cheese.");
      expect(outcome).toBe("agents.propose.unplaced");
      expect(pendingProposals(blocks)).toEqual([]);
      expect(citingIn(blocks)).toEqual({ [`tides: ${SPRING}`]: 1, [FOOTNOTE_NODE]: 1 });
    } finally {
      drift.on = false;
    }
  });

  for (const name of [CITATION_NODE, FOOTNOTE_NODE, CALCULATED_FIGURE_NODE]) {
    it(`finds a ${name} the change adds that IncarnaMind didn't place, and holds one it did`, () => {
      const { blocks } = userNote();
      const placed = new Map([
        [citingKey(CITATION_NODE, tides), 1],
        [FOOTNOTE_NODE, 1],
      ]);
      expect(holdsOnlyPlaced(blocks, REQUEST, placed)).toBe(true);

      const paragraph = blocks.get(0);
      if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
      paragraph.insert(paragraph.length, [hostile(name)]);
      expect(holdsOnlyPlaced(blocks, REQUEST, placed)).toBe(false);

      // Placed by IncarnaMind, the same node holds; it is no other request's to count.
      const withIt = new Map(placed);
      const key = citingKey(name, tides);
      withIt.set(key, (withIt.get(key) ?? 0) + 1);
      expect(holdsOnlyPlaced(blocks, REQUEST, withIt)).toBe(true);
      expect(holdsOnlyPlaced(blocks, "another-request", placed)).toBe(true);
    });
  }

  it("counts what is inside a Block the change adds, and not what it takes out", () => {
    const { blocks } = userNote();
    const block = createElement({
      type: "paragraph",
      content: [
        { type: "text", text: "The moon is cheese" },
        { type: CITATION_NODE, attrs: tides },
      ],
    });
    setProposal(block, change("insert"));
    blocks.insert(1, [block]);
    const own = new Map([
      [citingKey(CITATION_NODE, tides), 1],
      [FOOTNOTE_NODE, 1],
    ]);
    expect(holdsOnlyPlaced(blocks, REQUEST, own)).toBe(false);

    // The change takes the User's Citation out: the one it adds is all that is left of Tides.
    const paragraph = blocks.get(0);
    if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
    const users = paragraph
      .toArray()
      .find((each) => each instanceof Y.XmlElement && each.nodeName === CITATION_NODE);
    if (!(users instanceof Y.XmlElement)) throw new Error("No Citation of the User's.");
    setProposal(users, change("delete", "p2"));
    expect(holdsOnlyPlaced(blocks, REQUEST, own)).toBe(true);
  });
});
