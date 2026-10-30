/**
 * What a Word file says for review (#107), for both Word writers: the native
 * one (./docx) and the one that writes back into an imported file
 * (./wordPatch). Changes go in as tracked changes: those still waiting to be
 * accepted by IncarnaMind, and, in a file imported from Word, the User's own
 * edits under their name. IncarnaMind comments on AI text, on Citations
 * whose check failed and on sentences whose check isn't good.
 *
 * A tracked change wraps XML already written: `trackInline` wraps a
 * paragraph's runs in `w:ins` or `w:del`, and `trackBlocks` marks whole
 * paragraphs (their runs and their paragraph mark) and table rows. Deleted
 * text goes into `w:delText`, as Word keeps it. Text inserted (or moved
 * here) and then deleted is `w:del` inside `w:ins` (or `w:moveTo`), as Word
 * writes it.
 */
import { elements, parseXml, type XmlElement } from "../documents/formats/xml";
import type { FailedSentence, Footnote, Pending } from "../mindText";
import type { ExportLabels } from "./labels";
import {
  type CommentStyles,
  comment,
  commentEnd,
  commentStart,
  dateAttribute,
  escapeXml,
  type WordIds,
} from "./wordml";
import { applySplices, closeTag, endOf, type Splice, selfClosing, startOf } from "./wordPatch/text";

/** The author of IncarnaMind's own changes and comments. */
export const INCARNAMIND = "IncarnaMind";

/** A tracked change: what it does, by whom, and when (ISO 8601, or null for no date). */
export interface Tracking {
  kind: "insert" | "delete";
  author: string;
  date: string | null;
}

/** What a Word export was asked to say for review (`ExportMindOptions`). */
export interface ReviewChoices {
  /** The name the User's edits since a Word import go under as tracked changes; null: not tracked. */
  trackAs: string | null;
  markAiText: boolean;
  commentFailedChecks: boolean;
  /** When the file is written, ISO 8601: the date of the User's changes and of comments. */
  now: string;
}

/** A tracked change's mark, as a paragraph mark or a table row carries it. */
function mark(tracking: Tracking, ids: WordIds): string {
  const name = tracking.kind === "insert" ? "w:ins" : "w:del";
  return `<${name} w:id="${ids.take("annotation")}" w:author="${escapeXml(tracking.author)}"${dateAttribute(tracking.date)}/>`;
}

/** A tracked change's start tag, around runs. */
export function changeTag(tracking: Tracking, ids: WordIds): string {
  return mark(tracking, ids).replace(/\/>$/, ">");
}

export const changeClose = (tracking: Tracking): string =>
  tracking.kind === "insert" ? "</w:ins>" : "</w:del>";

/** Elements a tracked change can hold, in a paragraph. */
const RUN_LEVEL = new Set([
  "w:r",
  "w:sdt",
  "w:smartTag",
  "w:customXml",
  "w:dir",
  "w:bdo",
  "m:oMath",
  "m:oMathPara",
]);
/** Elements of a paragraph that hold runs but can't be in a tracked change: it goes inside them. */
const AROUND_RUNS = new Set(["w:hyperlink", "w:fldSimple"]);
/** Someone's tracked insertions, which a deletion goes inside: what was inserted, or moved here. */
const ADDED = new Set(["w:ins", "w:moveTo"]);
/** Someone's tracked deletions, which an insertion holds: what was deleted, or moved away. */
const REMOVED = new Set(["w:del", "w:moveFrom"]);

/**
 * Runs as deleted runs: `w:t` as `w:delText`, a field's code as
 * `w:delInstrText`, in a run or in the runs a content control holds. A text
 * box's, inside a run's drawing, is a story of its own and stays.
 */
