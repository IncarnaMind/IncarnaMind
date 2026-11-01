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
 * split from it by emphasis. A rewrite is read by Edit with AI's own
 * reading, so it is read here first the same way (`markersRead`): every "[" that its parsing
 * could join to a number gets a word joiner before it is read, and only when the reading finds
 * no marker but those placed for tokens is it written; otherwise every "[" gets one. The User's
 * Citations the agent has no token for, and their footnotes, it reads as handles
 * ("[kept:1]", "[note:1]") that keep them where they are, once each. Who made the changes is
 * recorded with them; their text is marked third-party once the User accepts it
 * (`decideProposals`), and read as such while it waits.
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { asGenerated } from "../../shared/aiText";
import { type NodeJSON, replaceMarkers } from "../../shared/blockJson";
import {
  readProposalAttribute,
  recordProposalRequest,
  resolveProposals,
  targetHash,
  waitingChanges,
} from "../../shared/proposals";
import { createElement } from "../answers/blocks";
import { emphasisOf, markdownToBlocks, withoutEmphasisEscapes } from "../answers/markdown";
import {
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  type OutsideAgentRequest,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
  type ProposalAttribute,
} from "../api";
import { readRemovals } from "../edits/prompt";
import {
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

/** A paragraph's name, by its place: ¶1 is the first. */
const paragraphName = (index: number) => `¶${index + 1}`;

/** Every ¶ in the User's words escaped, so it never reads as a name. */
const escapeNames = (text: string) => text.replace(/¶/g, "\\¶");
const unescapeNames = (text: string) => text.replace(/\\¶/g, "¶");

const WORD_JOINER = "\u2060";

/** Words with a word joiner after every "[": no parsing takes it out, so no marker forms there. */
const inert = (text: string) => text.replaceAll("[", `[${WORD_JOINER}`);

/**
 * Words with a word joiner after each "[" that Edit with AI's reading could join to a number
 * ("[1]", "[^1]", "[=1]"), through the emphasis and escapes it takes out ("[**1**]", "[_^1_]",
 * "\\[^1]"). A "[" before words ("[sic]") stays as it is.
 */
const inertBeforeNumbers = (text: string) =>
  text.replace(/\[(?=[\\*_~]*[\^=]?[\\*_~]*\d)/g, `[${WORD_JOINER}`);

/** A typed "<removed>" kept as words, unless the agent already wrote it escaped as it was shown. */
const keepRemovedTag = (text: string) => text.replace(/(?<!\\)<(?=\/?removed[\s/>])/gi, "\\<");

/** How Edit with AI's reading finds a marker in a paragraph's plain words (../proposals/write). */
const MARKER = /\[\^(\d+)\]|\[(\d+)\]|\$([^$\n]+)\$|\n/g;

/**
 * The Citation and footnote markers a rewrite reads as, as Edit with AI's reading finds them in
 * each paragraph and each line's plain words: what would become a Citation or footnote.
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

/** Inline nodes that cite or stand for a cited figure: only IncarnaMind's own may be in new text. */
const CITING: ReadonlySet<string> = new Set([CITATION_NODE, FOOTNOTE_NODE, CALCULATED_FIGURE_NODE]);

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
  const version = createHash("sha256")
    .update(
      paragraphs
        .map(
          (paragraph) => `${paragraph.blockId}\u0000${paragraph.held ?? ""}\u0000${paragraph.text}`,
        )
        .join("\u0001"),
    )
    .digest("base64url")
    .slice(0, 16);
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
    readonly key: "agents.propose.formula" | "agents.propose.table" | "agents.propose.unread",
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

/** A name the agent may have written at the start of its own text, as the Note reads. */
const LEADING_NAME = /^\s*¶(?:\d+\+?|\+)\s+/;

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
): { text: string; fresh: Map<number, Attributes> } {
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
      if (!cited?.citable) return inert(options.notFound);
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
        out += own || inert(match[0]);
        at = match.index + match[0].length;
      }
      return out + plain(part.slice(at));
    };
    // A table's cells name their sources in brackets ("[Tides, p. 3]"): there, every "[" is words.
    const text = written
      .replace(LEADING_NAME, "")
      .split("\n")
      .map((line) =>
        withTokens(line, (part) => words(part, line.includes("|") ? inert : guard), marker),
      )
      .join("\n");
    return { text, fresh, placed };
  };
  let rewrite = attempt(inertBeforeNumbers);
  if (!sameMarkers(markersRead(rewrite.text), rewrite.placed)) rewrite = attempt(inert);
  const read = markersRead(rewrite.text);
  if (!rewrite.placed.every((marker) => read.includes(marker))) {
    throw new ChangeRefused("agents.propose.formula", name);
  }
  if (!sameMarkers(read, rewrite.placed)) throw new ChangeRefused("agents.propose.unread", name);
  return { text: rewrite.text, fresh: rewrite.fresh };
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
 * agent may cite a Citation, and their words AI text with every "[" outside code inert. A citing
 * node the parse made itself, and a token's place parsing left in code, are only words.
 */
