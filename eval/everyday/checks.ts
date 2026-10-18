/**
 * The guards every everyday request in the assistant is held to, read from
 * what the core stored, as a User would see it:
 *
 * - **Asked to write, the Mind changed.**
 * - **Every claimed change is real**, as a model judges the reply against the
 *   record of what the calls did (./judge), never the app's own net.
 * - **Citations are there**: in the reply, or, for text written into a Mind,
 *   in the Mind, and no source there is written as text, like
 *   "[Deck, slide 3]" (#1075).
 * - **Every Document is covered**: asked about all the Documents in scope,
 *   each is cited, or named in a sentence saying it wasn't covered.
 * - **Only what was asked changes**: asked about one paragraph, the others
 *   read as they did.
 * - **Changed in place**: asked to make text in the Mind longer, it changes
 *   that text, not adding a second version beside it, nor leaving it as it
 *   was (#1061).
 * - **The Question asked is the Answer's subject**: asked after the example's
 *   Answer, nothing in the reply is about an earlier Answer or the example.
 */
import { changeLogOf } from "../../src/core/answers/claimedChanges";
import type { ConversationAnswer, MarkedCitation } from "../../src/core/api";
import type { ClaimVerdict } from "./judge";

/** What a request expects of its Answer. */
export interface Expected {
  /** It asks for text in a Mind: writing, adding, changing, making one. */
  write: boolean;
  /** Its Answer must cite the Documents in scope. */
  cite: boolean;
  /** It asks about every Document in scope ("summarise these papers"). */
  coverAll: boolean;
  /** Only this top-level Block of the Mind it is asked from (from 0) may change. */
  only?: number;
  /** It asks to change text already in the Mind: adding a new version beside it fails. */
  inPlace?: true;
  /** It is asked after the example's Answer, and its reply says nothing of an earlier Answer or the example. */
  noEarlier?: boolean;
}

export interface RequestOutcome {
  expected: Expected;
  answer: Pick<ConversationAnswer, "text" | "toolCalls" | "steps"> & {
    citations: readonly Pick<MarkedCitation, "documentId">[];
  };
  verdict: ClaimVerdict;
  /** The Documents the Citations it wrote into Minds quote, by id. */
  citedInMinds: readonly string[];
  /** The top-level Blocks of the Mind it was asked from (from 0) that read otherwise once its changes are accepted. */
  changedBlocks: readonly number[];
  /** The top-level Blocks Add to note put in before the request (from 0): what `inPlace` must change. */
  addedBlocks?: readonly number[];
  /** Sources the Minds it wrote hold as text, in brackets, as written. */
  sourcesAsText?: readonly string[];
  scoped: readonly { id: string; name: string }[];
}

export type RequestFailure =
  | { kind: "no-change" }
  /** `flagged`: the app's own net said so under the reply. */
  | { kind: "unbacked"; sentences: string[]; flagged: boolean }
  | { kind: "no-citations" }
  | { kind: "uncovered"; documents: string[] }
  | { kind: "outside"; blocks: number[] }
  | { kind: "beside" }
  | { kind: "untouched" }
  | { kind: "as-text"; sources: string[] }
  | { kind: "earlier"; said: string };

const key = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();

const EARLIER = new RegExp(
  [
    String.raw`\b(?:earlier|previous|first|last|prior) (?:answer|response|reply)\b`,
    String.raw`\b(?:disregard|ignore) (?:my|the|that|this) (?:earlier|previous|first|last|prior|answer|response|reply|figure|limit)`,
    String.raw`Northwind|facilities agreement|leverage (?:limit|covenant)|\b3\.[15]x\b|\b3\.[15] times`,
    "(?:之前|先前|前面|上一个|上一次|第一个)的?(?:回答|回复|答案)|(?:请|应)?(?:忽略|无视)(?:我|之前|先前|上一)",
    "贷款协议|杠杆率",
  ].join("|"),
  "i",
);

