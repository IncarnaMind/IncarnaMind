/**
 * Whether the changes the User asked the assistant for wait for them instead
 * of applying (#880): when they would take out most of the User's own text in
 * the Mind, unless they translate it, which rewrites all of it by asking. The
 * core tells the model so in a call's result, and the window holds them back,
 * by this one measure.
 */
import * as Y from "yjs";
import {
  type AnswerToolCall,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
  type MindChange,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../core/api";
import { proposalRequestOf, readProposalAttribute, readProposalRef } from "./proposals";

const MOST_OF_YOUR_TEXT = 0.5;

const TRANSLATION =
  /\btranslat|\bin(?:to)? (?:chinese|english)\b|翻译|译成|(?:改成|用)(?:中文|英文)/i;

interface Run {
  insert: string;
  attributes: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function runsOf(text: Y.XmlText): Run[] {
  const delta: unknown = text.toDelta();
  if (!Array.isArray(delta)) return [];
  return delta.flatMap((run: unknown) =>
    isRecord(run) && typeof run.insert === "string"
      ? [{ insert: run.insert, attributes: isRecord(run.attributes) ? run.attributes : {} }]
      : [],
  );
}

const marked = (run: Run, mark: string) => {
  const value = run.attributes[mark];
  return value !== undefined && value !== null;
};

interface OwnTextMeasurement {
  own: number;
  removed: number;
}

function measureOwnText(
  blocks: Y.XmlFragment | Y.XmlElement,
  requests: ReadonlySet<string>,
): OwnTextMeasurement {
  let own = 0;
  let removed = 0;
  const visit = (parent: Y.XmlFragment | Y.XmlElement, goes: boolean) => {
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const run of runsOf(child)) {
          if (marked(run, GENERATED_MARK) || marked(run, PROPOSAL_INSERT_MARK)) continue;
          own += run.insert.length;
          const deleted = readProposalRef(run.attributes[PROPOSAL_DELETE_MARK]);
          if (goes || (deleted && requests.has(deleted.request))) removed += run.insert.length;
        }
      } else if (child instanceof Y.XmlElement) {
        const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
        if (proposal?.kind === "insert") continue;
        visit(child, goes || (proposal?.kind === "delete" && requests.has(proposal.request)));
      }
    }
  };
  visit(blocks, false);
  return { own, removed };
}

/** How much original User text a Block or Mind holds, excluding AI and inserted text. */
export function ownTextLength(blocks: Y.XmlFragment | Y.XmlElement): number {
  return measureOwnText(blocks, new Set()).own;
}

/** How much of the User's own text in the Mind, not AI text, the requests' changes take out: a share from 0 to 1. */
export function ownTextRemoved(
  blocks: Y.XmlFragment | Y.XmlElement,
  requests: ReadonlySet<string>,
): number {
  const { own, removed } = measureOwnText(blocks, requests);
  return own === 0 ? 0 : removed / own;
}

export function askedFor(doc: Y.Doc, request: string): boolean {
  const made = proposalRequestOf(doc, request);
  return made !== null && "requested" in made && made.requested !== undefined;
}

/** The requests in this Mind that the window applies, excluding other Minds and unrequested revisions. */
export function requestedRequests(doc: Y.Doc, requests: ReadonlySet<string>): Set<string> {
  return new Set([...requests].filter((request) => askedFor(doc, request)));
}

export function translationRequested(doc: Y.Doc, requests: ReadonlySet<string>): boolean {
  return [...requests].every((request) => {
    const made = proposalRequestOf(doc, request);
    if (made?.source !== "edit-with-ai" && made?.source !== "answer-added") return false;
    return (
      ("action" in made && made.action === "translate") ||
      ("instruction" in made && TRANSLATION.test(made.instruction ?? ""))
    );
  });
}

export function waitsForUser(doc: Y.Doc, requests: ReadonlySet<string>): boolean {
  return (
    requests.size > 0 &&
    !translationRequested(doc, requests) &&
    ownTextRemoved(doc.getXmlFragment(MIND_CONTENT_FIELD), requests) > MOST_OF_YOUR_TEXT
  );
}

/**
 * Whether the window applies `change` at once, with Undo, or it waits for the User: its request
 * was asked for in `calls` (the Answer's Tool calls), and it doesn't take out most of the User's own
 * text. The core says so to the model, and the evaluations read the same answer.
 */
export function appliedAsAsked(
  doc: Y.Doc,
  change: Pick<MindChange, "mindId" | "request">,
  calls: readonly AnswerToolCall[],
): boolean {
  const asked = new Set(
    calls.flatMap((call) =>
      call.mindChange?.mindId === change.mindId ? [call.mindChange.request] : [],
    ),
  );
  return askedFor(doc, change.request) && !waitsForUser(doc, requestedRequests(doc, asked));
}
