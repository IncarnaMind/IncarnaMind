/**
 * Checks of the User's own sentences in the editor (#96): the mark that
 * holds a sentence's result (`CLAIM_CHECK_MARK`), where each check is now,
 * how it shows (`claimCheckShown`), and the wash behind a sentence found
 * unsupported or contradicted.
 */
import { Extension, Mark } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  type CellFigurePlace,
  CHART_NODE,
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  type RetainedFigureAnalysis,
  type SearchScope,
} from "../../../core/api";
import type { NoteParagraph, RecordCiteNote } from "../../../core/recordCites/referents";
import { readCalculatedFigureEvidence } from "../../../shared/calculatedFigures";
import { chartCheckText, chartPoints, readChart } from "../../../shared/charts";
import { citationAttributesOf } from "../../../shared/citations";
import { asCitedNow } from "../../../shared/citedNow";
import {
  analysisFigureShown,
  type ClaimCheckShown,
  claimCheckShown,
  claimMarkState,
  figureCheckShown,
  type KeptMark,
  type NoteFooting,
  readClaimCheck,
  showsPartRows,
} from "../../../shared/claimChecks";
import { type InlineTextPiece, inlineRange, projectInlineText } from "../../../shared/inlineText";
import { ySyncOf } from "../../../shared/markKeys";
import { sameScope } from "../../../shared/searchScope";
import { INLINE_NODE, sentenceSpans } from "../../../shared/sentences";
import { onlyNamesItsSource } from "../../../shared/sourceNames";

/** Every attribute a check's mark keeps: all of `ClaimCheckAttributes`, never read from pasted HTML. */
const ATTRIBUTES: readonly (keyof ClaimCheckAttributes)[] = [
  "id",
  "request",
  "action",
  "state",
  "parts",
  "reason",
  "detail",
  "providerId",
  "modelId",
  "text",
  "evidence",
  "correction",
  "says",
  "unsupported",
  "calculation",
  "citedCaseUnchecked",
  "citedCaseFound",
  "scope",
  "versions",
  "excluded",
  "readDocuments",
  "recordCites",
  "checkedAt",
  "kept",
  "read",
  "fromAnswer",
  "figures",
  "remainder",
];

/** The room a sentence's check mark takes at the end of its sentence when the Mind's margin folds. */
const INLINE_ROOM = "claim-inline-room";
/** Between a sentence's last word or Citation marker and its mark. */
const INLINE_GAP = 4;

/**
 * A sentence's check, on its text. A copied sentence pastes without it: its
 * check belongs where it was made.
 */
export const ClaimCheck = Mark.create({
  name: CLAIM_CHECK_MARK,
  inclusive: false,
  addAttributes: () =>
    Object.fromEntries(
      ATTRIBUTES.map((name) => [
        name,
        {
          // Only a carried check names its Answer: a null `fromAnswer` stored on every other
          // checked sentence would take a long Note past its size bound (#2220).
          default: name === "remainder" || name === "fromAnswer" ? undefined : null,
          parseHTML: () => null,
          renderHTML: () => ({}),
        },
      ]),
    ),
  parseHTML: () => [],
  renderHTML: ({ mark }) => ["span", { "data-claim-check": String(mark.attrs.id ?? "") }, 0],
  // The editor's Yjs sync keeps each check under a key of its own and reads one when two meet on
  // the same words, by the core's rule (patches/y-tiptap/marks.mjs, #2996).
  extendMarkSchema: (extension) =>
    extension.name === CLAIM_CHECK_MARK ? ySyncOf(CLAIM_CHECK_MARK) : {},
});

/** A paragraph's text as checks read it, and where it is in the document. */
export interface ParagraphPlaces {
  /** An inline node that isn't text is one U+FFFC, a line break "\n". */
  text: string;
  /** Where each character of `text` starts in the document, and where it ends: a footnote takes more room than its one character. */
  starts: number[];
  ends: number[];
  /** The inline nodes that aren't text, each at its character of `text` and its position. */
  inline: { node: ProseMirrorNode; at: number; pos: number }[];
}