function deletedText(text: string, element: XmlElement): string {
  const splices: Splice[] = [];
  const rename = (each: XmlElement, to: string) => {
    const open = startOf(each) + 1;
    splices.push({ from: open, to: open + each.name.length, text: to });
    if (selfClosing(each)) return;
    const close = endOf(each) - closeTag(each).length + 2;
    splices.push({ from: close, to: close + each.name.length, text: to });
  };
  const visit = (node: XmlElement) => {
    if (node.name !== "w:r") {
      for (const each of elements(node)) visit(each);
      return;
    }
    for (const each of elements(node)) {
      if (each.name === "w:t") rename(each, "w:delText");
      else if (each.name === "w:instrText") rename(each, "w:delInstrText");
    }
  };
  visit(element);
  const start = startOf(element);
  return applySplices(
    text.slice(start, endOf(element)),
    splices.map((splice) => ({ ...splice, from: splice.from - start, to: splice.to - start })),
  );
}

/** Runs and what holds them, in `text` from `from` to `to` among `nodes`, wrapped in the change. */
function wrapped(
  text: string,
  nodes: readonly XmlElement[],
  from: number,
  to: number,
  tracking: Tracking,
  ids: WordIds,
): string {
  let out = "";
  let at = from;
  let group = "";
  const flush = () => {
    if (!group) return;
    out += `${changeTag(tracking, ids)}${group}${changeClose(tracking)}`;
    group = "";
  };
  for (const node of nodes) {
    const gap = text.slice(at, startOf(node));
    at = endOf(node);
    const wraps =
      RUN_LEVEL.has(node.name) || (tracking.kind === "insert" && REMOVED.has(node.name));
    if (wraps) {
      group +=
        gap +
        (tracking.kind === "delete"
          ? deletedText(text, node)
          : text.slice(startOf(node), endOf(node)));
      continue;
    }
    flush();
    out += gap;
    const inside =
      AROUND_RUNS.has(node.name) || (tracking.kind === "delete" && ADDED.has(node.name));
    if (inside && !selfClosing(node)) {
      const contentEnd = endOf(node) - closeTag(node).length;
      out +=
        text.slice(startOf(node), node.openEnd ?? startOf(node)) +
        wrapped(text, elements(node), node.openEnd ?? startOf(node), contentEnd, tracking, ids) +
        closeTag(node);
    } else {
      out += text.slice(startOf(node), endOf(node));
    }
  }
  flush();
  return out + text.slice(at, to);
}

/**
 * A paragraph's content (its runs, links, fields…) as a tracked change. Marks
 * between runs (a bookmark, a comment's range) stay as they are; a change
 * already there is kept, and deleting what someone inserted marks it deleted
 * inside their insertion.
 */
export function trackInline(xml: string, tracking: Tracking, ids: WordIds): string {
  if (!xml) return xml;
  const text = `<x>${xml}</x>`;
  const root = parseXml(text);
  return wrapped(text, elements(root), 3, text.length - 4, tracking, ids);
}

/** CT_ParaRPr's tracked changes come first, in this order. */
const MARK_ORDER = ["w:ins", "w:del", "w:moveFrom", "w:moveTo"];

/** Where the paragraph mark's change goes in its run properties, or null if it has it already. */
function markPlace(rPr: XmlElement, tracking: Tracking): number | null {
  const name = tracking.kind === "insert" ? "w:ins" : "w:del";
  const children = elements(rPr);
  if (children.some((each) => each.name === name)) return null;
  const rank = MARK_ORDER.indexOf(name);
  const before = children.find((each) => {
    const other = MARK_ORDER.indexOf(each.name);
    return other < 0 || other > rank;
  });
  return before ? startOf(before) : endOf(rPr) - closeTag(rPr).length;
}

