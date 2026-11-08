/**
 * An outside agent's changes to a Note, as Proposals that wait for the User (#352, ADR-0026
 * decision 4a). The agent reads the Note with a name before each paragraph, ¶1 first
 * (`namedNote`), as Edit with AI shows a passage (#2356), and names the paragraph each change
 * is for: one it rewrites or takes out (¶3), or one it adds new paragraphs after (¶3+). Each
 * rewrite is written as Edit with AI writes one, word by word over that paragraph alone, so no
 * paragraph is ever paired with the agent's text by guess. The names hold only for the Note as
 * it was read: `version` changes with any paragraph, and changes named for an older read are
 * refused before anything is written.
 *
 * Only IncarnaMind marks a Citation in the agent's text: a token IncarnaMind minted for this
 * agent becomes one (`cited`), and nothing else does, whatever the agent wrote around a "["
 * (ADR-0026, decision 4). New paragraphs are parsed first, with each token held by characters
 * no parsing makes or takes; only then do those become Citations, and every "[" left in their
 * words outside code gets a word joiner after it, so no later reading joins one to a number
 * split from it by emphasis. A rewrite is read by Edit with AI's own reading, so it is read
 * here first the same way (`markersRead`): a "[" that reads as a marker as written gets a word
 * joiner, and when the reading still finds a marker no token placed (one emphasis joined to a
 * number, "[**1**]"), every "[" gets one. The User's Citations the agent has no token for, and
 * their footnotes, it reads as handles ("[kept:1]", "[note:1]") that keep them where they are,
 * once each. The changes are written as every model's change is (../proposals/apply): tried on
 * a copy of the Note, checked, and refused whole, with the reason, when a part can't be written.
 * Who made them is recorded with them; their text is marked third-party once the User accepts it
 * (`decideProposals`), and read as such while it waits.
 */
import * as Y from "yjs";
import { asGenerated } from "../../shared/aiText";
import { type NodeJSON, replaceMarkers } from "../../shared/blockJson";
import { REFUSAL_WORDS } from "../../shared/changeRefusals";
import { INERT_BRACKET, inertBrackets } from "../../shared/inertBrackets";
import {
  readProposalAttribute,
  readProposalRef,
  targetHash,
  waitingChanges,
} from "../../shared/proposals";
import { INLINE_NODE } from "../../shared/sentences";
import { type ChangedParagraph, sentenceWords, uncitedSpans } from "../../shared/uncitedSentences";
import { createElement } from "../answers/blocks";
import { emphasisOf, markdownToBlocks, withoutEmphasisEscapes } from "../answers/markdown";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  MIND_CONTENT_FIELD,
  type OutsideAgentRequest,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../api";
import { escapeNames, paragraphName, readName, readRemovals, unescapeNames } from "../edits/prompt";
import type { MindContent } from "../mindContent";
import { createChanges, refusalOf, type WriteReport, type Wrote } from "../proposals/apply";
import { citationKey, citingKey, holdsOnlyPlaced, tally, tallyCiting } from "../proposals/placed";
import {
  blockProposal,
  layout,
  proposeRewrite,
  readSelection,
  type Selection,
  textBlocks,
} from "../proposals/write";
import { CITATION_TOKEN } from "./citations";

type Attributes = Record<string, unknown>;

/** A paragraph of a Note as an agent reads it by name. */
export interface NamedParagraph {
  /** "¶3". */
  name: string;
  blockId: string;
  /** Its text as the agent reads it: a kind's marker ("## ", "- "), each Citation as its token. */
  text: string;
  /** Why it can't be changed now: changes wait in it, or an Answer is being written there. */
  held: "waiting" | "busy" | null;
}

export interface NamedNote {
  paragraphs: NamedParagraph[];
  /** The Note as the agent reads it: a paragraph to a line, each after its name. */
  text: string;
  /** Changes whenever a paragraph does: changes are refused against another. */
  version: string;
}