/** A paragraph (`block`, at `pos` in the document) read as checks read it, leaving out the children `skip` says. */
export function paragraphPlaces(
  block: ProseMirrorNode,
  pos: number,
  skip: (child: ProseMirrorNode, start: number) => boolean = () => false,
): ParagraphPlaces {
  const places: ParagraphPlaces = { text: "", starts: [], ends: [], inline: [] };
  block.forEach((child, offset) => {
    const start = pos + 1 + offset;
    if (skip(child, start)) return;
    if (child.isText) {
      const words = child.text ?? "";
      for (let index = 0; index < words.length; index++) {
        places.starts.push(start + index);
        places.ends.push(start + index + 1);
      }
      places.text += words;
      return;
    }
    places.inline.push({ node: child, at: places.text.length, pos: start });
    places.starts.push(start);
    places.ends.push(start + child.nodeSize);
    places.text += child.type.name === "hardBreak" ? "\n" : INLINE_NODE;
  });
  return places;
}

export function claimPlaces(
  block: ProseMirrorNode,
  pos: number,
  skip: (child: ProseMirrorNode, start: number) => boolean = () => false,
) {
  const raw = paragraphPlaces(block, pos, skip);
  const pieces: InlineTextPiece[] = [];
  let at = 0;
  const addText = (to: number) => {
    const from = raw.starts[at];
    const end = raw.ends[to - 1];
    if (at < to && from !== undefined && end !== undefined)
      pieces.push({ kind: "text", text: raw.text.slice(at, to), from, to: end });
  };
  for (const each of raw.inline) {
    addText(each.at);
    const place = { from: each.pos, to: raw.ends[each.at] ?? each.pos + each.node.nodeSize };
    const type = each.node.type.name;
    if (type === CITATION_NODE) pieces.push({ kind: "citation", ...place });
    else if (type === "hardBreak") pieces.push({ kind: "break", ...place });
    else {
      const figure =
        type === CALCULATED_FIGURE_NODE ? readCalculatedFigureEvidence(each.node.attrs) : null;
      pieces.push({ kind: "atom", ...place, ...(figure && { shown: figure.figure.shown }) });
    }
    at = each.at + 1;
  }
  addText(raw.text.length);
  const projection = projectInlineText(pieces);
  const citations = pieces.filter((piece) => piece.kind === "citation");
  const sentences = sentenceSpans(projection.text).flatMap((span, index, all) => {
    const range = inlineRange(projection, span.from, span.to);
    if (!range) return [];
    const { from, to: end } = range;
    const next = projection.starts[all[index + 1]?.from ?? projection.text.length] ?? Infinity;
    const to = citations
      .filter((cite) => cite.from >= end && cite.to <= next)
      .reduce((last, cite) => Math.max(last, cite.to), end);
    return [
      { start: span.from, end: span.to, from, to, text: projection.text.slice(span.from, span.to) },
    ];
  });
  const inline = raw.inline.map((each) => {
    const at = projection.rawStarts.findIndex((start) => start !== null && start >= each.at);
    return { ...each, at: at < 0 ? projection.text.length : at };
  });
  return { ...projection, inline, sentences };
}

/**
 * Where characters `from`–`to` of a check's sentence, as its check read it, are in the document;
 * null when the sentence has moved or changed.
 */
export function placeInSentence(
  state: EditorState,
  claim: Pick<ClaimSpan, "sentence">,
  { from, to }: { from: number; to: number },
): { from: number; to: number } | null {
  const $start = state.doc.resolve(claim.sentence.from);
  if (!$start.parent.isTextblock) return null;
  const places = claimPlaces($start.parent, $start.start() - 1);
  const at = places.starts.indexOf(claim.sentence.from);
  if (at < 0 || places.text.slice(at, at + claim.sentence.text.length) !== claim.sentence.text)
    return null;
  return inlineRange(places, at + from, at + to);
}

/** A check where it is in the editor now. */
export interface ClaimSpan {
  kind?: "chart";
  check: ClaimCheckAttributes;
  /** The first marked character, and after the last. */
  from: number;
  to: number;
  /** The whole sentences the marked text is in, as they read now. */
  sentence: { from: number; to: number; text: string };
  /** A paragraph's sentences: its Block and where they are in its text, as the core places figures. */
  place?: { blockId: string; from: number; to: number };
}

