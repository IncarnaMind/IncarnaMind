/**
 * A paragraph written back into its own XML (#105). Its text as imported and
 * as it is now are compared word by word, as Proposals compare text, and only
 * what changed is written again: each child of the `w:p` whose text was all
 * kept, with its marks, is copied as it was; a child with an edit is written
 * again run by run, each character in the run it came from, with that run's
 * properties, so formatting the editor doesn't show (a font, a size, a
 * colour) stays. Typed text takes the formatting of what it replaces, else of
 * the character before it, as typing in Word does; the editor's marks are then
 * set on top. What the import kept as is (a field, a footnote mark, a
 * bookmark…) goes back as its original XML. A new paragraph is written the
 * same way, with nothing to keep.
 *
 * For review (#107), what changes still waiting add and remove goes in as
 * IncarnaMind's tracked changes, and, when the User's edits are tracked,
 * their words added and removed as theirs, and a format they changed with
 * what it was (`w:rPrChange`). IncarnaMind's comments on AI text start and
 * end where its passages do. Someone's change from the file (#108) still
 * waiting stays as it was there; one accepted or rejected leaves no trace.
 */
import type { NodeJSON } from "../../../shared/blockJson";
import { readClaimCheck } from "../../../shared/claimChecks";
import { readWordAtom } from "../../../shared/wordFiles";
import {
  CLAIM_CHECK_MARK,
  FOOTNOTE_NODE,
  GENERATED_MARK,
  IMAGE_NODE,
  PAGE_BREAK_NODE,
  WORD_ATOM_NODE,
  type WordAtomKind,
} from "../../api";
import type { Places } from "../../documents/formats/docxImport";
import { elements, type XmlElement } from "../../documents/formats/xml";
import {
  type FailedSentence,
  type Inline,
  isWordChange,
  type Pending,
  type Pendings,
  type ReviewReading,
  samePendings,
} from "../../mindText";
import { diffSteps, splitWords } from "../../proposals/diff";
import { dateAttribute, escapeXml, type WordIds } from "../wordml";
import { changeClose, changeTag, type Review, type Tracking, trackInline } from "../wordReview";
import {
  marksOf,
  NO_MARKS,
  nodePendings,
  sameMarks,
  type TextMarks,
  textPendings,
  withFileFormat,
} from "./mind";
import { marksOfRun, Properties, runPropertiesFor, withoutFormatChange } from "./properties";
import {
  closeTag,
  endOf,
  type Namespaces,
  openTag,
  rescoped,
  scopeOf,
  sliceOf,
  startOf,
} from "./text";

/** One thing in a paragraph's text: a character, a line break, something kept as is, or new. */
export interface Token {
  kind: "char" | "break" | "atom" | "special";
  /** What compares equal: the character, a line break, the atom's source. A special never does. */
  key: string;
  char: string;
  marks: TextMarks;
  /** As imported: the run its text was read from. */
  run: XmlElement | null;
  /** An atom's source: "w:bookmarkStart#3", "w:r#40..w:r#44". */
  source: string | null;
  /** An atom of the Note's text now: its node, which `AtomPlan` may choose to write the XML. */
  node?: NodeJSON;
  /** A special's content, for the native writer: a Citation's footnote, maths, a new picture. */
  inline: Inline | null;
  /** What changes still waiting do to it (#107). */
  pending: Pendings;
  /** It is AI text. */
  ai: boolean;
  sentence?: FailedSentence;
}

const BREAK = "\u0001break";
let specials = 0;

const char = (value: string, marks: TextMarks, run: XmlElement | null): Token => ({
  kind: "char",
  key: value,
  char: value,
  marks,
  run,
  source: null,
  inline: null,
  pending: {},
  ai: false,
});

const atom = (source: string): Token => ({
  kind: "atom",
  key: `\u0001${source}`,
  char: "",
  marks: NO_MARKS,
  run: null,
  source,
  inline: null,
  pending: {},
  ai: false,
});

/** A special: never equal to anything, so it is always written new. */
export const special = (inline: Inline): Token => ({
  kind: "special",
  key: `\u0002${specials++}`,
  char: "",
  marks: NO_MARKS,
  run: null,
  source: null,
  inline,
  pending: {
    ...(inline.inserted && { inserted: inline.inserted }),
    ...(inline.deleted && { deleted: inline.deleted }),
  },
  ai: false,
});

const textTokens = (text: string, marks: TextMarks, run: XmlElement | null) =>
  Array.from(text, (each) => char(each, marks, run));

/** A line break, as one in the text or where a note's paragraph ends (#746). */
export const lineBreak = (run: XmlElement | null = null): Token => ({
  ...char("\n", NO_MARKS, run),
  kind: "break",
  key: BREAK,
});

/**
 * A paragraph's text as the import read it, each character with the run it
 * came from, and someone's changes to it in the file (`reading`, #108).
 */
