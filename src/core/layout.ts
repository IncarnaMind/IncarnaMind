import { randomUUID } from "node:crypto";
import { parseLocation } from "../shared/locations";
import {
  type AssistantCorner,
  type AssistantDock,
  type AssistantFloat,
  type AssistantPlace,
  type CitationCheck,
  type CitationCheckReason,
  DEFAULT_ASSISTANT,
  type DocumentPlace,
  type LayoutChange,
  type LayoutGroup,
  type LayoutTab,
  MAX_TAB_GROUPS,
  type OpenWhere,
  type TabCitation,
  type TabItem,
  type WindowLayout,
} from "./api";
import { InvalidInputError, isRecord, NotFoundError } from "./errors";

/*
 * Each window's tabs and groups (VS Code's editor groups): kept here, saved
 * per window with the device's settings, and changed only through
 * `change`, so every client sees the same layout and it survives a restart.
 */

/** What is kept of a window's layout. */
interface Layout {
  groups: LayoutGroup[];
  focusedGroupId: string;
  assistant: AssistantPlace;
}

/** Where a tab was in its window: its group, that group's place, and the tab's place in it. */
interface TabPlace {
  tab: LayoutTab;
  groupId: string;
  groupIndex: number;
  index: number;
}

/**
 * A tab a Mind's delete closed, and where it was, for the restore that puts it back: the same
 * rule closes and reopens, in every window, whatever way the Mind was deleted.
 */
interface GoneTab extends TabPlace {
  mindId: string;
  windowId: string;
  shown: boolean;
  focused: boolean;
  /** The close it went with: its place was counted among the tabs closed after it, not before. */
  closedIn: number;
}

/** How many closed tabs ⇧⌘T can bring back. */
const MAX_CLOSED = 30;
/** Enough for any window; it bounds what one saved layout can hold. */
const MAX_TABS_PER_GROUP = 200;
const MAX_TEXT = 20_000;

const storageKey = (windowId: string) => `windowLayout.${windowId}`;

// ---------------------------------------------------------------------------
// Reading input: the renderer's changes, and layouts saved by any version.

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= 200;

const isUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/** True when `List` holds every member of `T` and nothing else: keeps a list here in step with its type. */
type Exactly<List extends readonly string[], T extends string> = [T] extends [List[number]]
  ? [List[number]] extends [T]
    ? true
    : never
  : never;

const CHECKS = [
  "checking",
  "found",
  "not-found",
  "cant-check",
  "not-checked",
  "unsupported",
  "contradicted",
] as const satisfies readonly CitationCheck[];

const REASONS = [
  "quote-not-on-pages",
  "quoted-words-not-on-pages",
  "pages-outside-passage",
  "too-many-pages",
  "in-several-places",
  "no-text",
  "kept-inside",
  "document-removed",
  "answer-limit",
  "monthly-limit",
  "small-model",
  "unsure-word",
] as const satisfies readonly CitationCheckReason[];

// The lists follow their types: a new check or reason fails the type-check until it is listed.
const _inStep: [
  Exactly<typeof CHECKS, CitationCheck>,
  Exactly<typeof REASONS, CitationCheckReason>,
] = [true, true];
void _inStep;

function parseItem(value: unknown): TabItem {
  if (isRecord(value)) {
    if (value.kind === "mind" && isId(value.mindId)) return { kind: "mind", mindId: value.mindId };
    if (value.kind === "figures" && isId(value.mindId))
      return { kind: "figures", mindId: value.mindId };
    if (value.kind === "library") return { kind: "library" };
    if (value.kind === "home") return { kind: "home" };
    if (value.kind === "document" && isId(value.documentId)) {
      return { kind: "document", documentId: value.documentId };
    }
  }
  throw new InvalidInputError("A tab shows a Note, the Library, Home or a Document.");
}

function parseCitation(value: unknown): TabCitation {
  if (!isRecord(value) || !CHECKS.includes(value.check as CitationCheck)) {
    throw new InvalidInputError("A Citation's place needs its check.");
  }
  const citation: TabCitation = { check: value.check as CitationCheck };
  // Why it can't be checked: the viewer's mark for a scan's unsure word reads it (#535).
  if (REASONS.includes(value.checkReason as CitationCheckReason)) {
    citation.checkReason = value.checkReason as CitationCheckReason;
  }
  if (value.number !== undefined) {
    if (!isUnit(value.number)) throw new InvalidInputError("A Citation's number counts from 1.");
    citation.number = value.number;
  }
  for (const key of ["label", "contentHash"] as const) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > 500) {
      throw new InvalidInputError(`A Citation's ${key} is short text.`);
    }
    citation[key] = text;
  }
  for (const key of ["pageFrom", "pageTo"] as const) {
    const unit = value[key];
    if (unit === undefined || unit === null) continue;
    if (!isUnit(unit)) throw new InvalidInputError({ key: "error.layout.units" });
    citation[key] = unit;
  }
  // A place a version of this app doesn't know is left out: the Units still open the Document.
  const location = value.location === undefined ? null : parseLocation(value.location);
  if (location) citation.location = location;
  return citation;
}

