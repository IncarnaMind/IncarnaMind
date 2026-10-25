import { type Editor, Extension, getTextBetween, getTextSerializersFromSchema } from "@tiptap/core";
import { Fragment, type MarkType, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Selection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitationAttributes,
  type KeptCitationText,
  MIND_PROPOSAL_REQUESTS_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type TextPlace,
  WORD_CHANGE_ID,
} from "../../../core/api";
import { originMaps } from "../../../shared/blockOrigins";
import { citationState } from "../../../shared/citations";
import { type MessageKey, type MessageParams, translate } from "../../../shared/i18n";
import {
  decideProposals,
  INLINE_NODES,
  NODE_CHARACTER,
  proposalRequestOf,
  type ResolvedProposal,
  readProposalAttribute,
  readProposalRef,
  targetHash,
} from "../../../shared/proposals";

/** A Proposal waiting in the Mind, as the editor shows it. */
export interface PendingProposal {
  id: string;
  request: string;
  /** Where it is: from the start of its first part to the end of its last. */
  from: number;
  to: number;
  /**
   * Its parts: runs of the words it removes and adds, and each Block or
   * inline node it removes or adds (`node`).
   */
  ranges: { from: number; to: number; node?: "insert" | "delete" }[];
  /** The text it removes and adds, an inline node as U+FFFC; a whole Block's text for a Block. */
  removed: string;
  added: string;
  /** "insert" or "delete" for a whole Block; null for words in a text. */
  block: "insert" | "delete" | null;
  /** Citations it removes and doesn't add back. */
  droppedCitations: number;
  /** The Citations it adds, to tell whether a Document they cite is gone. */
  citations: Partial<CitationAttributes>[];
  /**
   * The text it changes isn't what it was made for any more
   * (`outOfDateProposals` in src/shared/proposals.ts, read here from the
   * editor's own document): it can't be accepted, only rejected or made again.
   */
  outOfDate: boolean;
  /** Where the Block holding its last part ends: its "Out of date" line goes there. */
  blockEnd: number;
  /** It is someone's change from the Word file the Mind was imported from (#108), not the assistant's. */
  theirs: boolean;
}

interface ReviewState {
  /** Waiting for the User: all but those of requests `applying`. */
  proposals: readonly PendingProposal[];
  /** Requests of edits applying (#880), drawn as the text they make. */
  applying: ReadonlySet<string>;
  /** Every request seen so far: one that comes new and was asked for here is applying from its first frame. */
  known: ReadonlySet<string>;
  applied: readonly PendingProposal[];
  /** The Proposal under the pointer, by id. */
  hovered: string | null;
  /** Text waiting for Edit with AI to come back, or the selection the composer is editing. */
  target: { from: number; to: number } | null;
  decorations: DecorationSet;
}

type Meta =
  | { hovered: string | null }
  | { target: { from: number; to: number } | null }
  | { applying: ReadonlySet<string> };

export const proposalReviewKey = new PluginKey<ReviewState>("proposalReview");

/**
 * How long the pointer rests on another change before the card switches to
 * it: a move from a change onto its card can cross other changes, and taking
 * one over on the way would put the card's Accept on the wrong change.
 */
const HOVER_SWITCH_MS = 250;
const hoverSwitches = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

function clearHoverSwitch(view: EditorView): void {
  const timer = hoverSwitches.get(view);
  if (timer !== undefined) clearTimeout(timer);
  hoverSwitches.delete(view);
}

/** Keeps a card's change while the pointer travels from the change onto the card. */
export function keepShownChange(view: EditorView): void {
  clearHoverSwitch(view);
}

/** The key that tells one Citation from another, to know whether a Proposal adds it back. */
const citationKey = (node: ProseMirrorNode) =>
  `${String(node.attrs.documentId)}\u0000${String(node.attrs.quote)}`;

/** A node's text as a Proposal's target reads it (`targetText` in src/shared/proposals.ts). */
function targetTextOf(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? "";
  if (INLINE_NODES.has(node.type.name)) return NODE_CHARACTER;
  let text = "";
  node.forEach((child) => {
    text += targetTextOf(child);
  });
  return text;
}

