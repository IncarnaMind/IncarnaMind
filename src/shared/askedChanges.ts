/**
 * Whether the changes the User asked the assistant for wait for them instead
 * of applying (#880): when they would take out most of the User's own text in
 * the Mind, unless they translate it, which rewrites all of it by asking, or
 * when the User asked only for text to go and they do more (#2356). The core
 * tells the model so in a call's result, and the window holds them back, by
 * this one measure.
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
  type SentenceChanges,
} from "../core/api";
import { diffSteps, splitWords } from "../core/proposals/diff";
import { hasMarkIn, markValueOf } from "./markKeys";
import {
  proposalRequestOf,
  readProposalAttribute,
  readProposalRef,
  removesOnlyAsked,
} from "./proposals";
import {
  changedText,
  sentenceChanges,
  takesOnlyOut,
  writtenAgain,
  writtenBy,
} from "./sentenceChanges";

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
  /** Letters, digits and Han characters, as `removed` counts them. */
  words: number;
  removed: number;
}

const wordCharacters = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

/** How many word characters of `out` the words of `back` don't write again, in order. */
function notWrittenBack(out: string, back: string): number {
  if (back === "") return wordCharacters(out);
  const old = splitWords(out);
  let at = 0;
  let lost = 0;
  for (const step of diffSteps(old, splitWords(back))) {
    if (step === "insert") continue;
    const token = old[at++] ?? "";
    if (step === "delete") lost += wordCharacters(token);
  }
  return lost;
}

/**
 * What the User's own text loses: the words each change strikes and doesn't write back, in word
 * characters. A paragraph written anew is struck whole and written again (#1028), its spaces and
 * marks with it, so counted by its strike, or with its spaces, the same change would wait or apply
 * by how it reads, and English apart from Chinese (#2356).
 */
function measureOwnText(
  blocks: Y.XmlFragment | Y.XmlElement,
  requests: ReadonlySet<string>,
): OwnTextMeasurement {
  let own = 0;
  let words = 0;
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
          const added = readProposalRef(markValueOf(PROPOSAL_INSERT_MARK, run.attributes));
          if (added) changeOf(added.id).back += run.insert;
          if (marked(run, GENERATED_MARK) || hasMarkIn(PROPOSAL_INSERT_MARK, run.attributes))
            continue;
          own += run.insert.length;
          words += wordCharacters(run.insert);
          const deleted = readProposalRef(markValueOf(PROPOSAL_DELETE_MARK, run.attributes));
          if (goes) removed += wordCharacters(run.insert);
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
  return { own, words, removed };
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
  const { words, removed } = measureOwnText(blocks, requests);
  return words === 0 ? 0 : removed / words;
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

/**
 * Why the requests' changes wait for the User, or null when they apply: they take out most of the
 * User's own text, or one the assistant said was asked only to take text out does more (#2356),
 * as `changes` says, or the reply's other changes there write back what it takes out
 * (`writtenAgain`).
 */
export function whyItWaits(
  doc: Y.Doc,
  requests: ReadonlySet<string>,
):
  | { why: "most-of-their-text" }
  | { why: "more-than-taken-out"; changes: SentenceChanges; writtenAgain: string[] }
  | null {
  if (requests.size === 0) return null;
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  if (
    !translationRequested(doc, requests) &&
    ownTextRemoved(blocks, requests) > MOST_OF_YOUR_TEXT
  ) {
    return { why: "most-of-their-text" };
  }
  for (const request of requests) {
    if (!removesOnlyAsked(doc, request)) continue;
    const { before, after } = changedText(blocks, request);
    // A removal the reply revised in place left no Proposals of its own: its revision is judged instead.
    if (before.length === 0 && after.length === 0) continue;
    const changes = sentenceChanges(before, after);
    // The reply's other changes may write back what this one takes out: together they do more.
    const others = new Set([...requests].filter((each) => each !== request));
    const again = others.size === 0 ? [] : writtenAgain(before, writtenBy(blocks, others));
    if (!takesOnlyOut(changes) || again.length > 0) {
      return { why: "more-than-taken-out", changes, writtenAgain: again };
    }
  }
  return null;
}

export function waitsForUser(doc: Y.Doc, requests: ReadonlySet<string>): boolean {
  return whyItWaits(doc, requests) !== null;
}

/**
 * The requests in one Mind that `calls` asked for and the window applies at once, with Undo: the
 * changes it holds back because they take out most of the User's own text are left out (#2321).
 */
export function appliedRequests(
  doc: Y.Doc,
  mindId: string,
  calls: readonly AnswerToolCall[],
): Set<string> {
  const asked = new Set(
    calls.flatMap((call) => (call.mindChange?.mindId === mindId ? [call.mindChange.request] : [])),
  );
  const requested = requestedRequests(doc, asked);
  return waitsForUser(doc, requested) ? new Set() : requested;
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
  return appliedRequests(doc, change.mindId, calls).has(change.request);
}
