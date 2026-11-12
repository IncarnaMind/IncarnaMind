import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { DOMParser } from "linkedom";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Mind } from "../../src/core/api";
import type { CommandContext } from "../../src/renderer/src/commands/registry";
import type { ObjectRef } from "../../src/renderer/src/objects";
import { documentOf } from "../helpers/storeDocuments";

/*
 * ⌘K with something selected (#1741, the nightly of 11-12): the actions on the selection, the
 * words selected in a Note or the rows chosen in a list, come before the other actions that match
 * what is typed, each part best first; with nothing typed, or nothing selected, the list is as it
 * was. The Note is a mounted editor, as the app's is: one never mounted counts as destroyed.
 */

const page = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
const bridge = new Proxy({}, { get: () => () => () => undefined });
Object.assign(page.defaultView, { incarnamind: bridge, incarnamindFiles: bridge });
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  Element: page.defaultView.Element,
  HTMLElement: page.defaultView.HTMLElement,
  HTMLInputElement: page.defaultView.HTMLInputElement,
  HTMLTextAreaElement: page.defaultView.HTMLTextAreaElement,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

await import("../../src/renderer/src/commands/app");
const palette = await import("../../src/renderer/src/palette");
const { noteHandle } = await import("../../src/renderer/src/commands/handles");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { useAppStore } = await import("../../src/renderer/src/store");
const { useSelection } = await import("../../src/renderer/src/selection");

const AT = "2026-10-13T09:00:00.000Z";
const NOTE: Mind = {
  id: "m-harbour",
  title: "Harbour times",
  autoTitle: "",
  kind: "mind",
  createdAt: AT,
  updatedAt: AT,
  folderId: null,
};
const aNote: ObjectRef = { kind: "mind", id: NOTE.id };
const twoDocuments: ObjectRef[] = [
  { kind: "document", id: "d-1" },
  { kind: "document", id: "d-2" },
];
useAppStore.setState({ documents: [documentOf("d-1"), documentOf("d-2")], minds: [NOTE] });

const CHECK = "command:check.againstDocuments";

afterEach(() => {
  useSelection.getState().clear();
  document.body.replaceChildren();
  const note = noteHandle.current;
  noteHandle.current = null;
  note?.editor.destroy();
  note?.doc.destroy();
});

/** The Note in front with `words` selected in it, and ⌘K's context as it opens with the focus nowhere. */
function withWordsSelected(words: string): CommandContext {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "harbour-block" },
          content: [{ type: "text", text: words }],
        },
      ],
    },
  });
  const { doc } = editor.state;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)),
  );
  noteHandle.current = { editor, mindId: NOTE.id, doc: new Y.Doc(), place: NOTE.id };
  return { ...palette.contextAt(null), focus: aNote };
}

const actions = (query: string, ctx: CommandContext, language: "en" | "zh-CN") =>
  palette
    .actionGroup(palette.readQuery(query).words, ctx, language, new Map())
    .flatMap((group) => group.items);
const keys = (query: string, ctx: CommandContext, language: "en" | "zh-CN" = "en") =>
  actions(query, ctx, language).map((item) => item.key);