/** The end of the Block a position is in: the textblock around it, or the Block that ends there. */
function blockEndAt(doc: ProseMirrorNode, pos: number): number {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  return $pos.parent.isTextblock ? $pos.after() : pos;
}

/**
 * The paragraph or heading a Proposal writes anew, all of its text removed
 * and new text in its place (#1028); null for any other.
 */
export function paragraphWrittenAnew(
  doc: ProseMirrorNode,
  proposal: PendingProposal,
): ProseMirrorNode | null {
  if (proposal.block || proposal.removed.trim() === "" || proposal.added.trim() === "") return null;
  const $from = doc.resolve(proposal.from);
  const covered = proposal.ranges.reduce((sum, range) => sum + range.to - range.from, 0);
  return $from.parent.isTextblock &&
    proposal.from === $from.start() &&
    proposal.to === $from.end() &&
    covered === $from.end() - $from.start()
    ? $from.parent
    : null;
}

/** The Block id of the paragraph a Proposal writes anew, to find it once its old words are gone. */
export function rewrittenParagraphOf(
  doc: ProseMirrorNode,
  proposal: PendingProposal,
): string | null {
  const id: unknown = paragraphWrittenAnew(doc, proposal)?.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
}

/**
 * Every Proposal in the document, in the order they start. A Citation a
 * Proposal removes and doesn't add back counts as dropped; one the same
 * request adds elsewhere (moved) doesn't. One is out of date as the core
 * reads it: the words or Block it removes aren't what it recorded, or aren't
 * in one piece any more.
 */
export function proposalsIn(doc: ProseMirrorNode): readonly PendingProposal[] {
  let proposals = readProposals.get(doc);
  if (!proposals) {
    proposals = readProposalsIn(doc);
    readProposals.set(doc, proposals);
  }
  return proposals;
}

// The review bars and the rewritten-paragraph lines both read each document the User's typing makes.
const readProposals = new WeakMap<ProseMirrorNode, readonly PendingProposal[]>();