/** A paragraph's or a table's place in a Word file's main document part (`WordSource.n`). */
const WORD_PLACE = /^w:(p|tbl)#\d+$/;

function parsePlace(value: unknown): DocumentPlace {
  if (!isRecord(value)) throw new InvalidInputError("A place in a Document is an object.");
  const place: DocumentPlace = {};
  for (const key of ["pageFrom", "pageTo", "figure"] as const) {
    if (value[key] === undefined) continue;
    if (!isUnit(value[key])) throw new InvalidInputError("Units count from 1.");
    place[key] = value[key];
  }
  if (value.quote !== undefined) {
    if (typeof value.quote !== "string" || value.quote.length > MAX_TEXT) {
      throw new InvalidInputError("A quote is text.");
    }
    place.quote = value.quote;
  }
  if (value.citation !== undefined) place.citation = parseCitation(value.citation);
  if (value.currentVersion !== undefined) {
    if (value.currentVersion !== true)
      throw new InvalidInputError("A place shows the current version or not.");
    place.currentVersion = true;
  }
  if (value.wordPlace !== undefined) {
    if (typeof value.wordPlace !== "string" || !WORD_PLACE.test(value.wordPlace)) {
      throw new InvalidInputError({ key: "error.layout.wordPlace" });
    }
    place.wordPlace = value.wordPlace;
  }
  return place;
}

function parseWhere(value: unknown): OpenWhere {
  if (value === undefined) return { in: "place" };
  if (isRecord(value)) {
    if (value.in === "place" || value.in === "beside") return { in: value.in };
    if (value.in === "side" && (value.from === undefined || isId(value.from))) {
      return value.from === undefined ? { in: "side" } : { in: "side", from: value.from };
    }
    if (
      value.in === "group" &&
      (value.groupId === undefined || isId(value.groupId)) &&
      (value.before === undefined || value.before === null || isId(value.before))
    ) {
      return {
        in: "group",
        ...(value.groupId !== undefined && { groupId: value.groupId }),
        ...(value.before !== undefined && { before: value.before }),
      };
    }
  }
  throw new InvalidInputError("Open it in place, to the side, beside or in a group.");
}

const optionalBoolean = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || typeof value === "boolean") return value;
  throw new InvalidInputError(`"${name}" is true or false.`);
};

const DOCKS: readonly AssistantDock[] = ["right", "left", "bottom", "float"];
const CORNERS: readonly AssistantCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
/** Larger than any screen: it bounds what a saved layout can hold. The window fits the rest. */
const MAX_PX = 10_000;

/** A size or distance in CSS pixels, whole; null if it isn't one. */
function readPx(value: unknown, { min }: { min: number }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > MAX_PX) {
    return null;
  }
  return Math.round(value);
}

function readFloat(value: unknown): AssistantFloat | null {
  if (!isRecord(value) || !CORNERS.includes(value.corner as AssistantCorner)) return null;
  const width = readPx(value.width, { min: 1 });
  const height = readPx(value.height, { min: 1 });
  const x = readPx(value.x, { min: 0 });
  const y = readPx(value.y, { min: 0 });
  if (width === null || height === null || x === null || y === null) return null;
  return { width, height, corner: value.corner as AssistantCorner, x, y };
}

/** The assistant's place as the renderer sent it: only what it changes, each part checked. */
function parseAssistantPlace(value: unknown): Partial<AssistantPlace> {
  if (!isRecord(value)) throw new InvalidInputError("The assistant's place is an object.");
  const place: Partial<AssistantPlace> = {};
  if (value.dock !== undefined) {
    if (!DOCKS.includes(value.dock as AssistantDock)) {
      throw new InvalidInputError("The assistant docks right, left or at the bottom, or floats.");
    }
    place.dock = value.dock as AssistantDock;
  }
  const folded = optionalBoolean(value.folded, "folded");
  if (folded !== undefined) place.folded = folded;
  for (const key of ["width", "height"] as const) {
    if (value[key] === undefined) continue;
    const px = readPx(value[key], { min: 1 });
    if (px === null) throw new InvalidInputError(`The assistant's ${key} is a size in pixels.`);
    place[key] = px;
  }
  if (value.float !== undefined) {
    const float = readFloat(value.float);
    if (!float)
      throw new InvalidInputError("A floating assistant has a size, a corner and a place.");
    place.float = float;
  }
  return place;
}

