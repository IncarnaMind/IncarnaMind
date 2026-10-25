/**
 * Each style table is stored as one whole value rather than nested Y types:
 * styles never change once read, and two devices reading the same package
 * write the same values. What is read is checked value by value, since
 * another device wrote it and the editor turns it into CSS.
 */
import type * as Y from "yjs";
import {
  MIND_SETTINGS_FIELD,
  MIND_WORD_LOOK_FIELD,
  WORD_RUN_MARK,
  type WordBorder,
  type WordCellLook,
  type WordLook,
  type WordParagraphLook,
  type WordRunLook,
  type WordTableLook,
  type WordTabStop,
  type WordWidth,
} from "../core/api";
import { isRecord } from "../core/errors";
import type { NodeJSON } from "./blockJson";

const lookMap = (doc: Y.Doc) => doc.getMap<unknown>(MIND_WORD_LOOK_FIELD);

export function setWordLook(doc: Y.Doc, look: WordLook): void {
  const map = lookMap(doc);
  map.set("paragraphs", look.paragraphs);
  map.set("runs", look.runs);
  map.set("tables", look.tables);
  map.set("cells", look.cells);
  map.set("body", look.body);
  map.set("width", look.width);
  map.set("defaultTab", look.defaultTab);
  if (look.tablesHang) map.set("tablesHang", true);
  else map.delete("tablesHang");
  map.set("version", look.version);
}

/** The key of the run look a text node's mark names; null for none. */
export function runLookOf(node: NodeJSON): string | null {
  const key = node.marks?.find((mark) => mark.type === WORD_RUN_MARK)?.attrs?.k;
  return typeof key === "string" ? key : null;
}

