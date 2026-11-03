/**
 * The last check on what an outside agent's change writes (#352): every Citation, footnote and
 * figure the Note holds once it is accepted is one IncarnaMind placed, whatever the readings
 * before made of the agent's text, and each is told apart by all it holds. A node the writing
 * adds, swaps for one of its own or changes in place refuses the whole change, and the Note is
 * as it was. The change is written as the Note's own client, so its state vector doesn't grow.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { type NamedChange, namedNote, proposeNamed } from "../../src/core/agents/proposals";
import { createElement } from "../../src/core/answers/blocks";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  type ProposalAttribute,
} from "../../src/core/api";
import { citingKey, holdsOnlyPlaced } from "../../src/core/proposals/placed";
import { setProposal } from "../../src/core/proposals/write";
import type { NodeJSON } from "../../src/shared/blockJson";
import { pendingProposals, readProposalAttribute, targetHash } from "../../src/shared/proposals";
import {
  citingIn,
  figure,
  harbours,
  optionsWith,
  propose,
  proposeIn,
  QUOTES,
  REQUEST,
  tides,
  userNote,
} from "../helpers/agentChanges";

type Drift = "add" | "unmarked" | "footnote" | "citation" | "figure" | "endnote" | "source";

/** What the writing below the check does of its own, as a reader that drifted would. */
const drift = vi.hoisted(() => ({ mode: null as Drift | null, dropsTokens: false }));

// A parse that drops what holds a token's place, as a Markdown reader changed one day might.
vi.mock("../../src/core/answers/markdown", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/answers/markdown")>();
  const dropHeld = (node: NodeJSON): NodeJSON[] =>
    drift.dropsTokens && node.type === "text" && (node.text ?? "").includes("\uE000")
      ? []
      : [node.content ? { ...node, content: node.content.flatMap(dropHeld) } : node];
  return {
    ...real,
    markdownToBlocks: (...args: Parameters<typeof real.markdownToBlocks>) =>
      real.markdownToBlocks(...args).flatMap(dropHeld),
  };
});

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

/** Each node of `name` in the Note the change doesn't take out. */
function staying(paragraph: Y.XmlElement, name: string): Y.XmlElement[] {
  const found: Y.XmlElement[] = [];
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "delete") {
        continue;
      }
      if (child.nodeName === name) found.push(child);
      visit(child);
    }
  };
  const blocks = paragraph.doc?.getXmlFragment(MIND_CONTENT_FIELD);
  if (blocks) visit(blocks);
  return found;
}

function drifted(paragraph: Y.XmlElement, mode: Drift): void {
  // Changed in place, with no Proposal: a figure marked checked with no check run, and the
  // User's footnote made an endnote or given other Word XML to write back.
  for (const each of mode === "figure" ? staying(paragraph, CALCULATED_FIGURE_NODE) : []) {
    each.setAttribute("claimCheck", "checked");
  }
  for (const each of mode === "endnote" ? staying(paragraph, FOOTNOTE_NODE) : []) {
    each.setAttribute("endnote", "true");
  }
  for (const each of mode === "source" ? staying(paragraph, FOOTNOTE_NODE) : []) {
    each.setAttribute("source", "<w:t>EVIL</w:t>");
  }
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
    {
      drift: "figure",
      what: "the User's figure in another paragraph marked checked",
      text: "The moon is made of green cheese.",
    },
    {
      drift: "endnote",
      what: "the User's footnote made an endnote",
      text: "Spring tides come at new moon [kept:1] as noted [note:1].",
    },
    {
      drift: "source",
      what: "the User's footnote given other Word XML",
      text: "Spring tides come at new moon [kept:1] as noted [note:1].",
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

  it("refuses new paragraphs when the parse drops what holds a token's place", () => {
    const text = "Moon rocks are grey [cite:moona001].";
    expect(propose("add", text).outcome).toBe("accepted");

    drift.dropsTokens = true;
    try {
      const { blocks, outcome } = propose("add", text);
      expect(outcome).toBe("agents.propose.lost");
      expect(citingIn(blocks)).toEqual(asWritten);
    } finally {
      drift.dropsTokens = false;
    }
  });

  it("rejects what the Note's write wrote when a callback answers there what it didn't on the copy, and says so", () => {
    const changes: NamedChange[] = [
      { kind: "rewrite", at: 0, text: "Moon rocks are grey [cite:moona001]." },
      { kind: "add", after: 0, text: "Moonquakes are rare [cite:moonc003]." },
    ];
    const proposeOn = (note: ReturnType<typeof userNote>, newId: () => string) => {
      const named = namedNote(note.blocks, { citation: () => null, waiting: "", busy: "" });
      note.doc.transact(() => proposeNamed(note.blocks, named, changes, optionsWith(newId)));
    };
    // Both writes ask the same questions: on the copy, then in the Note.
    let asked = 0;
    proposeOn(userNote(), () => `id-${++asked}`);
    expect(asked % 2).toBe(0);

    const note = userNote();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const drifting = () => {
      calls += 1;
      if (calls === asked) throw new Error("A new id can't be made now.");
      return `id-${calls}`;
    };
    try {
      expect(() => proposeOn(note, drifting)).toThrow("A new id can't be made now.");
      expect(calls).toBe(asked);
      expect(pendingProposals(note.blocks)).toEqual([]);
      expect(citingIn(note.blocks)).toEqual(asWritten);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(REQUEST), expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });

  it("writes each change as the Note's own client: its state vector doesn't grow", () => {
    const note = userNote();
    const clients = () => Y.decodeStateVector(Y.encodeStateVector(note.doc)).size;
    expect(clients()).toBe(1);
    for (const n of [1, 2, 3]) {
      expect(proposeIn(note, "add", `Moon rocks are grey ${n} [cite:moona001].`).outcome).toBe(
        "accepted",
      );
    }
    expect(citingIn(note.blocks)).toEqual({ ...asWritten, [`moon: ${QUOTES.moona001}`]: 3 });
    expect(clients()).toBe(1);
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
