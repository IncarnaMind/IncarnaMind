/**
 * The lines over an edit the User asked for (#880; DESIGN.md, AI edits),
 * drawn in the text above the Block they are about. ProposalBars handles
 * their buttons, by `data-applied-action`. They go once the User edits.
 */
import { type Editor, Extension } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE, type EditPart, type RemovedParagraphs } from "../../../core/api";
import type { Language } from "../../../core/language";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { addsOnly, type ChangeKind, countChanged, onlyRemoves } from "../../../shared/proposals";
import { paragraphStart, paragraphsRemoved } from "../../../shared/sentenceChanges";
import {
  type ChangeCounts,
  changeFact,
  type NamedChange,
  namedFact,
  removedFact,
} from "../changeFacts";
import { iconMarkup } from "../components/icons";
import type { EstimateLine } from "../cost";
import { anchorOf } from "./arrivedChanges";
import { type LineSight, lineSight } from "./lineSight";
import { fromDocument, proposalsIn } from "./proposalReview";
import { blockAt } from "./writingPlace";

export const APPLIED_ACTIONS = ["undo", "apply", "discard", "remove-kept"] as const;
export type AppliedAction = (typeof APPLIED_ACTIONS)[number];

export const isAppliedAction = (value: string): value is AppliedAction =>
  (APPLIED_ACTIONS as readonly string[]).includes(value);

export interface KeptLine {
  blockId: string;
  count: number;
  /** Of more than one kind: named Blocks, not paragraphs. */
  mixed: boolean;
}

/** Where one change an applied edit made is: its new words, as Yjs positions that hold through edits, and the old ones it took out. */
export interface ChangePlace {
  from: unknown;
  to: unknown;
  removed: Fragment;
  /** Whole Blocks, added or taken out; `to` of added ones is just inside the last one's end. */
  block: "added" | "removed" | null;
  /**
   * The paragraph it wrote anew, by Block id (#1028): its place is all that
   * paragraph's text, as the positions before its old words went with them.
   */
  paragraph?: string;
  /**
   * How many characters it wrote, for a change inside a paragraph: 0 for one
   * that only took words out. y-tiptap gives no position at 1 or less, so a
   * change at the Note's first Block has no start of its own; its end and this
   * say where its words begin (#1411).
   */
  writtenSize?: number;
}

/** One change an applied edit made, and what it wrote, to find it again where the User has since typed. */
export interface AppliedChange extends ChangePlace {
  written: Fragment;
  /** The Block its new words are in, where they are found again (`changeNow`). */
  blockId: string | null;
  /** Its first new word's or Block's own Yjs item; null for one that only took words out. */
  start: unknown;
  /** Words it only took out: the text either side of where they were, up to the next change in its Block. */
  around?: { before: string; after: string };
}

export type AppliedLine = (
  | {
      kind: "applied";
      /** Null at the Mind's end. */
      blockId: string | null;
      /** What it changed, added or removed. */
      blocks: ChangedBlocks;
      /** What the assistant was asked for, as its Answer counts it (#880): "Wrote 3 paragraphs". */
      facts?: ChangeCounts;
      reason: string | null;
      kept: KeptLine | null;
      /** The parts a selection too long for the model was edited in (#2348). Absent: one. */
      parts?: number;
      /** The turn whose changes these are, an Answer or a request at the Note's foot. */
      turn?: string;
    }
  | {
      kind: "held";
      blockId: string | null;
      request: string;
      /** Asked of the assistant: all of its requests in the Mind, held as they would rewrite most of the User's text. */
      asked?: { mindId: string; requests: readonly string[]; facts: ChangeCounts };
    }
  // An edit too long for one request, on a model billed per token, waits for the User here (#2348).
  | {
      kind: "ask";
      blockId: string | null;
      parts: number;
      /** What the run would cost, shown, never asked about (#83). */
      estimate: EstimateLine | null;
      start(): void;
      cancel(): void;
    }
  // An edit asked in the selection menu, once the menu is closed: it holds the spot its Undo line lands in.
  | {
      kind: "running";
      blockId: string | null;
      stop(): void;
      /** Another change was asked while this one runs: the line says one at a time (#2123). */
      busy?: true;
      /** A selection too long for the model is edited in parts: which of how many (#2348). */
      part?: EditPart;
      /** What a run on a cloud model is about to cost, when the model's price is known (#83). */
      estimate?: EstimateLine | null;
    }
  | {
      kind: "failed";
      blockId: string | null;
      text: string;
      action: { label: string; run(): void } | null;
      close(): void;
      /** Not a failure: what became of words handed to the User's own AI (#3612). */
      asked?: true;
    }
) & {
  /** The language it was last drawn in, once that changed. */
  language?: Language;
};