/** The assistant's place as any version saved it: what this one can't read is the default. */
function readSavedAssistant(value: unknown): AssistantPlace {
  if (!isRecord(value)) return structuredClone(DEFAULT_ASSISTANT);
  return {
    dock: DOCKS.includes(value.dock as AssistantDock)
      ? (value.dock as AssistantDock)
      : DEFAULT_ASSISTANT.dock,
    folded: value.folded === true,
    width: readPx(value.width, { min: 1 }) ?? DEFAULT_ASSISTANT.width,
    height: readPx(value.height, { min: 1 }) ?? DEFAULT_ASSISTANT.height,
    float: readFloat(value.float) ?? { ...DEFAULT_ASSISTANT.float },
  };
}

function requireId(value: unknown, name: string): string {
  if (!isId(value)) throw new InvalidInputError(`The change needs its ${name}.`);
  return value;
}

/** A change as the renderer sent it, checked. */
export function parseLayoutChange(value: unknown): LayoutChange {
  if (!isRecord(value)) throw new InvalidInputError("A layout change is an object.");
  switch (value.type) {
    case "open": {
      const preview = optionalBoolean(value.preview, "preview");
      const focus = optionalBoolean(value.focus, "focus");
      const keep = optionalBoolean(value.keep, "keep");
      const behind = optionalBoolean(value.behind, "behind");
      return {
        type: "open",
        item: parseItem(value.item),
        where: parseWhere(value.where),
        ...(preview !== undefined && { preview }),
        ...(focus !== undefined && { focus }),
        ...(keep !== undefined && { keep }),
        ...(behind !== undefined && { behind }),
        ...(value.place !== undefined && { place: parsePlace(value.place) }),
      };
    }
    case "show":
    case "close":
    case "closeOthers":
    case "closeToTheRight":
    case "keep":
      return { type: value.type, tabId: requireId(value.tabId, "tab") };
    case "closeGroup":
    case "focus":
      return { type: value.type, groupId: requireId(value.groupId, "group") };
    case "reopen":
    case "equalize":
      return { type: value.type };
    case "move":
      return {
        type: "move",
        tabId: requireId(value.tabId, "tab"),
        groupId: requireId(value.groupId, "group"),
        before: value.before === null ? null : requireId(value.before, "tab to go before"),
      };
    case "split": {
      if (value.side !== "left" && value.side !== "right") {
        throw new InvalidInputError("A split goes left or right.");
      }
      const copy = optionalBoolean(value.copy, "copy");
      if (copy === undefined) throw new InvalidInputError("A split copies the tab or moves it.");
      return {
        type: "split",
        tabId: requireId(value.tabId, "tab"),
        side: value.side,
        copy,
        ...(value.groupId !== undefined && { groupId: requireId(value.groupId, "group") }),
      };
    }
    case "pin": {
      const pinned = optionalBoolean(value.pinned, "pinned");
      if (pinned === undefined) throw new InvalidInputError("Pin or unpin it.");
      return { type: "pin", tabId: requireId(value.tabId, "tab"), pinned };
    }
    case "resize": {
      const widths = value.widths;
      if (
        !Array.isArray(widths) ||
        !widths.every((width) => typeof width === "number" && Number.isFinite(width) && width > 0)
      ) {
        throw new InvalidInputError("Widths are positive numbers, one per group.");
      }
      return { type: "resize", widths: widths as number[] };
    }
    case "assistant":
      return { type: "assistant", place: parseAssistantPlace(value.place) };
    default:
      throw new InvalidInputError("That isn't a layout change.");
  }
}

/** A tab saved by any version: what this one can't read is left out. */
function readSavedTab(value: unknown): LayoutTab | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  try {
    const item = parseItem(value.item);
    return {
      id: value.id,
      item,
      preview: value.preview === true && item.kind === "document",
      pinned: value.pinned === true,
      place: value.place == null ? null : parsePlace(value.place),
      opened: isUnit(value.opened) ? value.opened : 0,
    };
  } catch {
    return null;
  }
}

function readSavedLayout(value: unknown): Layout | null {
  if (!isRecord(value) || !Array.isArray(value.groups)) return null;
  const groups: LayoutGroup[] = [];
  const seen = new Set<string>();
  for (const saved of value.groups.slice(0, MAX_TAB_GROUPS)) {
    if (!isRecord(saved) || !isId(saved.id) || !Array.isArray(saved.tabs)) continue;
    const tabs = saved.tabs
      .slice(0, MAX_TABS_PER_GROUP)
      .map(readSavedTab)
      .filter((tab): tab is LayoutTab => tab !== null && !seen.has(tab.id));
    for (const tab of tabs) seen.add(tab.id);
    const width = typeof saved.width === "number" && saved.width > 0 ? saved.width : 1;
    groups.push({
      id: saved.id,
      tabs,
      activeTabId: typeof saved.activeTabId === "string" ? saved.activeTabId : null,
      width,
    });
  }
  if (groups.length === 0) return null;
  const focused = groups.find((group) => group.id === value.focusedGroupId) ?? groups[0];
  return {
    groups,
    focusedGroupId: (focused as LayoutGroup).id,
    assistant: readSavedAssistant(value.assistant),
  };
}