function readProposalsIn(doc: ProseMirrorNode): PendingProposal[] {
  const found = new Map<string, PendingProposal>();
  const removedCitations = new Map<string, string[]>();
  const addedCitations = new Map<string, Set<string>>();
  /** Per Proposal: the text it records, the text it removes now, and where each removed part is. */
  const targets = new Map<string, { target: string | null; text: string; parts: number[][] }>();
  const entry = (ref: { id: string; request: string; target?: string }) => {
    let proposal = found.get(ref.id);
    if (!proposal) {
      proposal = {
        id: ref.id,
        request: ref.request,
        from: Number.POSITIVE_INFINITY,
        to: 0,
        ranges: [],
        removed: "",
        added: "",
        block: null,
        droppedCitations: 0,
        citations: [],
        outOfDate: false,
        blockEnd: 0,
        theirs: ref.id.startsWith(WORD_CHANGE_ID),
      };
      found.set(ref.id, proposal);
      targets.set(ref.id, { target: null, text: "", parts: [] });
    }
    const target = targets.get(ref.id);
    if (target && target.target === null && ref.target !== undefined) target.target = ref.target;
    return proposal;
  };
  /** A part of what it removes, in the order met. */
  const removes = (id: string, text: string, from: number, to: number) => {
    const target = targets.get(id);
    if (!target) return;
    target.text += text;
    target.parts.push([from, to]);
  };
  const extend = (
    proposal: PendingProposal,
    from: number,
    to: number,
    node?: "insert" | "delete",
  ) => {
    const last = proposal.ranges.at(-1);
    if (!node && last && !last.node && last.to === from) last.to = to;
    else proposal.ranges.push(node ? { from, to, node } : { from, to });
    proposal.from = Math.min(proposal.from, from);
    proposal.to = Math.max(proposal.to, to);
  };
  const noteCitations = (
    node: ProseMirrorNode,
    request: string,
    kind: "insert" | "delete",
    id: string,
  ) => {
    const each = (citation: ProseMirrorNode) => {
      if (citation.type.name !== CITATION_NODE) return;
      if (kind === "delete") {
        const list = removedCitations.get(id) ?? [];
        list.push(`${request}\u0000${citationKey(citation)}`);
        removedCitations.set(id, list);
      } else {
        const set = addedCitations.get(request) ?? new Set<string>();
        set.add(citationKey(citation));
        addedCitations.set(request, set);
        found.get(id)?.citations.push(citation.attrs as Partial<CitationAttributes>);
      }
    };
    each(node);
    node.descendants((child) => {
      each(child);
    });
  };

  doc.descendants((node, pos) => {
    const attribute = readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]);
    if (attribute) {
      const proposal = entry(attribute);
      extend(proposal, pos, pos + node.nodeSize, attribute.kind);
      // An inline node reads as one character, whatever it holds (a footnote, its text).
      const text = node.isInline
        ? NODE_CHARACTER
        : node.textBetween(0, node.content.size, "\n", NODE_CHARACTER);
      if (attribute.kind === "insert") proposal.added += text;
      else {
        proposal.removed += text;
        removes(attribute.id, targetTextOf(node), pos, pos + node.nodeSize);
      }
      proposal.blockEnd = node.isBlock ? pos + node.nodeSize : blockEndAt(doc, pos);
      if (node.isBlock) proposal.block = attribute.kind;
      noteCitations(node, attribute.request, attribute.kind, attribute.id);
      // A whole Block's words are its own: nothing inside it is another Proposal.
      return false;
    }
    if (!node.isText) return true;
    for (const mark of node.marks) {
      const name = mark.type.name;
      if (name !== PROPOSAL_INSERT_MARK && name !== PROPOSAL_DELETE_MARK) continue;
      const ref = readProposalRef(mark.attrs);
      if (!ref) continue;
      const proposal = entry(ref);
      extend(proposal, pos, pos + node.nodeSize);
      proposal.blockEnd = blockEndAt(doc, pos);
      if (name === PROPOSAL_INSERT_MARK) proposal.added += node.text ?? "";
      else {
        proposal.removed += node.text ?? "";
        removes(ref.id, node.text ?? "", pos, pos + node.nodeSize);
      }
    }
    return false;
  });

  for (const [id, { target, text, parts }] of targets) {
    if (target === null) continue;
    const apart = parts.some((part, index) => index > 0 && part[0] !== parts[index - 1]?.[1]);
    const proposal = found.get(id);
    if (proposal) proposal.outOfDate = apart || targetHash(text) !== target;
  }

  for (const proposal of found.values()) {
    const added = addedCitations.get(proposal.request);
    proposal.droppedCitations = (removedCitations.get(proposal.id) ?? []).filter(
      (key) => !added?.has(key.slice(key.indexOf("\u0000") + 1)),
    ).length;
  }
  return [...found.values()].sort((a, b) => a.from - b.from);
}

/**
 * The Proposals a selection is on: those a selection of text touches (a
 * section of the Mind, as in Word), or the one the cursor is in or beside.
 */
export function proposalsAt(
  proposals: readonly PendingProposal[],
  selection: Pick<Selection, "from" | "to" | "empty">,
): PendingProposal[] {
  return proposals.filter((proposal) =>
    proposal.ranges.some((range) =>
      selection.empty
        ? range.from <= selection.from && selection.from <= range.to
        : range.from < selection.to && selection.from < range.to,
    ),
  );
}

/**
 * How many of the Citations a change adds cite a Document deleted since: it
 * says "Source removed" (the Citations stay, with the quote they keep). None
 * while the Documents load (`documents` null).
 */
export function sourcesRemoved(
  proposal: Pick<PendingProposal, "citations">,
  documents: Parameters<typeof citationState>[1],
  kept: readonly KeptCitationText[] = [],
): number {
  return proposal.citations.filter(
    (citation) => citationState(citation, documents, kept).reason === "document-removed",
  ).length;
}

/**
 * A copied slice as the Mind reads it (#94): words and nodes a Proposal adds
 * left out, those it removes kept as plain text, so a pending change pastes
 * as the text it would replace.
 */