const LINE_KINDS: ReadonlySet<unknown> = new Set<AppliedLine["kind"]>([
  "applied",
  "held",
  "ask",
  "running",
  "failed",
]);

const isAppliedLine = (value: unknown): value is AppliedLine =>
  typeof value === "object" && value !== null && "kind" in value && LINE_KINDS.has(value.kind);

interface LineState {
  line: AppliedLine | null;
  marks: DecorationSet;
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

interface Options {
  translate: Translate;
  undoKeys(): string;
}

export const appliedLineKey = new PluginKey<LineState>("appliedEditLine");

function button(action: AppliedAction, label: string): HTMLButtonElement {
  const each = document.createElement("button");
  each.type = "button";
  each.className = "proposal-action";
  each.dataset.appliedAction = action;
  each.dataset.testid = `applied-${action}`;
  each.textContent = label;
  return each;
}

function dot(): HTMLSpanElement {
  const each = document.createElement("span");
  each.className = "proposal-dot";
  each.setAttribute("aria-hidden", "true");
  each.textContent = "·";
  return each;
}

function lineElement(testId: string, className: string, parts: (Node | string)[]): HTMLElement {
  const line = document.createElement("div");
  line.contentEditable = "false";
  line.className = className;
  line.dataset.testid = testId;
  line.setAttribute("role", "group");
  line.append(...parts);
  return line;
}

function sparkle(): Element {
  const holder = document.createElement("span");
  holder.innerHTML = iconMarkup("spark", "proposals-bar-icon");
  return holder.firstElementChild ?? holder;
}

function keys(label: string): HTMLElement {
  const kbd = document.createElement("kbd");
  kbd.className = "applied-keys";
  kbd.textContent = label;
  return kbd;
}

function text(className: string, words: string, testId?: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = words;
  if (testId) span.dataset.testid = testId;
  return span;
}

const waitingOf = (doc: ProseMirrorNode, request: string) =>
  proposalsIn(doc).filter((each) => each.request === request).length;

interface Place {
  from: number;
  to: number;
}

interface Ends {
  from: number | null;
  to: number | null;
}

function endsOf(state: EditorState, change: ChangePlace): Ends | null {
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) return null;
  const at = (relative: unknown): number | null =>
    relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
  const from = at(change.from);
  const inside = at(change.to);
  const end = inside === null || inside > state.doc.content.size ? null : state.doc.resolve(inside);
  const to = change.block !== "added" ? inside : end && end.depth > 0 ? end.after() : null;
  return { from, to };
}

function anchoredPlace(state: EditorState, change: ChangePlace): Place | null {
  if (change.paragraph) {
    const found = blockAt(state.doc, change.paragraph);
    return found ? { from: found.pos + 1, to: found.pos + found.node.nodeSize - 1 } : null;
  }
  const ends = endsOf(state, change);
  if (!ends) return null;
  const { from, to } = ends;
  if (to === null || to > state.doc.content.size) return null;
  // y-tiptap gives no position at 1 or less, so only a start at the Note's first Block is missing one; its end and the size it wrote say where its words begin.
  const written = change.block === null ? change.writtenSize : undefined;
  const start = from ?? (written === undefined ? null : to - written);
  if (start === null || start < 0 || to < start) return null;
  // That start is counted, not held: words taken out since would carry it into the paragraph before.
  if (from === null && !state.doc.resolve(start).sameParent(state.doc.resolve(to))) return null;
  return { from: start, to };
}