const KEY = /^[prtc][0-9a-z]{1,16}$/;
const HEX = /^[0-9A-F]{6}$/i;
const WORD_NAME = /^[A-Za-z]{1,32}$/;
// Font names go into CSS strings: nothing that could end one.
const FONT = /^[^"\\{};<>\p{Cc}]{1,64}$/u;

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const within = (low: number, high: number) => (value: unknown) => {
  const points = num(value);
  return points === undefined || points <= 0 ? undefined : Math.min(high, Math.max(low, points));
};
// Word's own ranges, in points: font sizes, and the spacing of default tab stops (up to 22 in).
const size = within(1, 1638);
const tabSpacing = within(1, 1584);
const hex = (value: unknown) =>
  typeof value === "string" && HEX.test(value) ? value.toUpperCase() : undefined;
const font = (value: unknown) =>
  typeof value === "string" && FONT.test(value) ? value : undefined;
const wordName = (value: unknown) =>
  typeof value === "string" && WORD_NAME.test(value) ? value : undefined;
const key = (value: unknown) => (typeof value === "string" && KEY.test(value) ? value : undefined);
const yes = (value: unknown) => (value === true ? (true as const) : undefined);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | undefined =>
  values.find((each) => each === value);

/** Drops unset keys, so equal looks serialise equal. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

function sides<Side extends string, V>(
  value: unknown,
  names: readonly Side[],
  read: (side: unknown) => V | undefined,
): Partial<Record<Side, V>> | undefined {
  if (!isRecord(value)) return undefined;
  const kept: Partial<Record<Side, V>> = {};
  for (const name of names) {
    const side = read(value[name]);
    if (side !== undefined) kept[name] = side;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function border(value: unknown): WordBorder | undefined {
  if (!isRecord(value)) return undefined;
  const style = wordName(value.style);
  const width = num(value.width);
  const space = num(value.space);
  if (style === undefined || width === undefined || space === undefined) return undefined;
  return { style, width, color: hex(value.color) ?? null, space };
}

function width(value: unknown): WordWidth | undefined {
  if (!isRecord(value)) return undefined;
  const amount = num(value.value);
  const unit = oneOf(value.unit, ["pt", "percent"] as const);
  return amount !== undefined && unit ? { value: amount, unit } : undefined;
}

const BOX = ["top", "bottom", "left", "right"] as const;

const borders = <Side extends string>(value: unknown, names: readonly Side[]) =>
  sides(value, names, border);

const margins = (value: unknown) => sides(value, BOX, num);

function runLook(value: Record<string, unknown>): WordRunLook {
  return defined({
    font: font(value.font),
    eastAsia: font(value.eastAsia),
    size: size(value.size),
    color: hex(value.color),
    highlight: wordName(value.highlight),
    shade: hex(value.shade),
    bold: yes(value.bold),
    italic: yes(value.italic),
    underline: wordName(value.underline),
    strike: yes(value.strike),
    doubleStrike: yes(value.doubleStrike),
    caps: yes(value.caps),
    smallCaps: yes(value.smallCaps),
    vertical: oneOf(value.vertical, ["superscript", "subscript"] as const),
    letterSpacing: num(value.letterSpacing),
    widthPercent: num(value.widthPercent),
    hidden: yes(value.hidden),
  });
}

function tab(value: unknown): WordTabStop[] {
  if (!isRecord(value)) return [];
  const at = num(value.at);
  const align = oneOf(value.align, ["left", "center", "right", "decimal", "bar"] as const);
  const leader = oneOf(value.leader, [
    "none",
    "dot",
    "hyphen",
    "underscore",
    "heavy",
    "middleDot",
  ] as const);
  return at !== undefined && align && leader ? [{ at, align, leader }] : [];
}

function paragraphLook(value: Record<string, unknown>): WordParagraphLook {
  const line = isRecord(value.line) ? value.line : null;
  const rule = oneOf(line?.rule, ["auto", "exact", "atLeast"] as const);
  const lineValue = num(line?.value);
  const tabs = Array.isArray(value.tabs) ? value.tabs.flatMap(tab) : [];
  return defined({
    run: key(value.run),
    next: key(value.next),
    characterSize: size(value.characterSize),
    align: oneOf(value.align, ["left", "center", "right", "justify", "distribute"] as const),
    left: num(value.left),
    right: num(value.right),
    firstLine: num(value.firstLine),
    before: num(value.before),
    after: num(value.after),
    line: rule && lineValue !== undefined ? { rule, value: lineValue } : undefined,
    contextual: yes(value.contextual),
    tabs: tabs.length > 0 ? tabs : undefined,
    shade: hex(value.shade),
    borders: borders(value.borders, [...BOX, "between"] as const),
    keepNext: yes(value.keepNext),
    keepLines: yes(value.keepLines),
    pageBreakBefore: yes(value.pageBreakBefore),
    widowControl: value.widowControl === false ? false : undefined,
  });
}

function tableLook(value: Record<string, unknown>): WordTableLook {
  const columns = Array.isArray(value.columns)
    ? value.columns.flatMap((each) => num(each) ?? [])
    : [];
  return defined({
    width: width(value.width),
    align: oneOf(value.align, ["left", "center", "right"] as const),
    indent: num(value.indent),
    borders: borders(value.borders, [...BOX, "insideH", "insideV"] as const),
    margins: margins(value.margins),
    fixed: yes(value.fixed),
    columns: columns.length > 0 ? columns : undefined,
  });
}

function cellLook(value: Record<string, unknown>): WordCellLook {
  return defined({
    width: width(value.width),
    shade: hex(value.shade),
    borders: borders(value.borders, BOX),
    vertical: oneOf(value.vertical, ["top", "center", "bottom"] as const),
    margins: margins(value.margins),
    noWrap: yes(value.noWrap),
  });
}

function styles<T>(value: unknown, read: (style: Record<string, unknown>) => T) {
  const kept: Record<string, T> = {};
  if (!isRecord(value)) return kept;
  for (const [name, style] of Object.entries(value)) {
    if (KEY.test(name) && isRecord(style)) kept[name] = read(style);
  }
  return kept;
}

export function wordLookOf(doc: Y.Doc): WordLook | null {
  const map = lookMap(doc);
  const version = num(map.get("version"));
  if (version === undefined) return null;
  return {
    version,
    body: size(map.get("body")) ?? null,
    width: num(map.get("width")) ?? null,
    defaultTab: tabSpacing(map.get("defaultTab")) ?? null,
    ...(map.get("tablesHang") === true && { tablesHang: true as const }),
    paragraphs: styles(map.get("paragraphs"), paragraphLook),
    runs: styles(map.get("runs"), runLook),
    tables: styles(map.get("tables"), tableLook),
    cells: styles(map.get("cells"), cellLook),
  };
}

export type MindLook = "word" | "plain";

const MIND_LOOK_KEY = "look";

export const mindLookOf = (doc: Y.Doc): MindLook =>
  doc.getMap<unknown>(MIND_SETTINGS_FIELD).get(MIND_LOOK_KEY) === "plain" ? "plain" : "word";

export function setMindLook(doc: Y.Doc, look: MindLook): void {
  doc.getMap<unknown>(MIND_SETTINGS_FIELD).set(MIND_LOOK_KEY, look);
}

export function observeWordLook(doc: Y.Doc, listener: () => void): () => void {
  const looks = lookMap(doc);
  const settings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
  const onSettings = (event: Y.YMapEvent<unknown>) => {
    if (event.keysChanged.has(MIND_LOOK_KEY)) listener();
  };
  looks.observe(listener);
  settings.observe(onSettings);
  return () => {
    looks.unobserve(listener);
    settings.unobserve(onSettings);
  };
}