export function acceptedSlice(slice: Slice): Slice {
  const added = (node: ProseMirrorNode | null) =>
    !!node &&
    (readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind === "insert" ||
      node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK));
  const strip = (fragment: Fragment): Fragment => {
    const kept: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      if (added(node)) return;
      if (node.isText) {
        kept.push(node.mark(node.marks.filter((mark) => mark.type.name !== PROPOSAL_DELETE_MARK)));
        return;
      }
      const attrs = readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])
        ? { ...node.attrs, [PROPOSAL_ATTRIBUTE]: null }
        : node.attrs;
      kept.push(node.type.create(attrs, strip(node.content), node.marks));
    });
    return Fragment.from(kept);
  };
  const content = strip(slice.content);
  // An open end that was left out leaves the next node at the edge: open it as far as it goes.
  return added(slice.content.firstChild) || added(slice.content.lastChild)
    ? Slice.maxOpen(content)
    : new Slice(content, slice.openStart, slice.openEnd);
}

/** A place in a paragraph or heading: its id, and how far into its text, an inline node counting as one. */
export interface BlockPlace {
  blockId: string;
  offset: number;
}

const goesOnAccept = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind === "delete" ||
  node.marks.some((mark) => mark.type.name === PROPOSAL_DELETE_MARK);

/**
 * Where a place in a paragraph or heading will be once the changes there are
 * accepted, counted in the text that stays; null when a change removes its
 * Block. Unlike a position in the editor, it holds through the accept, which
 * comes back from Yjs as a new document.
 */
export function placeOnAccept(doc: ProseMirrorNode, place: TextPlace): BlockPlace | null {
  let found: BlockPlace | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    if (node.attrs.id !== place.blockId) return false;
    const $pos = doc.resolve(pos + 1);
    for (let depth = $pos.depth; depth > 0; depth--) {
      if (readProposalAttribute($pos.node(depth).attrs[PROPOSAL_ATTRIBUTE])?.kind === "delete") {
        return false;
      }
    }
    let left = place.offset;
    let offset = 0;
    node.forEach((child) => {
      const part = Math.min(child.isText ? child.nodeSize : 1, Math.max(left, 0));
      if (!goesOnAccept(child)) offset += part;
      left -= part;
    });
    found = { blockId: place.blockId, offset };
    return false;
  });
  return found;
}

/** Where a Block's place is in the editor now; null when the Block is gone. */
export function positionOf(doc: ProseMirrorNode, place: BlockPlace): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;
    if (node.attrs.id !== place.blockId) return false;
    let left = place.offset;
    let at = pos + 1;
    for (let index = 0; index < node.childCount && left > 0; index++) {
      const child = node.child(index);
      const size = child.isText ? child.nodeSize : 1;
      if (child.isText && left <= size) {
        at += left;
        left = 0;
        break;
      }
      left -= size;
      at += child.nodeSize;
    }
    found = at;
    return false;
  });
  return found;
}

/** The Proposals waiting in the editor's Mind. */
export const pendingIn = (state: EditorState): readonly PendingProposal[] =>
  proposalReviewKey.getState(state)?.proposals ?? [];

/** The Proposals the editor's selection is on. */
export const pendingAtSelection = (state: EditorState): PendingProposal[] =>
  proposalsAt(pendingIn(state), state.selection);

/** The Proposal the bar is for: the one under the pointer, else the one the cursor is in. */
export function shownProposal(state: EditorState): PendingProposal | null {
  const review = proposalReviewKey.getState(state);
  if (!review) return null;
  const hovered = review.hovered && review.proposals.find((each) => each.id === review.hovered);
  return hovered || (pendingAtSelection(state)[0] ?? null);
}

/** The text waiting for Edit with AI, or being edited from the composer. */
export const editTarget = (state: EditorState) => proposalReviewKey.getState(state)?.target ?? null;

export function setApplying(editor: Editor, applying: ReadonlySet<string>): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(proposalReviewKey, { applying } satisfies Meta));
}

export const applyingIn = (state: EditorState): ReadonlySet<string> =>
  proposalReviewKey.getState(state)?.applying ?? new Set();

