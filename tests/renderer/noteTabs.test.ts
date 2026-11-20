import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { updateYFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import { blockProposal } from "../../src/core/proposals/write";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { checkRows, noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { MyNotesHistory } from "../../src/renderer/src/editor/myNotes";
import { notePlace } from "../../src/renderer/src/editor/notePlace";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  addNoteTab,
  deleteNoteTab,
  moveNoteTab,
  NoteTabs,
  noteTabsOf,
  openNoteTab,
  openTabAt,
  renameNoteTab,
  shownEnd,
  tabIndexAt,
} from "../../src/renderer/src/editor/noteTabs";
import { shownHeadings } from "../../src/renderer/src/editor/outline";
import { proposalsIn } from "../../src/renderer/src/editor/proposalReview";
import { editorExtensions } from "../helpers/editor";

function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}
const page = domDocument();
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

/*
 * Tabs in a Note (#3414): a Note stays one sequence of Blocks, a tab Block starts each tab, and
 * the page shows the tab the selection is in. Made, renamed, moved and deleted through the panel's
 * actions, each one step of Undo; the keys never take the cursor or a change out of the tab.
 */

const schema = getSchema(noteExtensions());
const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({ type: "paragraph", content: [text(value)] });
const heading = (level: number, value: string): JSONContent => ({
  type: "heading",
  attrs: { level },
  content: [text(value)],
});
const tab = (id: string, title: string): JSONContent => ({
  type: "noteTab",
  attrs: { id, title },
});
const cited = (value: string, check: "found" | "not-found"): JSONContent => ({
  type: "paragraph",
  content: [
    text(value),
    { type: "citation", attrs: { documentId: "timetable", quote: value, check } },
  ],
});

/**
 * A Note of these Blocks, as stored, in an editor on a page and bound to it, as the Note's is:
 * nothing to undo yet.
 */
function noteWith(blocks: JSONContent[], doc = new Y.Doc()): Editor {
  updateYFragment(
    doc,
    doc.getXmlFragment(MIND_CONTENT_FIELD),
    schema.nodeFromJSON({ type: "doc", content: blocks }),
    { mapping: new Map(), isOMark: new Map() },
  );
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...editorExtensions(),
      NoteTabs.configure({ mindId: "ferries" }),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      // The Note's own Undo and Redo, in place of Collaboration's.
      MyNotesHistory,
    ],
  });
  editors.push(editor);
  return editor;
}

const FERRY_REPORT = [
  tab("summary", "Summary"),
  heading(1, "Harbourline Ferries: annual report"),
  paragraph("Sailings ran on time on most days."),
  heading(2, "Highlights"),
  tab("fleet", "Fleet"),
  heading(2, "Refits"),
  paragraph("Two ferries were refitted over the winter."),
  heading(2, "Crews"),
  tab("appendix", "Appendix"),
  heading(2, "Timetables"),
  paragraph("The island routes sail every hour."),
];

const titles = (editor: Editor) => noteTabsOf(editor.state).tabs.map((each) => each.title);
const open = (editor: Editor) => noteTabsOf(editor.state).open;
const headings = (editor: Editor) => shownHeadings(editor.state).map((each) => each.text);
/** The text of each tab, Blocks joined by " / ", as a reader of the whole Note sees them. */
const tabTexts = (editor: Editor) => {
  const { doc } = editor.state;
  return noteTabsOf(editor.state).tabs.map((each) => {
    const lines: string[] = [];
    doc.nodesBetween(each.from, each.to, (node, pos) => {
      if (pos < each.from || node.type.name === "noteTab") return false;
      if (node.isTextblock) lines.push(node.textContent);
      return !node.isTextblock;
    });
    return lines.join(" / ");
  });
};
const cursorIn = (editor: Editor, words: string) => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(words)) at = pos + 1;
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
};
const said = () => "Moved";
/** The title of the tab a position is in. */
const tabTitleAt = (editor: Editor, pos: number) => {
  const { tabs } = noteTabsOf(editor.state);
  return tabs[tabIndexAt(tabs, pos)]?.title;
};