// ---------------------------------------------------------------------------
// The changes.

const oneTabEach = (item: TabItem): item is { kind: "library" } | { kind: "home" } =>
  item.kind === "library" || item.kind === "home";

const sameItem = (a: TabItem, b: TabItem): boolean =>
  a.kind === b.kind &&
  (a.kind === "mind" || a.kind === "figures"
    ? a.mindId === (b as typeof a).mindId
    : a.kind === "document"
      ? a.documentId === (b as typeof a).documentId
      : true);

function emptyLayout(newId: () => string): Layout {
  const group: LayoutGroup = { id: newId(), tabs: [], activeTabId: null, width: 1 };
  return {
    groups: [group],
    focusedGroupId: group.id,
    assistant: structuredClone(DEFAULT_ASSISTANT),
  };
}

const focusedGroup = (layout: Layout): LayoutGroup =>
  (layout.groups.find((group) => group.id === layout.focusedGroupId) ??
    layout.groups[0]) as LayoutGroup;

function requireGroup(layout: Layout, groupId: string): LayoutGroup {
  const group = layout.groups.find((each) => each.id === groupId);
  if (!group) throw new InvalidInputError("This window has no such group.");
  return group;
}

function requireTab(layout: Layout, tabId: string): { group: LayoutGroup; tab: LayoutTab } {
  for (const group of layout.groups) {
    const tab = group.tabs.find((each) => each.id === tabId);
    if (tab) return { group, tab };
  }
  throw new InvalidInputError("This window has no such tab.");
}

/** Where it is open, the focused group first. */
function findOpen(layout: Layout, item: TabItem): { group: LayoutGroup; tab: LayoutTab } | null {
  const focused = focusedGroup(layout);
  for (const group of [focused, ...layout.groups.filter((each) => each !== focused)]) {
    const tab = group.tabs.find((each) => sameItem(each.item, item));
    if (tab) return { group, tab };
  }
  return null;
}

/**
 * Puts a tab in a group at `index`, or after the shown tab. Among the pinned
 * tabs it is pinned; after them it isn't.
 */
function insert(group: LayoutGroup, tab: LayoutTab, index?: number): void {
  const pinned = group.tabs.filter((each) => each.pinned).length;
  const active = group.tabs.findIndex((each) => each.id === group.activeTabId);
  const wanted = index ?? Math.max(active === -1 ? group.tabs.length : active + 1, pinned);
  const at = Math.max(0, Math.min(wanted, group.tabs.length));
  tab.pinned = at < pinned || (tab.pinned && at === pinned);
  group.tabs.splice(at, 0, tab);
}

/** Takes a tab out of its group; the tab after it (or else before it) is shown if it was. */
function takeOut(group: LayoutGroup, tab: LayoutTab): number {
  const index = group.tabs.indexOf(tab);
  group.tabs.splice(index, 1);
  if (group.activeTabId === tab.id) {
    group.activeTabId = group.tabs[Math.min(index, group.tabs.length - 1)]?.id ?? null;
  }
  return index;
}

/** A new, empty group at `at`, taking half of `beside`'s width. */
function addGroup(layout: Layout, at: number, beside: LayoutGroup, newId: () => string) {
  const group: LayoutGroup = { id: newId(), tabs: [], activeTabId: null, width: beside.width / 2 };
  beside.width /= 2;
  layout.groups.splice(at, 0, group);
  return group;
}

/**
 * Where a tab that closed goes back to: its group, made again where it was if it went with its last
 * tab; and the tab there shows the same thing already, if one does, which comes back instead.
 */
function homeFor(
  layout: Layout,
  place: TabPlace,
): { group: LayoutGroup; twin: LayoutTab | undefined } {
  const last = layout.groups.at(-1) as LayoutGroup;
  const at = Math.min(place.groupIndex, layout.groups.length);
  const neighbour = (layout.groups[at] ?? last) as LayoutGroup;
  // A group left empty by the close goes too; one made again beside it is where it was once `tidy`
  // has taken the empty one out, and it keeps the group's id so every tab that was in it comes back
  // into the one group, not one group each.
  const group =
    layout.groups.find((each) => each.id === place.groupId) ??
    (layout.groups.length < MAX_TAB_GROUPS
      ? addGroup(layout, at, neighbour, () => place.groupId)
      : neighbour);
  return { group, twin: group.tabs.find((each) => sameItem(each.item, place.tab.item)) };
}

/** The group right of `from`, made if there is room, else the one left of it. */
function sideGroup(layout: Layout, from: LayoutGroup, newId: () => string): LayoutGroup {
  if (from.tabs.length === 0) return from;
  const index = layout.groups.indexOf(from);
  const right = layout.groups[index + 1];
  if (right) return right;
  if (layout.groups.length < MAX_TAB_GROUPS) return addGroup(layout, index + 1, from, newId);
  return layout.groups[index - 1] ?? from;
}

