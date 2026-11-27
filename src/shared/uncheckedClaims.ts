/**
 * Claim sentences in Yjs Blocks left unchecked after an outside AI writes or edits a Note (#3862).
 * Shared by core (`applyAsked`, `access` via `decideProposals`) and renderer (`writeAccepted`,
 * `resolveInEditor`, `resolveRow`), aligned with `noteHealth` and `mindCheck.sending` so omitted
 * opinions, `keptAsView`, and `assistant-conclusion` are never miscounted as unchecked.
 */
import * as Y from "yjs";
import {
  ANALYSIS_TABLE_NODE,
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_SETTINGS_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../core/api";
import { citationAttributesOf } from "./citations";
import { keptOn, readClaimCheck } from "./claimChecks";
import { ANALYSIS_REASONS } from "./figureChecks";
import { readFigures } from "./figures";
import { hasMarkIn, keyedMarkOf } from "./markKeys";
import { markMindCheckUnchecked, readMindCheck, sentenceKey } from "./mindCheck";
import { readOpinionSentences, resolveOpinions } from "./opinions";
import { INLINE_NODE, isClaim, onlyNamesItsTable, sentenceSpans } from "./sentences";
import { onlyNamesItsSource } from "./sourceNames";

const UNCOUNTED: ReadonlySet<string> = new Set([
  "codeBlock",
  "question",
  "footnote",
  "mathBlock",
  "inlineMath",
  "analysisTable",
]);

const SETTLED: ReadonlySet<ClaimCheckAttributes["state"]> = new Set([
  "supported",
  "unsupported",
  "contradicted",
]);

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

interface MarkSpan {
  from: number;
  to: number;
  check: ClaimCheckAttributes;
}

interface ProposalRange {
  from: number;
  to: number;
}

interface Candidate {
  blockId: string;
  text: string;
  occurrence: number;
  from: number;
  to: number;
  hasFigures: boolean;
  hasCitations: boolean;
  valueCell: boolean;
  marks: readonly MarkSpan[];
  kept: readonly { from: number; to: number; text: string }[];
}

const blockIdOf = (element: Y.XmlElement): string | null => {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  return typeof id === "string" && id !== "" ? id : null;
};

function isSettledMark(check: ClaimCheckAttributes, text: string): boolean {
  if (check.state === "checking") return true;
  if (check.text !== text) return false;
  if (SETTLED.has(check.state)) return true;
  return (
    check.state === "not-checked" &&
    check.reason !== null &&
    (check.reason === "assistant-conclusion" || ANALYSIS_REASONS.has(check.reason))
  );
}

function readParagraph(element: Y.XmlElement, blockId: string, valueCell: boolean): Candidate[] {
  let text = "";
  let holdsTableMarker = false;
  const figures: number[] = [];
  const citations: { at: number; attributes: ReturnType<typeof citationAttributesOf> }[] = [];
  const proposals: ProposalRange[] = [];
  const marks: MarkSpan[] = [];
  const openMarks = new Map<string, { from: number; to: number; check: ClaimCheckAttributes }>();

  const flushClosed = (activeIds: ReadonlySet<string>) => {
    for (const [id, span] of openMarks) {
      if (!activeIds.has(id)) {
        marks.push(span);
        openMarks.delete(id);
      }
    }
  };

  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const run of child.toDelta() as Run[]) {
        if (typeof run.insert !== "string") continue;
        const from = text.length;
        text += run.insert;
        const to = text.length;
        const attrs = run.attributes;
        if (hasMarkIn(PROPOSAL_INSERT_MARK, attrs) || hasMarkIn(PROPOSAL_DELETE_MARK, attrs)) {
          proposals.push({ from, to });
        }
        const activeIds = new Set<string>();
        if (attrs) {
          for (const [key, value] of Object.entries(attrs)) {
            if (keyedMarkOf(key) !== CLAIM_CHECK_MARK) continue;
            const check = readClaimCheck(value);
            if (!check) continue;
            activeIds.add(check.id);
            const existing = openMarks.get(check.id);
            if (existing && existing.to === from) existing.to = to;
            else {
              if (existing) marks.push(existing);
              openMarks.set(check.id, { from, to, check });
            }
          }
        }
        flushClosed(activeIds);
      }
      continue;
    }
    if (!(child instanceof Y.XmlElement)) continue;
    flushClosed(new Set());
    if (child.nodeName === ANALYSIS_TABLE_NODE) holdsTableMarker = true;
    const at = text.length;
    if (child.nodeName === "hardBreak") {
      text += "\n";
      continue;
    }
    text += INLINE_NODE;
    if (child.getAttribute(PROPOSAL_ATTRIBUTE) !== undefined) {
      proposals.push({ from: at, to: at + 1 });
    }
    if (child.nodeName === CALCULATED_FIGURE_NODE) figures.push(at);
    else if (child.nodeName === CITATION_NODE) {
      citations.push({ at, attributes: citationAttributesOf(child.getAttributes()) });
    }
  }
  flushClosed(new Set());

  if (holdsTableMarker && onlyNamesItsTable(text)) return [];

  const kept = marks
    .filter((mark) => mark.check.kept === true)
    .map((mark) => ({ from: mark.from, to: mark.to, text: mark.check.text }));
  const occurrences = new Map<string, number>();
  const out: Candidate[] = [];
  for (const span of sentenceSpans(text, figures)) {
    const words = text.slice(span.from, span.to);
    const occurrence = occurrences.get(words) ?? 0;
    occurrences.set(words, occurrence + 1);
    if (proposals.some((prop) => prop.from < span.to && prop.to > span.from)) continue;
    const cited = citations.filter((each) => each.at >= span.from && each.at < span.to);
    if (
      onlyNamesItsSource(
        words,
        cited.map((each) => each.attributes),
      )
    ) {
      continue;
    }
    const hasFigures =
      figures.some((at) => at >= span.from && at < span.to) || readFigures(words).length > 0;
    out.push({
      blockId,
      text: words,
      occurrence,
      from: span.from,
      to: span.to,
      hasFigures,
      hasCitations: cited.length > 0,
      valueCell,
      marks,
      kept,
    });
  }
  return out;
}