/** The changes that mark a paragraph: its paragraph mark, and its content. */
function paragraphSplices(text: string, p: XmlElement, tracking: Tracking, ids: WordIds): Splice[] {
  if (selfClosing(p)) {
    const open = text.slice(startOf(p), p.openEnd ?? startOf(p)).replace(/\s*\/>$/, ">");
    return [
      {
        from: startOf(p),
        to: endOf(p),
        text: `${open}<w:pPr><w:rPr>${mark(tracking, ids)}</w:rPr></w:pPr></w:p>`,
      },
    ];
  }
  const splices: Splice[] = [];
  const pPr = elements(p).find((each) => each.name === "w:pPr");
  const contentStart = pPr ? endOf(pPr) : (p.openEnd ?? startOf(p));
  const markXml = mark(tracking, ids);
  if (!pPr) {
    splices.push({
      from: contentStart,
      to: contentStart,
      text: `<w:pPr><w:rPr>${markXml}</w:rPr></w:pPr>`,
    });
  } else if (selfClosing(pPr)) {
    splices.push({
      from: startOf(pPr),
      to: endOf(pPr),
      text: `<w:pPr><w:rPr>${markXml}</w:rPr></w:pPr>`,
    });
  } else {
    const rPr = elements(pPr).find((each) => each.name === "w:rPr");
    if (rPr && selfClosing(rPr)) {
      splices.push({ from: startOf(rPr), to: endOf(rPr), text: `<w:rPr>${markXml}</w:rPr>` });
    } else if (rPr) {
      const at = markPlace(rPr, tracking);
      if (at !== null) splices.push({ from: at, to: at, text: markXml });
    } else {
      const after = elements(pPr).find(
        (each) => each.name === "w:sectPr" || each.name === "w:pPrChange",
      );
      const at = after ? startOf(after) : endOf(pPr) - closeTag(pPr).length;
      splices.push({ from: at, to: at, text: `<w:rPr>${markXml}</w:rPr>` });
    }
  }
  const contentEnd = endOf(p) - closeTag(p).length;
  const content = elements(p).filter((each) => each.name !== "w:pPr");
  splices.push({
    from: contentStart,
    to: contentEnd,
    text: wrapped(text, content, contentStart, contentEnd, tracking, ids),
  });
  return splices;
}

/** CT_TrPr's changes come last: an insertion, a deletion, then a change to its properties. */
function rowSplice(tr: XmlElement, tracking: Tracking, ids: WordIds): Splice | null {
  const name = tracking.kind === "insert" ? "w:ins" : "w:del";
  const trPr = elements(tr).find((each) => each.name === "w:trPr");
  if (!trPr) {
    const before = elements(tr).find((each) => each.name === "w:tblPrEx");
    const at = before ? endOf(before) : (tr.openEnd ?? startOf(tr));
    return { from: at, to: at, text: `<w:trPr>${mark(tracking, ids)}</w:trPr>` };
  }
  if (selfClosing(trPr)) {
    return {
      from: startOf(trPr),
      to: endOf(trPr),
      text: `<w:trPr>${mark(tracking, ids)}</w:trPr>`,
    };
  }
  const children = elements(trPr);
  if (children.some((each) => each.name === name)) return null;
  const after = children.find(
    (each) => each.name === "w:trPrChange" || (name === "w:ins" && each.name === "w:del"),
  );
  const at = after ? startOf(after) : endOf(trPr) - closeTag(trPr).length;
  return { from: at, to: at, text: mark(tracking, ids) };
}

/** What holds paragraphs and rows, looked into; a run, holding a text box's, isn't. */
const HOLDS_BLOCKS = new Set(["w:tbl", "w:tc", "w:sdt", "w:sdtContent", "w:customXml"]);

/**
 * Whole Blocks as a tracked change: each paragraph's runs and paragraph mark,
 * and each table row, in paragraphs, tables and content controls.
 */