function show(layout: Layout, group: LayoutGroup, tab: LayoutTab, focus: boolean): void {
  group.activeTabId = tab.id;
  if (focus) layout.focusedGroupId = group.id;
}

/**
 * Keeps a layout whole: no empty group beside others (its width goes to its
 * neighbour, and so does the focus), a shown tab in every group that has
 * tabs, the pinned tabs first, and widths that add up to 1.
 */
function tidy(layout: Layout): void {
  for (let index = 0; index < layout.groups.length && layout.groups.length > 1; ) {
    const group = layout.groups[index] as LayoutGroup;
    if (group.tabs.length > 0) {
      index++;
      continue;
    }
    layout.groups.splice(index, 1);
    const neighbour = (layout.groups[index - 1] ?? layout.groups[index]) as LayoutGroup;
    neighbour.width += group.width;
    if (layout.focusedGroupId === group.id) layout.focusedGroupId = neighbour.id;
  }
  for (const group of layout.groups) {
    group.tabs = [
      ...group.tabs.filter((tab) => tab.pinned),
      ...group.tabs.filter((tab) => !tab.pinned),
    ];
    if (!group.tabs.some((tab) => tab.id === group.activeTabId)) {
      group.activeTabId = group.tabs[0]?.id ?? null;
    }
  }
  if (!layout.groups.some((group) => group.id === layout.focusedGroupId)) {
    layout.focusedGroupId = (layout.groups[0] as LayoutGroup).id;
  }
  const total = layout.groups.reduce((sum, group) => sum + group.width, 0);
  for (const group of layout.groups) {
    group.width = total > 0 && group.width > 0 ? group.width / total : 1 / layout.groups.length;
  }
}

/** The tab opened behind last, and the tab that was in front of it then. */
interface OpenedBehind {
  tabId: string;
  shownId: string | null;
}

/** Applies an `open` change; returns the tab it opened behind, if it did. */
function open(
  layout: Layout,
  change: Extract<LayoutChange, { type: "open" }>,
  newId: () => string,
  openedBehind: OpenedBehind | null,
): OpenedBehind | null {
  const { item, place } = change;
  const where = change.where ?? { in: "place" };
  const behind = change.behind === true;
  const focus = change.focus !== false && !behind;
  const preview = change.preview === true && item.kind === "document";
  const update = (tab: LayoutTab) => {
    if (change.preview === false || change.keep === true) tab.preview = false;
    if (place) {
      tab.place = place;
      tab.opened += 1;
    }
  };
  const reveal = (group: LayoutGroup, tab: LayoutTab) => {
    update(tab);
    if (!behind) show(layout, group, tab, focus);
  };

  const from =
    where.in === "side" && where.from !== undefined
      ? requireGroup(layout, where.from)
      : focusedGroup(layout);
  const shown = from.tabs.find((tab) => tab.id === from.activeTabId);
  // The Library and Home have one tab per window; anything else is revealed wherever it is
  // open, and only a tab asked for in a group (Open in a new tab) can be a second one.
  const found = where.in !== "group" || oneTabEach(item) ? findOpen(layout, item) : null;
  // Showing a Document that is behind the Mind in the group it is opened from would replace
  // the Mind in view: its tab moves to the group a new tab would open in.
  const behindMind =
    found?.group === from &&
    found.tab !== shown &&
    shown?.item.kind === "mind" &&
    (item.kind === "document" || item.kind === "figures") &&
    (where.in === "side" || where.in === "beside");
  if (found && !behindMind) {
    reveal(found.group, found.tab);
    return null;
  }

  let target: LayoutGroup;
  let before: string | null | undefined;
  if (where.in === "group") {
    target =
      where.groupId === undefined ? focusedGroup(layout) : requireGroup(layout, where.groupId);
    before = where.before;
  } else if (where.in === "side") {
    target = sideGroup(layout, from, newId);
  } else if (where.in === "beside") {
    target = shown?.item.kind === "document" ? from : sideGroup(layout, from, newId);
  } else {
    target = from;
  }

  const here = target.tabs.find((tab) => sameItem(tab.item, item));
  const replaced = preview ? target.tabs.find((tab) => tab.preview) : undefined;
  if (here) {
    reveal(target, here);
  } else if (found) {
    takeOut(from, found.tab);
    update(found.tab);
    const displaced = found.tab.preview ? target.tabs.find((tab) => tab.preview) : undefined;
    if (displaced) takeOut(target, displaced);
    const pinned = target.tabs.filter((tab) => tab.pinned).length;
    insert(target, found.tab, found.tab.pinned ? pinned : undefined);
    if (!behind || target.activeTabId === null) show(layout, target, found.tab, focus);
  } else if (replaced) {
    replaced.item = item;
    replaced.place = place ?? null;
    replaced.opened += 1;
    if (!behind) show(layout, target, replaced, focus);
  } else {
    const tab: LayoutTab = {
      id: newId(),
      item,
      preview,
      pinned: false,
      place: place ?? null,
      opened: place ? 1 : 0,
    };
    const at = before ? target.tabs.findIndex((each) => each.id === before) : -1;
    // Tabs opened behind one after another keep the order they were opened in, as a browser's do.
    const chained =
      behind && openedBehind?.shownId === target.activeTabId
        ? target.tabs.findIndex((each) => each.id === openedBehind?.tabId)
        : -1;
    insert(
      target,
      tab,
      before !== undefined
        ? at === -1
          ? target.tabs.length
          : at
        : chained === -1
          ? undefined
          : chained + 1,
    );
    if (!behind || target.activeTabId === null) {
      show(layout, target, tab, focus);
      return null;
    }
    return { tabId: tab.id, shownId: target.activeTabId };
  }
  return null;
}