/** Every check in the document, top to bottom. */
export function claimSpans(doc: ProseMirrorNode): ClaimSpan[] {
  const spans: ClaimSpan[] = [];
  doc.descendants((block, pos) => {
    if (block.type.name === CHART_NODE) {
      const check = readClaimCheck(block.attrs[CLAIM_CHECK_MARK]);
      if (check)
        spans.push({
          kind: "chart",
          check,
          from: pos,
          to: pos + block.nodeSize,
          sentence: {
            from: pos,
            to: pos + block.nodeSize,
            text: chartCheckText(readChart(block.attrs)),
          },
        });
      return false;
    }
    if (!block.isTextblock) return true;
    const found = new Map<string, { check: ClaimCheckAttributes; from: number; to: number }>();
    block.forEach((child, offset) => {
      if (child.type.name === CITATION_NODE) return;
      const from = pos + 1 + offset;
      const to = from + child.nodeSize;
      const mark = child.marks.find((each) => each.type.name === CLAIM_CHECK_MARK);
      const check = mark
        ? readClaimCheck(mark.attrs)
        : child.type.name === CALCULATED_FIGURE_NODE
          ? readClaimCheck(child.attrs[CLAIM_CHECK_MARK])
          : null;
      if (check) {
        const known = found.get(check.id);
        if (known) known.to = to;
        else found.set(check.id, { check, from, to });
      }
    });
    if (found.size === 0) return false;
    const places = claimPlaces(block, pos);
    const { text, starts, ends, sentences } = places;
    for (const { check, from, to } of found.values()) {
      const markedStart = starts.indexOf(from);
      const markedEnd = ends.indexOf(to) + 1;
      if (markedStart < 0 || markedEnd <= markedStart) continue;
      const touched = sentences.filter((span) => span.from < to && span.to > from);
      const start = Math.min(markedStart, touched[0]?.start ?? markedStart);
      const end = Math.max(markedEnd, touched.at(-1)?.end ?? markedEnd);
      const range = inlineRange(places, start, end);
      if (!range) continue;
      const blockId = block.attrs[BLOCK_ID_ATTRIBUTE];
      const placeFrom = places.rawStarts[start];
      const placeTo = places.rawEnds[end - 1];
      spans.push({
        check,
        from,
        to,
        sentence: {
          from: range.from,
          to: Math.max(range.to, touched.at(-1)?.to ?? 0),
          text: text.slice(start, end),
        },
        ...(typeof blockId === "string" &&
          typeof placeFrom === "number" &&
          typeof placeTo === "number" && { place: { blockId, from: placeFrom, to: placeTo } }),
      });
    }
    return false;
  });
  return spans;
}

/** The Note's paragraphs as the core's record cites read them (`recordCiteParagraphs`). */
function noteParagraphs(doc: ProseMirrorNode): NoteParagraph[] {
  const paragraphs: NoteParagraph[] = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    const blockId = block.attrs[BLOCK_ID_ATTRIBUTE];
    if (block.type.name === "paragraph" && typeof blockId === "string")
      paragraphs.push({ blockId, text: paragraphPlaces(block, pos).text });
    return false;
  });
  return paragraphs;
}

/** The Note as a check's `Id.` and `supra` read it now, its paragraphs read once and only if needed. */
function noteOf(
  doc: ProseMirrorNode,
): (span: ClaimSpan) => { note: RecordCiteNote; noteText(): string } {
  let paragraphs: NoteParagraph[] | undefined;
  const read = () => {
    paragraphs ??= noteParagraphs(doc);
    return paragraphs;
  };
  return ({ place, sentence }) => ({
    note: {
      paragraphs: read,
      ...(place && { place: { blockId: place.blockId, from: place.from } }),
    },
    noteText: () =>
      place
        ? (read()
            .find((paragraph) => paragraph.blockId === place.blockId)
            ?.text.slice(place.from, place.to) ?? sentence.text)
        : sentence.text,
  });
}