export function baseTokens(
  content: readonly NodeJSON[],
  origins: ReadonlyMap<NodeJSON, XmlElement>,
  reading?: ReviewReading,
): Token[] {
  const tokens: Token[] = [];
  for (const node of content) {
    const run = origins.get(node) ?? null;
    if (node.type === "text") {
      const pending = textPendings(node, reading);
      tokens.push(
        ...textTokens(node.text ?? "", marksOf(node.marks), run).map((token) => ({
          ...token,
          pending,
        })),
      );
    } else if (node.type === "hardBreak")
      tokens.push({ ...lineBreak(run), pending: nodePendings(node, reading) });
    else {
      const source = sourceOf(node);
      if (source) tokens.push(atom(source));
    }
  }
  return tokens;
}

/** Nodes the document had that keep their XML in a `source`, as atoms do. */
const SOURCED: ReadonlySet<string> = new Set([IMAGE_NODE, FOOTNOTE_NODE, PAGE_BREAK_NODE]);

/** Where a node kept from the document came from: an atom's, an imported picture's, note's or page break's. */
export function sourceOf(node: NodeJSON): string | null {
  if (node.type === WORD_ATOM_NODE) return readWordAtom(node.attrs ?? {}).source;
  if (SOURCED.has(node.type)) {
    const source = node.attrs?.source;
    return typeof source === "string" && source !== "" ? source : null;
  }
  return null;
}

/** What a node with a source is, as what is kept as is is written once (`AtomPlan`). */
export function keptKindOf(node: NodeJSON): WordAtomKind {
  if (node.type === IMAGE_NODE) return "picture";
  if (node.type === PAGE_BREAK_NODE) return "pageBreak";
  if (node.type === FOOTNOTE_NODE) return node.attrs?.endnote === true ? "endnote" : "footnote";
  return readWordAtom(node.attrs ?? {}).kind;
}

/**
 * A paragraph's text as it is now. `specialOf` reads what the native writer
 * writes (Citations, footnotes, maths, a new picture); other inline nodes
 * read as their text. Read for review (`reading`), what changes still waiting
 * do to each is marked, and AI text (all of it, `wholeAi`, in an Answer from
 * before AI text was marked), and the sentences in `checks` whose check isn't good.
 */
export function currentTokens(
  content: readonly NodeJSON[],
  specialOf: (node: NodeJSON) => Inline[],
  textOf: (node: NodeJSON) => string,
  reading?: ReviewReading,
  wholeAi = false,
  checks?: ReadonlyMap<string, FailedSentence>,
): Token[] {
  const tokens: Token[] = [];
  const marked = (made: Token[], node: NodeJSON, pending: Pendings): Token[] => {
    const ai =
      reading !== undefined &&
      node.type === "text" &&
      (wholeAi || (node.marks?.some((mark) => mark.type === GENERATED_MARK) ?? false));
    if (!ai && !pending.inserted && !pending.deleted) return made;
    for (const token of made) {
      token.pending = { ...token.pending, ...pending };
      token.ai = ai;
    }
    return made;
  };
  for (const node of content) {
    if (node.type === "text") {
      const made = marked(
        textTokens(node.text ?? "", marksOf(node.marks), null),
        node,
        textPendings(node, reading),
      );
      const checkId = readClaimCheck(
        node.marks?.find((mark) => mark.type === CLAIM_CHECK_MARK)?.attrs,
      )?.id;
      const sentence = checkId === undefined ? undefined : checks?.get(checkId);
      if (sentence) for (const token of made) token.sentence = sentence;
      tokens.push(...made);
    } else if (node.type === "hardBreak") {
      tokens.push(
        ...marked(
          [{ ...char("\n", NO_MARKS, null), kind: "break", key: BREAK }],
          node,
          nodePendings(node, reading),
        ),
      );
    } else {
      const pending = nodePendings(node, reading);
      const source = sourceOf(node);
      if (source) {
        // A copy of a note or a page break, or one from another file, is written as a new one.
        const inline =
          node.type === FOOTNOTE_NODE || node.type === PAGE_BREAK_NODE
            ? (specialOf(node)[0] ?? null)
            : null;
        tokens.push(...marked([{ ...atom(source), inline, node }], node, pending));
      } else {
        const inlines = specialOf(node);
        if (inlines.length > 0) tokens.push(...inlines.map(special));
        else tokens.push(...marked(textTokens(textOf(node), NO_MARKS, null), node, pending));
      }
    }
  }
  return tokens;
}

/**
 * Tokens with someone's change to their whole paragraph from the file
 * (#108): kept as it was there, or resolved, word by word like the others.
 */
export function withWordChanges(tokens: Token[], pending: Pendings): Token[] {
  const inserted = isWordChange(pending.inserted) ? pending.inserted : undefined;
  const deleted = isWordChange(pending.deleted) ? pending.deleted : undefined;
  if (!inserted && !deleted) return tokens;
  return tokens.map((token) =>
    token.kind === "special"
      ? token
      : {
          ...token,
          pending: {
            ...(inserted && { inserted }),
            ...(deleted && { deleted }),
            ...token.pending,
          },
        },
  );
}

/** Someone's changes from the file on a token, as one key. */
const wordChangesOf = (pending: Pendings) =>
  `${isWordChange(pending.inserted) ? pending.inserted.id : ""}\u0000${isWordChange(pending.deleted) ? pending.deleted.id : ""}`;