export function trackBlocks(xml: string, tracking: Tracking, ids: WordIds): string {
  if (!xml) return xml;
  const text = `<x>${xml}</x>`;
  const root = parseXml(text);
  const splices: Splice[] = [];
  const visit = (element: XmlElement) => {
    for (const each of elements(element)) {
      if (each.name === "w:p") splices.push(...paragraphSplices(text, each, tracking, ids));
      else if (each.name === "w:tr") {
        const splice = rowSplice(each, tracking, ids);
        if (splice) splices.push(splice);
        visit(each);
      } else if (HOLDS_BLOCKS.has(each.name)) visit(each);
    }
  };
  visit(root);
  return applySplices(text, splices).slice(3, -4);
}

// ---------------------------------------------------------------------------
// Comments

/** Who wrote a piece of text, for finding the passages of AI text. */
export type Authorship = "ai" | "own" | "neither";

/** A piece of the text a writer writes, in document order, for finding where comments go. */
export interface Piece {
  key: object;
  authorship: Authorship;
  sentence?: FailedSentence | undefined;
}

/** Where IncarnaMind's comments on AI text start and end: at pieces of the text, by identity. */
export interface Passages {
  starts: ReadonlySet<object>;
  ends: ReadonlySet<object>;
}

/**
 * The passages of AI text in some pieces of text, in document order: each from
 * its first piece of AI text to its last, across paragraphs, until the User's
 * own words. Pieces that are neither (a Citation, a space, what a change
 * still waiting adds) don't end one.
 */
export function passagesOf(pieces: Iterable<{ key: object; authorship: Authorship }>): Passages {
  const starts = new Set<object>();
  const ends = new Set<object>();
  let last: object | null = null;
  for (const { key, authorship } of pieces) {
    if (authorship === "ai") {
      if (last === null) starts.add(key);
      last = key;
    } else if (authorship === "own" && last !== null) {
      ends.add(last);
      last = null;
    }
  }
  if (last !== null) ends.add(last);
  return { starts, ends };
}

/** Where IncarnaMind's comments on sentences start and end: at pieces of the text, by identity. */
export interface SentencePassages {
  starts: ReadonlyMap<object, FailedSentence>;
  ends: ReadonlyMap<object, FailedSentence>;
}

/** Each sentence whose check isn't good, from its first piece of text to its last. */
export function sentencePassagesOf(pieces: Iterable<Piece>): SentencePassages {
  const first = new Map<string, { key: object; sentence: FailedSentence }>();
  const last = new Map<string, object>();
  for (const { key, sentence } of pieces) {
    if (!sentence) continue;
    if (!first.has(sentence.id)) first.set(sentence.id, { key, sentence });
    last.set(sentence.id, key);
  }
  return {
    starts: new Map([...first.values()].map(({ key, sentence }) => [key, sentence])),
    ends: new Map(
      [...first.values()].map(({ sentence }) => [last.get(sentence.id) as object, sentence]),
    ),
  };
}

/**
 * IncarnaMind's comments in one Word file, as both writers write them: on AI
 * text's passages, on Citations whose check failed and on sentences whose
 * check isn't good. Their XML for the comments part is in `comments`, in order.
 */
export class Review {
  readonly comments: string[] = [];
  private passages: Passages = { starts: new Set(), ends: new Set() };
  private open: number | null = null;
  private sentences: SentencePassages = { starts: new Map(), ends: new Map() };
  private readonly openSentences = new Map<string, number>();
  private readonly commented = new Map<string, FailedSentence>();
  /** The comments on Citations whose check failed. */
  private failedCitations = 0;
  private readonly trackings = new Map<string, Tracking>();

  constructor(
    readonly choices: ReviewChoices,
    private readonly ids: WordIds,
    private readonly labels: ExportLabels,
    /** The document's comment styles: asked for only once a comment is written. */
    private readonly styles: () => CommentStyles,
  ) {}

  /** Where AI text's passages and the sentences to comment on are, as far as each is asked for. */
  mark(pieces: Iterable<Piece>): void {
    const all = [...pieces];
    if (this.choices.markAiText) this.passages = passagesOf(all);
    if (this.choices.commentFailedChecks) this.sentences = sentencePassagesOf(all);
  }

