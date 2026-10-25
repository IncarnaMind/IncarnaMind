import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  GENERATED_MARK,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../core/api";
import { isRecord } from "../core/errors";
import { originOf } from "./blockOrigins";
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

/** Whether a Block holds any text the User wrote: a run that is neither AI text nor in an AI's waiting insert. */
function holdsOwnText(element: Y.XmlElement, doc: Y.Doc | null): boolean {
  const proposal = readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE));
  if (proposal?.kind === "insert" && byAi(doc, proposal.request)) return false;
  return element.toArray().some((child) => {
    if (child instanceof Y.XmlText) {
      return child.toDelta().some((run: unknown) => textOfRun(run) !== "" && !isAiRun(run, doc));
    }
    return child instanceof Y.XmlElement && holdsOwnText(child, doc);
  });
}

/**
 * Whether an Answer in the assistant made or filled the Mind and the User hasn't written in it
 * since: every Block that holds something was added from a conversation's Answer (its origin) and
 * holds none of the User's text, but a title heading first. A Meeting's notes filled after Stop,
 * a Research task's report or an imported file aren't added from an Answer, so they never are.
 * Named to the model, such a Mind drew a later request for a new piece into it (#1790).
 */
export function madeByAnswer(blocks: Y.XmlFragment): boolean {
  const doc = blocks.doc;
  if (!doc) return false;
  const filled = blocks
    .toArray()
    .filter(
      (block): block is Y.XmlElement =>
        block instanceof Y.XmlElement && !(block.nodeName === "paragraph" && block.length === 0),
    );
  const fromAnswer = (block: Y.XmlElement) => {
    const id = block.getAttribute(BLOCK_ID_ATTRIBUTE);
    return typeof id === "string" && originOf(doc, id)?.from.anchor.kind === "message";
  };
  const [first, ...rest] = filled;
  const body = first && first.nodeName === "heading" && !fromAnswer(first) ? rest : filled;
  return body.length > 0 && body.every((block) => fromAnswer(block) && !holdsOwnText(block, doc));
}