/** How the agent reads what isn't words. */
export interface NamedWords {
  /** A Citation of the Note: its token; null when there is none to give, for a handle. */
  citation(attributes: Attributes): string | null;
  /** Before the words of a paragraph with changes waiting, and of one being written. */
  waiting: string;
  busy: string;
}

/**
 * What keeps the User's own in a paragraph the agent rewrites, as it reads it there: footnote n
 * ("[note:1]"), or Citation n it has no token for ("[kept:1]"). One the User typed is shown
 * escaped ("\\[note:1]") and read back as words.
 */
const HANDLE = /(?<!\\)\[(note|kept):(\d{1,4})\]/g;
const handle = (kind: "note" | "kept", n: number) => `[${kind}:${n}]`;
const escapeHandles = (text: string) => text.replace(/\[(?=(?:note|kept):\d)/g, "\\[");
const unescapeHandles = (text: string) => text.replace(/\\\[(?=(?:note|kept):\d)/g, "[");

/**
 * Words with a word joiner after each "[" that reads as a marker as written ("[1]", "[^1]",
 * "[=1]", "\\[^1]", "[\\^1]"). A "[" before words ("[sic]") stays as it is. One that only
 * parsing joins to a number ("[**1**]") is left to the reading after it (`rewriteText`).
 */
const inertBeforeNumbers = (text: string) => text.replace(/\[(?=\\*[\^=]?\\*\d)/g, INERT_BRACKET);

/** A typed "<removed>" kept as words, unless the agent already wrote it escaped as it was shown. */
const keepRemovedTag = (text: string) => text.replace(/(?<!\\)<(?=\/?removed[\s/>])/gi, "\\<");

/**
 * How Edit with AI's reading finds a marker in a paragraph's plain words (../proposals/write),
 * and a calculated figure's ("[=1]", ADR-0021), which a later reading could take for one.
 */
const MARKER = /\[\^(\d+)\]|\[(\d+)\]|\[=(\d+)\]|\$([^$\n]+)\$|\n/g;

/**
 * The markers a rewrite reads as, as Edit with AI's reading finds them in each paragraph and
 * each line's plain words: what would become a Citation or footnote, or read as a figure.
 */
function markersRead(text: string): string[] {
  const said = readRemovals(text, true).text;
  const found = (part: string) =>
    [...(emphasisOf(part)?.plain ?? withoutEmphasisEscapes(part)).matchAll(MARKER)].flatMap(
      (match) =>
        match[1] !== undefined
          ? [`[^${match[1]}]`]
          : match[2] !== undefined
            ? [`[${match[2]}]`]
            : match[3] !== undefined
              ? [`[=${match[3]}]`]
              : [],
    );
  const byParagraph = said.split(/\n[ \t]*\n+/).flatMap(found);
  const byLine = said.split("\n").flatMap(found);
  return byParagraph.length >= byLine.length ? byParagraph : byLine;
}

/** The same markers, each as often. */
const sameMarkers = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Where a token stands in new paragraphs while they are parsed: characters no parsing makes or takes. */
const HELD_TOKEN = /\uE000(\d{1,4})\uE001/g;
const heldToken = (n: number) => `\uE000${n}\uE001`;
const HOLDING = /[\uE000\uE001]/g;

/** A Block an unaccepted Proposal adds, or one inside it: not in the Note yet. */
function addedByProposal(element: Y.XmlElement): boolean {
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    if (readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "insert") return true;
  }
  return false;
}

const sizeOf = (element: Y.XmlElement) =>
  layout(element).reduce((sum, child) => sum + child.size, 0);

const wholeOf = (element: Y.XmlElement, blockId: string) =>
  ({
    from: { blockId, offset: 0 },
    to: { blockId, offset: sizeOf(element) },
  }) as const;

/** A held paragraph's words as the Note holds them: what its changes would add left out. */
function heldWords(element: Y.XmlElement): string {
  let text = "";
  for (const { node } of layout(element)) {
    if (!(node instanceof Y.XmlText)) continue;
    for (const run of node.toDelta() as { insert: unknown; attributes?: Attributes }[]) {
      if (typeof run.insert === "string" && !(PROPOSAL_INSERT_MARK in (run.attributes ?? {})))
        text += run.insert;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/** The selection's text as the agent reads it: its Citations as tokens or handles, footnotes as handles. */
function shownText(selection: Selection, words: NamedWords): string {
  return escapeHandles(escapeNames(selection.text)).replace(
    /\[\^(\d+)\]|\[(\d+)\]/g,
    (whole, footnote: string | undefined, citation: string | undefined) => {
      if (citation !== undefined) {
        const n = Number(citation);
        const attributes = selection.citations[n - 1];
        return attributes ? (words.citation(attributes) ?? handle("kept", n)) : whole;
      }
      const n = Number(footnote);
      return selection.footnotes[n - 1] ? handle("note", n) : whole;
    },
  );
}

/**
 * The Note's paragraphs and headings by name, at any depth, as `textBlocks` lists them: a
 * table's cells, a list's items and an Answer's paragraphs too. An empty one has no name, nor
 * one a Proposal adds, which isn't in the Note yet.
 */
export function namedNote(blocks: Y.XmlFragment, words: NamedWords): NamedNote {
  const paragraphs: NamedParagraph[] = [];
  const seen = new Set<string>();
  for (const { element } of textBlocks(blocks)) {
    const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (typeof blockId !== "string" || blockId === "" || seen.has(blockId)) continue;
    seen.add(blockId);
    if (addedByProposal(element)) continue;
    const { from, to } = wholeOf(element, blockId);
    const read = readSelection(blocks, from, to);
    const held = read.ok ? null : read.reason === "busy" ? "busy" : "waiting";
    const text = read.ok ? shownText(read.selection, words) : escapeNames(heldWords(element));
    if (text.trim() === "") continue;
    paragraphs.push({ name: paragraphName(paragraphs.length), blockId, text, held });
  }
  const line = (paragraph: NamedParagraph) =>
    paragraph.held === null
      ? `${paragraph.name} ${paragraph.text}`
      : `${paragraph.name} ${paragraph.held === "busy" ? words.busy : words.waiting} ${paragraph.text}`;
  const version = targetHash(
    paragraphs
      .map(
        (paragraph) => `${paragraph.blockId}\u0000${paragraph.held ?? ""}\u0000${paragraph.text}`,
      )
      .join("\u0001"),
  );
  return { paragraphs, text: paragraphs.map(line).join("\n\n"), version };
}

/** One of the agent's changes, by the index of the named paragraph it is for. */
export type NamedChange =
  | { kind: "rewrite"; at: number; text: string }
  | { kind: "remove"; at: number }
  | { kind: "add"; after: number; text: string };

/** A token's Citation, checked again against its Document as it is now. */
export interface CitedToken {
  /** As it was minted: what tells a Citation the paragraph already has. */
  minted: { documentId: string; quote: string; pageFrom: number | null };
  /** As checked now: what a new Citation of it holds. */
  attributes: Attributes;
  /** It may be cited anew; otherwise it only keeps a Citation the paragraph has (own workings). */
  citable: boolean;
}

/**
 * What `proposeNamed` writes with. It writes twice, on a copy and then into the Note, so each
 * callback must give the same answer for the same question both times.
 */
export interface ProposeOptions {
  request: string;
  made: OutsideAgentRequest;
  /** A token's Citation; null for a token that isn't this agent's, or of its Folders. */
  cited(token: string): CitedToken | null;
  /** What a token it can't cite with reads as. */
  notFound: string;
  newId(): string;
}

/** A change that can't be written as it is, in the interface language's words: nothing was written. */
export class ChangeRefused extends Error {
  constructor(
    readonly key:
      | "agents.propose.formula"
      | "agents.propose.lost"
      | (typeof REFUSAL_WORDS)[keyof typeof REFUSAL_WORDS]["agent"],
    readonly paragraph: string,
  ) {
    super(`${paragraph}: ${key}`);
    this.name = "ChangeRefused";
  }
}

/** A paragraph that can't be changed now (`NamedParagraph.held`): nothing was written. */
export class HeldParagraph extends Error {
  constructor(
    readonly paragraph: NamedParagraph,
    readonly held: "waiting" | "busy",
  ) {
    super(`${paragraph.name} can't be changed now.`);
    this.name = "HeldParagraph";
  }
}

/** The agent's text without a name it may have written at its start, as the Note reads one (`readName`). */
function withoutName(written: string): string {
  const { name, rest } = readName(written.trimStart());
  return name && !("unclear" in name) ? rest : written;
}

/** The same Citation: the same quote of the same Document, at the same place. */
const sameCitation = (had: Attributes, minted: CitedToken["minted"]) =>
  had.documentId === minted.documentId &&
  had.quote === minted.quote &&
  (had.pageFrom ?? null) === minted.pageFrom;

/**
 * The agent's new text for one paragraph, for Edit with AI's reading of a reply: a Citation or
 * footnote the paragraph has is its own marker again, once, so it stays as it is; a token it may
 * cite is a marker past the paragraph's, with its checked attributes in `fresh`; anything else
 * is words. Read here first: a marker no token placed falls back to every "[" made inert, and
 * one placed that the reading would lose (between two dollar signs, as a formula) refuses it.
 */
function rewriteText(
  written: string,
  selection: Selection,
  name: string,
  options: ProposeOptions,
): { text: string; fresh: Map<number, Attributes>; kept: string[] } {
  const attempt = (guard: (text: string) => string) => {
    const fresh = new Map<number, Attributes>();
    const placed: string[] = [];
    const used = new Set<string>();
    let next = selection.citations.length;
    const once = (marker: string): string | null => {
      if (used.has(marker)) return null;
      used.add(marker);
      placed.push(marker);
      return marker;
    };
    const marker = (token: string): string => {
      const cited = options.cited(token);
      const own = cited
        ? selection.citations.findIndex((each) => sameCitation(each, cited.minted))
        : -1;
      const kept = own >= 0 ? once(`[${own + 1}]`) : null;
      if (kept) return kept;
      if (!cited?.citable) return inertBrackets(options.notFound);
      next += 1;
      fresh.set(next, cited.attributes);
      placed.push(`[${next}]`);
      return `[${next}]`;
    };
    const words = (part: string, words: (piece: string) => string) => {
      let out = "";
      let at = 0;
      const plain = (piece: string) => words(keepRemovedTag(unescapeHandles(unescapeNames(piece))));
      for (const match of part.matchAll(HANDLE)) {
        out += plain(part.slice(at, match.index));
        const n = Number(match[2]);
        const own =
          match[1] === "note"
            ? selection.footnotes[n - 1] && once(`[^${n}]`)
            : selection.citations[n - 1] && once(`[${n}]`);
        out += own || inertBrackets(match[0]);
        at = match.index + match[0].length;
      }
      return out + plain(part.slice(at));
    };
    // A table's cells name their sources in brackets ("[Tides, p. 3]"): there, every "[" is words.
    const text = withoutName(written)
      .split("\n")
      .map((line) =>
        withTokens(line, (part) => words(part, line.includes("|") ? inertBrackets : guard), marker),
      )
      .join("\n");
    return { text, fresh, placed, kept: [...used] };
  };
  let rewrite = attempt(inertBeforeNumbers);
  if (!sameMarkers(markersRead(rewrite.text), rewrite.placed)) rewrite = attempt(inertBrackets);
  const read = markersRead(rewrite.text);
  if (!rewrite.placed.every((marker) => read.includes(marker))) {
    throw new ChangeRefused("agents.propose.formula", name);
  }
  return { text: rewrite.text, fresh: rewrite.fresh, kept: rewrite.kept };
}

/** `text` with each token as `marker` gives it and the words between as `words` gives them. */
function withTokens(
  text: string,
  words: (part: string) => string,
  marker: (token: string) => string,
): string {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(CITATION_TOKEN)) {
    out += words(text.slice(at, match.index)) + marker(match[1] ?? "");
    at = match.index + match[0].length;
  }
  return out + words(text.slice(at));
}

/**
 * New paragraphs as Blocks: Markdown, parsed with each token held apart, then each token this
 * agent may cite a Citation, and their words AI text with every "[" outside code inert. The
 * parse makes no Citation, footnote or figure of its own; a token's place it left in code is
 * only words.
 */
function newBlocks(
  written: string,
  name: string,
  options: ProposeOptions,
): { nodes: NodeJSON[]; cited: Attributes[] } {
  const tokens: { token: string; attributes: Attributes | null; held: number; back: number }[] = [];
  const held = new Map<string, number>();
  const hold = (token: string): string => {
    const index = held.get(token) ?? tokens.length;
    if (index === tokens.length) {
      const checked = options.cited(token);
      tokens.push({
        token,
        attributes: checked?.citable ? checked.attributes : null,
        held: 0,
        back: 0,
      });
      held.set(token, index);
    }
    const each = tokens[index];
    if (each) each.held += 1;
    return heldToken(index);
  };
  const cameBack = (index: string | undefined) => {
    const each = tokens[Number(index)];
    if (each) each.back += 1;
  };
  const markdown = withTokens(
    withoutName(written),
    (part) => unescapeNames(part).replace(HOLDING, ""),
    hold,
  );
  const cited: Attributes[] = [];
  const parsed = replaceMarkers(markdownToBlocks(markdown), HELD_TOKEN, (match, before) => {
    cameBack(match[1]);
    const attributes = tokens[Number(match[1])]?.attributes;
    if (!attributes) return { before, put: options.notFound };
    cited.push(attributes);
    const node: NodeJSON = {
      type: CITATION_NODE,
      attrs: Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== null)),
    };
    return { before, put: node };
  });
  const asWritten = (text: string) =>
    text.replace(HELD_TOKEN, (_, n: string) => `[cite:${tokens[Number(n)]?.token ?? ""}]`);
  // Code is the agent's code: a "[0]" in it is code, never read as a marker.
  const own = (node: NodeJSON, code = false): NodeJSON[] => {
    if (node.type === "text") {
      const inCode = code || (node.marks?.some((mark) => mark.type === "code") ?? false);
      for (const match of (node.text ?? "").matchAll(HELD_TOKEN)) cameBack(match[1]);
      const text = asWritten(node.text ?? "");
      return [{ ...node, text: inCode ? text : inertBrackets(text) }];
    }
    const inCode = code || node.type === "codeBlock";
    return [
      node.content ? { ...node, content: node.content.flatMap((each) => own(each, inCode)) } : node,
    ];
  };
  const nodes = asGenerated(parsed.flatMap((each) => own(each))).filter(
    (block) => !(block.type === "paragraph" && (block.content?.length ?? 0) === 0),
  );
  // A token the parse took into a formula or a link's address is neither a Citation nor words:
  // it never came back, or its held place is still there.
  const lost =
    tokens.some((each) => each.back !== each.held) || JSON.stringify(nodes).search(HOLDING) >= 0;
  if (lost) throw new ChangeRefused("agents.propose.lost", name);
  return { nodes, cited };
}

/** A whole new Block, or list item, as a Proposal of `request` that adds it. */
function proposedElement(node: NodeJSON, options: ProposeOptions): Y.XmlElement {
  const proposal = blockProposal({ id: options.newId(), request: options.request }, "insert", "");
  return createElement({ ...node, attrs: { ...node.attrs, [PROPOSAL_ATTRIBUTE]: proposal } });
}

/**
 * Puts new Blocks after a paragraph: items of a list of its own kind go into its list, right
 * after its item; anything else goes after the top-level Block it is in.
 */
function addAfter(
  blocks: Y.XmlFragment,
  paragraph: Y.XmlElement,
  nodes: readonly NodeJSON[],
  options: ProposeOptions,
): void {
  const item = paragraph.parent instanceof Y.XmlElement ? paragraph.parent : null;
  const list =
    item?.nodeName === "listItem" && item.parent instanceof Y.XmlElement ? item.parent : null;
  if (item && list && nodes.every((node) => node.type === list.nodeName)) {
    const items = nodes.flatMap((node) =>
      (node.content ?? []).map((each) => proposedElement(each, options)),
    );
    list.insert(list.toArray().indexOf(item) + 1, items);
    return;
  }
  let top: Y.XmlElement = paragraph;
  while (top.parent instanceof Y.XmlElement) top = top.parent;
  blocks.insert(
    blocks.toArray().indexOf(top) + 1,
    nodes.map((node) => proposedElement(node, options)),
  );
}

/**
 * The sentences a request's changes leave with no Citation, as the bar of each of them counts
 * them (`uncitedSpans`): each paragraph they are in, read with them accepted and no other.
 */
function uncitedOf(blocks: Y.XmlFragment, request: string): string[] {
  const found: string[] = [];
  for (const { element } of textBlocks(blocks)) {
    let wholly = false;
    let skipped = false;
    let kind: ChangedParagraph["kind"] = element.nodeName === "heading" ? "heading" : "paragraph";
    for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
      if (at.nodeName === "tableCell" || at.nodeName === "tableHeader") kind = "cell";
      const whole = readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE));
      if (!whole) continue;
      if (whole.kind === "insert" && whole.request === request) wholly = true;
      else if (whole.kind === "insert" || whole.request === request) skipped = true;
    }
    if (skipped) continue;
    let text = "";
    const mine = new Set<number>();
    const cited = new Set<number>();
    for (const { node } of layout(element)) {
      if (node instanceof Y.XmlText) {
        for (const run of node.toDelta() as { insert: unknown; attributes?: Attributes }[]) {
          if (typeof run.insert !== "string") continue;
          const adds = readProposalRef(run.attributes?.[PROPOSAL_INSERT_MARK]);
          const removes = readProposalRef(run.attributes?.[PROPOSAL_DELETE_MARK]);
          if ((adds && adds.request !== request) || removes?.request === request) continue;
          for (const character of run.insert.split("")) {
            if (wholly || adds) mine.add(text.length);
            text += character;
          }
        }
        continue;
      }
      const own = readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE));
      if (own && (own.kind === "insert" ? own.request !== request : own.request === request)) {
        continue;
      }
      if (wholly || own?.kind === "insert") mine.add(text.length);
      if (node.nodeName === CITATION_NODE) cited.add(text.length);
      text += INLINE_NODE;
    }
    const paragraph: ChangedParagraph = { text, mine, cited, kind };
    found.push(...uncitedSpans(paragraph).map((span) => sentenceWords(paragraph, span)));
  }
  return found;
}

