/**
 * The lines over an edit the User asked for (#880; DESIGN.md, AI edits),
 * drawn in the text above the Block they are about, and under Review
 * changes a Restore original after the new words of each section rewritten
 * as a whole and of each other change.
 * ProposalBars handles their buttons, by `data-applied-action` and
 * `data-applied-restore`. They go once the User edits.
 */
import { type Editor, Extension, isMacOS } from "@tiptap/core";
import {
  DOMSerializer,
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE } from "../../../core/api";
import type { Language } from "../../../core/language";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { type ChangeKind, countChanged } from "../../../shared/proposals";
import { type ChangeCounts, changeFact } from "../changeFacts";
import { SPARK_PATH } from "../components/iconPaths";
import { anchorOf } from "./arrivedChanges";
import {
  type ChangedBlock,
  LINE_WIDGET,
  originalShown,
  type RewrittenSection,
  rewrittenSections,
  sectionKey,
  sectionLine,
  sectionOf,
  toggled,
  wasLine,
} from "./changeOriginals";
import { fromDocument, proposalsIn } from "./proposalReview";
import { blockAt } from "./writingPlace";

export const APPLIED_ACTIONS = [
  "undo",
  "review",
  "undo-all",
  "done",
  "apply",
  "discard",
  "remove-kept",
] as const;
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
}

/** One change an applied edit made, and what it wrote: Restore original puts the old words back only over those, as they were (#1795). */
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
      changes: readonly AppliedChange[];
      kept: KeptLine | null;
    }
  | {
      kind: "review";
      blockId: string | null;
      changes: readonly AppliedChange[];
      byAssistant?: true;
      undo?: { available(): boolean; mind: string };
      /** Changes, and sections, whose old text shows, struck (`changeOriginals`). */
      shown?: readonly string[];
      /** Still shown: not restored since, and the edit not undone. */
      shows?(change: AppliedChange): boolean;
    }
  | {
      kind: "held";
      blockId: string | null;
      request: string;
      /** Asked of the assistant: all of its requests in the Mind, held as they would rewrite most of the User's text. */
      asked?: { mindId: string; requests: readonly string[]; facts: ChangeCounts };
    }
  // An edit asked in the selection menu, once the menu is closed: it holds the spot its Undo line lands in.
  | { kind: "running"; blockId: string | null; stop(): void }
  | {
      kind: "failed";
      blockId: string | null;
      text: string;
      action: { label: string; run(): void } | null;
      close(): void;
    }
) & {
  /** The language it was last drawn in, once that changed. */
  language?: Language;
};