/** What a check is compared with besides its sentence: the Documents' versions and the Mind's Folder. */
export interface ClaimContext {
  /** Kept across a change until the next is read, so a total never falls back to its stored footing meanwhile. */
  footing: NoteFooting;
  figureContexts?: ReadonlyMap<string, string> | null;
  /** Where each figure the one Check reads in a table's cells is, by Block: its start and end in the Block's text. */
  figurePlaces?: ReadonlyMap<string, readonly (readonly [number, number])[]> | null;
  /** Each live Document's current version, by id; null while they aren't known. */
  versions: ReadonlyMap<string, string> | null;
  folderId: string | null;
  scope: SearchScope | null;
  /** The walled Folder that keeps a Document inside it, seen from the Note; null when it may read it. */
  keptInside?: ((documentId: string) => string | null) | null;
}

export function claimPartRows(check: ClaimCheckAttributes): ClaimCheckAttributes["parts"] {
  return showsPartRows(check) ? check.parts : undefined;
}

/** `ClaimContext.figurePlaces` from where the core reads figures in table cells. */
export function figurePlacesOf(
  cells: readonly CellFigurePlace[],
): Map<string, (readonly [number, number])[]> {
  const places = new Map<string, (readonly [number, number])[]>();
  for (const { blockId, from, to } of cells)
    places.set(blockId, [...(places.get(blockId) ?? []), [from, to]]);
  return places;
}

/** A check where it is, and how it shows: never one the User keeps as their own view, which shows nothing. */
export interface ShownClaim extends ClaimSpan {
  shown: Exclude<ClaimCheckShown, { state: "kept" }>;
  /**
   * The check as the sentence's Citations read it now (`asCitedNow`, #3019): what its mark and card
   * show. `check` is what the mark stores, which every change to the mark starts from.
   */
  reads: ClaimCheckAttributes;
  /**
   * A needs-recheck its sentence's edit made, where the check would still hold with the words it was
   * checked on: what an edit leaves to check only if nothing else moved since (#2313).
   */
  holdsWithItsText?: boolean;
}

interface ClaimState {
  context: ClaimContext;
  claims: readonly ShownClaim[];
  /** The marks the User keeps as their own view (#1111), at their places. */
  kept: readonly KeptMark[];
  /** Whether the Mind's margin has folded and each mark sits in the text (see `setClaimInline`). */
  inline: boolean;
  /** Each mark's own width, by its check's id, for the room it takes at its sentence's end. */
  rooms: ReadonlyMap<string, number>;
  decorations: DecorationSet;
}

const claimsKey = new PluginKey<ClaimState>("claimChecks");

/** A transaction with this meta compares the checks with new Documents or a new Folder (`setClaimContext`). */
const CONTEXT = "claimContext";
/** A transaction with this meta folds the margin's marks into the text, or unfolds them (`setClaimInline`). */
const INLINE = "claimInline";
/** A transaction with this meta says how wide each mark is, for the room it takes (`setClaimRooms`). */
const ROOMS = "claimRooms";

const NO_ROOMS: ReadonlyMap<string, number> = new Map();

const NO_CONTEXT: ClaimContext = {
  footing: "not-yet-known",
  versions: null,
  folderId: null,
  scope: null,
};

/** The Citations in a sentence's stretch of the document, as its card finds them (`citationsOf`). */
function citationsWithin(
  doc: ProseMirrorNode,
  { from, to }: { from: number; to: number },
): Partial<CitationAttributes>[] {
  const found: Partial<CitationAttributes>[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === CITATION_NODE && pos >= from && pos < to)
      found.push(citationAttributesOf(node.attrs));
    return true;
  });
  return found;
}

