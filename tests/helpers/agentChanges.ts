/**
 * A Note for an outside agent's changes (#352) written straight through `proposeNamed`, as the
 * MCP Tool writes them: one paragraph of the User's with a Citation of Tides, which the agent
 * can't read, and a footnote; the tokens it was given; and its change accepted when it waits.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  ChangeRefused,
  type CitedToken,
  type NamedChange,
  namedNote,
  proposeNamed,
} from "../../src/core/agents/proposals";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { decideProposals } from "../../src/shared/proposals";

export const SPRING = "Spring tides happen twice a month, at new moon and full moon.";
export const REQUEST = "agent-request";
const schema = getSchema(noteExtensions());

/** The User's Citation in the Note, of Tides, which the agent can't read. */
export const tides = {
  id: "c1",
  passageId: "passage-tides",
  documentId: "tides",
  documentName: "Tides",
  contentHash: "hash-tides",
  quote: SPRING,
  check: "found",
};

/** The tokens the agent was given: three it may cite with, one of a Document it may only keep. */
export const QUOTES = {
  moona001: "Moon rocks are grey basalt and dust.",
  moonb002: "The far side is never seen from Earth.",
  moonc003: "Moonquakes are rare and weak.",
} as const;
export type Citable = keyof typeof QUOTES;
export const CITABLE = Object.keys(QUOTES) as Citable[];

function tokenOf(token: string): CitedToken | null {
  const quote = token in QUOTES ? QUOTES[token as Citable] : token === "ownwork1" ? "Mine." : null;
  if (quote === null) return null;
  const documentId = token === "ownwork1" ? "workings" : "moon";
  return {
    minted: { documentId, quote, pageFrom: null },
    attributes: {
      passageId: `passage-${token}`,
      documentId,
      documentName: documentId === "moon" ? "Moon" : "Workings",
      contentHash: `hash-${documentId}`,
      quote,
      check: "found",
    },
    citable: token !== "ownwork1",
  };
}

/** A Note of one paragraph of the User's, with a Citation of Tides and a footnote. */
export function userNote(): { doc: Y.Doc; blocks: Y.XmlFragment } {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const content: JSONContent[] = [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [
        { type: "text", text: "Spring tides come at new moon " },
        { type: CITATION_NODE, attrs: tides },
        { type: "text", text: " as noted" },
        {
          type: FOOTNOTE_NODE,
          attrs: { id: "n1" },
          content: [{ type: "text", text: "The User's own note." }],
        },
        { type: "text", text: "." },
      ],
    },
  ];
  prosemirrorToYXmlFragment(schema.nodeFromJSON({ type: "doc", content }), blocks);
  return { doc, blocks };
}

/** The Citations, footnotes and figures a Note holds, a Citation by what it cites. */
export function citingIn(blocks: Y.XmlFragment): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const key =
        child.nodeName === CITATION_NODE
          ? `${child.getAttribute("documentId")}: ${child.getAttribute("quote")}`
          : [FOOTNOTE_NODE, CALCULATED_FIGURE_NODE].includes(child.nodeName)
            ? child.nodeName
            : null;
      if (key) counts[key] = (counts[key] ?? 0) + 1;
      visit(child);
    }
  };
  visit(blocks);
  return counts;
}

export type Outcome = "accepted" | ChangeRefused["key"];

/** The agent's change as it proposes it, through `proposeNamed`, and accepted when it waits. */
export function propose(path: "rewrite" | "add", text: string) {
  const { doc, blocks } = userNote();
  const note = namedNote(blocks, { citation: () => null, waiting: "", busy: "" });
  const change: NamedChange =
    path === "rewrite" ? { kind: "rewrite", at: 0, text } : { kind: "add", after: 0, text };
  let ids = 0;
  let outcome: Outcome = "accepted";
  doc.transact(() => {
    try {
      proposeNamed(blocks, note, [change], {
        request: REQUEST,
        made: {
          source: "outside-agent",
          agent: "Codex",
          pairingId: "pairing",
          createdAt: "2026-11-02T09:00:00.000Z",
        },
        cited: tokenOf,
        notFound: "[quote not found]",
        newId: () => `id-${++ids}`,
      });
    } catch (error) {
      if (!(error instanceof ChangeRefused)) throw error;
      outcome = error.key;
    }
  });
  if (outcome === "accepted") {
    doc.transact(() => decideProposals(blocks, () => true, "accept"));
  }
  return { blocks, outcome };
}