function newBlocks(written: string, options: ProposeOptions): NodeJSON[] {
  const tokens: { token: string; attributes: Attributes | null }[] = [];
  const held = new Map<string, string>();
  const hold = (token: string): string => {
    const known = held.get(token);
    if (known) return known;
    const found = options.cited(token);
    const place = heldToken(tokens.length);
    tokens.push({ token, attributes: found?.citable ? found.attributes : null });
    held.set(token, place);
    return place;
  };
  const markdown = withTokens(
    written.replace(LEADING_NAME, ""),
    (part) => unescapeNames(part).replace(HOLDING, ""),
    hold,
  );
  const placed = new Set<NodeJSON>();
  const cited = replaceMarkers(markdownToBlocks(markdown), HELD_TOKEN, (match, before) => {
    const attributes = tokens[Number(match[1])]?.attributes;
    if (!attributes) return { before, put: options.notFound };
    const node: NodeJSON = {
      type: CITATION_NODE,
      attrs: Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== null)),
    };
    placed.add(node);
    return { before, put: node };
  });
  const asWritten = (text: string) =>
    text.replace(HELD_TOKEN, (_, n: string) => `[cite:${tokens[Number(n)]?.token ?? ""}]`);
  // Code is the agent's code: a "[0]" in it is code, never read as a marker.
  const own = (node: NodeJSON, code = false): NodeJSON[] => {
    if (CITING.has(node.type) && !placed.has(node)) return [];
    if (node.type === "text") {
      const inCode = code || (node.marks?.some((mark) => mark.type === "code") ?? false);
      const text = asWritten(node.text ?? "");
      return [{ ...node, text: inCode ? text : inert(text) }];
    }
    const inCode = code || node.type === "codeBlock";
    return [
      node.content ? { ...node, content: node.content.flatMap((each) => own(each, inCode)) } : node,
    ];
  };
  return asGenerated(cited.flatMap((each) => own(each))).filter(
    (block) => !(block.type === "paragraph" && (block.content?.length ?? 0) === 0),
  );
}

/** A whole new Block, or list item, as a Proposal of `request` that adds it. */
function proposedElement(node: NodeJSON, options: ProposeOptions): Y.XmlElement {
  const proposal: ProposalAttribute = {
    id: options.newId(),
    request: options.request,
    target: targetHash(""),
    kind: "insert",
  };
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
 * Writes the agent's changes into the Note as Proposals of `options.request`, waiting for the
 * User, and records who made them. `note` must be the Note
 * as named in this same Yjs transaction. Nothing is written unless every change can be: a
 * paragraph held is refused (`HeldParagraph`). Returns how many changes wait.
 */
export function proposeNamed(
  blocks: Y.XmlFragment,
  note: NamedNote,
  changes: readonly NamedChange[],
  options: ProposeOptions,
): number {
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

  // Everything is read and turned into what it writes first: a refusal leaves the Note as it was.
  const rewrites: {
    selection: Selection;
    name: string;
    text: string;
    fresh: Map<number, Attributes>;
  }[] = [];
  const adds = new Map<number, NodeJSON[]>();
  for (const change of changes) {
    if (change.kind === "add") {
      adds.set(change.after, [
        ...(adds.get(change.after) ?? []),
        ...newBlocks(change.text, options),
      ]);
      continue;
    }
    const { paragraph, element } = elementAt(change.at);
    if (paragraph.held) throw new HeldParagraph(paragraph, paragraph.held);
    const { from, to } = wholeOf(element, paragraph.blockId);
    const read = readSelection(blocks, from, to);
    if (!read.ok) throw new HeldParagraph(paragraph, read.reason === "busy" ? "busy" : "waiting");
    const written =
      change.kind === "remove"
        ? { text: "", fresh: new Map<number, Attributes>() }
        : rewriteText(change.text, read.selection, paragraph.name, options);
    rewrites.push({ selection: read.selection, name: paragraph.name, ...written });
  }
  const placed = [...adds.entries()].map(([after, nodes]) => ({ ...elementAt(after), nodes }));

  for (const { selection, name, text, fresh } of rewrites) {
    const written = proposeRewrite(selection, text, options.request, options.newId, fresh);
    if (written.unmadeTable || (written.unplaced?.length ?? 0) > 0) {
      // What it wrote of the changes before goes too: all of them, or none.
      resolveProposals(blocks, (each) => each.request === options.request, "reject");
      throw new ChangeRefused("agents.propose.table", name);
    }
  }
  for (const { element, nodes } of placed) {
    if (nodes.length > 0) addAfter(blocks, element, nodes, options);
  }
  const doc = blocks.doc;
  const count = waitingChanges(blocks, (each) => each.request === options.request);
  if (doc && count > 0) recordProposalRequest(doc, options.request, options.made);
  return count;
}