/** The checks in a document as they show now, and the sentences the User keeps as their own view. */
export function claimsOf(
  doc: ProseMirrorNode,
  context: ClaimContext,
): Pick<ClaimState, "claims" | "kept"> {
  const claims: ShownClaim[] = [];
  const kept: KeptMark[] = [];
  const note = noteOf(doc);
  for (const span of claimSpans(doc)) {
    const { place } = span;
    const figured =
      context.figurePlaces && place
        ? (context.figurePlaces.get(place.blockId) ?? []).some(
            ([from, to]) => from >= place.from && to <= place.to,
          )
        : undefined;
    const citations = span.kind === "chart" ? [] : citationsWithin(doc, span.sentence);
    // No check reads a sentence that only names its source, so an earlier mark on it shows no card (#3093).
    if (span.kind !== "chart" && onlyNamesItsSource(span.sentence.text, citations)) continue;
    let shown = claimCheckShown(span.check, {
      ...context,
      text: span.sentence.text,
      citations,
      ...(figured !== undefined && { figured }),
      ...note(span),
    });
    const holdsWithItsText =
      shown.state === "needs-recheck" && shown.why === "edited"
        ? claimCheckShown(span.check, {
            ...context,
            text: span.check.text,
            citations,
            ...(figured !== undefined && { figured }),
            ...note(span),
          })
        : null;
    if (span.kind === "chart") {
      const node = doc.nodeAt(span.from);
      const chart = readChart(node?.attrs ?? {});
      const expected = chartPoints(chart).length * (chart.kind === "scatter" ? 2 : 1);
      if (
        (!span.check.figures?.length || span.check.figures.length !== expected) &&
        shown.state !== "kept" &&
        shown.state !== "checking" &&
        shown.state !== "needs-recheck" &&
        (!span.check.figures?.length || shown.state === "supported")
      )
        shown = { state: "not-checked", reason: "unread" };
    }
    if (shown.state === "kept") {
      kept.push({ from: span.from, to: span.to, text: span.sentence.text });
    } else
      claims.push({
        ...span,
        shown,
        reads: asCitedNow(span.check, citations, span.sentence.text),
        ...(holdsWithItsText !== null && {
          holdsWithItsText:
            holdsWithItsText.state === "supported" ||
            holdsWithItsText.state === "unsupported" ||
            holdsWithItsText.state === "contradicted" ||
            holdsWithItsText.state === "kept",
        }),
      });
  }
  return { claims, kept };
}

function stateOf(
  doc: ProseMirrorNode,
  context: ClaimContext,
  inline = false,
  rooms: ReadonlyMap<string, number> = NO_ROOMS,
): ClaimState {
  const { claims, kept } = claimsOf(doc, context);
  const washes = claims.flatMap(({ shown, from, to, kind }) =>
    shown.state === "unsupported" || shown.state === "contradicted"
      ? [
          kind === "chart"
            ? Decoration.node(from, to, { class: `claim-wash claim-wash--${shown.state}` })
            : Decoration.inline(from, to, { class: `claim-wash claim-wash--${shown.state}` }),
        ]
      : [],
  );
  // A folded Mind draws each mark at its sentence's end, in the text, so the fold's 40px gutter
  // stays the text's: the sentence's last word or Citation marker keeps the mark's room in its own
  // box, exactly its own width plus 4px, so the room never makes a line of its own.
  const roomsOf = inline
    ? claims.flatMap(({ check, sentence, shown }) =>
        shown.state === "not-checked" && !foundElsewhere({ shown, check })
          ? []
          : [
              Decoration.inline(sentence.to - 1, sentence.to, {
                class: INLINE_ROOM,
                style: `padding-right: ${(rooms.get(check.id) ?? 0) + INLINE_GAP}px`,
              }),
            ],
      )
    : [];
  return {
    context,
    claims,
    kept,
    inline,
    rooms,
    decorations: DecorationSet.create(doc, [...washes, ...roomsOf]),
  };
}

/** How the checks of a Mind's sentences cover its Documents (#764). */
export interface Coverage {
  /** More than half of the sentences that got a verdict found nothing in the Documents. */
  mostlyUncovered: boolean;
  /** Some of them were checked in a Folder only, so every Document could still say something. */
  canWiden: boolean;
  /** From the first to the last sentence that found nothing: where "Check against all Documents" goes. */
  range: { from: number; to: number } | null;
  /** How the first of them was checked. */
  action: ShownClaim["check"]["action"] | null;
}

const NO_COVERAGE: Coverage = {
  mostlyUncovered: false,
  canWiden: false,
  range: null,
  action: null,
};