function contentAt(doc: ProseMirrorNode, place: Place): Fragment {
  const $from = doc.resolve(place.from);
  const $to = doc.resolve(place.to);
  return $from.sameParent($to)
    ? $from.parent.content.cut($from.parentOffset, $to.parentOffset)
    : doc.slice(place.from, place.to).content;
}

const asWritten = (doc: ProseMirrorNode, change: AppliedChange, place: Place) =>
  contentAt(doc, place).eq(change.written);

// Whether the Yjs item a position holds to is still there, through Undo and Redo: a change's own
// first word or Block, never the same words pasted where it was.
function holds(state: EditorState, relative: unknown): boolean {
  const store = ySyncPluginKey.getState(state)?.binding?.doc.store;
  if (!store || !(relative instanceof Y.RelativePosition) || relative.item === null) return true;
  let item = Y.getItem(store, relative.item);
  while (item instanceof Y.Item && item.redone) item = Y.getItem(store, item.redone);
  return item instanceof Y.Item && !item.deleted;
}

// A list item has no id of its own: an added one is found by its first paragraph's.
function addedFrom(doc: ProseMirrorNode, blockId: string, written: Fragment): number | null {
  const found = blockAt(doc, blockId);
  const type = written.firstChild?.type;
  if (!found || !type || found.node.type === type) return found?.pos ?? null;
  const $pos = doc.resolve(found.pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type === type) return $pos.before(depth);
  }
  return null;
}

// Its place can take in words typed just after it, as its end holds to what follows, and a
// paragraph written anew is all that paragraph: its own words still start where they did.
function foundAgain(state: EditorState, change: AppliedChange): Place | null {
  const { doc } = state;
  if (change.block === "added") {
    const from = change.blockId === null ? null : addedFrom(doc, change.blockId, change.written);
    const place = from === null ? null : { from, to: from + change.written.size };
    return place && place.to <= doc.content.size && asWritten(doc, change, place) ? place : null;
  }
  const binding = ySyncPluginKey.getState(state)?.binding;
  const from = binding
    ? relativePositionToAbsolutePosition(binding.doc, binding.type, change.start, binding.mapping)
    : null;
  const place = from === null ? null : { from, to: from + change.written.size };
  return place && place.to <= doc.content.size && asWritten(doc, change, place) ? place : null;
}

const textAt = (doc: ProseMirrorNode, from: number, to: number) =>
  doc.textBetween(from, to, "\n", "\uFFFC");

// Putting back words it only took out is safe while the text either side is as the edit left it.
function removalNow(
  state: EditorState,
  change: AppliedChange,
  anchored: Place | null,
): { place: Place; written: boolean } | null {
  if (!anchored) return null;
  if (change.block === "removed") return { place: anchored, written: true };
  const block = change.blockId === null ? null : blockAt(state.doc, change.blockId);
  if (!block) return null;
  const start = block.pos + 1;
  const end = block.pos + block.node.nodeSize - 1;
  const at = anchored.from;
  const { before = "", after = "" } = change.around ?? {};
  const written =
    start <= at &&
    at <= end &&
    textAt(state.doc, start, at).endsWith(before) &&
    textAt(state.doc, at, end).startsWith(after);
  return { place: anchored, written };
}

/**
 * Where a change is in the editor now, and whether it holds what it wrote,
 * the same words, AI text as they were: the User hasn't touched them since.
 * Null once its words are gone.
 */
function changeNow(
  state: EditorState,
  change: AppliedChange,
): { place: Place; written: boolean } | null {
  const anchored = anchoredPlace(state, change);
  if (change.written.size === 0) return removalNow(state, change, anchored);
  if (holds(state, change.start)) {
    if (anchored && asWritten(state.doc, change, anchored)) {
      return { place: anchored, written: true };
    }
    const again = foundAgain(state, change);
    if (again) return { place: again, written: true };
  }
  return anchored && { place: anchored, written: false };
}

export const placeOfChange = (state: EditorState, change: AppliedChange): Place | null =>
  changeNow(state, change)?.place ?? null;

const blockIdOf = (node: ProseMirrorNode | null | undefined): string | null => {
  const id: unknown = node?.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
};

