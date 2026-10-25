import * as Y from "yjs";
import { GENERATED_MARK, PROPOSAL_ATTRIBUTE, PROPOSAL_INSERT_MARK } from "../core/api";
import { isRecord } from "../core/errors";
import { proposalRequestOf, readProposalAttribute, readProposalRef } from "./proposals";

const textOfRun = (run: unknown): string =>
  isRecord(run) && typeof run.insert === "string" ? run.insert : "";

const textOf = (element: Y.XmlElement): string =>
  element
    .toArray()
    .map((child) => (child instanceof Y.XmlText ? child.toDelta().map(textOfRun).join("") : ""))
    .join("");

/**
 * Whether a Mind holds nothing yet: no Block but paragraphs with no text, and a title heading at
 * most. An image, a chart, a divider or a table is something. The assistant writes a piece into
 * such a Mind, and so does New Mind under an Answer, rather than making another (#1559).
 */
export function holdsNothing(blocks: Y.XmlFragment): boolean {
  return blocks
    .toArray()
    .filter((block): block is Y.XmlElement => block instanceof Y.XmlElement)
    .every((block, index) =>
      block.nodeName === "paragraph"
        ? block.toArray().every((child) => child instanceof Y.XmlText && child.length === 0)
        : index === 0 && block.nodeName === "heading",
    );
}

/**
 * Whether a Mind the assistant made holds no more than it was made with:
 * empty lines, and the heading of its title its text starts with (#908).
 * Rejecting its changes then takes the Mind away too.
 */
export function holdsOnlyItsTitle(blocks: Y.XmlFragment, title: string): boolean {
  return blocks
    .toArray()
    .filter((block): block is Y.XmlElement => block instanceof Y.XmlElement)
    .every((block, index) =>
      block.nodeName === "paragraph"
        ? block.length === 0
        : index === 0 && block.nodeName === "heading" && textOf(block) === title,
    );
}

// A Word file's tracked insertions wait as Proposals too, but someone wrote them.
const byAi = (doc: Y.Doc | null, request: string | undefined): boolean => {
  const made = doc && request !== undefined ? proposalRequestOf(doc, request) : null;
  return made !== null && made.source !== "word-change";
};

const isAiRun = (run: unknown, doc: Y.Doc | null): boolean =>
  isRecord(run) &&
  isRecord(run.attributes) &&
  (run.attributes[GENERATED_MARK] != null ||
    byAi(doc, readProposalRef(run.attributes[PROPOSAL_INSERT_MARK])?.request));

/**
 * Whether a Mind holds text and all of it is AI text, applied or still waiting: one an Answer made
 * or filled that the User hasn't written in since. Named to the model, such a Mind drew a later
 * request for a new piece into it (#1790).
 */
export function holdsOnlyAiText(blocks: Y.XmlFragment): boolean {
  let ai = false;
  const holdsOwn = (parent: Y.XmlFragment | Y.XmlElement): boolean =>
    parent.toArray().some((child) => {
      if (child instanceof Y.XmlText) {
        return child.toDelta().some((run: unknown) => {
          if (textOfRun(run) === "") return false;
          if (!isAiRun(run, blocks.doc)) return true;
          ai = true;
          return false;
        });
      }
      if (!(child instanceof Y.XmlElement)) return false;
      const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
      if (proposal?.kind === "insert" && byAi(blocks.doc, proposal.request)) {
        ai = true;
        return false;
      }
      return holdsOwn(child);
    });
  return !holdsOwn(blocks) && ai;
}
