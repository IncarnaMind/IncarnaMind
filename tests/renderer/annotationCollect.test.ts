/**
 * Collect into a note (#327): its Undo takes back only the Blocks it wrote and leaves the Note it
 * made, whatever was written there since; one too big for a note is refused before a Note is made,
 * and a write that fails leaves the Note rather than deleting what may be in it.
 */
import { beforeEach, expect, test, vi } from "vitest";
import type { Annotation, AnnotationGroup } from "../../src/core/api";

const calls: { method: string; input?: unknown }[] = [];
const write = { fails: false };

vi.mock("../../src/renderer/src/conversations", () => ({
  questionOf: () => null,
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    createMind: async (input: unknown) => {
      calls.push({ method: "createMind", input });
      return { id: "collected", title: "", folderId: null };
    },
    addToNote: async (input: unknown) => {
      calls.push({ method: "addToNote", input });
      if (write.fails)
        throw new Error("addToNote takes a list of Notes, as the editor writes them.");
      return { mindId: "collected", blockIds: ["heading", "quote"] };
    },
    undoAddToNote: async (input: unknown) => {
      calls.push({ method: "undoAddToNote", input });
      return { kept: 0 };
    },
    deleteMind: async (input: unknown) => {
      calls.push({ method: "deleteMind", input });
    },
  },
}));

const reportError = vi.fn();
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({
      changeLayout: async () => true,
      reportError,
      minds: [],
      documents: [],
    }),
  },
}));

const pushed: { undo(): Promise<void> }[] = [];
vi.mock("../../src/renderer/src/undo", () => ({
  answerUndoPlace: (id: string) => `answer:${id}`,
  useUndo: {
    getState: () => ({ push: (entry: { undo(): Promise<void> }) => pushed.push(entry) }),
  },
}));

const problems: string[] = [];
vi.mock("../../src/renderer/src/notices", () => ({
  useNotices: {
    getState: () => ({
      showError: (error: Error) => problems.push(error.message),
      confirm: () => undefined,
    }),
  },
}));

const annotation = (id: string): Annotation =>
  ({
    id,
    documentId: "costs",
    documentName: "Costs",
    contentHash: "version-a",
    passageId: "passage-1",
    source: "user",
    colour: "yellow",
    quote: "A contingency of 4% is held for weather delays.",
    note: null,
    pageFrom: null,
    pageTo: null,
    location: { kind: "section", heading: "Contingency" },
    check: "found",
    checkReason: null,
    anchor: null,
    author: null,
    missing: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  }) as Annotation;

const groupOf = (count: number): AnnotationGroup[] => [
  {
    documentId: "costs",
    documentName: "Costs",
    annotations: Array.from({ length: count }, (_, at) => annotation(`a${at}`)),
  },
];

beforeEach(() => {
  calls.length = 0;
  pushed.length = 0;
  problems.length = 0;
  write.fails = false;
  reportError.mockClear();
});

test("Undo takes back the Blocks Collect wrote and leaves the Note, whatever was written since", async () => {
  const { collectIntoMind } = await import("../../src/renderer/src/annotationActions");
  await collectIntoMind(groupOf(1), null);
  const [change] = pushed;
  if (!change) throw new Error("Collect offered no Undo.");

  await change.undo();
  expect(calls.map((call) => call.method)).toEqual(["createMind", "addToNote", "undoAddToNote"]);
  expect(calls.at(-1)?.input).toEqual({ mindId: "collected", blockIds: ["heading", "quote"] });
});

test("a collection too big for one note is refused before a Note is made", async () => {
  const { collectIntoMind } = await import("../../src/renderer/src/annotationActions");
  // A heading and one quote each: 2,001 highlights are 2,002 Blocks, more than a note takes at once.
  await collectIntoMind(groupOf(2001), null);
  expect(calls).toEqual([]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/2,?001/);
});

test("a write that fails leaves the Note it made, rather than deleting what may be in it", async () => {
  const { collectIntoMind } = await import("../../src/renderer/src/annotationActions");
  write.fails = true;
  await collectIntoMind(groupOf(1), null);
  expect(calls.map((call) => call.method)).toEqual(["createMind", "addToNote"]);
  expect(reportError).toHaveBeenCalledTimes(1);
  expect(pushed).toEqual([]);
});