/** One step of a paragraph from its text as imported to its text now, in the order written. */
export type Aligned =
  /** A base token kept, as current token `y`. */
  | { step: "equal"; x: number; y: number }
  /** A base token the User removed. */
  | { step: "delete"; x: number }
  /** A current token the User added. */
  | { step: "insert"; y: number }
  /** A current token a change still waiting adds. */
  | { step: "proposed"; y: number };

/**
 * A paragraph's text as imported and now, aligned word by word. What the AI's
 * changes still waiting add isn't the Mind's text yet: it is left out of the
 * comparison, and goes where it is among the rest. Someone's from the file
 * (#108) was in it, and is compared; what one the User resolved since took
 * away (`resolvedAway`) is removed without being compared.
 */
export function alignTokens(base: readonly Token[], current: readonly Token[]): Aligned[] {
  const accepted = current.flatMap((token, index) =>
    token.pending.inserted && !isWordChange(token.pending.inserted) ? [] : [index],
  );
  const now = accepted.map((index) => current[index] as Token);
  const gone = resolvedAway(base, now);
  const compared = base.flatMap((_, index) => (gone.has(index) ? [] : [index]));
  const steps = diffTokens(
    compared.map((index) => base[index] as Token),
    now,
  );
  const aligned: Aligned[] = [];
  let x = 0;
  let next = 0;
  let written = 0;
  let removed = 0;
  const proposedBefore = (limit: number) => {
    for (; written < limit; written++) aligned.push({ step: "proposed", y: written });
  };
  /** Base tokens up to `limit` that are gone, and the one at it, in order. */
  const reach = (limit: number) => {
    for (; removed < limit; removed++)
      if (gone.has(removed)) aligned.push({ step: "delete", x: removed });
    removed = limit + 1;
    return limit;
  };
  for (const step of steps) {
    if (step === "delete") {
      aligned.push({ step: "delete", x: reach(compared[x++] as number) });
      continue;
    }
    const y = accepted[next++] as number;
    proposedBefore(y);
    written = y + 1;
    if (step === "equal") aligned.push({ step: "equal", x: reach(compared[x++] as number), y });
    else aligned.push({ step: "insert", y });
  }
  reach(base.length);
  proposedBefore(current.length);
  return aligned;
}

/** How many resolved changes in a paragraph its export weighs one by one when the User edited it too. */
const GREEDY_CHANGES = 16;

/** Someone's change a base token is part of, resolved since, and whether the token is what it adds. */
interface Resolved {
  id: string;
  adds: boolean;
}

/**
 * The base tokens that someone's changes from the file the User accepted or
 * rejected since took away: an insertion rejected, a deletion accepted. The
 * Mind no longer says which way each went, so it is read from the text now:
 * the ways that give it exactly, if any do (`exactly`), else the ways that
 * leave it nearest: all one way, then change by change.
 */
function resolvedAway(base: readonly Token[], now: readonly Token[]): Set<number> {
  const waiting = new Set<string>();
  for (const token of now) {
    for (const each of [token.pending.inserted, token.pending.deleted])
      if (isWordChange(each)) waiting.add(each.id);
  }
  const changeOf = base.map((token): Resolved | null => {
    const { inserted, deleted } = token.pending;
    if (isWordChange(inserted) && !waiting.has(inserted.id)) return { id: inserted.id, adds: true };
    if (isWordChange(deleted) && !waiting.has(deleted.id)) return { id: deleted.id, adds: false };
    return null;
  });
  const ids = new Set(changeOf.flatMap((change) => (change ? [change.id] : [])));
  if (ids.size === 0) return new Set();
  const keysNow = now.map((token) => token.key);
  const exact = exactly(base, changeOf, keysNow);
  const acceptedIds = exact ?? new Map<string, boolean>();
  const kept = (index: number) => {
    const change = changeOf[index];
    return !change || change.adds === (acceptedIds.get(change.id) ?? true);
  };
  if (!exact) {
    const cost = () =>
      diffSteps(
        base.flatMap((token, index) => (kept(index) ? [token.key] : [])),
        keysNow,
      ).filter((step) => step !== "equal").length;
    const all = (accepted: boolean) => {
      for (const id of ids) acceptedIds.set(id, accepted);
      return cost();
    };
    const allAccepted = all(true);
    if (all(false) > allAccepted) all(true);
    // Each change weighed on its own costs two comparisons of the paragraph: only for a few.
    if (ids.size <= GREEDY_CHANGES) {
      for (const id of ids) {
        const was = acceptedIds.get(id) ?? true;
        const before = cost();
        acceptedIds.set(id, !was);
        if (cost() >= before) acceptedIds.set(id, was);
      }
    }
  }
  return new Set(base.flatMap((_, index) => (kept(index) ? [] : [index])));
}

/**
 * Whether each resolved change was accepted, such that the text as imported
 * becomes the text now exactly; null if no way does (the User edited it too).
 */