/** Whether the checks, taken together, say the Documents don't cover most of what was checked. */
export function coverageOf(claims: readonly ShownClaim[]): Coverage {
  let checked = 0;
  const lacking: ShownClaim[] = [];
  for (const claim of claims) {
    const { state } = claim.shown;
    if (state === "supported" || state === "contradicted") checked++;
    else if (state === "unsupported") {
      checked++;
      lacking.push(claim);
    }
  }
  const first = lacking[0];
  const last = lacking.at(-1);
  if (!first || !last || checked < 2 || lacking.length * 2 <= checked) return NO_COVERAGE;
  return {
    mostlyUncovered: true,
    canWiden: lacking.some(
      (claim) => !claim.check.scope.widened && claim.check.scope.folderId !== null,
    ),
    range: { from: first.from, to: last.to },
    action: first.check.action,
  };
}

/** Whether two readings of the coverage say the same. */
export const sameCoverage = (a: Coverage, b: Coverage | null | undefined): boolean =>
  b !== null &&
  b !== undefined &&
  a.mostlyUncovered === b.mostlyUncovered &&
  a.canWiden === b.canWiden &&
  a.range?.from === b.range?.from &&
  a.range?.to === b.range?.to;

/** What a check's margin glyph shows (`claimMarkState`). */
export const markOf = (claim: ShownClaim) => claimMarkState(claim.shown.state, claim.check);

/**
 * Whether it is Supported, not yet cited (#3019): the model's ✓, which shows once the Passage its
 * check found is one of the sentence's Citations. Its mark shows, and it is counted apart. A mark an
 * older version stored as Not checked, found elsewhere, has no verdict to bring back: it is Not
 * checked, and a check makes it again.
 */
export const foundElsewhere = ({ shown, check }: Pick<ShownClaim, "shown" | "check">): boolean =>
  shown.state === "not-checked" &&
  shown.reason === "found-elsewhere" &&
  check.state !== "not-checked";

/** The parts of a check, as its Citations read them now, that are Supported, not yet cited (#3019). */
export function waitingParts({
  check,
  reads,
}: Pick<ShownClaim, "check" | "reads">): ReadonlySet<ClaimCheckPart> {
  return new Set(
    (reads.parts ?? []).filter(
      (part, index) =>
        part.verdict === "not-checked" &&
        part.reason === "found-elsewhere" &&
        (check.parts?.[index]?.verdict ?? check.state) === "supported",
    ),
  );
}

/** The checks in the editor, as they show now. Empty without `ClaimChecks`. */
export function shownClaims(state: EditorState): readonly ShownClaim[] {
  return claimsKey.getState(state)?.claims ?? [];
}

/** The table row a position is in, as the Note's check reads a row's figures together; null outside a table. */
function rowAround(doc: ProseMirrorNode, at: number): { from: number; to: number } | null {
  const place = doc.resolve(Math.min(at, doc.content.size));
  for (let depth = place.depth; depth > 0; depth--)
    if (place.node(depth).type.name === "tableRow")
      return { from: place.before(depth), to: place.after(depth) };
  return null;
}

/**
 * How a figure's check shows, and whether that check worked it out again from its kept
 * inputs (a calculated figure's "Inputs found · recalculated").
 */
export function figureShownIn(
  state: EditorState,
  id: string,
  run: RetainedFigureAnalysis | null = null,
  result: string | null = null,
  /** Where the figure is: only the check of the sentence that holds it is its own (#2378). */
  at: number | null = null,
): ClaimCheckShown & { recalculated?: true } {
  const context = claimsKey.getState(state)?.context ?? NO_CONTEXT;
  const row = at === null ? null : rowAround(state.doc, at);
  for (const span of claimSpans(state.doc)) {
    // A figure pasted elsewhere with the same id never takes another sentence's check; a table
    // cell's figure is checked with its row's.
    if (
      at !== null &&
      (row
        ? span.sentence.to <= row.from || span.sentence.from >= row.to
        : at < span.sentence.from || at >= span.sentence.to)
    )
      continue;
    const now = {
      ...context,
      text: span.sentence.text,
      citations: span.kind === "chart" ? [] : citationsWithin(state.doc, span.sentence),
    };
    const child = span.check.figures?.find((figure) => figure.id === id);
    if (!child) {
      // A whole-sentence check from before figures were checked one by one still says a re-check, a
      // Keep or a run of its own; its verdict alone is no figure's evidence (#1932, #2378).
      if (!span.check.figures?.length) {
        if (span.check.kept) return claimCheckShown(span.check, now);
        // An Analysis's figure is its run's: no check of the sentence's words stands for it (#2378).
        if (result !== null) continue;
        const legacy = claimCheckShown({ ...span.check, figures: undefined }, now);
        if (
          legacy.state === "needs-recheck" ||
          legacy.state === "kept" ||
          legacy.state === "checking"
        )
          return legacy;
      }
      continue;
    }
    if (span.check.kept) return claimCheckShown(span.check, now);
    const shown = analysisFigureShown(figureCheckShown(child, now), {
      run,
      result,
      versions: now.versions,
      keptInside: context.keptInside ?? null,
      check: child,
    });
    // A workbook's figure shows how it was worked out on its own card (#2347).
    return shown.state === "supported" && child.calculation && !child.calculation.figure.workbook
      ? { ...shown, recalculated: true }
      : shown;
  }
  return analysisFigureShown(
    { state: "not-checked", reason: "unread" },
    { run, result, versions: context.versions, keptInside: context.keptInside ?? null },
  );
}