/**
 * Records the `sentenceKey`s of any unchecked claim sentences inside `touchedBlockIds` onto the
 * Note's existing complete `MindCheckRun.unchecked`, so an outside AI write that landed without
 * checking returns the Note to its Check button without affecting `#3840` User edits or brand-new
 * Notes (`readMindCheck === null`).
 */
export function markOutsideWriteUnchecked(
  doc: Y.Doc,
  blocks: Y.XmlFragment,
  touchedBlockIds: ReadonlySet<string>,
): boolean {
  if (touchedBlockIds.size === 0) return false;
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  const run = readMindCheck(settings);
  if (!run || run.stop !== null) return false;

  const candidates: Candidate[] = [];
  const visit = (
    node: Y.XmlFragment | Y.XmlElement,
    inTouched: boolean,
    valueCell: boolean,
  ): void => {
    const children = node.toArray();
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!(child instanceof Y.XmlElement)) continue;
      if (UNCOUNTED.has(child.nodeName)) continue;
      if (child.getAttribute(PROPOSAL_ATTRIBUTE) !== undefined) continue;
      if (child.nodeName === "answer" && child.getAttribute("status") === "streaming") continue;
      const id = blockIdOf(child);
      const touched = inTouched || (id !== null && touchedBlockIds.has(id));
      const nextValueCell =
        child.nodeName === "tableCell"
          ? index > 0
          : child.nodeName === "tableHeader"
            ? false
            : valueCell;
      if (child.nodeName === "paragraph") {
        if (touched && id !== null) {
          candidates.push(...readParagraph(child, id, nextValueCell));
        }
        continue;
      }
      visit(child, touched, nextValueCell);
    }
  };
  visit(blocks, false, false);
  if (candidates.length === 0) return false;

  const skipped = new Set(run.skipped);
  const omitted = new Set(
    resolveOpinions(candidates, readOpinionSentences(doc)).map((each) =>
      JSON.stringify([each.blockId, each.text, each.occurrence]),
    ),
  );
  const keys = new Set<string>();
  for (const candidate of candidates) {
    const key = sentenceKey(candidate.text);
    const id = JSON.stringify([candidate.blockId, candidate.text, candidate.occurrence]);
    if ((!candidate.valueCell && skipped.has(key)) || omitted.has(id)) continue;
    if (keptOn(candidate.kept, candidate)) continue;
    if (
      !candidate.valueCell &&
      !isClaim(candidate.text) &&
      !candidate.hasFigures &&
      !candidate.hasCitations
    ) {
      continue;
    }
    const settled = candidate.marks.some(
      (mark) =>
        mark.from < candidate.to &&
        mark.to > candidate.from &&
        isSettledMark(mark.check, candidate.text),
    );
    if (!settled) keys.add(key);
  }
  return markMindCheckUnchecked(settings, [...keys]);
}
