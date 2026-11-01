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
 * The agent's text is third-party text, and only IncarnaMind marks a Citation in it: a token
 * IncarnaMind minted for this agent becomes one (`cited`), and every "[" that could start one
 * of IncarnaMind's own markers gets a word joiner after it, so a `[^1]`, `[1]` or `[=1]` the
 * agent wrote stays words.
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { asGenerated } from "../../shared/aiText";
import { type NodeJSON, withCitations } from "../../shared/blockJson";
import {
  readProposalAttribute,
  recordProposalRequest,
  targetHash,
  waitingChanges,
} from "../../shared/proposals";
import { setTextOrigin } from "../../shared/textOrigins";
import { createElement } from "../answers/blocks";
import { escapeRemovedMark, markdownToBlocks } from "../answers/markdown";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type OutsideAgentRequest,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
  type ProposalAttribute,
} from "../api";
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
  /** A Citation of the Note: its token, or words when there is none to give. */
  citation(attributes: Attributes): string;
  /** Before the words of a paragraph with changes waiting, and of one being written. */
  waiting: string;
  busy: string;
}

/** A footnote the User wrote in a paragraph, as the agent reads it there: "[note:1]". */
const NOTE_HANDLE = /\[note:(\d{1,4})\]/g;
const noteHandle = (n: number) => `[note:${n}]`;

/** A paragraph's name, by its place: ¶1 is the first. */
const paragraphName = (index: number) => `¶${index + 1}`;

/** Every ¶ in the User's words escaped, so it never reads as a name. */
const escapeNames = (text: string) => text.replace(/¶/g, "\\¶");
const unescapeNames = (text: string) => text.replace(/\\¶/g, "¶");

const WORD_JOINER = "\u2060";

/**
 * The agent's words with a word joiner after each "[" that could start one of IncarnaMind's
 * markers ("[^1]", "[1]", "[=1]"), however escaped: no parsing takes it out, so no marker
 * forms from them (ADR-0026, decision 4).
 */