// A ProseMirror place's Yjs position holds to the item before it; this one holds to the item at it.
function itemAt(state: EditorState, pos: number): Y.RelativePosition | null {
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) return null;
  const before = absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
  const at = Y.createAbsolutePositionFromRelativePosition(before, binding.doc);
  return at && Y.createRelativePositionFromTypeIndex(at.type, at.index, 0);
}

/** The changes as they are once applied: what each wrote, and the Block it is in. */
export function appliedChanges(
  state: EditorState,
  places: readonly ChangePlace[],
): AppliedChange[] {
  const { doc } = state;
  const placed = places.map((change) => anchoredPlace(state, change));
  return places.map((change, index) => {
    const place = placed[index];
    if (!place) return { ...change, written: Fragment.empty, blockId: null, start: null };
    const $from = doc.resolve(place.from);
    const blockId =
      change.block === "removed"
        ? null
        : change.block === "added"
          ? (anchorOf(doc.nodeAt(place.from))?.blockId ?? null)
          : $from.parent.isTextblock
            ? blockIdOf($from.parent)
            : null;
    const written = contentAt(doc, place);
    if (written.size > 0) return { ...change, written, blockId, start: itemAt(state, place.from) };
    if (change.block !== null || !$from.parent.isTextblock) {
      return { ...change, written, blockId, start: null };
    }
    let from = $from.start();
    let to = $from.end();
    for (const other of placed) {
      if (!other || other === place) continue;
      if (other.to <= place.from && other.to > from) from = other.to;
      if (other.from >= place.from && other.from < to) to = other.from;
    }
    const around = { before: textAt(doc, from, place.from), after: textAt(doc, place.from, to) };
    return { ...change, written, blockId, start: null, around };
  });
}

const COUNTED: ReadonlySet<string> = new Set(["paragraph", "heading"]);

/** What an edit's lines count: the paragraphs it changed, and its tables added or removed whole. */
export interface ChangedBlocks {
  paragraphs: number;
  tables: number;
  /** Every paragraph and table counted was added whole, the User's kept: added, not changed (`addsOnly`). */
  added?: true;
  /** Every paragraph counted was removed whole, and nothing else changed (`onlyRemoves`). */
  removed?: RemovedParagraphs;
  /** The one paragraph changed or added, and nothing else, named. */
  named?: NamedChange;
}

/** Whether a paragraph or heading lies wholly between two positions. */
function textBetween(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false;
  if (to > from) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (found) return false;
      if (node.isTextblock) found = pos >= from && pos + node.nodeSize <= to;
      return !node.isTextblock;
    });
  }
  return found;
}

/**
 * What an applied edit's changes are in, as the applied line and its Undo notice
 * count it: paragraphs by `countChanged`, as the core counts them
 * (`changedParagraphs`), and a table added or removed whole is one table, not its cells.
 */
export function changedBlocksOf(
  state: EditorState,
  changes: readonly AppliedChange[],
): ChangedBlocks {
  const kinds: ChangeKind[] = [];
  const removedTexts: string[] = [];
  const touched: NamedChange[] = [];
  const counted = new Set<number>();
  const tables = new Set<number>();
  let removedTables = 0;
  /** Where the last Block added or removed ended: text between it and the next ends their run. */
  let reached: number | null = null;
  for (const change of changes) {
    const place = placeOfChange(state, change);
    if (!place) continue;
    if (change.block !== null) {
      if (reached !== null && textBetween(state.doc, reached, place.from)) kinds.push("kept");
      reached = place.to;
    } else reached = null;
    if (change.block === "removed") {
      let blocks = 0;
      let wholeTables = 0;
      let emptyLines = 0;
      change.removed.descendants((node) => {
        if (node.type.name === "table") {
          wholeTables++;
          kinds.push("table-removed");
          return false;
        }
        // An empty line taken out is no paragraph, as the core counts it (#3759).
        if (COUNTED.has(node.type.name) && node.content.size === 0) emptyLines++;
        else if (COUNTED.has(node.type.name)) {
          blocks++;
          kinds.push(node.type.name === "heading" ? "title-removed" : "removed");
          if (node.type.name !== "heading") removedTexts.push(node.textContent);
        }
        return !node.isTextblock;
      });
      removedTables += wholeTables;
      if (blocks === 0 && wholeTables === 0 && emptyLines === 0) kinds.push("removed");
      continue;
    }
    state.doc.nodesBetween(place.from, Math.max(place.to, place.from + 1), (node, pos) => {
      if (node.type.name === "table" && change.block === "added") {
        if (!tables.has(pos)) kinds.push("table-added");
        tables.add(pos);
        return false;
      }
      if (COUNTED.has(node.type.name) && !counted.has(pos)) {
        counted.add(pos);
        touched.push({ start: paragraphStart(node.textContent), added: change.block !== null });
        if (change.block === null) kinds.push("edited");
        else kinds.push(node.type.name === "heading" ? "title-added" : "added");
      }
      return !node.isTextblock;
    });
  }
  const paragraphs = countChanged(kinds);
  const [only] = touched;
  return {
    paragraphs,
    tables: tables.size + removedTables,
    ...(addsOnly(kinds) && { added: true }),
    ...(onlyRemoves(kinds) && { removed: paragraphsRemoved(removedTexts) }),
    ...(paragraphs === 1 &&
      touched.length === 1 &&
      tables.size + removedTables === 0 &&
      only &&
      only.start !== "" &&
      !onlyRemoves(kinds) && { named: only }),
  };
}