function exactly(
  base: readonly Token[],
  changeOf: readonly (Resolved | null)[],
  now: readonly string[],
): Map<string, boolean> | null {
  /** The base in stretches: text no resolved change has, and each change's own. */
  const stretches: { id: string | null; from: number; to: number }[] = [];
  changeOf.forEach((change, index) => {
    const id = change?.id ?? null;
    const last = stretches.at(-1);
    if (last && last.id === id) last.to = index + 1;
    else stretches.push({ id, from: index, to: index + 1 });
  });
  const matches = (from: number, to: number, accepted: boolean | null, at: number) => {
    let y = at;
    for (let x = from; x < to; x++) {
      if (accepted !== null && changeOf[x]?.adds !== accepted) continue;
      if (now[y] !== (base[x] as Token).key) return -1;
      y++;
    }
    return y;
  };
  /** After each stretch, each place in the text now it can end at, with how it got there. */
  const reached: Map<number, { from: number; accepted: boolean | null }>[] = [];
  let places = new Map<number, { from: number; accepted: boolean | null }>([
    [0, { from: 0, accepted: null }],
  ]);
  for (const stretch of stretches) {
    const next = new Map<number, { from: number; accepted: boolean | null }>();
    for (const at of places.keys()) {
      for (const accepted of stretch.id === null ? [null] : [true, false]) {
        const end = matches(stretch.from, stretch.to, accepted, at);
        if (end >= 0 && !next.has(end)) next.set(end, { from: at, accepted });
      }
    }
    if (next.size === 0) return null;
    reached.push(next);
    places = next;
  }
  if (!places.has(now.length)) return null;
  const accepted = new Map<string, boolean>();
  let at = now.length;
  for (let index = stretches.length - 1; index >= 0; index--) {
    const step = reached[index]?.get(at);
    if (!step) return null;
    const { id } = stretches[index] as { id: string | null };
    if (id !== null && step.accepted !== null) accepted.set(id, step.accepted);
    at = step.from;
  }
  return accepted;
}

/** What writing a paragraph needs of the part it is in. */
export interface ParagraphContext {
  text: string;
  parents: ReadonlyMap<XmlElement, XmlElement>;
  places: Places;
  /** A special's XML, from the native writer. */
  special(inline: Inline): string;
  /** Where an original hyperlink leads, as the import reads it. */
  hrefOf(hyperlink: XmlElement): string | null;
  /** A new hyperlink's start tag. */
  newLink(href: string): string;
  /** The id of the character style links are in, if the document has one. */
  linkStyle: string | null;
  /** The id of that style, added to the document if it hasn't one: for a new link. */
  addLinkStyle(): string;
  /** The ids of tracked changes, and IncarnaMind's review (#107). */
  ids: WordIds;
  review: Review;
  /** Whether an atom the User removed from its paragraph is written there, as removed: it isn't written elsewhere. */
  removedHere(source: string): boolean;
  /** As `DocumentPatchInput.lookCurrent`: if not, text keeps the file's colour, font, size and raise where the Mind has none. */
  lookCurrent: boolean;
}

export interface ParagraphInput {
  /** The paragraph as imported, and its text; none for a new paragraph. */
  base: { element: XmlElement; tokens: Token[] } | null;
  current: Token[];
  /** The paragraph's properties as they are to be written (a whole `w:pPr`, or ""). */
  pPr: string;
  /** Whether `pPr` differs from what the paragraph has. */
  pPrChanged: boolean;
  /** Run properties for text with no character before or after it to take its formatting from. */
  fallbackRun: string;
  /** Where the paragraph is written: the namespaces in scope there. */
  scope: Namespaces;
  /**
   * Whether the User's edits in it are tracked as theirs: not in a paragraph
   * a change still waiting adds, whose words are IncarnaMind's.
   */
  track: boolean;
}

/** A child of the paragraph, or several a field spans, written as one. */
interface Piece {
  from: number;
  to: number;
  /** Indices of the base tokens it holds. */
  tokens: number[];
  /** Its field's runs aren't siblings: it can only be written as it was. */
  frozen: boolean;
  dirty: boolean;
  written: boolean;
}

