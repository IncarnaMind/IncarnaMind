/**
 * Gives the look only to Blocks whose fingerprint is still the one recorded
 * at import. Every change is planned and checked before any is made.
 */
import * as Y from "yjs";
import type { NodeJSON } from "../shared/blockJson";
import { readParagraphFormat } from "../shared/paragraphFormat";
import {
  setWordSource,
  wordFingerprint,
  wordFingerprintBeforeLook,
  wordSourceOf,
} from "../shared/wordFiles";
import {
  BLOCK_ID_ATTRIBUTE,
  MIND_WORD_LOOK_FIELD,
  PARAGRAPH_FORMAT_ATTRIBUTE,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
  WORD_TAB_MARK,
  type WordLook,
  type WordSource,
} from "./api";
import { nodesByPlace, type WordStructure } from "./documents/formats/docxImport";
import { CONDITIONAL_FORMATTING_VERSION } from "./documents/formats/docxLook";
import { isRecord } from "./errors";
import { diffSteps, splitWords } from "./proposals/diff";

/** The direct formatting the look leaves to marks (`splitDirect`). */
const DIRECT_MARKS: readonly string[] = [TEXT_COLOR_MARK, SUPERSCRIPT_MARK, SUBSCRIPT_MARK];

/** The look's marks, and formatting the import reads with styles resolved. */
const GIVEN_MARKS: ReadonlySet<string> = new Set([
  WORD_RUN_MARK,
  WORD_TAB_MARK,
  "bold",
  "italic",
  "underline",
  "strike",
  ...DIRECT_MARKS,
]);

/** The attributes the look gives a node: its key, and the direct formatting it leaves out. */
const GIVEN_ATTRIBUTES = [WORD_LOOK_ATTRIBUTE, PARAGRAPH_FORMAT_ATTRIBUTE] as const;

function givenValue(node: NodeJSON, name: string): string | object | null {
  const value = node.attrs?.[name];
  return typeof value === "string" || isRecord(value) ? value : null;
}

type LookChange =
  | {
      kind: "attribute";
      element: Y.XmlElement<Record<string, string | object>>;
      name: string;
      value: string | object;
    }
  | {
      kind: "marks";
      text: Y.XmlText;
      index: number;
      length: number;
      marks: Record<string, Record<string, unknown>>;
    }
  | { kind: "source"; id: string; source: WordSource }
  | { kind: "fingerprint"; element: Y.XmlElement };

export interface LookPlan {
  changes: LookChange[];
  given: number;
  editedSinceImport: number;
}

function grouped(content: readonly NodeJSON[]): (NodeJSON[] | NodeJSON)[] {
  const groups: (NodeJSON[] | NodeJSON)[] = [];
  for (const node of content) {
    if (node.type === "text") {
      if (!node.text) continue;
      const last = groups.at(-1);
      if (Array.isArray(last)) last.push(node);
      else groups.push([node]);
    } else {
      groups.push(node);
    }
  }
  return groups;
}

const plainText = (text: Y.XmlText): string =>
  (text.toDelta() as { insert: unknown }[])
    .map((run) => (typeof run.insert === "string" ? run.insert : ""))
    .join("");

function changesFor(element: Y.XmlElement, node: NodeJSON): LookChange[] | null {
  if (element.nodeName !== node.type) return null;
  const changes: LookChange[] = [];
  for (const name of GIVEN_ATTRIBUTES) {
    const value = givenValue(node, name);
    if (value !== null) changes.push({ kind: "attribute", element, name, value });
  }
  const children = element.toArray();
  const groups = grouped(node.content ?? []);
  if (children.length !== groups.length) return null;
  for (const [index, group] of groups.entries()) {
    const child = children[index];
    if (Array.isArray(group)) {
      if (!(child instanceof Y.XmlText)) return null;
      const text = group.map((each) => each.text ?? "").join("");
      if (plainText(child) !== text) return null;
      let at = 0;
      for (const each of group) {
        const length = each.text?.length ?? 0;
        const marks = Object.fromEntries(
          (each.marks ?? [])
            .filter((mark) => GIVEN_MARKS.has(mark.type))
            .map((mark) => [mark.type, mark.attrs ?? {}]),
        );
        if (Object.keys(marks).length > 0 && length > 0) {
          changes.push({ kind: "marks", text: child, index: at, length, marks });
        }
        at += length;
      }
    } else {
      if (!(child instanceof Y.XmlElement)) return null;
      const inner = changesFor(child, group);
      if (!inner) return null;
      changes.push(...inner);
    }
  }
  return changes;
}