const changesIn = (t: Translate, { paragraphs, tables }: ChangedBlocks): string => {
  const counted =
    tables === 1 ? t("edit.count.tables.one") : t("edit.count.tables", { count: tables });
  if (paragraphs === 0) return counted;
  return t("edit.changes", {
    paragraphs:
      paragraphs === 1
        ? t("mindChanges.count.paragraphs.one")
        : t("mindChanges.count.paragraphs", { count: paragraphs }),
    tables: counted,
  });
};

/** What the applied line and its Undo notice say an edit changed: "Changed 3 paragraphs and 1 table". */
export function appliedText(t: Translate, blocks: ChangedBlocks): string {
  if (blocks.named) return namedFact(t, blocks.named);
  if (blocks.added) return addedText(t, blocks);
  if (blocks.removed) return removedFact(t, blocks.removed, null);
  if (blocks.tables > 0) return t("edit.applied.changes", { changes: changesIn(t, blocks) });
  return blocks.paragraphs === 1
    ? t("edit.applied.one")
    : t("edit.applied", { count: blocks.paragraphs });
}

/** An edit that only added: "Added 3 paragraphs and a table", as the assistant's lines say it. */
function addedText(t: Translate, { paragraphs, tables }: ChangedBlocks): string {
  const table =
    tables === 1
      ? t("mindChanges.count.tables.one")
      : t("mindChanges.count.tables", { count: tables });
  if (paragraphs === 0) return t("edit.tables", { tables: table });
  if (tables > 0) {
    const counted =
      paragraphs === 1
        ? t("mindChanges.count.paragraphs.one")
        : t("mindChanges.count.paragraphs", { count: paragraphs });
    return t("edit.added.tables", { paragraphs: counted, tables: table });
  }
  return paragraphs === 1 ? t("edit.added.one") : t("edit.added", { count: paragraphs });
}

function actionButton(label: string, testId: string, run: () => void): HTMLButtonElement {
  const each = document.createElement("button");
  each.type = "button";
  each.className = "proposal-action";
  each.dataset.testid = testId;
  each.textContent = label;
  // The cursor stays in the text.
  each.addEventListener("mousedown", (event) => event.preventDefault());
  each.addEventListener("click", run);
  return each;
}