/** A window's layout and the tabs it closed, with every change it can take. */
class WindowState {
  constructor(
    readonly layout: Layout,
    private readonly newId: () => string,
    readonly closed: TabPlace[] = [],
  ) {}

  private openedBehind: OpenedBehind | null = null;

  private close(group: LayoutGroup, tab: LayoutTab): void {
    const groupIndex = this.layout.groups.indexOf(group);
    const index = takeOut(group, tab);
    this.closed.push({ tab, groupId: group.id, groupIndex, index });
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
  }

  /** Closes tabs right to left, so ⇧⌘T brings them back where they were. */
  private closeAll(group: LayoutGroup, tabs: LayoutTab[]): void {
    for (const tab of [...tabs].reverse()) this.close(group, tab);
  }

  apply(change: LayoutChange, valid: (item: TabItem) => boolean): void {
    const { layout, newId } = this;
    const openedBehind = this.openedBehind;
    this.openedBehind = null;
    switch (change.type) {
      case "open":
        // One already open, opened behind again, leaves the run of tabs opened behind as it was.
        this.openedBehind =
          open(layout, change, newId, openedBehind) ?? (change.behind ? openedBehind : null);
        break;
      case "show": {
        const { group, tab } = requireTab(layout, change.tabId);
        show(layout, group, tab, true);
        break;
      }
      case "close": {
        const { group, tab } = requireTab(layout, change.tabId);
        this.close(group, tab);
        break;
      }
      case "closeOthers": {
        const { group, tab } = requireTab(layout, change.tabId);
        this.closeAll(
          group,
          group.tabs.filter((each) => each !== tab && !each.pinned),
        );
        show(layout, group, tab, true);
        break;
      }
      case "closeToTheRight": {
        const { group, tab } = requireTab(layout, change.tabId);
        const after = group.tabs.slice(group.tabs.indexOf(tab) + 1);
        this.closeAll(
          group,
          after.filter((each) => !each.pinned),
        );
        break;
      }
      case "closeGroup": {
        const group = requireGroup(layout, change.groupId);
        this.closeAll(group, [...group.tabs]);
        break;
      }
      case "reopen":
        this.reopen(valid);
        break;
      case "move":
        this.move(change.tabId, change.groupId, change.before);
        break;
      case "split":
        this.split(change);
        break;
      case "keep":
        requireTab(layout, change.tabId).tab.preview = false;
        break;
      case "pin": {
        const { group, tab } = requireTab(layout, change.tabId);
        group.tabs.splice(group.tabs.indexOf(tab), 1);
        tab.pinned = change.pinned;
        if (change.pinned) tab.preview = false;
        // At the end of the pinned tabs: the last one pinned, or the first one unpinned.
        const pinned = group.tabs.filter((each) => each.pinned).length;
        group.tabs.splice(pinned, 0, tab);
        break;
      }
      case "focus":
        layout.focusedGroupId = requireGroup(layout, change.groupId).id;
        break;
      case "resize":
        if (change.widths.length !== layout.groups.length) {
          throw new InvalidInputError("Give one width per group.");
        }
        layout.groups.forEach((group, index) => {
          group.width = change.widths[index] as number;
        });
        break;
      case "equalize":
        for (const group of layout.groups) group.width = 1;
        break;
      case "assistant":
        layout.assistant = { ...layout.assistant, ...change.place };
        break;
    }
    tidy(layout);
  }

  private reopen(valid: (item: TabItem) => boolean): void {
    const { layout } = this;
    let closed = this.closed.pop();
    while (closed && !valid(closed.tab.item)) closed = this.closed.pop();
    if (!closed) return;
    const { tab, index } = closed;
    // Opened again since it closed: that tab is shown, not a second one. The
    // Library and Home have one tab per window; anything else one per group.
    const single = oneTabEach(tab.item) ? findOpen(layout, tab.item) : null;
    if (single) {
      show(layout, single.group, single.tab, true);
      return;
    }
    const { group, twin } = homeFor(layout, closed);
    if (twin) {
      show(layout, group, twin, true);
      return;
    }
    insert(group, tab, index);
    show(layout, group, tab, true);
  }

