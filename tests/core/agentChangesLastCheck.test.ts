/**
 * The last check on what an outside agent's change writes (#352): every Citation, footnote and
 * figure the Note holds once it is accepted is one IncarnaMind placed, whatever the readings
 * before made of the agent's text, and each is told apart by what it holds. A node the writing
 * adds, or swaps for one of its own, refuses the whole change, and the Note is as it was.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { citingKey, holdsOnlyPlaced } from "../../src/core/agents/proposals";
import { createElement } from "../../src/core/answers/blocks";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
  type ProposalAttribute,
} from "../../src/core/api";
import { setProposal } from "../../src/core/proposals/write";
import { pendingProposals, readProposalAttribute, targetHash } from "../../src/shared/proposals";
import {
  citingIn,
  figure,
  harbours,
  propose,
  REQUEST,
  tides,
  userNote,
} from "../helpers/agentChanges";

/** What the writing below the check does of its own, as a reader that drifted would. */
const drift = vi.hoisted(() => ({
  mode: null as "add" | "unmarked" | "footnote" | "citation" | null,
}));

vi.mock("../../src/core/proposals/write", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/proposals/write")>();
  return {
    ...real,
    proposeRewrite: (...args: Parameters<typeof real.proposeRewrite>) => {
      const written = real.proposeRewrite(...args);
      const paragraph = args[0].segments[0]?.element;
      if (paragraph && drift.mode) drifted(paragraph, drift.mode);
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

/** A node of `name`, as a change of the agent's adds it. */
function added(name: string): Y.XmlElement {
  const node =
    name === FOOTNOTE_NODE
      ? createElement({
          type: name,
          attrs: { id: "n9" },
          // The User's footnote's Citation, in words of the writer's own.
          content: [
            { type: "text", text: "Source: a court ruling that never existed, after " },
            { type: CITATION_NODE, attrs: harbours },
          ],
        })
      : createElement({ type: name, attrs: name === CITATION_NODE ? tides : { id: "f9", figure } });
  setProposal(node, change("insert"));
  return node;
}

const nodesIn = (element: Y.XmlElement, name: string) =>
  element.toArray().filter((each): each is Y.XmlElement => {
    return each instanceof Y.XmlElement && each.nodeName === name;
  });

function drifted(
  paragraph: Y.XmlElement,
  mode: "add" | "unmarked" | "footnote" | "citation",
): void {
  if (mode === "add") paragraph.insert(paragraph.length, [added(CITATION_NODE)]);
  // Written as if it were the User's, with no Proposal to reject.
  if (mode === "unmarked") {
    paragraph.insert(paragraph.length, [createElement({ type: CITATION_NODE, attrs: tides })]);
  }
  if (mode === "footnote") {
    // The User's footnote taken out, and one of the writer's own in its place.
    for (const footnote of nodesIn(paragraph, FOOTNOTE_NODE)) {
      setProposal(footnote, change("delete", "p8"));
    }
    paragraph.insert(paragraph.length, [added(FOOTNOTE_NODE)]);
  }
  if (mode === "citation") {
    // The Citation the token placed, made to point at another passage of another Document.
    for (const citation of nodesIn(paragraph, CITATION_NODE)) {
      if (readProposalAttribute(citation.getAttribute(PROPOSAL_ATTRIBUTE))?.kind !== "insert") {
        continue;
      }
      citation.setAttribute("passageId", "EVIL");
      citation.setAttribute("contentHash", "EVIL");
      citation.setAttribute("documentName", "EVIL");
    }
  }
}

/** The Note as the User wrote it, before any change. */
const asWritten = citingIn(userNote().blocks);

describe("the last check on what an agent's change writes (#352)", () => {
  it.each([
    {
      drift: "add",
      what: "a Citation it didn't place",
      text: "The moon is made of green cheese.",
    },
    {
      drift: "unmarked",
      what: "a Citation it didn't place, outside any Proposal",
      text: "The moon is made of green cheese.",
    },
    {
      drift: "footnote",
      what: "the User's footnote swapped for another",
      text: "Spring tides come at new moon [kept:1] as noted [note:1].",
    },
    {
      drift: "citation",
      what: "the token's Citation swapped for one of another passage",
      text: "Moon rocks are grey [cite:moona001].",
    },
  ] as const)("refuses the whole change when the writing leaves $what", ({ drift: mode, text }) => {
    // As written, the rewrite waits.
    expect(propose("rewrite", text).outcome).toBe("accepted");

    drift.mode = mode;
    try {
      const { blocks, outcome } = propose("rewrite", text);
      expect(outcome).toBe("agents.propose.unplaced");
      expect(pendingProposals(blocks)).toEqual([]);
      expect(citingIn(blocks)).toEqual(asWritten);
    } finally {
      drift.mode = null;
    }
  });

  /** Each citing node in `blocks`, by `citingKey`, as IncarnaMind would place them. */
  function ownIn(blocks: Y.XmlFragment | Y.XmlElement): Map<string, number> {
    const placed = new Map<string, number>();
    const visit = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if ([CITATION_NODE, FOOTNOTE_NODE, CALCULATED_FIGURE_NODE].includes(child.nodeName)) {
          placed.set(citingKey(child), (placed.get(citingKey(child)) ?? 0) + 1);
        }
        visit(child);
      }
    };
    visit(blocks);
    return placed;
  }

  for (const name of [CITATION_NODE, FOOTNOTE_NODE, CALCULATED_FIGURE_NODE]) {
    it(`finds a ${name} the change adds that IncarnaMind didn't place, and holds one it did`, () => {
      const { blocks } = userNote();
      const placed = ownIn(blocks);
      expect(holdsOnlyPlaced(blocks, REQUEST, placed)).toBe(true);

      const paragraph = blocks.get(0);
      if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
      const node = added(name);
      paragraph.insert(paragraph.length, [node]);
      expect(holdsOnlyPlaced(blocks, REQUEST, placed)).toBe(false);

      // Placed by IncarnaMind, the same node holds; it is no other request's to count.
      const withIt = new Map(placed);
      for (const [key, n] of [[citingKey(node), 1] as const, ...ownIn(node)]) {
        withIt.set(key, (withIt.get(key) ?? 0) + n);
      }
      expect(holdsOnlyPlaced(blocks, REQUEST, withIt)).toBe(true);
      expect(holdsOnlyPlaced(blocks, "another-request", placed)).toBe(true);
    });
  }

  it("counts what is inside a Block the change adds, and not what it takes out", () => {
    const { blocks } = userNote();
    const own = ownIn(blocks);
    const block = createElement({
      type: "paragraph",
      content: [
        { type: "text", text: "The moon is cheese" },
        { type: CITATION_NODE, attrs: tides },
      ],
    });
    setProposal(block, change("insert"));
    blocks.insert(1, [block]);
    expect(holdsOnlyPlaced(blocks, REQUEST, own)).toBe(false);

    // The change takes the User's Citation out: the one it adds is all that is left of Tides.
    const paragraph = blocks.get(0);
    if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
    const [users] = nodesIn(paragraph, CITATION_NODE);
    if (!users) throw new Error("No Citation of the User's.");
    setProposal(users, change("delete", "p2"));
    expect(holdsOnlyPlaced(blocks, REQUEST, own)).toBe(true);
  });
});