function mainLine(line: AppliedLine, options: Options): HTMLElement {
  const t = options.translate;
  if (line.kind === "ask") {
    const parts: (Node | string)[] = [text("min-w-0", t("edit.ask.parts", { count: line.parts }))];
    if (line.estimate) {
      const cost = text("min-w-0", line.estimate.parts.join(" · "), "edit-estimate");
      cost.title = line.estimate.title;
      parts.push(dot(), cost);
    }
    parts.push(
      dot(),
      actionButton(t("edit.ask.start"), "edit-ask-start", line.start),
      dot(),
      actionButton(t("edit.ask.cancel"), "edit-ask-cancel", line.cancel),
    );
    const element = lineElement("applied-line", "applied-line", parts);
    element.setAttribute("role", "status");
    return element;
  }
  if (line.kind === "running") {
    const pulse = document.createElement("span");
    pulse.className = "edit-pending-dot";
    pulse.setAttribute("aria-hidden", "true");
    const parts: (Node | string)[] = [
      pulse,
      text(
        "min-w-0",
        line.busy
          ? t("edit.problem.busy")
          : line.part
            ? t("edit.pending.part", { at: line.part.at, of: line.part.of })
            : t("edit.pending.instruction"),
      ),
    ];
    if (line.estimate) {
      const cost = text("min-w-0", line.estimate.parts.join(" · "), "edit-estimate");
      cost.title = line.estimate.title;
      parts.push(dot(), cost);
    }
    parts.push(dot(), actionButton(t("edit.stop"), "menu-edit-stop", line.stop));
    const element = lineElement("menu-edit-line", "applied-line", parts);
    element.setAttribute("role", "status");
    return element;
  }
  if (line.kind === "failed") {
    const mark = document.createElement("span");
    mark.className = "applied-problem-dot";
    mark.setAttribute("aria-hidden", "true");
    const parts: (Node | string)[] = [...(line.asked ? [] : [mark]), text("min-w-0", line.text)];
    if (line.action) {
      parts.push(dot(), actionButton(line.action.label, "menu-edit-action", line.action.run));
    }
    parts.push(dot(), actionButton(t("edit.close"), "menu-edit-close", line.close));
    const element = lineElement(
      line.asked ? "edit-asked" : "edit-problem",
      "applied-line applied-line--problem",
      parts,
    );
    element.setAttribute("role", line.asked ? "status" : "alert");
    return element;
  }
  if (line.kind === "applied") {
    const what = text(
      "applied-count min-w-0",
      line.facts ? changeFact(t, line.facts, null) : appliedText(t, line.blocks),
      "applied-count",
    );
    const parts: (Node | string)[] = [sparkle(), what];
    if (line.parts !== undefined && line.parts > 1) {
      parts.push(
        dot(),
        text("min-w-0", t("edit.applied.parts", { count: line.parts }), "applied-parts"),
      );
    }
    parts.push(dot(), button("undo", t("edit.applied.undo")), keys(options.undoKeys()));
    // What the assistant wrote comes in the page's top margin; an edit asked on the text keeps its line over its Block.
    const element = lineElement(
      "applied-line",
      line.facts ? "applied-line applied-line--band" : "applied-line",
      parts,
    );
    if (line.reason) element.title = t("proposal.why", { reason: line.reason });
    if (line.turn) element.dataset.turn = line.turn;
    return element;
  }
  return lineElement("applied-line", "applied-line", [
    sparkle(),
    text("applied-count min-w-0", t(line.asked ? "edit.held.own" : "edit.held"), "applied-count"),
    dot(),
    button("apply", t("edit.held.apply")),
    dot(),
    button("discard", t("edit.held.discard")),
  ]);
}

function keptLine(kept: KeptLine, t: Translate): HTMLElement {
  const words =
    kept.count === 1
      ? t(kept.mixed ? "edit.kept.blocks.one" : "edit.kept.paragraphs.one")
      : t(kept.mixed ? "edit.kept.blocks" : "edit.kept.paragraphs", { count: kept.count });
  return lineElement("applied-kept", "applied-kept-line", [
    text("min-w-0", words),
    dot(),
    button("remove-kept", kept.count === 1 ? t("edit.kept.remove.one") : t("edit.kept.remove")),
  ]);
}

function placeOf(doc: ProseMirrorNode, blockId: string | null): number | null {
  if (blockId === null) return doc.content.size;
  return blockAt(doc, blockId)?.pos ?? null;
}