/** A key pressed in the note, as the editor's keymaps take it. */
function press(editor: Editor, key: string, mods: { mod?: boolean } = {}): void {
  const event = {
    key,
    keyCode: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: mods.mod === true,
    metaKey: mods.mod === true,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  editor.state.plugins.some(
    (plugin) => plugin.props.handleKeyDown?.call(plugin, editor.view, event) === true,
  );
}

/** What a key started settles before the next change: the guard on the keys ends with its task. */
const keyDone = () => Promise.resolve();

describe("tabs in a Note", () => {
  test("show one at a time: the tab the selection is in, its headings in the outline", () => {
    const editor = noteWith(FERRY_REPORT);
    expect(titles(editor)).toEqual(["Summary", "Fleet", "Appendix"]);
    expect(open(editor)).toBe(0);
    expect(headings(editor)).toEqual(["Harbourline Ferries: annual report", "Highlights"]);

    // The page draws the open tab alone, its first Block spaced as a Note's first Block is.
    const drawn = () =>
      [...editor.view.dom.children]
        .filter((block) => !block.classList.contains("note-tab-hidden"))
        .map(
          (block) => `${block.classList.contains("note-tab-start") ? "^" : ""}${block.textContent}`,
        );
    expect(drawn()).toEqual([
      "^Harbourline Ferries: annual report",
      "Sailings ran on time on most days.",
      "Highlights",
    ]);

    // A jump into another tab (a heading, a check, a Citation, find) opens it.
    cursorIn(editor, "island routes");
    expect(open(editor)).toBe(2);
    expect(headings(editor)).toEqual(["Timetables"]);
    expect(drawn()).toEqual(["^Timetables", "The island routes sail every hour."]);
    // Typed in, it keeps that: a new first line takes the place.
    editor.view.dispatch(
      editor.state.tr.insert(
        noteTabsOf(editor.state).tabs[2]?.from ?? 0,
        editor.state.schema.nodes.paragraph?.create(null, editor.state.schema.text("Winter")) ?? [],
      ),
    );
    expect(drawn()).toEqual(["^Winter", "Timetables", "The island routes sail every hour."]);

    // Opened from the panel, a tab gets its cursor back where it was left.
    openNoteTab(editor, 1);
    expect(open(editor)).toBe(1);
    expect(headings(editor)).toEqual(["Refits", "Crews"]);
    openNoteTab(editor, 2);
    expect(editor.state.doc.resolve(editor.state.selection.from).parent.textContent).toBe(
      "The island routes sail every hour.",
    );

    // Something shown that isn't a selection, as find's match is, opens its tab first.
    openTabAt(editor, 3);
    expect(open(editor)).toBe(0);
  });

  test("New tab makes a Note's text its first tab, ‘Tab 1’, opens ‘Tab 2’, and ⌘Z takes it back in one step", () => {
    const editor = noteWith([heading(1, "Crew rota"), paragraph("Two crews a day.")]);
    expect(titles(editor)).toEqual([]);
    const blocks = () => {
      const each: string[] = [];
      editor.state.doc.forEach((node) => {
        each.push(`${node.type.name}: ${node.textContent}`);
      });
      return each;
    };
    const before = blocks();

    const id = addNoteTab(editor, (n) => `Tab ${n}`);
    expect(noteTabsOf(editor.state).tabs.map((each) => each.id)).toEqual([expect.any(String), id]);
    expect(titles(editor)).toEqual(["Tab 1", "Tab 2"]);
    expect(open(editor)).toBe(1);
    expect(tabTexts(editor)).toEqual(["Crew rota / Two crews a day.", ""]);
    // The new tab's text is where the cursor is, to be written in.
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(tabTitleAt(editor, editor.state.selection.from)).toBe("Tab 2");

    // A third gets the next number no tab has.
    addNoteTab(editor, (n) => `Tab ${n}`);
    expect(titles(editor)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);

    editor.commands.undo();
    expect(titles(editor)).toEqual(["Tab 1", "Tab 2"]);
    editor.commands.undo();
    expect(titles(editor)).toEqual([]);
    expect(blocks()).toEqual(before);
  });

  test("rename, move and delete a tab of three, each one step of Undo", () => {
    const editor = noteWith(FERRY_REPORT);
    const texts = tabTexts(editor);

    renameNoteTab(editor, 1, "  Fleet and crews ");
    expect(titles(editor)).toEqual(["Summary", "Fleet and crews", "Appendix"]);
    // A blank name changes nothing.
    renameNoteTab(editor, 1, "  ");
    expect(titles(editor)).toEqual(["Summary", "Fleet and crews", "Appendix"]);
    editor.commands.undo();
    expect(titles(editor)).toEqual(["Summary", "Fleet", "Appendix"]);

    // Moved, a tab takes its Blocks with it, and stays open if it was.
    cursorIn(editor, "island routes");
    moveNoteTab(editor, 2, 0, (n) => `Tab ${n}`, said);
    expect(titles(editor)).toEqual(["Appendix", "Summary", "Fleet"]);
    expect(tabTexts(editor)).toEqual([texts[2], texts[0], texts[1]]);
    expect(open(editor)).toBe(0);
    moveNoteTab(editor, 0, 2, (n) => `Tab ${n}`, said);
    expect(titles(editor)).toEqual(["Summary", "Fleet", "Appendix"]);
    editor.commands.undo();
    expect(titles(editor)).toEqual(["Appendix", "Summary", "Fleet"]);
    editor.commands.undo();
    expect(titles(editor)).toEqual(["Summary", "Fleet", "Appendix"]);
    expect(tabTexts(editor)).toEqual(texts);

    // Deleted, its Blocks go with it and the tab after it opens; ⌘Z brings them all back.
    cursorIn(editor, "refitted");
    deleteNoteTab(editor, 1, said);
    expect(titles(editor)).toEqual(["Summary", "Appendix"]);
    expect(tabTexts(editor)).toEqual([texts[0], texts[2]]);
    expect(open(editor)).toBe(1);
    editor.commands.undo();
    expect(titles(editor)).toEqual(["Summary", "Fleet", "Appendix"]);
    expect(tabTexts(editor)).toEqual(texts);

    // A Note keeps one tab.
    deleteNoteTab(editor, 2, said);
    deleteNoteTab(editor, 1, said);
    deleteNoteTab(editor, 0, said);
    expect(titles(editor)).toEqual(["Summary"]);
  });

  test("the first tab of a Note written without its tab Block gains one when renamed or moved", () => {
    const editor = noteWith([
      paragraph("Sailings ran on time."),
      tab("fleet", "Fleet"),
      paragraph("Two ferries were refitted."),
    ]);
    expect(noteTabsOf(editor.state).tabs.map((each) => each.id)).toEqual([null, "fleet"]);
    moveNoteTab(editor, 0, 1, (n) => `Tab ${n}`, said);
    expect(titles(editor)).toEqual(["Fleet", "Tab 1"]);
    expect(tabTexts(editor)).toEqual(["Two ferries were refitted.", "Sailings ran on time."]);
  });

  test("the keys stay in the tab: Backspace at its start and Delete at its end do nothing, ⌘A selects it", async () => {
    const editor = noteWith(FERRY_REPORT);
    openNoteTab(editor, 1);
    const before = editor.state.doc.toJSON();
    // At the start of the tab's first line: the tab Block before it is never joined.
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    press(editor, "Backspace");
    await keyDone();
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(open(editor)).toBe(1);

    // At the end of its last line: the next tab's Block is never joined.
    const end = shownEnd(editor.state) - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    press(editor, "Delete");
    await keyDone();
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(open(editor)).toBe(1);

    press(editor, "a", { mod: true });
    await keyDone();
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to, " / ")).toBe(
      "Refits / Two ferries were refitted over the winter. / Crews",
    );

    // A selection of everything, from the Edit menu, is cut to the tab shown.
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    expect(open(editor)).toBe(1);
    const cut = editor.state.selection;
    expect(editor.state.doc.textBetween(cut.from, cut.to, " / ")).toBe(
      "Refits / Two ferries were refitted over the winter. / Crews",
    );
  });

  test("a tab left with no Blocks gets an empty line, and Add to note goes at the open tab's end", () => {
    const editor = noteWith(FERRY_REPORT);
    openNoteTab(editor, 2);
    const appendix = noteTabsOf(editor.state).tabs[2];
    if (!appendix) throw new Error("No third tab.");
    editor.view.dispatch(editor.state.tr.delete(appendix.from, appendix.to));
    expect(titles(editor)).toEqual(["Summary", "Fleet", "Appendix"]);
    expect(tabTexts(editor)[2]).toBe("");

    openNoteTab(editor, 1);
    const place = notePlace(editor.state.doc, null, shownEnd(editor.state));
    expect(tabTitleAt(editor, place.from)).toBe("Fleet");
  });

  test("the Note's check counts every tab, and its jump to the next that needs a look opens that tab", () => {
    const editor = noteWith([
      tab("summary", "Summary"),
      cited("Sailings ran on time.", "found"),
      tab("fleet", "Fleet"),
      paragraph("Two ferries were refitted."),
      tab("appendix", "Appendix"),
      cited("The island routes sail hourly.", "not-found"),
    ]);
    expect(open(editor)).toBe(0);
    const projected = claimsOf(editor.state.doc, {
      footing: "not-yet-known",
      versions: null,
      folderId: null,
      scope: null,
      figureContexts: new Map(),
    });
    const health = noteHealth(editor.state.doc, {
      ...projected,
      citationCheck: (citation) => citation.check,
    });
    expect(health.found).toHaveLength(1);
    expect(health.notFound).toHaveLength(1);
    const look = checkRows(health).find((each) => each.row === "look");
    const place = look?.places[0];
    if (place === undefined) throw new Error("Nothing needs a look.");
    expect(tabTitleAt(editor, place)).toBe("Appendix");

    // As the card's jump does: the cursor goes there, and its tab opens.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(place))),
    );
    expect(open(editor)).toBe(2);
  });

  test("a tab an agent proposes keeps its Proposal as the User writes, one change with the Block after it", () => {
    const doc = new Y.Doc();
    const proposal = blockProposal({ id: "costs", request: "agent" }, "insert", "");
    const editor = noteWith(
      [
        tab("summary", "Summary"),
        paragraph("Sailings ran on time."),
        { type: "noteTab", attrs: { id: "costs", title: "Costs", proposal } },
        { ...paragraph("Fuel cost more."), attrs: { proposal } },
      ],
      doc,
    );
    editor.view.dispatch(editor.state.tr.insertText("Most ", 3));
    const added = doc.getXmlFragment(MIND_CONTENT_FIELD).get(2);
    expect(added instanceof Y.XmlElement && added.getAttribute(PROPOSAL_ATTRIBUTE)).toEqual(
      proposal,
    );
    // The panel marks it as waiting, and no other.
    expect(noteTabsOf(editor.state).tabs.map((each) => each.proposal?.id ?? null)).toEqual([
      null,
      "costs",
    ]);
    const proposals = proposalsIn(editor.state.doc);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: "costs", block: "insert", added: "Fuel cost more." });
  });
});