/** A paragraph's XML; `lost` counts edits next to a field that couldn't be written. */
export function writeParagraph(
  input: ParagraphInput,
  context: ParagraphContext,
): { xml: string; lost: number } {
  const { base, current } = input;
  const { text, parents, places, review } = context;
  const sameAsFile = (was: TextMarks, now: TextMarks) =>
    sameMarks(was, context.lookCurrent ? now : withFileFormat(now, was));
  const element = base?.element ?? null;
  const children = element ? elements(element).filter((each) => each.name !== "w:pPr") : [];
  const childIndex = new Map(children.map((each, index) => [each, index]));
  const scope = element ? scopeOf(element, parents) : input.scope;

  /** The index of the paragraph's child an element is in; -1 outside the paragraph. */
  const segmentOf = (node: XmlElement | undefined): number => {
    for (let at = node; at; at = parents.get(at)) {
      const index = childIndex.get(at);
      if (index !== undefined && parents.get(at) === element) return index;
      if (at === element) return -1;
    }
    return -1;
  };
  /** The elements an atom's source names: one, or a field's first and last run. */
  const elementsOf = (source: string): XmlElement[] =>
    source
      .split("..")
      .map((each) => places.get(each))
      .filter((each): each is XmlElement => each !== undefined);

  const baseList = base?.tokens ?? [];
  const spans = baseList.map((token): [number, number] => {
    if (token.kind === "atom" && token.source) {
      const [first, last = first] = elementsOf(token.source);
      return [segmentOf(first), segmentOf(last)];
    }
    const at = segmentOf(token.run ?? undefined);
    return [at, at];
  });

  // Pieces: the children, those a field spans joined.
  const pieceOf = new Array<Piece | null>(children.length).fill(null);
  const pieces: Piece[] = [];
  for (let index = 0; index < children.length; ) {
    let to = index;
    for (const [from, last] of spans) if (from >= 0 && from <= to && last > to) to = last;
    const piece: Piece = {
      from: index,
      to,
      tokens: [],
      frozen: false,
      dirty: false,
      written: false,
    };
    for (let at = index; at <= to; at++) pieceOf[at] = piece;
    pieces.push(piece);
    index = to + 1;
  }
  baseList.forEach((token, index) => {
    const [from] = spans[index] as [number, number];
    const piece = from >= 0 ? pieceOf[from] : null;
    if (!piece) return;
    piece.tokens.push(index);
    if (token.kind === "atom" && token.source?.includes("..")) {
      const [first, last] = elementsOf(token.source);
      if (first && last && parents.get(first) !== parents.get(last)) piece.frozen = true;
    }
  });
  const pieceOfToken = (index: number) => {
    const from = spans[index]?.[0] ?? -1;
    return from >= 0 ? pieceOf[from] : null;
  };

  // What changed, word by word, as Proposals compare text.
  const aligned = alignTokens(baseList, current);
  /** For each current token, the base token it is (equal), or -1 (new). */
  const baseOf = new Array<number>(current.length).fill(-1);
  /** Each new token's child: that of the base token before it in the comparison, else after. */
  const homeOf = new Array<Piece | null>(current.length).fill(null);
  /** Each character's formatting: its own run's; typed text takes the run of what it replaces, else of the character before it. */
  const formatRun = new Array<XmlElement | null>(current.length).fill(null);
  let lastPiece: Piece | null = null;
  let previousRun: XmlElement | null = null;
  let replacing: XmlElement | null = null;
  const waiting: number[] = [];
  const isText = (token: Token | undefined) => token?.kind === "char" || token?.kind === "break";
  for (const each of aligned) {
    if (each.step === "insert" || each.step === "proposed") {
      const { y } = each;
      homeOf[y] = lastPiece;
      if (!lastPiece) waiting.push(y);
      if (isText(current[y])) {
        formatRun[y] = replacing ?? previousRun;
        previousRun = formatRun[y] ?? previousRun;
      }
      continue;
    }
    const { x } = each;
    const piece = pieceOfToken(x);
    const was = baseList[x] as Token;
    if (each.step === "equal") {
      const { y } = each;
      baseOf[y] = x;
      const now = current[y] as Token;
      if (
        piece &&
        (!samePendings(was.pending, now.pending) ||
          (isText(was) && !sameAsFile(was.marks, now.marks)) ||
          (now.sentence !== undefined && review.choices.commentFailedChecks))
      )
        piece.dirty = true;
      if (isText(was)) {
        formatRun[y] = was.run;
        previousRun = was.run ?? previousRun;
      }
      replacing = null;
    } else {
      if (piece) piece.dirty = true;
      if (isText(was) && replacing === null) replacing = was.run;
    }
    if (piece) {
      for (const at of waiting) homeOf[at] = piece;
      waiting.length = 0;
      lastPiece = piece;
    }
  }
  for (const [index, home] of homeOf.entries()) {
    if (baseOf[index] !== -1 || !home) continue;
    if (home.frozen) homeOf[index] = null;
    else home.dirty = true;
  }
  let following: XmlElement | null = null;
  for (let index = current.length - 1; index >= 0; index--) {
    if (!isText(current[index])) continue;
    if (baseOf[index] !== -1) following = formatRun[index] ?? following;
    formatRun[index] ??= following;
  }

  if (
    base &&
    !input.pPrChanged &&
    aligned.every((each) => each.step === "equal") &&
    pieces.every((piece) => !piece.dirty)
  ) {
    return { xml: sliceOf(text, base.element), lost: 0 };
  }

  const writer = new RunWriter(input, context, scope, element);
  let out = "";
  let lost = 0;
  /** The last child written as it was, so the space between it and the next is kept. */
  let lastVerbatim = -1;
  const verbatim = (piece: Piece) => {
    const from = children[piece.from] as XmlElement;
    const to = children[piece.to] as XmlElement;
    out += writer.flush();
    const gapStart =
      lastVerbatim >= 0 && lastVerbatim === piece.from - 1
        ? endOf(children[lastVerbatim] as XmlElement)
        : startOf(from);
    out += text.slice(gapStart, endOf(to));
    lastVerbatim = piece.to;
    piece.written = true;
  };
  /** Children with nothing the Mind shows (a proofing mark), kept where they were. */
  const passiveBefore = (index: number) => {
    for (const piece of pieces) {
      if (piece.to >= index) break;
      if (!piece.written && piece.tokens.length === 0) verbatim(piece);
    }
  };
  /**
   * The changes still waiting on a token, outermost first, but someone's from
   * the file it still has as it had (`kept`), which stay in the change they are
   * in there. A special's are the native writer's.
   */
  const pendingOf = (token: Token, kept: boolean): Tracking[] => {
    if (token.kind === "special") return [];
    const { inserted, deleted } = token.pending;
    const writes = (pending: Pending | undefined): pending is Pending =>
      pending !== undefined && !(kept && isWordChange(pending));
    return [
      ...(writes(inserted) ? [review.pending("insert", inserted)] : []),
      ...(writes(deleted) ? [review.pending("delete", deleted)] : []),
    ];
  };
  const userInsert = input.track ? review.user("insert") : null;
  const userDelete = input.track ? review.user("delete") : null;

  for (const each of aligned) {
    if (each.step === "delete") {
      // The User's removal, written as theirs when their edits are tracked; someone's change
      // from the file resolved (an insertion rejected, a deletion accepted) leaves no trace.
      const token = baseList[each.x] as Token;
      const piece = pieceOfToken(each.x);
      if (isWordChange(token.pending.inserted) || isWordChange(token.pending.deleted)) continue;
      if (!userDelete || !piece || piece.frozen) continue;
      if (token.kind === "atom" && !(token.source && context.removedHere(token.source))) continue;
      passiveBefore(piece.from);
      lastVerbatim = -1;
      writer.add(token, token.run, [userDelete], null, "own");
      continue;
    }
    const index = each.y;
    const token = current[index] as Token;
    const from = baseOf[index] as number;
    const piece = from >= 0 ? pieceOfToken(from) : homeOf[index];
    if (from >= 0 && !piece) continue; // kept outside the paragraph, where it is
    if (piece && !piece.dirty) {
      if (!piece.written) {
        passiveBefore(piece.from);
        verbatim(piece);
      }
      continue;
    }
    if (piece?.frozen) {
      if (!piece.written) {
        passiveBefore(piece.from);
        verbatim(piece);
      }
      if (from < 0 || !sameAsFile((baseList[from] as Token).marks, token.marks)) lost++;
      continue;
    }
    if (piece) passiveBefore(piece.from);
    lastVerbatim = -1;
    if (each.step === "equal") {
      const was = baseList[from] as Token;
      const reformatted = isText(was) && !sameAsFile(was.marks, token.marks);
      const kept = wordChangesOf(was.pending) === wordChangesOf(token.pending);
      writer.add(
        token,
        formatRun[index] ?? null,
        pendingOf(token, kept),
        reformatted ? userInsert : null,
        kept ? "kept" : "own",
      );
    } else {
      // Text that is still part of someone's insertion is theirs, wherever the comparison puts it.
      const own =
        each.step === "insert" && userInsert && !token.pending.inserted ? [userInsert] : [];
      writer.add(
        token,
        formatRun[index] ?? null,
        [...own, ...pendingOf(token, false)],
        null,
        "borrowed",
      );
    }
  }
  for (const piece of pieces) {
    if (piece.frozen && piece.dirty && !piece.written) {
      // A field joined to text that was all deleted: the field and its text stay.
      verbatim(piece);
      lost += piece.tokens.length;
    }
  }
  out += writer.flush();
  passiveBefore(Number.POSITIVE_INFINITY);
  out += writer.flush();

  const open = element ? openTag(text, element) : "<w:p>";
  return { xml: `${open}${input.pPr}${out}</w:p>`, lost };
}