const span = (value: unknown) => (typeof value === "number" ? value : 1);

function looksByPosition(table: Y.XmlElement, node: NodeJSON): LookChange[] {
  const rows = table.toArray();
  const imported = node.content ?? [];
  if (table.nodeName !== "table" || rows.length !== imported.length) return [];
  const changes: LookChange[] = [];
  const give = (element: Y.XmlElement, from: NodeJSON) => {
    const key = from.attrs?.[WORD_LOOK_ATTRIBUTE];
    if (typeof key === "string") {
      changes.push({ kind: "attribute", element, name: WORD_LOOK_ATTRIBUTE, value: key });
    }
  };
  give(table, node);
  for (const [index, row] of rows.entries()) {
    const cells = row instanceof Y.XmlElement ? row.toArray() : [];
    const importedCells = imported[index]?.content ?? [];
    if (cells.length !== importedCells.length) return [];
    for (const [at, cell] of cells.entries()) {
      const from = importedCells[at];
      if (
        !(cell instanceof Y.XmlElement) ||
        !from ||
        cell.nodeName !== from.type ||
        span(cell.getAttribute("colspan")) !== span(from.attrs?.colspan) ||
        span(cell.getAttribute("rowspan")) !== span(from.attrs?.rowspan)
      ) {
        return [];
      }
      give(cell, from);
    }
  }
  return changes;
}

const TOGGLES = ["bold", "italic", "underline", "strike"] as const;
const CELLS = new Set(["tableCell", "tableHeader"]);

type Delta = { insert: unknown; attributes?: Record<string, unknown> }[];

// A look read before conditional formatting never gave these toggles, so export would write each one off.
function conditionalToggles(paragraph: Y.XmlElement, node: NodeJSON): LookChange[] {
  const cell = paragraph.parent;
  if (!(cell instanceof Y.XmlElement) || !CELLS.has(cell.nodeName)) return [];
  const imported = (node.content ?? []).filter((each) => each.type === "text" && each.text);
  const runs = paragraph.toArray().flatMap((child) => (child instanceof Y.XmlText ? [child] : []));
  const deltas = runs.map((run) => run.toDelta() as Delta);
  const changes: LookChange[] = [];
  for (const toggle of TOGGLES) {
    const mark = imported[0]?.marks?.find((each) => each.type === toggle);
    if (!mark || !imported.every((each) => each.marks?.some((m) => m.type === toggle))) continue;
    if (deltas.some((delta) => delta.some((each) => each.attributes?.[toggle] !== undefined))) {
      continue;
    }
    for (const [index, run] of runs.entries()) {
      let at = 0;
      for (const each of deltas[index] ?? []) {
        const length = typeof each.insert === "string" ? each.insert.length : 1;
        if (typeof each.insert === "string") {
          changes.push({
            kind: "marks",
            text: run,
            index: at,
            length,
            marks: { [toggle]: mark.attrs ?? {} },
          });
        }
        at += length;
      }
    }
  }
  return changes;
}

function tabMarks(element: Y.XmlElement): LookChange[] {
  const changes: LookChange[] = [];
  for (const child of element.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    let at = 0;
    for (const each of child.toDelta() as Delta) {
      if (typeof each.insert !== "string") {
        at += 1;
        continue;
      }
      if (each.attributes?.[WORD_TAB_MARK] === undefined) {
        for (
          let tab = each.insert.indexOf("\t");
          tab >= 0;
          tab = each.insert.indexOf("\t", tab + 1)
        ) {
          changes.push({
            kind: "marks",
            text: child,
            index: at + tab,
            length: 1,
            marks: { [WORD_TAB_MARK]: {} },
          });
        }
      }
      at += each.insert.length;
    }
  }
  return changes;
}

const TEXTBLOCKS = new Set(["paragraph", "heading"]);