/**
 * Writes the agent's changes into the Note as Proposals of `options.request`, waiting for the
 * User, and records who made them. `note` must be the Note as named in this same Yjs
 * transaction. Nothing is written unless every change can be: a paragraph held is refused
 * (`HeldParagraph`), and a change that can't be written as it is (`ChangeRefused`), with the
 * reason the one check gives for any writer (../proposals/apply). Returns how many changes wait,
 * and the sentences they leave uncited.
 */
export function proposeNamed(
  blocks: Y.XmlFragment,
  note: NamedNote,
  changes: readonly NamedChange[],
  options: ProposeOptions,
): { waiting: number; uncited: string[] } {
  const doc = blocks.doc;
  if (!doc || doc.getXmlFragment(MIND_CONTENT_FIELD) !== blocks) {
    throw new Error("The Note's Blocks aren't in its document.");
  }
  // This one Note, already in the caller's transaction: any id names it.
  const notes: Pick<MindContent, "read" | "edit"> = {
    read: (_mindId, look) => look(blocks),
    edit: (_mindId, change) => doc.transact(() => change(blocks)),
  };
  const { createdAt, ...made } = options.made;
  const change = createChanges({ notes, now: () => new Date(createdAt) }).start({
    mindId: doc.guid,
    request: options.request,
    made,
  });
  const outcome = change.write((copy) => writeNamed(copy, note, changes, options));
  switch (outcome.kind) {
    case "written":
      return outcome.value;
    case "unchanged":
      return { waiting: 0, uncited: [] };
    case "changed":
      throw new Error(
        `An outside agent's request ${options.request} would change the User's text.`,
      );
    default:
      throw new ChangeRefused(REFUSAL_WORDS[outcome.kind].agent, outcome.at ?? "");
  }
}