const NONE_KEPT: readonly KeptMark[] = [];

/** The marks the User keeps as their own view, at their places: not counted. */
export function keptSpans(state: EditorState): readonly KeptMark[] {
  return claimsKey.getState(state)?.kept ?? NONE_KEPT;
}

/** Compares the checks with the Documents and the Mind's Folder and scope as they are now. */
export function setClaimContext(view: EditorView, context: ClaimContext): void {
  const now = claimsKey.getState(view.state)?.context;
  const sameScopes =
    now?.scope === context.scope ||
    (now?.scope && context.scope && sameScope(now.scope, context.scope));
  if (
    now?.versions === context.versions &&
    now.folderId === context.folderId &&
    sameScopes &&
    now.figureContexts === context.figureContexts &&
    now.figurePlaces === context.figurePlaces &&
    now.keptInside === context.keptInside &&
    now.footing === context.footing
  )
    return;
  view.dispatch(view.state.tr.setMeta(CONTEXT, context).setMeta("addToHistory", false));
}

/** Folds the margin's marks into the text, at their sentences' ends, or unfolds them (`MarginChecks`). */
export function setClaimInline(view: EditorView, inline: boolean): void {
  if ((claimsKey.getState(view.state)?.inline ?? false) === inline) return;
  view.dispatch(view.state.tr.setMeta(INLINE, inline).setMeta("addToHistory", false));
}

/** Says how wide each mark is, by its check's id, so its sentence keeps exactly that room plus 4px. */
export function setClaimRooms(view: EditorView, rooms: ReadonlyMap<string, number>): void {
  const now = claimsKey.getState(view.state)?.rooms ?? NO_ROOMS;
  if (now.size === rooms.size && [...rooms].every(([id, width]) => now.get(id) === width)) return;
  view.dispatch(view.state.tr.setMeta(ROOMS, rooms).setMeta("addToHistory", false));
}

/** Keeps the checks, how they show, and the washes behind sentences found unsupported or contradicted. */
export const ClaimChecks = Extension.create({
  name: "claimChecks",

  addProseMirrorPlugins() {
    return [
      new Plugin<ClaimState>({
        key: claimsKey,
        state: {
          init: (_config, state) => stateOf(state.doc, NO_CONTEXT),
          apply: (tr, claims) => {
            const context = tr.getMeta(CONTEXT) as ClaimContext | undefined;
            const inline = tr.getMeta(INLINE) as boolean | undefined;
            const rooms = tr.getMeta(ROOMS) as ReadonlyMap<string, number> | undefined;
            if (context || rooms || (inline !== undefined && inline !== claims.inline))
              return stateOf(
                tr.doc,
                context ?? claims.context,
                inline ?? claims.inline,
                rooms ?? claims.rooms,
              );
            return tr.docChanged
              ? stateOf(
                  tr.doc,
                  { ...claims.context, figureContexts: null },
                  claims.inline,
                  claims.rooms,
                )
              : claims;
          },
        },
        props: {
          decorations: (state) => claimsKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
