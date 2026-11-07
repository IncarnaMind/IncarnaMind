/**
 * Annotation note drafts (#327): one per annotation, owned by the surface that
 * opened it, kept outside the components so a resize, a failed Save or a pointer
 * leaving a hovered note never loses the User's words; and a note edit's Undo
 * takes back only the field that edit changed.
 */
import { expect, test } from "vitest";
import type { Annotation } from "../../src/core/api";
import { BRIDGE_KEY } from "../../src/shared/bridge";

const updates: { note?: string | null; colour?: string }[] = [];
const bridge = {
  updateAnnotation: async (_id: string, edit: { note?: string | null; colour?: string }) => {
    updates.push(edit);
  },
  on: () => () => undefined,
  annotationCounts: async () => ({}),
};
Object.defineProperty(globalThis, "window", {
  value: {
    [BRIDGE_KEY]: bridge,
    localStorage: { getItem: () => null, setItem: () => undefined },
  },
  configurable: true,
});

test("a draft is kept outside its editor and cleared only when it ends", async () => {
  const { useAnnotationDrafts } = await import("../../src/renderer/src/annotationDrafts");
  useAnnotationDrafts.getState().begin("a", "Half a sentence", "row");
  useAnnotationDrafts.getState().write("a", "Half a sentence, and more");
  // The row unmounts across the 760px tree swap: the draft is still there for the new one.
  expect(useAnnotationDrafts.getState().drafts.a).toBe("Half a sentence, and more");
  expect(useAnnotationDrafts.getState().places.a).toBe("row");
  useAnnotationDrafts.getState().end("a");
  expect(useAnnotationDrafts.getState().drafts.a).toBeUndefined();
  expect(useAnnotationDrafts.getState().places.a).toBeUndefined();
});

test("the row and the note over the page keep their own drafts", async () => {
  const { useAnnotationDrafts } = await import("../../src/renderer/src/annotationDrafts");
  useAnnotationDrafts.getState().begin("b", "In the list", "row");
  useAnnotationDrafts.getState().begin("c", "Over the page", "note");
  expect(useAnnotationDrafts.getState().places).toMatchObject({ b: "row", c: "note" });
  useAnnotationDrafts.getState().end("b");
  expect(useAnnotationDrafts.getState().drafts.c).toBe("Over the page");
});

test("a Save that goes in after later words were typed ends only the words it saved", async () => {
  const { useAnnotationDrafts } = await import("../../src/renderer/src/annotationDrafts");
  const drafts = useAnnotationDrafts.getState();
  drafts.begin("d", "Stored note", "row");
  drafts.write("d", "Submitted A");
  // While A's Save waits, more is typed; then A's Save goes in.
  drafts.write("d", "Later B 中文");
  useAnnotationDrafts.getState().saved("d", "Submitted A");
  expect(useAnnotationDrafts.getState().drafts.d).toBe("Later B 中文");
  expect(useAnnotationDrafts.getState().places.d).toBe("row");
  // Ended and opened again before A's Save went in: the new words stay too.
  useAnnotationDrafts.getState().end("d");
  useAnnotationDrafts.getState().begin("d", "Stored note", "note");
  useAnnotationDrafts.getState().write("d", "Stored note, and C");
  useAnnotationDrafts.getState().saved("d", "Submitted A");
  expect(useAnnotationDrafts.getState().drafts.d).toBe("Stored note, and C");
  useAnnotationDrafts.getState().saved("d", "Stored note, and C");
  expect(useAnnotationDrafts.getState().drafts.d).toBeUndefined();
  expect(useAnnotationDrafts.getState().places.d).toBeUndefined();
});

test("opening the other editor carries the words the draft holds there", async () => {
  const { useAnnotationDrafts } = await import("../../src/renderer/src/annotationDrafts");
  useAnnotationDrafts.getState().begin("e", "Stored old note", "row");
  useAnnotationDrafts.getState().write("e", "Retained row draft 中文");
  useAnnotationDrafts.getState().begin("e", "Stored old note", "note");
  expect(useAnnotationDrafts.getState().drafts.e).toBe("Retained row draft 中文");
  expect(useAnnotationDrafts.getState().places.e).toBe("note");
  useAnnotationDrafts.getState().begin("e", "Stored old note", "row");
  expect(useAnnotationDrafts.getState().drafts.e).toBe("Retained row draft 中文");
  expect(useAnnotationDrafts.getState().places.e).toBe("row");
  useAnnotationDrafts.getState().end("e");
});

test("a recolour's Undo takes back the colour alone, not a newer note", async () => {
  const { editAnnotation } = await import("../../src/renderer/src/annotationActions");
  const { useUndo } = await import("../../src/renderer/src/undo");
  const annotation = {
    id: "annotation-1",
    documentId: "document-1",
    documentName: "Costs",
    contentHash: "version-a",
    passageId: "passage-1",
    source: "user",
    colour: "yellow",
    quote: "The fee is fixed.",
    note: "The note as the action saw it",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page", from: 1, to: 1 },
    check: "found",
    checkReason: null,
    anchor: null,
    author: null,
    missing: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  } as Annotation;

  expect(await editAnnotation(annotation, { colour: "pink" })).toBe(true);
  const change = useUndo.getState().done.at(-1);
  if (!change) throw new Error("The recolour wasn't on the undo stack.");
  await change.undo();

  // The second write is the Undo: only the colour, never the note that may be newer.
  expect(updates).toEqual([{ colour: "pink" }, { colour: "yellow" }]);
});

test("a missing highlight is kept in the list, not drawn on the page", async () => {
  const { highlightsOf } = await import("../../src/renderer/src/annotations");
  const pageMarks = highlightsOf([
    { id: "m1", quote: "The words.", missing: true },
    { id: "live", quote: "The words.", missing: false },
    { id: "note", quote: "", missing: false },
  ] as Annotation[]);
  expect(pageMarks.map((annotation) => annotation.id)).toEqual(["live"]);
});

test("an area highlight a version left missing is listed, not washed over its Unit", async () => {
  const { areasOf } = await import("../../src/renderer/src/annotations");
  const area = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
  const at = { kind: "page", from: 1, to: 1, area };
  const washed = areasOf([
    { id: "words", quote: "The words.", missing: false, pageFrom: 1, location: at },
    { id: "picture", quote: "", missing: false, pageFrom: 1, location: at },
    { id: "gone", quote: "The words.", missing: true, pageFrom: 1, location: at },
    { id: "text", quote: "The words.", missing: false, pageFrom: 1, location: null },
  ] as Annotation[]);
  expect(washed.map((annotation) => annotation.id)).toEqual(["words", "picture"]);
});