/** Marks text as waiting for Edit with AI, or clears it (null). */
export function setEditTarget(editor: Editor, target: { from: number; to: number } | null): void {
  if (editor.isDestroyed) return;
  editor.commands.command(({ tr }) => {
    tr.setMeta(proposalReviewKey, { target } satisfies Meta);
    return true;
  });
}

/** Whether content a transaction puts in holds a Proposal (all but typing's few characters are looked at). */
function bringsProposals(tr: Transaction): boolean {
  const holds = (node: ProseMirrorNode) =>
    readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]) !== null ||
    node.marks.some(
      (mark) => mark.type.name === PROPOSAL_INSERT_MARK || mark.type.name === PROPOSAL_DELETE_MARK,
    );
  return tr.steps.some((step) => {
    const slice = (step as { slice?: { content: ProseMirrorNode["content"] } }).slice;
    if (!slice) return true;
    let found = false;
    slice.content.descendants((node) => {
      found ||= holds(node);
      return !found;
    });
    return found;
  });
}

/** A change that came from the Mind's document (the core, another window, Undo), not the User typing here. */
export const fromDocument = (tr: Transaction) => !!tr.getMeta(ySyncPluginKey)?.isChangeOrigin;

/**
 * Watches for the User moving the cursor or editing the Mind from now on;
 * changes that come from the Mind's document, as an AI change streaming in
 * does (#202), don't count. `stop` ends the watch.
 */
export function watchMovedOn(editor: Editor): { movedOn(): boolean; stop(): void } {
  let moved = false;
  const look = ({ transaction }: { transaction: Transaction }) => {
    if (!fromDocument(transaction) && (transaction.selectionSet || transaction.docChanged)) {
      moved = true;
    }
  };
  editor.on("transaction", look);
  return { movedOn: () => moved, stop: () => editor.off("transaction", look) };
}

/**
 * The line under a change out of date (DESIGN.md, AI edits): "Out of date ·
 * Regenerate · Reject", its only bar. Its buttons are handled where the Mind
 * is known (`ProposalBars`), by `data-proposal-regenerate` and
 * `data-proposal-reject`.
 */
function outOfDateLine(proposal: PendingProposal, index: number, count: number, t: Translate) {
  return () => {
    const line = document.createElement("div");
    line.className = "proposal-stale-line";
    line.contentEditable = "false";
    line.dataset.testid = "change-out-of-date";
    line.dataset.proposalId = proposal.id;
    line.setAttribute("role", "group");
    line.setAttribute("aria-label", t("proposal.outOfDate.label", { index, count }));
    const label = document.createElement("span");
    label.textContent = t("proposal.outOfDate");
    label.title = t(proposal.theirs ? "proposal.outOfDate.why.theirs" : "proposal.outOfDate.why");
    const dot = () => {
      const each = document.createElement("span");
      each.className = "proposal-dot";
      each.setAttribute("aria-hidden", "true");
      each.textContent = "·";
      return each;
    };
    const regenerate = document.createElement("button");
    regenerate.type = "button";
    regenerate.className = "proposal-action";
    regenerate.dataset.testid = "change-regenerate";
    regenerate.dataset.proposalRegenerate = proposal.id;
    regenerate.textContent = t("proposal.regenerate");
    regenerate.setAttribute("aria-label", t("proposal.regenerate.label", { index }));
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "proposal-action";
    reject.dataset.testid = "change-reject";
    reject.dataset.proposalReject = proposal.id;
    reject.textContent = t("proposal.reject");
    reject.setAttribute("aria-label", t("proposal.reject.label", { index }));
    // Someone's change can't be made again: only rejected, or its text edited by hand.
    if (proposal.theirs) line.append(label, dot(), reject);
    else line.append(label, dot(), regenerate, dot(), reject);
    return line;
  };
}

/** Interface strings, in the window's language (`ProposalReview`'s option). */
type Translate = (key: MessageKey, params?: MessageParams) => string;