  /**
   * A tab a Mind's delete closed, back in its group at its place, shown again if it was and its
   * group focused again if it was; true when that changed the layout.
   */
  putBack(entry: GoneTab): boolean {
    const { layout } = this;
    const { group, twin } = homeFor(layout, entry);
    const tab = twin ?? entry.tab;
    let changed = false;
    if (!twin) {
      insert(group, tab, entry.index);
      changed = true;
    }
    if (entry.shown && group.activeTabId !== tab.id) {
      group.activeTabId = tab.id;
      changed = true;
    }
    if (entry.focused && layout.focusedGroupId !== group.id) {
      layout.focusedGroupId = group.id;
      changed = true;
    }
    return changed;
  }

  private move(tabId: string, groupId: string, wanted: string | null): void {
    const { layout } = this;
    const { group: from, tab } = requireTab(layout, tabId);
    const to = requireGroup(layout, groupId);
    tab.preview = false;
    const before = wanted === tab.id ? (from.tabs[from.tabs.indexOf(tab) + 1]?.id ?? null) : wanted;
    takeOut(from, tab);
    const twin = from === to ? undefined : to.tabs.find((each) => sameItem(each.item, tab.item));
    if (twin) {
      // Already open there: that tab is shown, and this one goes.
      twin.preview = false;
      show(layout, to, twin, true);
      return;
    }
    const index = before === null ? -1 : to.tabs.findIndex((each) => each.id === before);
    insert(to, tab, index === -1 ? to.tabs.length : index);
    show(layout, to, tab, true);
  }

  private split(change: Extract<LayoutChange, { type: "split" }>): void {
    const { layout } = this;
    if (layout.groups.length >= MAX_TAB_GROUPS) return;
    const { group: from, tab } = requireTab(layout, change.tabId);
    const beside = change.groupId === undefined ? from : requireGroup(layout, change.groupId);
    // The Library and Home have one tab per window: they move instead.
    const copy = change.copy && !oneTabEach(tab.item);
    if (!copy && from === beside && from.tabs.length === 1) return;
    const index = layout.groups.indexOf(beside);
    const group = addGroup(layout, change.side === "left" ? index : index + 1, beside, this.newId);
    const moved: LayoutTab = copy ? { ...structuredClone(tab), id: this.newId() } : tab;
    if (!copy) takeOut(from, tab);
    moved.preview = false;
    moved.pinned = false;
    group.tabs.push(moved);
    show(layout, group, moved, true);
  }
}

// ---------------------------------------------------------------------------

export interface LayoutDependencies {
  /** Reads and writes a per-device value (the settings' own store). */
  readValue(key: string): unknown;
  writeValue(key: string, value: unknown): void;
  mindExists(mindId: string): boolean;
  documentExists(documentId: string): boolean;
  changed(windowId: string, layout: WindowLayout): void;
  newId?: () => string;
}

const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseWindowId(value: unknown): string {
  if (typeof value !== "string" || !WINDOW_ID.test(value)) {
    throw new InvalidInputError("A window is named by a short ID.");
  }
  return value;
}