describe("⌘K with something selected", () => {
  // protects=with a sentence selected, 核对 or "check" in ⌘K lists Check against Documents, though more actions match 核对 by name than the six ⌘K shows (palette.spec.ts:453); fails_when=the sentence's check is cut, or the other actions change order; no_claim=which commands a word finds.
  test.each([
    ["zh-CN", "核对", "港口每年公布高潮时间。"],
    ["en", "check", "Harbours publish the times of high water every year."],
  ] as const)(
    "with words selected in a Note (%s), %s lists their check first, the others as before",
    (language, query, words) => {
      const ctx = withWordsSelected(words);
      expect(ctx.textSelected).toBe(true);
      const now = keys(query, ctx, language);
      expect(now[0]).toBe(CHECK);
      expect(now.length).toBeLessThanOrEqual(6);
      const { textSelected: _, ...unranked } = ctx;
      const before = keys(query, unranked, language).filter((key) => key !== CHECK);
      expect(now.slice(1)).toEqual(before.slice(0, now.length - 1));
    },
  );

  test.each([
    ["en", "note", "Start a note from these 2 Documents", "New note"],
    ["en", "delete", "Delete 2 Documents", "Show Recently deleted"],
    ["zh-CN", "笔记", "用这 2 个文档新建笔记", "新建笔记"],
  ] as const)(
    "with Documents picked in the Library (%s), %s lists their own action first",
    (language, query, own, other) => {
      const names = actions(
        query,
        { selection: twoDocuments, focus: null, surface: "palette", picked: true },
        language,
      ).map((item) => item.name);
      expect(names[0]).toBe(own);
      expect(names).toContain(other);
    },
  );

  test("with nothing selected, the closer match comes first, as before", () => {
    // The Document in front is not a selection: New note keeps its place above its action.
    const onDocument = actions(
      "note",
      { selection: [], focus: { kind: "document", id: "d-1" }, surface: "palette" },
      "en",
    ).map((item) => item.name);
    expect(onDocument.indexOf("New note")).toBeLessThan(
      onDocument.indexOf("Start a note from this Document"),
    );
    expect(keys("check", { selection: [], focus: aNote, surface: "palette" })[0]).toBe(
      "command:mind.check",
    );
  });

  /** A row in a list marked as `surface`, which ⌘K opens from: what it acts on is that list's. */
  const rowIn = (surface: "sidebar" | "library"): Element => {
    const list = document.createElement("div");
    list.dataset.surface = surface;
    const row = document.createElement("button");
    list.append(row);
    document.body.append(list);
    return row;
  };
  const firstFrom = (row: Element, query: string, language: "en" | "zh-CN") =>
    keys(query, palette.contextAt(row), language)[0];

  // protects=from the sidebar, the row lit for the Note shown is no selection: "new" runs New note and "pdf" Export as PDF, until the User picks a row, and again after Esc (#1741); fails_when=the shown Note's actions come first with nothing picked, or a picked row's don't; no_claim=which commands a word finds.
  test.each([
    ["en", "new"],
    ["zh-CN", "新"],
  ] as const)(
    "from the sidebar (%s), the Note shown is no selection; one picked is, until Esc",
    (language, typed) => {
      const row = rowIn("sidebar");
      useSelection.getState().choose("sidebar", aNote);
      expect(firstFrom(row, typed, language)).toBe("command:mind.new");
      expect(firstFrom(row, "pdf", language)).toBe("command:mind.exportAs.pdf");
      // Shift-click on its own row picks it, the shown Note's own.
      useSelection.getState().extendTo("sidebar", aNote);
      expect(firstFrom(row, typed, language)).toBe("command:mind.openTab");
      expect(firstFrom(row, "pdf", language)).toBe("command:mind.print");
      useSelection.getState().clear();
      expect(firstFrom(row, typed, language)).toBe("command:mind.new");
    },
  );

  test.each([
    ["en", "note"],
    ["zh-CN", "笔记"],
  ] as const)(
    "in the Library (%s), the row opened is no selection; one picked is, until Esc",
    (language, typed) => {
      const row = rowIn("library");
      const opened: ObjectRef = { kind: "document", id: "d-1" };
      useSelection.getState().choose("library", opened);
      expect(firstFrom(row, typed, language)).toBe("command:mind.new");
      useSelection.getState().extendTo("library", opened);
      expect(firstFrom(row, typed, language)).toBe("command:document.startMind");
      useSelection.getState().clear();
      expect(firstFrom(row, typed, language)).toBe("command:mind.new");
    },
  );

  test("with nothing typed, the list is as it was", () => {
    const ctx = withWordsSelected("Harbours publish the times of high water.");
    const { textSelected: _, ...unranked } = ctx;
    expect(keys("", ctx)).toEqual(keys("", unranked));
    expect(keys("", { selection: [aNote], focus: null, surface: "palette" })).toEqual(
      keys("", { selection: [], focus: aNote, surface: "palette" }),
    );
  });
});