function decorations(
  state: EditorState,
  line: AppliedLine,
  options: Options,
  sight: LineSight,
): DecorationSet {
  const { doc } = state;
  const marks: Decoration[] = [];
  const at = placeOf(doc, line.blockId);
  const shared = { side: -1, ignoreSelection: true, stopEvent: () => true };
  if (at !== null) {
    const blocks = line.kind === "applied" ? line.blocks : { paragraphs: 0, tables: 0 };
    const words =
      line.kind === "failed"
        ? line.text
        : line.kind === "running"
          ? `${line.busy ? "busy" : ""}/${line.part?.at ?? ""}/${line.part?.of ?? ""}`
          : "";
    // What the count is said as, as well as the count.
    const named =
      (line.kind === "applied" && line.facts?.named?.start) || blocks.named?.start || "";
    const count = `${blocks.paragraphs}/${blocks.tables}/${blocks.added ? "added" : ""}/${blocks.removed ? `${blocks.removed.sentences}:${blocks.removed.start}` : ""}/${named}`;
    marks.push(
      Decoration.widget(
        at,
        () => {
          const element = mainLine(line, options);
          // The page's top band gives its own line room; one over a Block is kept in sight (#2123).
          if (line.blockId !== null && !element.classList.contains("applied-line--band")) {
            sight.watch(element, line.blockId);
          }
          return element;
        },
        {
          ...shared,
          // Drawn again in the interface language once it changes.
          key: `applied:${line.kind}:${count}:${line.blockId}:${words}:${options.translate("edit.applied.undo")}`,
        },
      ),
    );
  }
  const kept = line.kind === "applied" ? line.kept : null;
  const keptAt = kept ? placeOf(doc, kept.blockId) : null;
  if (kept && keptAt !== null) {
    marks.push(
      Decoration.widget(keptAt, () => keptLine(kept, options.translate), {
        ...shared,
        side: -2,
        key: `applied-kept:${kept.blockId}:${kept.count}:${options.translate("edit.kept.remove")}`,
      }),
    );
  }
  return DecorationSet.create(doc, marks);
}

export const AppliedEditLine = Extension.create<Options>({
  name: "appliedEditLine",

  addOptions() {
    return { translate: (key) => key, undoKeys: () => "" };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const sight = lineSight(() => this.editor.view);
    return [
      new Plugin<LineState>({
        key: appliedLineKey,
        view: () => {
          if (typeof window === "undefined") return {};
          const placeAll = () => sight.placeAll();
          // A scroll doesn't bubble, but it does capture: one watch over every scroller.
          window.addEventListener("scroll", placeAll, { capture: true, passive: true });
          window.addEventListener("resize", placeAll);
          return {
            destroy() {
              window.removeEventListener("scroll", placeAll, { capture: true });
              window.removeEventListener("resize", placeAll);
              sight.clear();
            },
          };
        },
        state: {
          init: () => ({ line: null, marks: DecorationSet.empty }),
          apply: (tr, value, _before, state) => {
            const meta: unknown = tr.getMeta(appliedLineKey);
            // Typing ends the line, but a held edit waits for its Apply or Discard.
            const typedOver =
              tr.docChanged &&
              !fromDocument(tr) &&
              value.line?.kind !== "held" &&
              value.line?.kind !== "running";
            const shown =
              meta === null || isAppliedLine(meta) ? meta : typedOver ? null : value.line;
            // Applied or discarded one by one, a held edit's changes are all gone.
            const gone =
              shown !== null &&
              shown.kind === "held" &&
              (shown !== value.line || tr.docChanged) &&
              (shown.asked?.requests ?? [shown.request]).every(
                (request) => waitingOf(state.doc, request) === 0,
              );
            const line = gone ? null : shown;
            if (!line) return { line: null, marks: DecorationSet.empty };
            if (line !== value.line || (tr.docChanged && fromDocument(tr))) {
              return { line, marks: decorations(state, line, options, sight) };
            }
            return tr.docChanged ? { line, marks: value.marks.map(tr.mapping, tr.doc) } : value;
          },
        },
        props: {
          decorations: (state) => appliedLineKey.getState(state)?.marks ?? null,
        },
      }),
    ];
  },
});

export const appliedLineIn = (state: EditorState): AppliedLine | null =>
  appliedLineKey.getState(state)?.line ?? null;

export function setAppliedLine(editor: Editor, line: AppliedLine | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(appliedLineKey, line));
}

export function redrawAppliedLine(editor: Editor, language: Language): void {
  const line = appliedLineIn(editor.state);
  if (line && line.language !== language) setAppliedLine(editor, { ...line, language });
}