export function createLayouts(deps: LayoutDependencies) {
  const newId = deps.newId ?? randomUUID;
  const windows = new Map<string, WindowState>();

  const exists = (item: TabItem) =>
    oneTabEach(item) ||
    (item.kind === "mind" || item.kind === "figures"
      ? deps.mindExists(item.mindId)
      : deps.documentExists(item.documentId));

  /**
   * The tabs the app had before groups (the Minds open, and the Library's tab),
   * so the first start after the update opens as the last one closed.
   */
  const fromEarlierVersion = (): Layout | null => {
    const minds = deps.readValue("openMinds");
    const active = deps.readValue("activeMind");
    const library = deps.readValue("libraryTab");
    const tabs: LayoutTab[] = [];
    const tab = (item: TabItem): LayoutTab => ({
      id: newId(),
      item,
      preview: false,
      pinned: false,
      place: null,
      opened: 0,
    });
    if (library === "open" || library === "shown") tabs.push(tab({ kind: "library" }));
    if (Array.isArray(minds)) {
      for (const mindId of minds) if (isId(mindId)) tabs.push(tab({ kind: "mind", mindId }));
    }
    if (tabs.length === 0) return null;
    const shown =
      library === "shown"
        ? tabs[0]
        : tabs.find((each) => each.item.kind === "mind" && each.item.mindId === active);
    const group: LayoutGroup = {
      id: newId(),
      tabs,
      activeTabId: (shown ?? tabs[0])?.id ?? null,
      width: 1,
    };
    return {
      groups: [group],
      focusedGroupId: group.id,
      assistant: structuredClone(DEFAULT_ASSISTANT),
    };
  };

  /** Leaves out the tabs of what isn't there any more; says whether any went. */
  const prune = (layout: Layout, keep: (item: TabItem) => boolean): boolean => {
    let removed = false;
    for (const group of layout.groups) {
      const kept = group.tabs.filter((tab) => keep(tab.item));
      removed ||= kept.length !== group.tabs.length;
      group.tabs = kept;
    }
    return removed;
  };

  /** By Mind, the tabs its delete closed in each window, until a restore puts them back. */
  const gone = new Map<string, GoneTab[]>();
  /** How many closes have happened, so a restore puts back the last-closed first (see `GoneTab`). */
  let closes = 0;

  const stateOf = (windowId: string): WindowState => {
    let state = windows.get(windowId);
    if (state) return state;
    const layout =
      readSavedLayout(deps.readValue(storageKey(windowId))) ??
      (windowId === "main" ? fromEarlierVersion() : null) ??
      emptyLayout(newId);
    prune(layout, exists);
    tidy(layout);
    state = new WindowState(layout, newId);
    windows.set(windowId, state);
    return state;
  };

  const view = (state: WindowState): WindowLayout => ({
    ...structuredClone(state.layout),
    reopenable: state.closed.length,
  });

  const save = (windowId: string, state: WindowState): WindowLayout => {
    deps.writeValue(storageKey(windowId), state.layout);
    deps.changed(windowId, view(state));
    return view(state);
  };

  return {
    get(windowId: unknown): WindowLayout {
      return view(stateOf(parseWindowId(windowId)));
    },

    change(windowId: unknown, input: unknown): WindowLayout {
      const id = parseWindowId(windowId);
      const change = parseLayoutChange(input);
      if (
        change.type === "open" &&
        (change.item.kind === "mind" || change.item.kind === "figures")
      ) {
        if (!deps.mindExists(change.item.mindId))
          throw new NotFoundError({ key: "error.mind.notFound" });
      }
      const state = stateOf(id);
      state.apply(change, exists);
      return save(id, state);
    },

    /**
     * Closes the tabs of Minds deleted since, in every window open, keeping where each was so a
     * restore puts it back. A deleted Document's tab stays until closed: its viewer says what
     * happened.
     */
    forgetDeletedMinds(): void {
      const deletedMind = (item: TabItem): string | null => {
        if (item.kind !== "mind" && item.kind !== "figures") return null;
        return deps.mindExists(item.mindId) ? null : item.mindId;
      };
      for (const [windowId, state] of windows) {
        const { layout } = state;
        const closed = layout.groups.flatMap((group, groupIndex) =>
          group.tabs.flatMap((tab, index) => {
            const mindId = deletedMind(tab.item);
            return mindId === null
              ? []
              : [
                  {
                    mindId,
                    windowId,
                    tab,
                    groupId: group.id,
                    groupIndex,
                    index,
                    shown: group.activeTabId === tab.id,
                    focused: layout.focusedGroupId === group.id,
                    closedIn: closes + 1,
                  },
                ];
          }),
        );
        if (closed.length === 0) continue;
        closes += 1;
        for (const entry of closed) {
          gone.set(entry.mindId, [...(gone.get(entry.mindId) ?? []), entry]);
        }
        prune(layout, (item) => deletedMind(item) === null);
        tidy(layout);
        save(windowId, state);
      }
    },

    /** Drops what a delete kept for Minds no restore will put back: deleted for good, or restored elsewhere. */
    forgetMinds(mindIds: readonly string[]): void {
      for (const mindId of mindIds) gone.delete(mindId);
    },

    /**
     * Puts back the tabs each restored Mind's delete closed, in every window they were open in,
     * where they were and as they were. A Mind deleted before this session has none kept: its undo
     * went with the session.
     */
    reopenMinds(mindIds: readonly string[]): void {
      const byWindow = new Map<string, GoneTab[]>();
      for (const mindId of mindIds) {
        const entries = gone.get(mindId);
        if (!entries) continue;
        gone.delete(mindId);
        for (const entry of entries) {
          byWindow.set(entry.windowId, [...(byWindow.get(entry.windowId) ?? []), entry]);
        }
      }
      for (const [windowId, list] of byWindow) {
        const state = windows.get(windowId);
        if (!state) continue;
        // The last closed first: its place, and its group's, were counted in a window the earlier
        // closes had already left, so each finds the place it had once those are back. A group's own
        // tabs, closed together and counted among each other, go left to right.
        const inOrder = [...list].sort(
          (a, b) => b.closedIn - a.closedIn || a.groupIndex - b.groupIndex || a.index - b.index,
        );
        let changed = false;
        for (const entry of inOrder) changed = state.putBack(entry) || changed;
        if (!changed) continue;
        tidy(state.layout);
        save(windowId, state);
      }
    },
  };
}