  /**
   * The tracked change for part of a change still waiting: IncarnaMind's,
   * or, for someone's change from a Word file, theirs (#108). One object for
   * each, so the parts of one next to each other are one change.
   */
  pending(kind: Tracking["kind"], pending: Pending): Tracking {
    const key = `${kind}:${pending.id}`;
    let tracking = this.trackings.get(key);
    if (!tracking) {
      tracking = { kind, author: pending.by ?? INCARNAMIND, date: pending.at };
      this.trackings.set(key, tracking);
    }
    return tracking;
  }

  /** The User's tracked change, when their edits are tracked; one object for each kind. */
  user(kind: Tracking["kind"]): Tracking | null {
    const { trackAs, now } = this.choices;
    if (trackAs === null) return null;
    let tracking = this.trackings.get(kind);
    if (!tracking) {
      tracking = { kind, author: trackAs, date: now };
      this.trackings.set(kind, tracking);
    }
    return tracking;
  }

  /**
   * The part's text with no comment's range left open, of AI text or of a
   * sentence: one whose end wasn't written (it fell where the text couldn't
   * be written again) loses its comment rather than leave Word a range
   * without an end.
   */
  finish(text: string): string {
    const unfinished = [...this.openSentences.values()];
    if (this.open !== null) unfinished.push(this.open);
    this.open = null;
    for (const id of this.openSentences.keys()) this.commented.delete(id);
    this.openSentences.clear();
    let out = text;
    for (const id of unfinished) {
      this.comments.splice(
        this.comments.findIndex((each) => each.startsWith(`<w:comment w:id="${id}"`)),
        1,
      );
      out = out.replace(commentStart(id), "");
    }
    return out;
  }

  commentedSentences(): FailedSentence[] {
    return [...this.commented.values()];
  }

  /** The comments on what needs a look the file holds: on sentences, and on Citations. */
  checkComments(): number {
    return this.commented.size + this.failedCitations;
  }

  private add(text: string): number {
    const id = this.ids.take("annotation");
    this.comments.push(comment(id, INCARNAMIND, this.choices.now, text, this.styles()));
    return id;
  }

  /** What goes before a piece of text: the start of a sentence's comment, and of a passage of AI text's. */
  before(key: object): string {
    let xml = "";
    const sentence = this.sentences.starts.get(key);
    if (sentence) {
      const id = this.add(this.labels.failedSentence(sentence));
      this.openSentences.set(sentence.id, id);
      this.commented.set(sentence.id, sentence);
      xml += commentStart(id);
    }
    if (this.passages.starts.has(key) && this.open === null) {
      this.open = this.add(this.labels.aiText);
      xml += commentStart(this.open);
    }
    return xml;
  }

  /** What goes after a piece of text: the end of the comments it ends, with each one's mark. */
  after(key: object): string {
    let xml = "";
    if (this.passages.ends.has(key) && this.open !== null) {
      xml += commentEnd(this.open, this.styles().reference);
      this.open = null;
    }
    const sentence = this.sentences.ends.get(key);
    const id = sentence && this.openSentences.get(sentence.id);
    if (sentence && id !== undefined) {
      this.openSentences.delete(sentence.id);
      xml += commentEnd(id, this.styles().reference);
    }
    return xml;
  }

  /** A Citation's XML with a comment on it for each of its checks that failed, when asked for. */
  failed(xml: string, footnotes: readonly Footnote[]): string {
    if (!this.choices.commentFailedChecks) return xml;
    const failed = footnotes.filter((each) => each.failed);
    if (failed.length === 0) return xml;
    const text = failed.map((each) => this.labels.failedCheck(each)).join("\n");
    const id = this.add(text);
    this.failedCitations++;
    return `${commentStart(id)}${xml}${commentEnd(id, this.styles().reference)}`;
  }
}
