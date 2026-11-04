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
import { diffSteps, splitWords } from "../core/proposals/diff";
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

/** A word, a number or a Han character: what a change writes back, unlike a space or a mark. */
const WORD = /[\p{L}\p{N}]/u;

/** How many characters of `out` the words of `back` don't write again, in order. */
function notWrittenBack(out: string, back: string): number {
  if (back === "") return out.length;
  const old = splitWords(out);
  let at = 0;
  let kept = 0;
  for (const step of diffSteps(old, splitWords(back))) {
    if (step === "insert") continue;
    const token = old[at++] ?? "";
    if (step === "equal" && WORD.test(token)) kept += token.length;
  }
  return out.length - kept;
}

/**
 * What the User's own text loses: the words each change strikes and doesn't write back. A
 * paragraph written anew is struck whole and written again (#1028), so counted by its strike, the
 * words it keeps would count as taken out, and the same change would wait or apply by how it
 * reads (#2356).
 */
function measureOwnText(
  blocks: Y.XmlFragment | Y.XmlElement,
  requests: ReadonlySet<string>,
): OwnTextMeasurement {
  let own = 0;
  let removed = 0;
  const changes = new Map<string, { out: string; back: string }>();
  const changeOf = (id: string) => {
    const change = changes.get(id) ?? { out: "", back: "" };
    changes.set(id, change);
    return change;
  };
  const visit = (parent: Y.XmlFragment | Y.XmlElement, goes: boolean) => {
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const run of runsOf(child)) {
          const added = readProposalRef(run.attributes[PROPOSAL_INSERT_MARK]);
          if (added && requests.has(added.request)) changeOf(added.id).back += run.insert;
          if (marked(run, GENERATED_MARK) || marked(run, PROPOSAL_INSERT_MARK)) continue;
          own += run.insert.length;
          const deleted = readProposalRef(run.attributes[PROPOSAL_DELETE_MARK]);
          if (goes) removed += run.insert.length;
          else if (deleted && requests.has(deleted.request)) changeOf(deleted.id).out += run.insert;
        }
      } else if (child instanceof Y.XmlElement) {
        const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
        if (proposal?.kind === "insert") continue;
        visit(child, goes || (proposal?.kind === "delete" && requests.has(proposal.request)));
      }
    }
  };
  visit(blocks, false);
  for (const { out, back } of changes.values()) removed += notWrittenBack(out, back);
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
 * Whether the window applies `change` at once, with Undo, or it waits for the User: a call in
 * `calls` asked for it in that Mind, and it doesn't take out most of the User's own text. The core
 * says so to the model, and the evaluations read the same answer.
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
  const requested = requestedRequests(doc, asked);
  return requested.has(change.request) && !waitsForUser(doc, requested);
}