/**
 * The steps from one paragraph's tokens to another's, comparing text by words
 * (`splitWords`), so a word replaced is replaced whole rather than kept letter
 * by letter where the two happen to share some.
 */
function diffTokens(a: readonly Token[], b: readonly Token[]): ReturnType<typeof diffSteps> {
  const wordsOf = (tokens: readonly Token[]) => {
    const words: { key: string; length: number }[] = [];
    for (let index = 0; index < tokens.length; ) {
      const token = tokens[index] as Token;
      if (token.kind !== "char") {
        words.push({ key: token.key, length: 1 });
        index++;
        continue;
      }
      let end = index;
      let text = "";
      for (; tokens[end]?.kind === "char"; end++) text += (tokens[end] as Token).char;
      for (const word of splitWords(text))
        words.push({ key: word, length: Array.from(word).length });
      index = end;
    }
    return words;
  };
  const left = wordsOf(a);
  const right = wordsOf(b);
  const steps: ReturnType<typeof diffSteps> = [];
  let x = 0;
  let y = 0;
  for (const step of diffSteps(
    left.map((word) => word.key),
    right.map((word) => word.key),
  )) {
    if (step === "equal") {
      for (let at = 0; at < (left[x] as { length: number }).length; at++) steps.push("equal");
      x++;
      y++;
    } else if (step === "delete") {
      for (let at = 0; at < (left[x] as { length: number }).length; at++) steps.push("delete");
      x++;
    } else {
      for (let at = 0; at < (right[y] as { length: number }).length; at++) steps.push("insert");
      y++;
    }
  }
  return steps;
}