const NOT_COVERED =
  /\b(?:couldn't|could not|can't|cannot|didn't|did not|wasn't|weren't|isn't|aren't|not|no|unable|left out|missing|skipped)\b|没有|未能|未|无法|不能|缺少|略去/i;

function namedAsUncovered(reply: string, name: string): boolean {
  return reply
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .some((sentence) => key(sentence).includes(key(name)) && NOT_COVERED.test(sentence));
}

/** The ways one request failed its guards; none when it passed. */
export function requestFailures(outcome: RequestOutcome): RequestFailure[] {
  const { expected, answer } = outcome;
  const failures: RequestFailure[] = [];
  const log = changeLogOf(answer.toolCalls);
  if (expected.write && log.changed.size === 0 && log.made.size === 0) {
    failures.push({ kind: "no-change" });
  }
  if (outcome.verdict.unbacked.length > 0) {
    failures.push({
      kind: "unbacked",
      sentences: outcome.verdict.unbacked,
      flagged: (answer.steps?.unbackedClaims ?? []).length > 0,
    });
  }
  // Asked a Question, it may still write its cited answer into a Mind, as a change to accept.
  const citedHere = expected.write
    ? outcome.citedInMinds.length
    : answer.citations.length + outcome.citedInMinds.length;
  if (expected.cite && outcome.scoped.length > 0 && citedHere === 0) {
    failures.push({ kind: "no-citations" });
  }
  if (expected.coverAll) {
    const cited = new Set([
      ...answer.citations.map((citation) => citation.documentId),
      ...outcome.citedInMinds,
    ]);
    const uncovered = outcome.scoped
      .filter(
        (document) => !cited.has(document.id) && !namedAsUncovered(answer.text, document.name),
      )
      .map((document) => document.name);
    if (uncovered.length > 0) failures.push({ kind: "uncovered", documents: uncovered });
  }
  if (expected.only !== undefined) {
    const outside = outcome.changedBlocks.filter((block) => block !== expected.only);
    if (outside.length > 0) failures.push({ kind: "outside", blocks: outside });
  }
  const added = answer.toolCalls.some(
    (call) => call.tool === "add_to_mind" && call.mindChange && call.mindChange.proposals > 0,
  );
  if (expected.inPlace && added) failures.push({ kind: "beside" });
  const { addedBlocks } = outcome;
  if (
    expected.inPlace &&
    addedBlocks &&
    !addedBlocks.some((block) => outcome.changedBlocks.includes(block))
  ) {
    failures.push({ kind: "untouched" });
  }
  if (outcome.sourcesAsText && outcome.sourcesAsText.length > 0) {
    failures.push({ kind: "as-text", sources: [...outcome.sourcesAsText] });
  }
  const said = expected.noEarlier ? answer.text.match(EARLIER)?.[0] : undefined;
  if (said) failures.push({ kind: "earlier", said });
  return failures;
}

/** A failure as the evaluation's report lists it. */
export function failureLine(failure: RequestFailure): string {
  switch (failure.kind) {
    case "no-change":
      return "asked to write, it changed no Mind";
    case "unbacked":
      return `claims a change no call made${failure.flagged ? " (flagged under the reply)" : ""}: ${failure.sentences.map((sentence) => `“${sentence}”`).join(" ")}`;
    case "no-citations":
      return "Documents in scope, and nothing it wrote cites them";
    case "uncovered":
      return `neither cites nor names as left out ${failure.documents.map((name) => `“${name}”`).join(", ")}`;
    case "outside":
      return `changed what it was asked to leave: Block ${failure.blocks.map((block) => block + 1).join(", ")}`;
    case "beside":
      return "added a new version beside the text it was asked to change";
    case "untouched":
      return "left the text it was asked to change as it was";
    case "as-text":
      return `wrote sources into a Mind as text: ${failure.sources.map((source) => `“${source}”`).join(", ")}`;
    case "earlier":
      return `talks about an earlier Answer or the example: “${failure.said}”`;
  }
}