/**
 * A paragraph the User edited keeps their text and formatting. It is given the file's direct
 * formatting it has none of: its format, and the marks of its words still as the file has them,
 * which export compares with the file's, so they aren't taken for the User's change. With
 * `restyle`, the Mind had the look before and the paragraph its look back where the look read
 * again took it away; without, it stays plain, as a Block edited before any look.
 */
function editedParagraph(element: Y.XmlElement, node: NodeJSON, restyle: boolean): LookChange[] {
  if (!TEXTBLOCKS.has(element.nodeName) || element.nodeName !== node.type) return [];
  const changes: LookChange[] = [];
  const key = givenValue(node, WORD_LOOK_ATTRIBUTE);
  if (restyle && key !== null && element.getAttribute(WORD_LOOK_ATTRIBUTE) === undefined) {
    changes.push({ kind: "attribute", element, name: WORD_LOOK_ATTRIBUTE, value: key });
  }
  const own = readParagraphFormat(element.getAttribute(PARAGRAPH_FORMAT_ATTRIBUTE));
  const format = { ...readParagraphFormat(node.attrs?.[PARAGRAPH_FORMAT_ATTRIBUTE]), ...own };
  if (JSON.stringify(format) !== JSON.stringify(own)) {
    changes.push({ kind: "attribute", element, name: PARAGRAPH_FORMAT_ATTRIBUTE, value: format });
  }
  const kept = restyle ? [...DIRECT_MARKS, WORD_RUN_MARK] : DIRECT_MARKS;
  const imported = (node.content ?? []).flatMap((each) =>
    each.type === "text" && each.text
      ? Array.from(each.text, (char) => ({
          char,
          marks: (each.marks ?? []).filter((mark) => kept.includes(mark.type)),
        }))
      : [],
  );
  if (!imported.some((each) => each.marks.length > 0)) return changes;
  const chars: { text: Y.XmlText; index: number; char: string; has: Set<string> }[] = [];
  for (const child of element.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    let at = 0;
    const delta: unknown = child.toDelta();
    for (const run of Array.isArray(delta) ? delta : []) {
      if (!isRecord(run) || typeof run.insert !== "string") {
        at += 1;
        continue;
      }
      const has = new Set(isRecord(run.attributes) ? Object.keys(run.attributes) : []);
      for (const char of run.insert) chars.push({ text: child, index: at++, char, has });
    }
  }
  const before = splitWords(imported.map((each) => each.char).join(""));
  const after = splitWords(chars.map((each) => each.char).join(""));
  let x = 0;
  let y = 0;
  let wordX = 0;
  let wordY = 0;
  for (const step of diffSteps(before, after)) {
    if (step !== "insert") {
      const length = before[wordX++]?.length ?? 0;
      for (let at = 0; step === "equal" && at < length; at++) {
        const from = imported[x + at];
        const to = chars[y + at];
        if (!from || !to) continue;
        const direct = DIRECT_MARKS.some((mark) => to.has.has(mark));
        const marks = from.marks.filter((mark) =>
          mark.type === WORD_RUN_MARK ? !to.has.has(WORD_RUN_MARK) : !direct,
        );
        if (marks.length === 0) continue;
        const given = Object.fromEntries(marks.map((mark) => [mark.type, mark.attrs ?? {}]));
        const last = changes.at(-1);
        if (
          last?.kind === "marks" &&
          last.text === to.text &&
          last.index + last.length === to.index &&
          JSON.stringify(last.marks) === JSON.stringify(given)
        ) {
          last.length++;
        } else {
          changes.push({ kind: "marks", text: to.text, index: to.index, length: 1, marks: given });
        }
      }
      x += length;
    }
    if (step !== "delete") y += after[wordY++]?.length ?? 0;
  }
  return changes;
}

const asImported = (element: Y.XmlElement, source: WordSource) =>
  wordFingerprint(element) === source.f || wordFingerprintBeforeLook(element) === source.f;