/**
 * How text stands to the run it takes its formatting from: the run's own
 * text, with someone's changes around it in the file kept or not, or new text
 * borrowing a neighbour's formatting, without someone's change to it.
 */
type RunUse = "kept" | "own" | "borrowed";

/** Someone's tracked changes around runs in the file: kept only around what they still change. */
const CHANGES = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]);

/**
 * A wrapper open around runs: an original element (a hyperlink, a smart tag,
 * someone's change), a new link, or a tracked change, whose start tag takes
 * an id when opened.
 */
interface Wrapper {
  key: XmlElement | Tracking | string;
  open: string | (() => string);
  close: string;
}

/** Writes tokens as runs, inside the wrappers each needs, joining those that can share a run. */
class RunWriter {
  private out = "";
  private open: Wrapper[] = [];
  /** Someone's changes opened once already: opened again, each takes a new id. */
  private readonly opened = new Set<XmlElement>();
  private run: {
    key: string;
    rPr: string;
    startTag: string;
    content: string;
    text: string;
    deleted: boolean;
  } | null = null;

  private readonly importedMarks = new Map<XmlElement, TextMarks>();

  constructor(
    private readonly input: ParagraphInput,
    private readonly context: ParagraphContext,
    private readonly scope: Namespaces,
    private readonly paragraph: XmlElement | null,
  ) {
    for (const token of input.base?.tokens ?? []) {
      if (token.kind === "char" && token.run && !this.importedMarks.has(token.run)) {
        this.importedMarks.set(token.run, token.marks);
      }
    }
  }

  /** The wrappers around an element, outermost first, up to the paragraph. */
  private wrappersOf(element: XmlElement | null): XmlElement[] {
    const chain: XmlElement[] = [];
    if (!this.paragraph || !element) return chain;
    for (
      let at = this.context.parents.get(element);
      at && at !== this.paragraph;
      at = this.context.parents.get(at)
    ) {
      chain.unshift(at);
    }
    return this.inside(element) ? chain : [];
  }

  private inside(element: XmlElement): boolean {
    for (let at: XmlElement | undefined = element; at; at = this.context.parents.get(at)) {
      if (at === this.paragraph) return true;
    }
    return false;
  }

  private wrapper(element: XmlElement): Wrapper {
    const { text, ids } = this.context;
    if (CHANGES.has(element.name)) {
      const open = () => {
        const tag = openTag(text, element);
        if (!this.opened.has(element)) {
          this.opened.add(element);
          return tag;
        }
        return tag.replace(/\sw:id="[^"]*"/, ` w:id="${ids.take("annotation")}"`);
      };
      return { key: element, open, close: closeTag(element) };
    }
    const properties = elements(element)
      .filter((each) => /Pr$/.test(each.name) && each.name !== "w:rPr")
      .map((each) => sliceOf(text, each))
      .join("");
    return { key: element, open: openTag(text, element) + properties, close: closeTag(element) };
  }

  /** A tracked change around runs, innermost of the wrappers: Word keeps links outside it. */
  private change(tracking: Tracking): Wrapper {
    return {
      key: tracking,
      open: () => changeTag(tracking, this.context.ids),
      close: changeClose(tracking),
    };
  }

  /** Opens and closes wrappers until exactly `wanted` are open. */
  private enter(wanted: Wrapper[]): void {
    let same = 0;
    while (
      same < this.open.length &&
      same < wanted.length &&
      this.open[same]?.key === wanted[same]?.key
    )
      same++;
    if (same === this.open.length && same === wanted.length) return;
    this.endRun();
    for (let at = this.open.length - 1; at >= same; at--) this.out += this.open[at]?.close ?? "";
    for (const wrapper of wanted.slice(same)) {
      this.out += typeof wrapper.open === "string" ? wrapper.open : wrapper.open();
    }
    this.open = wanted;
  }

  private endRun(): void {
    if (!this.run) return;
    const { startTag, rPr, content, text, deleted } = this.run;
    this.out += `${startTag}${rPr}${content}${textElement(text, deleted)}</w:r>`;
    this.run = null;
  }

  /**
   * A token, inside the tracked changes `changes` (outermost first); `formatBy`,
   * when its format changed and the User's edits are tracked, says who changed it.
   */
  add(
    token: Token,
    formatRun: XmlElement | null,
    changes: Tracking[],
    formatBy: Tracking | null,
    use: RunUse,
  ): void {
    const { review, ids } = this.context;
    const before = review.before(token);
    if (before) {
      this.endRun();
      this.out += before;
    }
    if (token.kind === "char" || token.kind === "break")
      this.addText(token, formatRun, changes, formatBy, use);
    else if (token.kind === "atom" && token.source) this.addAtom(token.source, changes);
    else if (token.inline) {
      this.enter([]);
      this.endRun();
      let xml = this.context.special(token.inline);
      for (const tracking of [...changes].reverse()) xml = trackInline(xml, tracking, ids);
      this.out += xml;
    }
    const after = review.after(token);
    if (after) {
      this.endRun();
      this.out += after;
    }
  }