function writeNamed(
  blocks: Y.XmlFragment,
  note: NamedNote,
  changes: readonly NamedChange[],
  options: ProposeOptions,
): Wrote<{ waiting: number; uncited: string[] }> {
  const elements = new Map<string, Y.XmlElement>();
  for (const { element } of textBlocks(blocks)) {
    const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (typeof id === "string" && !elements.has(id)) elements.set(id, element);
  }
  const elementAt = (index: number): { paragraph: NamedParagraph; element: Y.XmlElement } => {
    const paragraph = note.paragraphs[index];
    const element = paragraph ? elements.get(paragraph.blockId) : undefined;
    if (!paragraph || !element) throw new Error(`No paragraph ${index + 1} in the Note as named.`);
    return { paragraph, element };
  };

  const rewrites: {
    element: Y.XmlElement;
    selection: Selection;
    name: string;
    text: string;
    fresh: Map<number, Attributes>;
    kept: string[];
  }[] = [];
  const adds = new Map<number, NodeJSON[]>();
  const citedAnew: Attributes[] = [];
  for (const change of changes) {
    if (change.kind === "add") {
      const added = newBlocks(change.text, `${elementAt(change.after).paragraph.name}+`, options);
      adds.set(change.after, [...(adds.get(change.after) ?? []), ...added.nodes]);
      citedAnew.push(...added.cited);
      continue;
    }
    const { paragraph, element } = elementAt(change.at);
    if (paragraph.held) throw new HeldParagraph(paragraph, paragraph.held);
    const { from, to } = wholeOf(element, paragraph.blockId);
    const read = readSelection(blocks, from, to);
    if (!read.ok) throw new HeldParagraph(paragraph, read.reason === "busy" ? "busy" : "waiting");
    const written =
      change.kind === "remove"
        ? { text: "", fresh: new Map<number, Attributes>(), kept: [] }
        : rewriteText(change.text, read.selection, paragraph.name, options);
    rewrites.push({ element, selection: read.selection, name: paragraph.name, ...written });
  }
  const additions = [...adds.entries()].map(([after, nodes]) => ({ ...elementAt(after), nodes }));

  const placed = tallyCiting(new Map(), blocks, options.request);
  for (const { element, selection, fresh, kept } of rewrites) {
    tallyCiting(placed, element, options.request, -1);
    for (const marker of kept) {
      const n = Number(/\d+/.exec(marker)?.[0]);
      const footnote = marker.startsWith("[^") ? selection.footnotes[n - 1] : undefined;
      const citation = marker.startsWith("[^") ? undefined : selection.citations[n - 1];
      if (footnote) tally(placed, citingKey(footnote), 1);
      if (footnote) tallyCiting(placed, footnote, options.request);
      if (citation) tally(placed, citationKey(citation), 1);
    }
    for (const attributes of fresh.values()) tally(placed, citationKey(attributes), 1);
  }
  for (const attributes of citedAnew) tally(placed, citationKey(attributes), 1);

  const refused = (report: WriteReport) => ({
    changed: false,
    value: { waiting: 0, uncited: [] },
    ...report,
  });
  for (const { selection, name, text, fresh } of rewrites) {
    const written = proposeRewrite(selection, text, options.request, options.newId, fresh);
    if (refusalOf(written)) return refused({ ...written, at: name });
  }
  for (const { element, nodes } of additions) {
    if (nodes.length > 0) addAfter(blocks, element, nodes, options);
  }
  if (!holdsOnlyPlaced(blocks, options.request, placed)) return refused({ notPlaced: true });
  const waiting = waitingChanges(blocks, (each) => each.request === options.request);
  return {
    changed: waiting > 0,
    value: { waiting, uncited: uncitedOf(blocks, options.request) },
  };
}
