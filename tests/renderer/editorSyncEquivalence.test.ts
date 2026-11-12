import { getSchema } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import {
  initProseMirrorDoc,
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { CLAIM_CHECK_MARK, MIND_CONTENT_FIELD } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { random } from "../helpers/random";

/*
 * The editor's Yjs sync with #2988's format step writes the same Note as y-tiptap's own, with less
 * written: over a few hundred random edits to a paragraph (English, Chinese and emoji; checks side
 * by side; bold and italic over them; a line break), the Note read back is the same as with the
 * library's own formatting, which sets every run's marks again. An edit that changes no mark
 * writes no format at all, and no edit writes more formats than the library's.
 */

const schema = getSchema(noteExtensions());
const pieces = [
  "Revenue ",
  "was 10 ",
  "in May. ",
  "五月收入",
  "为10亿元。",
  "📈",
  "👩‍💻 ",
  "成本 ",
  "8. ",
];

function checkAttrs(id: string, state: string) {
  return {
    id,
    request: "check-note",
    action: "check-against-documents",
    state,
    text: id,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-12T09:00:00.000Z",
  };
}

/** Where a character starts or ends in the paragraph, never inside one: the edits keep to these. */
function boundaries(doc: ProseMirrorNode): number[] {
  const at = new Set<number>([1]);
  doc.descendants((node, pos) => {
    if (node.isText) {
      let offset = pos;
      for (const character of Array.from(node.text ?? "")) {
        at.add(offset);
        offset += character.length;
        at.add(offset);
      }
    } else if (node.isInline) {
      at.add(pos);
      at.add(pos + node.nodeSize);
    }
  });
  return [...at].sort((a, b) => a - b);
}

/** Each place's run of text: whether a place is inside one run, not at its edge. */
function insideRun(doc: ProseMirrorNode, place: number): boolean {
  const $at = doc.resolve(place);
  return $at.textOffset > 0;
}

type Pick = ReturnType<typeof random>;

function paragraph(rand: Pick): ProseMirrorNode {
  const content: ProseMirrorNode[] = [];
  const runs = 2 + Math.floor(rand.next() * 4);
  for (let index = 0; index < runs; index++) {
    if (index > 0 && rand.next() < 0.15)
      content.push(schema.nodes.hardBreak?.create() as ProseMirrorNode);
    const marks: Mark[] = [];
    const claim = schema.marks[CLAIM_CHECK_MARK];
    if (claim && rand.next() < 0.7)
      marks.push(
        claim.create(checkAttrs(`check-${index}`, rand.pick(["supported", "contradicted"]))),
      );
    if (rand.next() < 0.3) marks.push(schema.marks.bold?.create() as Mark);
    if (rand.next() < 0.2) marks.push(schema.marks.italic?.create() as Mark);
    content.push(schema.text(rand.pick(pieces) + rand.pick(pieces), marks));
  }
  return schema.node("doc", null, [schema.node("paragraph", { id: "p" }, content)]);
}

type Edit =
  | "insert inside a run"
  | "insert at an edge"
  | "delete inside a run"
  | "delete across runs"
  | "check changed"
  | "check added"
  | "bold removed"
  | "bold added"
  | "line break";

function edit(rand: Pick, doc: ProseMirrorNode, kind: Edit): Transaction {
  const tr = EditorState.create({ schema, doc }).tr;
  const places = boundaries(doc);
  const end = doc.content.size - 1;
  const inside = places.filter((place) => insideRun(doc, place));
  const edges = places.filter((place) => !insideRun(doc, place));
  const span = (from: number[]) => {
    const a = rand.pick(from);
    const b = rand.pick(places.filter((place) => place > a && place <= end));
    return [a, b ?? end] as const;
  };
  const claim = schema.marks[CLAIM_CHECK_MARK];
  switch (kind) {
    case "insert inside a run":
      return tr.insertText(rand.pick(pieces), rand.pick(inside.length ? inside : places));
    case "insert at an edge":
      return tr.insertText(rand.pick(pieces), rand.pick(edges));
    case "delete inside a run": {
      const place = rand.pick(inside.length ? inside : places);
      const next = places.find((each) => each > place);
      const $at = doc.resolve(place);
      const runEnd =
        place - $at.textOffset + ($at.parent.childAfter($at.parentOffset).node?.nodeSize ?? 0);
      return next !== undefined && next < runEnd ? tr.delete(place, next) : tr;
    }
    case "delete across runs": {
      const [a, b] = span(places);
      return tr.delete(a, b);
    }
    case "check changed": {
      let found: { from: number; to: number; mark: Mark } | null = null;
      doc.descendants((node, pos) => {
        const mark = node.marks.find((each) => each.type === claim);
        if (!found && mark && rand.next() < 0.6)
          found = { from: pos, to: pos + node.nodeSize, mark };
      });
      const target = found as { from: number; to: number; mark: Mark } | null;
      if (!target || !claim) return tr;
      return tr.addMark(
        target.from,
        target.to,
        claim.create({ ...target.mark.attrs, state: "kept", kept: true }),
      );
    }
    case "check added": {
      const [a, b] = span(places);
      return claim ? tr.addMark(a, b, claim.create(checkAttrs(`new-${a}`, "supported"))) : tr;
    }
    case "bold removed": {
      const [a, b] = span(places);
      return schema.marks.bold ? tr.removeMark(a, b, schema.marks.bold) : tr;
    }
    case "bold added": {
      const [a, b] = span(places);
      return schema.marks.bold ? tr.addMark(a, b, schema.marks.bold.create()) : tr;
    }
    case "line break":
      return tr.insert(rand.pick(places), schema.nodes.hardBreak?.create() as ProseMirrorNode);
  }
}

/** The formats an update writes. */
function formatsWritten(updates: Uint8Array[]): number {
  return updates
    .flatMap((update) => Y.decodeUpdate(update).structs)
    .filter((struct) => (struct as { content?: unknown }).content instanceof Y.ContentFormat)
    .length;
}

/** The keys of the formats a text holds, as y-tiptap reads them before an edit. */
function formatKeys(text: Y.XmlText): string[] {
  const keys = new Set<string>();
  type Item = { deleted: boolean; content: unknown; right: Item | null };
  for (let item = (text as unknown as { _start: Item | null })._start; item; item = item.right)
    if (!item.deleted && item.content instanceof Y.ContentFormat) keys.add(item.content.key);
  return [...keys];
}

/**
 * Runs y-tiptap's sync as the library ships it: each changed text gets every run's marks again,
 * as its updateYText does, in place of the format step.
 */
function libraryWrite(
  doc: Y.Doc,
  target: ProseMirrorNode,
  meta: ReturnType<typeof initProseMirrorDoc>["meta"],
) {
  const applyDelta = Y.XmlText.prototype.applyDelta;
  Y.XmlText.prototype.applyDelta = function (this: Y.XmlText, delta, options) {
    const ptexts = meta.mapping.get(this);
    // Only updateYText's formatting, all retains; a new text's first content goes in as it is.
    const formatting = delta.every((op: { retain?: number }) => op.retain !== undefined);
    if (!formatting || !Array.isArray(ptexts)) return applyDelta.call(this, delta, options);
    const cleared = Object.fromEntries(formatKeys(this).map((key) => [key, null]));
    const all = (ptexts as ProseMirrorNode[]).map((p) => ({
      retain: (p.text ?? "").length,
      attributes: {
        ...cleared,
        ...Object.fromEntries(p.marks.map((mark) => [mark.type.name, mark.attrs])),
      },
    }));
    return applyDelta.call(this, all, options);
  };
  try {
    updateYFragment(doc, doc.getXmlFragment(MIND_CONTENT_FIELD), target, meta);
  } finally {
    Y.XmlText.prototype.applyDelta = applyDelta;
  }
}

const KINDS: Edit[] = [
  "insert inside a run",
  "insert at an edge",
  "delete inside a run",
  "delete across runs",
  "check changed",
  "check added",
  "bold removed",
  "bold added",
  "line break",
];
const UNMARKED: ReadonlySet<Edit> = new Set(["insert inside a run", "delete inside a run"]);

test("over 360 random edits, the Note reads back as the library writes it, with no more formats written", () => {
  const rand = random(2988);
  let checked = 0;
  for (let round = 0; round < 40; round++) {
    for (const kind of KINDS) {
      const stored = new Y.Doc();
      prosemirrorToYXmlFragment(paragraph(rand), stored.getXmlFragment(MIND_CONTENT_FIELD));
      // As the core stores a check: only the keys it has, none of the editor's null or undefined ones.
      if (rand.next() < 0.5) {
        const text = (stored.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(0);
        if (text instanceof Y.XmlText) {
          let at = 0;
          for (const run of text.toDelta() as {
            insert: string;
            attributes?: Record<string, Record<string, unknown>>;
          }[]) {
            const check = run.attributes?.[CLAIM_CHECK_MARK];
            if (check)
              text.format(at, run.insert.length, {
                [CLAIM_CHECK_MARK]: Object.fromEntries(
                  Object.entries(check).filter(([, value]) => value != null),
                ),
              });
            at += run.insert.length;
          }
        }
      }
      const state = Y.encodeStateAsUpdate(stored);
      const ours = new Y.Doc();
      const theirs = new Y.Doc();
      Y.applyUpdate(ours, state);
      Y.applyUpdate(theirs, state);
      const oursRead = initProseMirrorDoc(ours.getXmlFragment(MIND_CONTENT_FIELD), schema);
      const theirsRead = initProseMirrorDoc(theirs.getXmlFragment(MIND_CONTENT_FIELD), schema);
      expect(theirsRead.doc.eq(oursRead.doc)).toBe(true);
      const seed = rand.next();
      const changed = edit(random(Math.floor(seed * 2 ** 31)), oursRead.doc, kind);
      const same = edit(random(Math.floor(seed * 2 ** 31)), theirsRead.doc, kind);
      expect(same.doc.eq(changed.doc)).toBe(true);
      const oursWritten: Uint8Array[] = [];
      const theirsWritten: Uint8Array[] = [];
      ours.on("update", (update: Uint8Array) => oursWritten.push(update));
      theirs.on("update", (update: Uint8Array) => theirsWritten.push(update));

      updateYFragment(ours, ours.getXmlFragment(MIND_CONTENT_FIELD), changed.doc, oursRead.meta);
      libraryWrite(theirs, same.doc, theirsRead.meta);

      const read = (doc: Y.Doc) =>
        yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(MIND_CONTENT_FIELD), schema).toJSON();
      const context = `${kind}, round ${round}`;
      expect(read(ours), context).toEqual(read(theirs));
      expect(formatsWritten(oursWritten), context).toBeLessThanOrEqual(
        formatsWritten(theirsWritten),
      );
      if (UNMARKED.has(kind)) expect(formatsWritten(oursWritten), context).toBe(0);
      checked++;
    }
  }
  expect(checked).toBe(360);
});