const inert = (text: string) => text.replace(/\[(?=\\*[\^=\d])/g, `[${WORD_JOINER}`);

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

/** The selection's text as the agent reads it: its markers as tokens and footnote handles. */
function shownText(selection: Selection, words: NamedWords): string {
  return escapeNames(selection.text).replace(
    /\[\^(\d+)\]|\[(\d+)\]/g,
    (whole, footnote: string | undefined, citation: string | undefined) => {
      if (citation !== undefined) {
        const attributes = selection.citations[Number(citation) - 1];
        return attributes ? words.citation(attributes) : whole;
      }
      return selection.footnotes[Number(footnote) - 1] ? noteHandle(Number(footnote)) : whole;
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
 * The agent's new text for one paragraph, as Edit with AI's reading of a reply takes it: a
 * Citation the paragraph has is its own marker again, so it stays as it is; a new one is a
 * marker past the paragraph's, with its checked attributes in `fresh`; a footnote handle of the
 * paragraph's is its footnote's marker.
 */
function rewriteText(
  written: string,
  selection: Selection,
  options: ProposeOptions,
): { text: string; fresh: Map<number, Attributes> } {
  const fresh = new Map<number, Attributes>();
  const markers = new Map<string, string>();
  let next = selection.citations.length;
  const marker = (token: string): string => {
    const known = markers.get(token);
    if (known) return known;
    const cited = options.cited(token);
    const own = cited
      ? selection.citations.findIndex((each) => sameCitation(each, cited.minted))
      : -1;
    let shown = inert(options.notFound);
    if (own >= 0) {
      shown = `[${own + 1}]`;
    } else if (cited?.citable) {
      next += 1;
      fresh.set(next, cited.attributes);
      shown = `[${next}]`;
    }
    markers.set(token, shown);
    return shown;
  };
  const words = (part: string) =>
    part
      .split(NOTE_HANDLE)
      .map((piece, index) => {
        if (index % 2 === 0) return inert(escapeRemovedMark(unescapeNames(piece)));
        const n = Number(piece);
        return selection.footnotes[n - 1] ? `[^${n}]` : inert(noteHandle(n));
      })
      .join("");
  return { text: withTokens(written.replace(LEADING_NAME, ""), words, marker), fresh };
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
    out += words(text.slice(at, match.index)) + marker(match[1] as string);
    at = match.index + match[0].length;
  }
  return out + words(text.slice(at));
}

/** New paragraphs as Blocks: Markdown, their tokens as Citations, their words AI text. */
function newBlocks(written: string, options: ProposeOptions): NodeJSON[] {
  const cited: Attributes[] = [];
  const markers = new Map<string, string>();
  const marker = (token: string): string => {
    const known = markers.get(token);
    if (known) return known;
    const found = options.cited(token);
    let shown = inert(options.notFound);
    if (found?.citable) {
      cited.push(found.attributes);
      shown = `[^${cited.length}]`;
    }
    markers.set(token, shown);
    return shown;
  };
  const markdown = withTokens(
    written.replace(LEADING_NAME, ""),
    (part) => inert(unescapeNames(part)),
    marker,
  );
  const blocks = withCitations(markdownToBlocks(markdown), (n) => {
    const attributes = cited[n - 1];
    return attributes
      ? {
          type: CITATION_NODE,
          attrs: Object.fromEntries(
            Object.entries(attributes).filter(([, value]) => value !== null),
          ),
        }
      : null;
  });
  return asGenerated(blocks).filter(
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
 * after its item; anything else goes after the top-level Block it is in. Returns their ids.
 */
function addAfter(
  blocks: Y.XmlFragment,
  paragraph: Y.XmlElement,
  nodes: readonly NodeJSON[],
  options: ProposeOptions,
): string[] {
  const item = paragraph.parent instanceof Y.XmlElement ? paragraph.parent : null;
  const list =
    item?.nodeName === "listItem" && item.parent instanceof Y.XmlElement ? item.parent : null;
  let elements: Y.XmlElement[];
  if (item && list && nodes.every((node) => node.type === list.nodeName)) {
    elements = nodes.flatMap((node) =>
      (node.content ?? []).map((each) => proposedElement(each, options)),
    );
    list.insert(list.toArray().indexOf(item) + 1, elements);
  } else {
    let top: Y.XmlElement = paragraph;
    while (top.parent instanceof Y.XmlElement) top = top.parent;
    elements = nodes.map((node) => proposedElement(node, options));
    blocks.insert(blocks.toArray().indexOf(top) + 1, elements);
  }
  return elements.flatMap(idsIn);
}

/** The Block ids in an element, its own first, at any depth. */
function idsIn(element: Y.XmlElement): string[] {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  return [
    ...(typeof id === "string" ? [id] : []),
    ...element.toArray().flatMap((child) => (child instanceof Y.XmlElement ? idsIn(child) : [])),
  ];
}

/**
 * Writes the agent's changes into the Note as Proposals of `options.request`, waiting for the
 * User, and records who made them and that their text is third-party. `note` must be the Note
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
  const rewrites: { selection: Selection; text: string; fresh: Map<number, Attributes> }[] = [];
  const adds = new Map<number, NodeJSON[]>();
  const touched: string[] = [];
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
        : rewriteText(change.text, read.selection, options);
    rewrites.push({ selection: read.selection, ...written });
    touched.push(paragraph.blockId);
  }
  const placed = [...adds.entries()].map(([after, nodes]) => ({ ...elementAt(after), nodes }));

  for (const { selection, text, fresh } of rewrites) {
    proposeRewrite(selection, text, options.request, options.newId, fresh);
  }
  for (const { element, nodes } of placed) {
    if (nodes.length > 0) touched.push(...addAfter(blocks, element, nodes, options));
  }
  const doc = blocks.doc;
  const count = waitingChanges(blocks, (each) => each.request === options.request);
  if (doc && count > 0) {
    recordProposalRequest(doc, options.request, options.made);
    setTextOrigin(doc, touched, "outside-agent");
  }
  return count;
}