function decorationsFor(
  doc: ProseMirrorNode,
  proposals: readonly PendingProposal[],
  applied: readonly PendingProposal[],
  current: string | null,
  target: { from: number; to: number } | null,
  t: Translate,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const range of applied.flatMap((proposal) => proposal.ranges)) {
    decorations.push(
      range.node
        ? Decoration.node(range.from, range.to, {
            class: `proposal-node proposal-node--${range.node} proposal-applying`,
          })
        : Decoration.inline(range.from, range.to, { class: "proposal-applying" }),
    );
  }
  for (const [index, proposal] of proposals.entries()) {
    const stale = proposal.outOfDate ? " proposal-stale" : "";
    for (const range of proposal.ranges) {
      // A node a Proposal adds or removes is drawn like its words (node views draw no marks).
      if (range.node) {
        const theirs = proposal.theirs ? " proposal-theirs" : "";
        decorations.push(
          Decoration.node(range.from, range.to, {
            class: `proposal-node proposal-node--${range.node}${theirs}${stale}${proposal.id === current ? " proposal-current" : ""}`,
            "data-proposal-id": proposal.id,
          }),
        );
      } else if (proposal.id === current || stale) {
        decorations.push(
          Decoration.inline(range.from, range.to, {
            class: `${proposal.id === current ? "proposal-current" : ""}${stale}`.trim(),
          }),
        );
      }
    }
    if (proposal.outOfDate) {
      decorations.push(
        Decoration.widget(
          proposal.blockEnd,
          outOfDateLine(proposal, index + 1, proposals.length, t),
          {
            key: `stale-${proposal.id}-${index}-${proposals.length}`,
            side: 1,
            ignoreSelection: true,
            stopEvent: () => true,
          },
        ),
      );
    }
  }
  if (target && target.from < target.to) {
    decorations.push(Decoration.inline(target.from, target.to, { class: "proposal-target" }));
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** The marks of words the User typed or pasted into a Proposal: their words are their own. */
function proposalMarks(state: EditorState): MarkType[] {
  return [
    state.schema.marks[PROPOSAL_INSERT_MARK],
    state.schema.marks[PROPOSAL_DELETE_MARK],
  ].filter((type): type is MarkType => type !== undefined);
}

/**
 * Proposals waiting in the Mind, reviewed in place: each found from its marks
 * and attributes (`proposalsIn`), the one the cursor is in washed, Blocks
 * and inline nodes a Proposal adds or removes drawn like its words, and the
 * text Edit with AI is working on marked until its Proposals come back.
 * Words the User types into a Proposal are theirs: they carry no Proposal.
 */
export const ProposalReview = Extension.create<{
  translate: Translate;
  /** Whether this window's own Question asked for the request's changes, so they apply as they arrive. */
  asked(state: EditorState, request: string): boolean;
}>({
  name: "proposalReview",

  addOptions() {
    return { translate: (key, params) => translate("en", key, params), asked: () => false };
  },

  addProseMirrorPlugins() {
    const t: Translate = (key, params) => this.options.translate(key, params);
    const { asked } = this.options;
    return [
      new Plugin<ReviewState>({
        key: proposalReviewKey,
        state: {
          init: (_config, state) => {
            const proposals = proposalsIn(state.doc);
            return {
              proposals,
              applying: new Set(),
              known: new Set(proposals.map((each) => each.request)),
              applied: [],
              hovered: null,
              target: null,
              decorations: decorationsFor(
                state.doc,
                proposals,
                [],
                proposalsAt(proposals, state.selection)[0]?.id ?? null,
                null,
                t,
              ),
            };
          },
          apply(tr, value, oldState, state): ReviewState {
            const meta = tr.getMeta(proposalReviewKey) as Meta | undefined;
            let { proposals, applying, applied, hovered, target, known } = value;
            const found =
              tr.docChanged &&
              (proposals.length + applied.length > 0 || fromDocument(tr) || bringsProposals(tr));
            if (meta && "applying" in meta) applying = meta.applying;
            // Typing brings no Proposal, only moves or removes one: a Mind with none stays without.
            if (found || applying !== value.applying) {
              const all = found ? proposalsIn(state.doc) : [...proposals, ...applied];
              // The window hears of a request's Answer a moment after its first change arrives:
              // asking the Mind's own record keeps the bar from showing for those frames.
              const fresh = found
                ? [...new Set(all.map((each) => each.request))].filter(
                    (request) => !known.has(request),
                  )
                : [];
              if (fresh.length > 0) {
                known = new Set([...known, ...fresh]);
                const taken = fresh.filter((request) => asked(state, request));
                if (taken.length > 0) applying = new Set([...applying, ...taken]);
              }
              proposals = all.filter((each) => !applying.has(each.request));
              applied = all.filter((each) => applying.has(each.request));
            }
            if (target && tr.docChanged) {
              const from = tr.mapping.map(target.from, 1);
              const to = tr.mapping.map(target.to, -1);
              target = from < to ? { from, to } : null;
            }
            if (meta && "hovered" in meta) hovered = meta.hovered;
            if (meta && "target" in meta) target = meta.target;
            if (hovered && !proposals.some((each) => each.id === hovered)) hovered = null;
            const current = proposalsAt(proposals, state.selection)[0]?.id ?? null;
            const unchanged =
              proposals === value.proposals &&
              applied === value.applied &&
              target === value.target &&
              current === (proposalsAt(value.proposals, oldState.selection)[0]?.id ?? null);
            return {
              proposals,
              applying,
              known,
              applied,
              hovered,
              target,
              decorations: unchanged
                ? value.decorations.map(tr.mapping, tr.doc)
                : decorationsFor(state.doc, proposals, applied, current, target, t),
            };
          },
        },

        // What the User types or pastes into a Proposal's words is theirs, not the Proposal's.
        appendTransaction(transactions, before, after) {
          const review = proposalReviewKey.getState(before);
          if (!review || review.proposals.length + review.applied.length === 0) return null;
          const typed = transactions.filter((tr) => tr.docChanged && !fromDocument(tr));
          if (typed.length === 0) return null;
          const marks = proposalMarks(after);
          const ranges: { from: number; to: number }[] = [];
          for (const [index, tr] of transactions.entries()) {
            if (!typed.includes(tr)) continue;
            for (const map of tr.mapping.maps) {
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd > newStart) ranges.push({ from: newStart, to: newEnd });
              });
            }
            // Into the last document: through the transactions after this one.
            for (const later of transactions.slice(index + 1)) {
              for (const range of ranges) {
                range.from = later.mapping.map(range.from, 1);
                range.to = later.mapping.map(range.to, -1);
              }
            }
          }
          let tr: Transaction | null = null;
          for (const range of ranges) {
            if (range.from >= range.to) continue;
            for (const type of marks) {
              if (!after.doc.rangeHasMark(range.from, range.to, type)) continue;
              tr ??= after.tr;
              tr.removeMark(range.from, range.to, type);
            }
          }
          return tr;
        },

        props: {
          decorations: (state) => proposalReviewKey.getState(state)?.decorations ?? null,

          // A pending change isn't the Mind's yet: it is copied as the text it would replace.
          transformCopied: (slice, view) =>
            pendingIn(view.state).length > 0 ? acceptedSlice(slice) : slice,

          // Plain text is read from the Mind's selection, not the copied slice (#504).
          clipboardTextSerializer: (slice, view) => {
            if (pendingIn(view.state).length === 0) return "";
            const { schema } = view.state;
            const copied = schema.topNodeType.create(null, slice.content);
            return getTextBetween(
              copied,
              { from: 0, to: copied.content.size },
              { textSerializers: getTextSerializersFromSchema(schema) },
            );
          },

          handleDOMEvents: {
            mouseover(view, event) {
              const target = event.target instanceof Element ? event.target : null;
              const id =
                target?.closest("[data-proposal-id]")?.getAttribute("data-proposal-id") || null;
              const current = proposalReviewKey.getState(view.state)?.hovered ?? null;
              if (!id || id === current) return false;
              clearHoverSwitch(view);
              const show = () => {
                hoverSwitches.delete(view);
                if (view.isDestroyed || id === proposalReviewKey.getState(view.state)?.hovered) {
                  return;
                }
                view.dispatch(
                  view.state.tr.setMeta(proposalReviewKey, { hovered: id } satisfies Meta),
                );
              };
              if (current === null) show();
              else hoverSwitches.set(view, setTimeout(show, HOVER_SWITCH_MS));
              return false;
            },
            mouseout(view, event) {
              const to = event.relatedTarget instanceof Element ? event.relatedTarget : null;
              if (!to?.closest("[data-proposal-id]")) clearHoverSwitch(view);
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** The pointer left the Proposal it was on, for the bar (which keeps it while it is pointed at). */
export function clearHovered(editor: Editor): void {
  if (editor.isDestroyed) return;
  clearHoverSwitch(editor.view);
  if (!proposalReviewKey.getState(editor.state)?.hovered) return;
  editor.commands.command(({ tr }) => {
    tr.setMeta(proposalReviewKey, { hovered: null } satisfies Meta);
    return true;
  });
}

/** The editor's copy of the Mind's Yjs document, and its Blocks, once it is bound. */
const bindingOf = (editor: Editor): { doc: Y.Doc; type: Y.XmlFragment } | undefined =>
  ySyncPluginKey.getState(editor.state)?.binding;

/** The editor's copy of the Mind's Yjs document, or null before it is bound. */
export const editorDoc = (editor: Editor): Y.Doc | null => bindingOf(editor)?.doc ?? null;

/** Who made someone's change from a Word file (#108), and when, as the file says; null for the assistant's. */
export function theirChange(
  editor: Editor,
  proposal: Pick<PendingProposal, "request">,
): { author: string | null; date: string | null } | null {
  const doc = editorDoc(editor);
  const made = doc ? proposalRequestOf(doc, proposal.request) : null;
  return made?.source === "word-change" ? { author: made.author, date: made.date } : null;
}

/** Why the assistant made a change, in the model's few words (#202); null when it didn't say. */
export function changeReason(
  editor: Editor,
  proposal: Pick<PendingProposal, "request">,
): string | null {
  const doc = editorDoc(editor);
  const made = doc ? proposalRequestOf(doc, proposal.request) : null;
  return made?.source === "edit-with-ai" ? (made.reason ?? null) : null;
}

/**
 * Accepts or rejects Proposals in the editor's copy of the Mind, as one step
 * of its Undo (⌘Z takes it back), the same way the core does anywhere
 * (`decideProposals`). The change reaches the core as the User's edits do.
 * `"all"` takes every Proposal the Mind holds when it runs, ones an Undo has
 * just brought back included, rather than a list read earlier, but those an
 * edit is applying and those of the requests `except` names. `alsoRecord`
 * writes more into the Mind in the same step, with what was resolved.
 */
export function resolveInEditor(
  editor: Editor,
  ids: ReadonlySet<string> | "all",
  outcome: "accept" | "reject",
  except: ReadonlySet<string> = new Set(),
  alsoRecord?: (doc: Y.Doc, resolved: readonly ResolvedProposal[]) => void,
): ResolvedProposal[] {
  const binding = bindingOf(editor);
  if (!binding || (ids !== "all" && ids.size === 0)) return [];
  const undo: Y.UndoManager | undefined = yUndoPluginKey.getState(editor.state)?.undoManager;
  // The counts of what was decided (`decideProposals`) go back with the Blocks, and so do the
  // origins a reject gives back (`restoreOrigins`).
  undo?.addToScope([binding.doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD), ...originMaps(binding.doc)]);
  undo?.stopCapturing();
  let resolved: ResolvedProposal[] = [];
  const applying = applyingIn(editor.state);
  // As the editor's own change, so its Undo takes it back.
  binding.doc.transact(() => {
    resolved = decideProposals(
      binding.type,
      (proposal) =>
        ids === "all"
          ? !applying.has(proposal.request) && !except.has(proposal.request)
          : ids.has(proposal.id),
      outcome,
    );
    alsoRecord?.(binding.doc, resolved);
  }, ySyncPluginKey);
  undo?.stopCapturing();
  return resolved;
}