const LINE_KINDS: ReadonlySet<unknown> = new Set<AppliedLine["kind"]>([
  "applied",
  "review",
  "held",
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

function restoreButton(index: number, count: number, t: Translate): HTMLButtonElement {
  const each = document.createElement("button");
  each.type = "button";
  each.className = "proposal-action applied-restore";
  each.dataset.appliedRestore = String(index);
  each.dataset.testid = "change-restore";
  each.title = `${t("proposal.position", { index: index + 1, count })} · ${isMacOS() ? "⌘⌫" : "Ctrl+Backspace"}`;
  each.setAttribute("aria-keyshortcuts", isMacOS() ? "Meta+Backspace" : "Control+Backspace");
  each.textContent = t("edit.review.restore");
  return each;
}

function restoreHolder(button: HTMLElement, ownLine: boolean): HTMLElement {
  const holder = document.createElement(ownLine ? "div" : "span");
  holder.contentEditable = "false";
  holder.className = ownLine
    ? "applied-restore-holder applied-restore-holder--block"
    : "applied-restore-holder";
  holder.append(button);
  return holder;
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

function sparkle(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "proposals-bar-icon",
  })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", SPARK_PATH);
  svg.append(path);
  return svg;
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

function anchoredPlace(state: EditorState, change: ChangePlace): Place | null {
  if (change.paragraph) {
    const found = blockAt(state.doc, change.paragraph);
    return found ? { from: found.pos + 1, to: found.pos + found.node.nodeSize - 1 } : null;
  }
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) return null;
  const at = (relative: unknown): number | null =>
    relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
  const from = at(change.from);
  const inside = at(change.to);
  const end = inside === null || inside > state.doc.content.size ? null : state.doc.resolve(inside);
  const to = change.block !== "added" ? inside : end && end.depth > 0 ? end.after() : null;
  return from === null || to === null || to < from || to > state.doc.content.size
    ? null
    : { from, to };
}

const textOf = (removed: Fragment) => removed.textBetween(0, removed.size, "\n", "￼");

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
export function changeNow(
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
 * What the changes shown again are in, as the applied line, its Undo notice
 * and Review changes all count it: paragraphs by `countChanged`, as the core counts them
 * (`changedParagraphs`), and a table added or removed whole is one table, not its cells.
 */
export function changedBlocksOf(
  state: EditorState,
  changes: readonly AppliedChange[],
): ChangedBlocks {
  const kinds: ChangeKind[] = [];
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
      change.removed.descendants((node) => {
        if (node.type.name === "table") {
          wholeTables++;
          return false;
        }
        if (COUNTED.has(node.type.name)) {
          blocks++;
          kinds.push(node.type.name === "heading" ? "title-removed" : "removed");
        }
        return !node.isTextblock;
      });
      removedTables += wholeTables;
      if (blocks === 0 && wholeTables === 0) kinds.push("removed");
      continue;
    }
    state.doc.nodesBetween(place.from, Math.max(place.to, place.from + 1), (node, pos) => {
      if (node.type.name === "table" && change.block === "added") {
        tables.add(pos);
        return false;
      }
      if (COUNTED.has(node.type.name) && !counted.has(pos)) {
        counted.add(pos);
        if (change.block === null) kinds.push("edited");
        else kinds.push(node.type.name === "heading" ? "title-added" : "added");
      }
      return !node.isTextblock;
    });
  }
  return { paragraphs: countChanged(kinds), tables: tables.size + removedTables };
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
  if (blocks.tables > 0) return t("edit.applied.changes", { changes: changesIn(t, blocks) });
  return blocks.paragraphs === 1
    ? t("edit.applied.one")
    : t("edit.applied", { count: blocks.paragraphs });
}