  private addText(
    token: Token,
    formatRun: XmlElement | null,
    changes: Tracking[],
    formatBy: Tracking | null,
    use: RunUse,
  ): void {
    const { text, hrefOf, linkStyle, addLinkStyle, newLink } = this.context;
    const original = this.wrappersOf(formatRun).filter(
      (each) => use === "kept" || !CHANGES.has(each.name),
    );
    const inheritedLink =
      original
        .filter((each) => each.name === "w:hyperlink")
        .map(hrefOf)
        .at(-1) ?? null;
    const around = original.filter(
      (each) => each.name !== "w:hyperlink" || hrefOf(each) === token.marks.link,
    );
    const wanted = around.map((each) => this.wrapper(each));
    const linked = around.some((each) => each.name === "w:hyperlink");
    if (token.marks.link && !linked) {
      wanted.push({
        key: `link:${token.marks.link}`,
        open: newLink(token.marks.link),
        close: "</w:hyperlink>",
      });
    }
    this.enter([...wanted, ...changes.map((each) => this.change(each))]);

    const rPrElement = formatRun
      ? elements(formatRun).find((each) => each.name === "w:rPr")
      : undefined;
    const ownRPr = formatRun
      ? rPrElement
        ? sliceOf(text, rPrElement)
        : ""
      : this.input.fallbackRun;
    const baseRPr = use === "borrowed" ? withoutFormatChange(ownRPr) : ownRPr;
    const linkChanged = token.marks.link !== inheritedLink;
    const style = !linkChanged ? null : token.marks.link ? addLinkStyle() : linkStyle;
    const from = (formatRun ? this.importedMarks.get(formatRun) : undefined) ?? marksOfRun(baseRPr);
    const marks = this.context.lookCurrent ? token.marks : withFileFormat(token.marks, from);
    const rPr = runPropertiesFor(baseRPr, marks, style, from);
    const startTag = formatRun ? openTag(text, formatRun) : "<w:r>";
    const deleted =
      changes.some((each) => each.kind === "delete") ||
      original.some((each) => each.name === "w:del");
    const key = `${startTag}\u0000${rPr}\u0000${deleted}\u0000${formatBy ? baseRPr : ""}`;
    if (this.run?.key !== key) {
      this.endRun();
      this.run = {
        key,
        rPr: formatBy ? this.formatChanged(rPr, baseRPr, formatBy) : rPr,
        startTag,
        content: "",
        text: "",
        deleted,
      };
    }
    const element = elementOf(token);
    if (element === null) {
      this.run.text += token.char;
    } else {
      this.run.content += textElement(this.run.text, deleted) + element;
      this.run.text = "";
    }
  }

  /** Run properties that say what they were before the User changed them (`w:rPrChange`). */
  private formatChanged(rPr: string, was: string, by: Tracking): string {
    const before = Properties.run(was).remove("w:rPrChange").toXml() || "<w:rPr/>";
    const change = `<w:rPrChange w:id="${this.context.ids.take("annotation")}" w:author="${escapeXml(by.author)}"${dateAttribute(by.date)}>${before}</w:rPrChange>`;
    return Properties.run(rPr).set("w:rPrChange", change).toXml();
  }

  private addAtom(source: string, changes: Tracking[]): void {
    const { text, parents, places, ids } = this.context;
    const [first, last] = source.split("..").map((each) => places.get(each));
    if (!first) return;
    if (first.name === "w:sectPr") return; // A section break is written in the paragraph's properties.
    const parent = parents.get(first);
    let xml: string;
    let around: XmlElement | null = first;
    if (last && last !== first) {
      xml = text.slice(startOf(first), endOf(last));
    } else if (parent?.name === "w:r") {
      const rPr = elements(parent).find((each) => each.name === "w:rPr");
      xml = `${openTag(text, parent)}${rPr ? sliceOf(text, rPr) : ""}${sliceOf(text, first)}</w:r>`;
      around = parent;
    } else {
      xml = sliceOf(text, first);
    }
    this.enter(this.wrappersOf(around).map((each) => this.wrapper(each)));
    this.endRun();
    let written = this.inside(first)
      ? xml
      : rescoped(xml, scopeOf(parent ?? first, parents), this.scope);
    for (const tracking of [...changes].reverse()) written = trackInline(written, tracking, ids);
    this.out += written;
  }

  /** What was written since the last flush, every wrapper closed. */
  flush(): string {
    this.enter([]);
    this.endRun();
    const out = this.out;
    this.out = "";
    return out;
  }
}

/** Text as a run's `w:t`, or `w:delText` for deleted text; none for no text. */
const textElement = (text: string, deleted = false) => {
  if (!text) return "";
  const name = deleted ? "w:delText" : "w:t";
  return `<${name} xml:space="preserve">${escapeXml(text)}</${name}>`;
};

/** The element a character is written as, if not as text: a tab, a line break, Word's hyphens. */
function elementOf(token: Token): string | null {
  if (token.kind === "break") return "<w:br/>";
  switch (token.char) {
    case "\t":
      return "<w:tab/>";
    case "‑":
      return "<w:noBreakHyphen/>";
    case "­":
      return "<w:softHyphen/>";
    case "\n":
      return "<w:br/>";
    default:
      return null;
  }
}