/** `previous`: the version of the look the Mind had, null for none. */
export function planLook(
  doc: Y.Doc,
  blocks: Y.XmlFragment,
  structure: WordStructure,
  previous: number | null,
): LookPlan {
  const byPlace = nodesByPlace(structure);
  const plan: LookPlan = { changes: [], given: 0, editedSinceImport: 0 };
  const given = new Set<Y.XmlElement>();
  const sourced = (element: Y.XmlElement) => {
    const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    const source = typeof id === "string" ? wordSourceOf(doc, id) : null;
    return id && source ? { id, source } : null;
  };
  const look = (element: Y.XmlElement) => {
    const found = sourced(element);
    if (found) {
      const node = byPlace.get(found.source.n);
      const changes = node && asImported(element, found.source) ? changesFor(element, node) : null;
      if (changes) {
        // Resolved formatting is content, so the fingerprints are taken again once it's given.
        plan.changes.push(...changes, { kind: "fingerprint", element });
        given.add(element);
        plan.given++;
        return;
      }
      plan.editedSinceImport++;
      if (node) plan.changes.push(...editedParagraph(element, node, previous !== null));
      if (node?.type === "table") plan.changes.push(...looksByPosition(element, node));
      if (node && (previous ?? 0) < CONDITIONAL_FORMATTING_VERSION) {
        plan.changes.push(...conditionalToggles(element, node));
      }
    }
    // The tab mark isn't content: a tab gets it whether its Block was edited or not.
    plan.changes.push(...tabMarks(element));
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlElement) look(child);
    }
  };
  // Fingerprints recorded before the look rejoined text are recorded again, so export still finds the Block unchanged.
  const recordAgain = (element: Y.XmlElement) => {
    if (given.has(element)) return;
    const found = sourced(element);
    if (found && wordFingerprintBeforeLook(element) === found.source.f) {
      const f = wordFingerprint(element);
      if (f !== found.source.f) {
        plan.changes.push({ kind: "source", id: found.id, source: { ...found.source, f } });
      }
    }
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlElement) recordAgain(child);
    }
  };
  for (const child of blocks.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    look(child);
    recordAgain(child);
  }
  return plan;
}

/**
 * Takes away the keys an earlier version gave that `look` doesn't have. Keys
 * name a look by its content, so a Block the User edited keeps every look
 * that reads the same.
 */
export function clearLook(doc: Y.Doc, blocks: Y.XmlFragment, look: WordLook): void {
  const kept = new Set(
    [look.paragraphs, look.runs, look.tables, look.cells].flatMap((styles) => Object.keys(styles)),
  );
  const stale = (key: unknown) => typeof key !== "string" || !kept.has(key);
  const clear = (element: Y.XmlElement) => {
    const key = element.getAttribute(WORD_LOOK_ATTRIBUTE);
    if (key !== undefined && stale(key)) element.removeAttribute(WORD_LOOK_ATTRIBUTE);
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlElement) clear(child);
      else if (child instanceof Y.XmlText) {
        let at = 0;
        for (const run of child.toDelta() as {
          insert: unknown;
          attributes?: Record<string, unknown>;
        }[]) {
          const length = typeof run.insert === "string" ? run.insert.length : 1;
          const mark = run.attributes?.[WORD_RUN_MARK];
          if (mark !== undefined && stale(isRecord(mark) ? mark.k : null)) {
            child.format(at, length, { [WORD_RUN_MARK]: null });
          }
          at += length;
        }
      }
    }
  };
  for (const child of blocks.toArray()) {
    if (child instanceof Y.XmlElement) clear(child);
  }
  doc.getMap(MIND_WORD_LOOK_FIELD).clear();
}

function fingerprintAgain(doc: Y.Doc, element: Y.XmlElement): void {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  const source = typeof id === "string" ? wordSourceOf(doc, id) : null;
  if (id && source) setWordSource(doc, id, { ...source, f: wordFingerprint(element) });
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlElement) fingerprintAgain(doc, child);
  }
}

export function applyLook(doc: Y.Doc, plan: LookPlan): void {
  for (const change of plan.changes) {
    if (change.kind === "attribute") {
      change.element.setAttribute(change.name, change.value);
    } else if (change.kind === "marks") {
      change.text.format(change.index, change.length, change.marks);
    } else if (change.kind === "source") {
      setWordSource(doc, change.id, change.source);
    } else {
      fingerprintAgain(doc, change.element);
    }
  }
}