function reviewText(t: Translate, blocks: ChangedBlocks, byAssistant: boolean): string {
  if (blocks.tables > 0) {
    const changes = changesIn(t, blocks);
    return byAssistant
      ? t("edit.review.assistant.changes", { changes })
      : t("edit.review.changes", { changes });
  }
  const count = blocks.paragraphs;
  if (byAssistant) {
    return count === 1 ? t("edit.review.assistant.one") : t("edit.review.assistant", { count });
  }
  return count === 1 ? t("edit.review.one") : t("edit.review", { count });
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

function mainLine(line: AppliedLine, options: Options, blocks: ChangedBlocks): HTMLElement {
  const t = options.translate;
  if (line.kind === "running") {
    const pulse = document.createElement("span");
    pulse.className = "edit-pending-dot";
    pulse.setAttribute("aria-hidden", "true");
    const element = lineElement("menu-edit-line", "applied-line", [
      pulse,
      text("min-w-0", t("edit.pending.instruction")),
      dot(),
      actionButton(t("edit.stop"), "menu-edit-stop", line.stop),
    ]);
    element.setAttribute("role", "status");
    return element;
  }
  if (line.kind === "failed") {
    const mark = document.createElement("span");
    mark.className = "applied-problem-dot";
    mark.setAttribute("aria-hidden", "true");
    const parts: (Node | string)[] = [mark, text("min-w-0", line.text)];
    if (line.action) {
      parts.push(dot(), actionButton(line.action.label, "menu-edit-action", line.action.run));
    }
    parts.push(dot(), actionButton(t("edit.close"), "menu-edit-close", line.close));
    const element = lineElement("edit-problem", "applied-line applied-line--problem", parts);
    element.setAttribute("role", "alert");
    return element;
  }
  if (line.kind === "applied") {
    const what = text(
      "min-w-0 font-semibold",
      line.facts ? changeFact(t, line.facts, null) : appliedText(t, line.blocks),
      "applied-count",
    );
    const parts: (Node | string)[] = [
      sparkle(),
      what,
      dot(),
      button("undo", t("edit.applied.undo")),
      keys(options.undoKeys()),
    ];
    if (line.changes.length > 0) parts.push(dot(), button("review", t("edit.applied.review")));
    // What the assistant wrote comes in the page's top margin; an edit asked on the text keeps its line over its Block.
    const element = lineElement(
      "applied-line",
      line.facts ? "applied-line applied-line--band" : "applied-line",
      parts,
    );
    if (line.reason) element.title = t("proposal.why", { reason: line.reason });
    return element;
  }
  if (line.kind === "review") {
    const undo = button("undo-all", t("edit.review.undoAll"));
    if (line.undo && !line.undo.available()) {
      undo.setAttribute("aria-disabled", "true");
      undo.title = t("mindChanges.undo.changedSince.noReview", { mind: line.undo.mind });
    }
    return lineElement("applied-line", "applied-line", [
      sparkle(),
      text(
        "min-w-0 font-semibold",
        reviewText(t, blocks, line.byAssistant === true),
        "applied-count",
      ),
      dot(),
      undo,
      dot(),
      button("done", t("edit.review.done")),
    ]);
  }
  return lineElement("applied-line", "applied-line", [
    sparkle(),
    text("min-w-0", t(line.asked ? "edit.held.own" : "edit.held"), "applied-count"),
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

const lineText = (text: string) =>
  text
    .replace(/\uFFFC/g, "")
    .replace(/\s+/g, " ")
    .trim();

function changedBlockOf(
  state: EditorState,
  change: AppliedChange,
  index: number,
  place: { from: number; to: number },
): ChangedBlock {
  const key = `applied:${index}`;
  if (change.block) {
    return { key, pos: place.from, how: change.block === "added" ? "added" : "removed" };
  }
  const $from = state.doc.resolve(place.from);
  const pos = $from.depth > 0 ? $from.before() : place.from;
  return change.paragraph
    ? {
        key,
        pos,
        how: "rewritten",
        old: lineText(textOf(change.removed)),
        title: lineText(state.doc.textBetween(place.from, place.to, " ", "\uFFFC")),
      }
    : { key, pos, how: "words" };
}

function removedBlocks(schema: Schema, removed: Fragment): HTMLElement {
  const drawn = DOMSerializer.fromSchema(schema).serializeFragment(removed);
  const item = drawn.firstElementChild;
  const ownItem =
    removed.childCount === 1 &&
    removed.firstChild?.type.name === "listItem" &&
    item instanceof HTMLElement;
  const element = ownItem ? item : document.createElement("div");
  if (!ownItem) element.append(drawn);
  element.classList.add("applied-old--block");
  element.contentEditable = "false";
  return element;
}

interface PlacedChange {
  change: AppliedChange;
  index: number;
  place: { from: number; to: number };
  written: boolean;
  block: ChangedBlock;
}

/** What one Restore original restores: a section rewritten as a whole, or a single change. */
export interface ChangeGroup {
  members: readonly PlacedChange[];
  /** The member whose new words come last, or the last of them when none has any: its Restore sits after it. */
  last: PlacedChange;
  from: number;
  to: number;
  /** None of it changed since: restoring it takes none of the User's words. */
  restorable: boolean;
}

function groupsOf(
  placed: readonly PlacedChange[],
  sections: readonly RewrittenSection[],
): ChangeGroup[] {
  const groups = new Map<RewrittenSection | PlacedChange, PlacedChange[]>();
  for (const each of placed) {
    const key = sectionOf(each.block, sections) ?? each;
    groups.set(key, [...(groups.get(key) ?? []), each]);
  }
  return [...groups.values()].map((members) => {
    const written = members.filter(({ place }) => place.to > place.from);
    return {
      members,
      last: (written.length > 0 ? written : members).reduce((a, b) =>
        b.place.to >= a.place.to ? b : a,
      ),
      from: Math.min(...members.map(({ place }) => place.from)),
      to: Math.max(...members.map(({ place }) => place.to)),
      restorable: members.every(({ written }) => written),
    };
  });
}

function reviewedBlocks(state: EditorState, changes: readonly AppliedChange[]) {
  const placed = changes.flatMap((change, index): PlacedChange[] => {
    const now = changeNow(state, change);
    if (!now) return [];
    const { place, written } = now;
    return [{ change, index, place, written, block: changedBlockOf(state, change, index, place) }];
  });
  const sections = rewrittenSections(
    state.doc,
    placed.map(({ block }) => block),
    false,
  );
  return { placed, sections, groups: groupsOf(placed, sections) };
}

/** The groups an edit's changes are restored in, in reading order. */
export const changeGroupsOf = (state: EditorState, changes: readonly AppliedChange[]) =>
  reviewedBlocks(state, changes).groups;

export const changesLeft = (line: Extract<AppliedLine, { kind: "review" }>) =>
  line.shows ? line.changes.filter((change) => line.shows?.(change)) : line.changes;

/**
 * What shows the old text of the change shown again that the cursor is in,
 * its section's when it is in one, and whether it shows; null for one not
 * written anew.
 */
export function appliedOriginalAt(state: EditorState): { key: string; shown: boolean } | null {
  const line = appliedLineIn(state);
  if (line?.kind !== "review") return null;
  const { placed, sections } = reviewedBlocks(state, changesLeft(line));
  const { from } = state.selection;
  const here = placed.find(({ place }) => place.from <= from && from <= place.to);
  if (!here) return null;
  const shownKeys = new Set(line.shown);
  const { inSection, shown } = originalShown(here.block, sections, shownKeys);
  if (inSection) return { key: sectionKey(inSection), shown };
  return here.block.how === "rewritten" ? { key: here.block.key, shown } : null;
}

/**
 * An applied edit's changes shown again (Review changes): old words struck,
 * new ones underlined, the doc left as it is; a paragraph written anew, and
 * a section, read as `changeOriginals` says.
 */
function changeMarks(
  state: EditorState,
  changes: readonly AppliedChange[],
  shownKeys: ReadonlySet<string>,
  t: Translate,
): Decoration[] {
  const { placed, sections, groups } = reviewedBlocks(state, changes);
  const drawn = new Set<number>();
  const lines: Decoration[] = sections.map((section) => {
    const open = shownKeys.has(sectionKey(section));
    return Decoration.widget(section.heading.pos, () => sectionLine(t, section, open), {
      ...LINE_WIDGET,
      key: `rewrote:${section.heading.key}:${open}:${section.heading.title}:${t("change.showOriginal")}`,
    });
  });
  const changed = placed.flatMap(({ change, index, place, block }) => {
    const { inSection, shown } = originalShown(block, sections, shownKeys);
    const marks: Decoration[] = [];
    if (block.how === "rewritten" && !inSection) {
      marks.push(
        Decoration.widget(block.pos, () => wasLine(t, block, shown), {
          ...LINE_WIDGET,
          key: `was:${block.key}:${shown}:${block.old}:${t("change.showOriginal")}`,
        }),
      );
    }
    const oldShows =
      block.how === "rewritten" || (block.how === "removed" && inSection) ? shown : true;
    const oldDrawn = change.removed.size > 0 && oldShows;
    if (oldDrawn) {
      const old = () => {
        const element = change.block
          ? removedBlocks(state.schema, change.removed)
          : document.createElement("del");
        element.classList.add("applied-old");
        element.dataset.appliedChange = String(index);
        if (!change.block) element.textContent = textOf(change.removed);
        return element;
      };
      marks.push(
        Decoration.widget(place.from, old, {
          side: -1,
          ignoreSelection: true,
          key: `applied-old:${index}:${textOf(change.removed)}`,
        }),
      );
    }
    const newDrawn = place.to > place.from;
    if (newDrawn) {
      const attributes = { "data-applied-change": String(index) };
      marks.push(
        change.block
          ? Decoration.node(place.from, place.to, {
              ...attributes,
              class: "applied-new applied-new--block",
            })
          : Decoration.inline(place.from, place.to, { ...attributes, class: "applied-new" }),
      );
    }
    if (newDrawn || oldDrawn) drawn.add(index);
    return marks;
  });
  const restores = groups.flatMap((group, at) => {
    if (!group.members.some(({ index }) => drawn.has(index))) return [];
    const { last, restorable } = group;
    const ownLine = last.change.block !== null;
    const label = t(restorable ? "edit.review.restore" : "edit.review.changedSince");
    return [
      Decoration.widget(
        last.place.to,
        () =>
          restoreHolder(
            restorable
              ? restoreButton(at, groups.length, t)
              : text("applied-changed", label, "change-changed-since"),
            ownLine,
          ),
        {
          // Widgets at one position draw in order of side: after the group's new words but
          // before the next change's old ones (-1), or, with no new words, after its own old ones.
          side: last.place.to > last.place.from ? -3 : -0.9,
          ignoreSelection: true,
          stopEvent: () => true,
          key: `applied-restore:${at}:${groups.length}:${ownLine}:${label}`,
        },
      ),
    ];
  });
  return [...lines, ...changed, ...restores];
}

function decorations(state: EditorState, line: AppliedLine, options: Options): DecorationSet {
  const { doc } = state;
  const marks: Decoration[] =
    line.kind === "review"
      ? changeMarks(state, changesLeft(line), new Set(line.shown), options.translate)
      : [];
  const at = placeOf(doc, line.blockId);
  const shared = { side: -1, ignoreSelection: true, stopEvent: () => true };
  if (at !== null) {
    const blocks =
      line.kind === "applied"
        ? line.blocks
        : line.kind === "review"
          ? changedBlocksOf(state, changesLeft(line))
          : { paragraphs: 0, tables: 0 };
    const words = line.kind === "failed" ? line.text : "";
    const count = `${blocks.paragraphs}/${blocks.tables}`;
    const canUndo = line.kind !== "review" || !line.undo || line.undo.available();
    marks.push(
      Decoration.widget(at, () => mainLine(line, options, blocks), {
        ...shared,
        // Drawn again in the interface language once it changes.
        key: `applied:${line.kind}:${count}:${line.blockId}:${canUndo}:${words}:${options.translate("edit.applied.undo")}`,
      }),
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
    return [
      new Plugin<LineState>({
        key: appliedLineKey,
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
            // Applied or discarded one by one, a held edit's changes are all gone; restored, a reviewed one's.
            const gone =
              shown !== null &&
              (shown.kind === "held"
                ? (shown !== value.line || tr.docChanged) &&
                  (shown.asked?.requests ?? [shown.request]).every(
                    (request) => waitingOf(state.doc, request) === 0,
                  )
                : shown.kind === "review" && changesLeft(shown).length === 0);
            const line = gone ? null : shown;
            if (!line) return { line: null, marks: DecorationSet.empty };
            if (line !== value.line || (tr.docChanged && fromDocument(tr))) {
              return { line, marks: decorations(state, line, options) };
            }
            return tr.docChanged ? { line, marks: value.marks.map(tr.mapping, tr.doc) } : value;
          },
        },
        props: {
          decorations: (state) => appliedLineKey.getState(state)?.marks ?? null,
          handleDOMEvents: {
            // A click on a change shown again puts the cursor in it, for ⌘⌫ and its bar.
            mousedown(view, event) {
              const target = event.target instanceof Element ? event.target : null;
              const index = Number(
                target?.closest("[data-applied-change]")?.getAttribute("data-applied-change"),
              );
              const line = appliedLineKey.getState(view.state)?.line;
              const change = line?.kind === "review" ? changesLeft(line)[index] : undefined;
              const place = change ? placeOfChange(view.state, change) : null;
              if (!place) return false;
              event.preventDefault();
              view.focus();
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, place.from)),
              );
              return true;
            },
          },
        },
      }),
    ];
  },
});

/** Shows an applied change's old text, or its section's, struck in place; or hides it again. */
export function toggleAppliedOriginal(editor: Editor, key: string): void {
  const line = appliedLineIn(editor.state);
  if (line?.kind !== "review") return;
  setAppliedLine(editor, { ...line, shown: [...toggled(new Set(line.shown), key)] });
}

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
