import { DOMParser } from "linkedom";
import { describe, expect, test, vi } from "vitest";

/*
 * My notes (#138) in a bound editor: a meeting's Note after the fill, with the User's lines and
 * the fill's AI lines, shown as My notes and as Notes in the same document.
 */
const page = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
class TransactionOnlyMutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const window = new Proxy(page.defaultView, {
  get: (target, name) =>
    name === "MutationObserver" ? TransactionOnlyMutationObserver : Reflect.get(target, name),
});
Object.assign(page, {
  getSelection: () => null,
  implementation: {
    createHTMLDocument: () =>
      new DOMParser().parseFromString("<html><head></head><body></body></html>", "text/html"),
  },
});
for (const [name, value] of Object.entries({
  window,
  document: page,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
})) {
  vi.stubGlobal(name, value);
}

const { Editor } = await import("@tiptap/core");
const { default: Collaboration } = await import("@tiptap/extension-collaboration");
const { Slice, Fragment } = await import("@tiptap/pm/model");
const { TextSelection } = await import("@tiptap/pm/state");
const { prosemirrorToYXmlFragment, yUndoPluginKey } = await import("@tiptap/y-tiptap");
const Y = await import("yjs");
const { GENERATED_MARK, MIND_CONTENT_FIELD } = await import("../../src/core/api");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { FindInMind, findStateOf, setFindQuery } = await import(
  "../../src/renderer/src/editor/findInMind"
);
const { MyNotes, MyNotesHistory, VisibleTextSelection, myNotesEmpty, showMyNotes } = await import(
  "../../src/renderer/src/editor/myNotes"
);

type NoteEditor = InstanceType<typeof Editor>;

const WORDS = {
  en: {
    own: "Agenda for Dana",
    heading: "Action items",
    aiLine: "Dana agreed the launch date",
    bullet: "Launch date",
    aiBullets: ["Moved to 18 November", "UK fee confirmed"],
    last: "Ask about pricing",
    summary: "Summary of the call",
    find: "launch",
    typed: "typed",
  },
  "zh-CN": {
    own: "和小王的议程",
    heading: "待办",
    aiLine: "小王同意了上线日期",
    bullet: "上线日期",
    aiBullets: ["改到 11 月 18 日", "英国费用已确认"],
    last: "问一下价格",
    summary: "通话摘要",
    find: "上线",
    typed: "补充",
  },
} as const;
type Words = (typeof WORDS)[keyof typeof WORDS];

const typed = (text: string) => ({ type: "text", text });
const ai = (text: string) => ({ type: "text", text, marks: [{ type: GENERATED_MARK }] });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const item = (...content: object[]) => ({ type: "listItem", content: [paragraph(...content)] });

/** The Note after the fill: the User's lines, and the fill's AI lines under and after them. */
const filledNote = (words: Words, withTyped = true) => ({
  type: "doc",
  content: [
    ...(withTyped
      ? [
          paragraph(typed(words.own)),
          { type: "heading", attrs: { level: 2 }, content: [typed(words.heading)] },
        ]
      : []),
    paragraph(ai(words.aiLine)),
    {
      type: "bulletList",
      content: [
        ...(withTyped ? [item(typed(words.bullet))] : []),
        ...words.aiBullets.map((each) => item(ai(each))),
      ],
    },
    ...(withTyped ? [paragraph(typed(words.last))] : []),
    paragraph(ai(words.summary)),
  ],
});

/** A note bound to a Yjs document, as the page's editor is, showing My notes or Notes. */
function noteOf(
  doc: InstanceType<typeof Y.Doc>,
  history: Partial<{ fillNext(): boolean; tell(said: string): void }> = {},
): NoteEditor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      MyNotes,
      MyNotesHistory.configure({
        fillNext: history.fillNext ?? (() => false),
        tell: history.tell ?? (() => undefined),
      }),
      FindInMind,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

function filledDoc(words: Words, withTyped = true): InstanceType<typeof Y.Doc> {
  const source = new Editor({ element: null, extensions: noteExtensions() });
  const doc = new Y.Doc();
  const node = source.schema.nodeFromJSON(filledNote(words, withTyped));
  prosemirrorToYXmlFragment(node, doc.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  return doc;
}

/** The lines the page shows, as the User reads them. */
const shownLines = (editor: NoteEditor) =>
  [...editor.view.dom.querySelectorAll("p, h1, h2, h3")]
    .filter((line) => !line.closest(".my-notes-hidden"))
    .map((line) => line.textContent ?? "");

/** Every line of the Note, as Notes shows it. */
const allLines = (editor: NoteEditor) => {
  const lines: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) lines.push(node.textContent);
  });
  return lines;
};

/** The position at the end, or `at` characters in, of the first line holding `words`. */
function inLine(editor: NoteEditor, words: string, at?: number): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === words) {
      found = pos + 1 + (at ?? node.content.size);
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`No line "${words}".`);
  return found;
}

const select = (editor: NoteEditor, anchor: number, head = anchor) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)),
  );

/** What follows is a step of its own in the Note's Undo, as after a pause in typing. */
const newStep = (editor: NoteEditor) =>
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();

const press = (editor: NoteEditor, key: string) =>
  editor.view.someProp("handleKeyDown", (handle) =>
    handle(editor.view, {
      type: "keydown",
      key,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      preventDefault() {},
    } as never),
  );

describe.each(["en", "zh-CN"] as const)("My notes (%s)", (language) => {
  const words = WORDS[language];
  const notesLines = [
    words.own,
    words.heading,
    words.aiLine,
    words.bullet,
    ...words.aiBullets,
    words.last,
    words.summary,
  ];

  // protects=My notes shows exactly the lines the User typed, a heading the fill wrote under and a bullet the fill's bullets follow among them, and nothing the fill wrote; Notes shows the same document whole (#138); fails_when=an AI line shows in My notes, a typed one doesn't, or leaving My notes leaves a line hidden; no_claim=the styling of AI text.
  test("shows the typed lines only, and Notes shows everything again", () => {
    const editor = noteOf(filledDoc(words));
    showMyNotes(editor, true);
    expect(shownLines(editor)).toEqual([words.own, words.heading, words.bullet, words.last]);
    showMyNotes(editor, false);
    expect(shownLines(editor)).toEqual(notesLines);
    editor.destroy();
  });

  // protects=an edit in My notes is the same line in Notes, in this copy and in another copy of the Note (#138); fails_when=the edit lands in a copy of the line, or Notes doesn't show it; no_claim=the core's storage.
  test("an edit in My notes is the same line in Notes, in another copy too", () => {
    const doc = filledDoc(words);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    doc.on("update", (update: Uint8Array) => Y.applyUpdate(other, update));
    const editor = noteOf(doc);
    const notes = noteOf(other);
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.bullet));
    editor.view.dispatch(editor.state.tr.insertText(` ${words.typed}`));
    showMyNotes(editor, false);
    expect(allLines(editor)).toContain(`${words.bullet} ${words.typed}`);
    expect(allLines(notes)).toEqual(
      notesLines.map((line) => (line === words.bullet ? `${line} ${words.typed}` : line)),
    );
    editor.destroy();
    notes.destroy();
  });

  // protects=Select all then Delete, or typing over it, or a paste over it, in My notes takes out only what shows: the fill's lines stay in Notes (#138); fails_when=a hidden line is deleted or replaced; no_claim=the browser's own selection drawing.
  test.each(["delete", "type", "paste"] as const)(
    "a selection across hidden lines, then %s, changes only what shows",
    (how) => {
      const editor = noteOf(filledDoc(words));
      showMyNotes(editor, true);
      editor.commands.selectAll();
      expect(editor.state.selection).toBeInstanceOf(VisibleTextSelection);
      if (how === "delete") editor.view.dispatch(editor.state.tr.deleteSelection());
      if (how === "type") {
        editor.view.someProp("handleTextInput", (handle) =>
          handle(editor.view, editor.state.selection.from, editor.state.selection.to, "x", () =>
            editor.state.tr.insertText("x"),
          ),
        );
      }
      if (how === "paste") {
        const pasted = editor.schema.text(words.typed);
        editor.view.dispatch(
          editor.state.tr.replaceSelection(new Slice(Fragment.from(pasted), 0, 0)),
        );
      }
      const left = how === "delete" ? "" : how === "type" ? "x" : words.typed;
      showMyNotes(editor, false);
      const lines = allLines(editor).filter((line) => line !== "");
      expect(lines).toEqual([
        ...(left ? [left] : []),
        words.aiLine,
        ...words.aiBullets,
        words.summary,
      ]);
      editor.destroy();
    },
  );

  // protects=a copy, or the copy a cut makes, from a selection across hidden lines holds only the lines that show, in their order (#138); fails_when=the copy holds the fill's lines; no_claim=the clipboard's formats, which the window test reads.
  test("a copy across hidden lines holds what shows", () => {
    const editor = noteOf(filledDoc(words));
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.own, 0), inLine(editor, words.last));
    const copied = editor.state.selection.content();
    expect(copied.content.textBetween(0, copied.content.size, "\n")).toBe(
      [words.own, words.heading, words.bullet, words.last].join("\n"),
    );
    editor.destroy();
  });

  // protects=Enter at the end of the User's bullet that the fill's bullets follow makes the User's new line before them, and Backspace or Delete beside hidden lines joins the nearest line that shows, never a hidden one (#138); fails_when=the new line lands among the fill's, or a join takes words into a hidden line; no_claim=list styling.
  test("Enter, Backspace and Delete beside hidden lines keep to what shows", () => {
    const editor = noteOf(filledDoc(words));
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.bullet));
    editor.commands.splitListItem("listItem");
    editor.view.dispatch(editor.state.tr.insertText(words.typed));
    expect(shownLines(editor)).toEqual([
      words.own,
      words.heading,
      words.bullet,
      words.typed,
      words.last,
    ]);

    select(editor, inLine(editor, words.heading));
    expect(press(editor, "Delete")).toBe(true);
    select(editor, inLine(editor, words.last, 0));
    expect(press(editor, "Backspace")).toBe(true);
    expect(shownLines(editor)).toEqual([
      words.own,
      `${words.heading}${words.bullet}`,
      `${words.typed}${words.last}`,
    ]);

    showMyNotes(editor, false);
    expect(allLines(editor)).toEqual([
      words.own,
      `${words.heading}${words.bullet}`,
      words.aiLine,
      `${words.typed}${words.last}`,
      ...words.aiBullets,
      words.summary,
    ]);
    editor.destroy();
  });

  // protects=no change of the User's in My notes reaches a hidden line: a mark across one, a direct deletion of one, a drag of a selection across one; the cursor never rests in one; the Mind's document still changes it (#138); fails_when=a hidden line is bolded, deleted or dragged from My notes, or a change from another copy is refused; no_claim=what the browser draws while dragging.
  test("nothing done in My notes reaches a hidden line, and the Note's own changes still do", () => {
    const doc = filledDoc(words);
    const editor = noteOf(doc);
    showMyNotes(editor, true);
    editor.commands.selectAll();
    editor.commands.toggleBold();
    showMyNotes(editor, false);
    let bold = 0;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "bold")) {
        expect(node.marks.some((mark) => mark.type.name === GENERATED_MARK)).toBe(false);
        bold++;
      }
    });
    expect(bold).toBe(4);
    showMyNotes(editor, true);

    const summary = inLine(editor, words.summary, 0) - 1;
    const line = editor.state.doc.nodeAt(summary);
    if (!line) throw new Error("No summary line.");
    const before = editor.state.doc;
    editor.view.dispatch(editor.state.tr.delete(summary, summary + line.nodeSize));
    expect(editor.state.doc.eq(before)).toBe(true);

    select(editor, inLine(editor, words.aiLine, 2));
    expect([words.heading, words.bullet]).toContain(
      editor.state.selection.$from.parent.textContent,
    );

    let prevented = false;
    editor.commands.selectAll();
    editor.view.someProp("handleDOMEvents", (handlers) =>
      handlers.dragstart?.(editor.view, {
        preventDefault: () => {
          prevented = true;
        },
      } as never),
    );
    expect(prevented).toBe(true);

    // Another copy deletes the summary: it goes from here too.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.on("update", (update: Uint8Array) => Y.applyUpdate(doc, update));
    const fragment = other.getXmlFragment(MIND_CONTENT_FIELD);
    fragment.delete(fragment.length - 1, 1);
    showMyNotes(editor, false);
    expect(allLines(editor)).not.toContain(words.summary);
    editor.destroy();
  });

  // protects=Find in My notes finds and counts only the lines that show, and Notes finds them all again (#138); fails_when=the count includes a hidden line, or stays stale after switching; no_claim=the bar's drawing.
  test("Find counts only what shows", () => {
    const editor = noteOf(filledDoc(words));
    setFindQuery(editor, words.find);
    expect(findStateOf(editor).matches).toHaveLength(2);
    showMyNotes(editor, true);
    expect(findStateOf(editor).matches).toHaveLength(1);
    showMyNotes(editor, false);
    expect(findStateOf(editor).matches).toHaveLength(2);
    editor.destroy();
  });

  // protects=⌘Z in My notes takes back what the User did there; it doesn't run the fill's own step, and says so; a step that changed hidden lines only runs and says it did (#138); fails_when=the fill is taken back unseen from My notes, or a hidden change is undone with nothing said; no_claim=the line's drawing.
  test("Undo takes back the User's own step, not the fill's, and says when a step changed only hidden lines", () => {
    const said: string[] = [];
    let fillNext = false;
    const editor = noteOf(filledDoc(words), {
      fillNext: () => fillNext,
      tell: (each) => said.push(each),
    });
    // In Notes, the User takes out a word of the fill's summary.
    select(editor, inLine(editor, words.summary, 0), inLine(editor, words.summary, 1));
    editor.view.dispatch(editor.state.tr.deleteSelection());
    // In My notes, the User types into their own line.
    newStep(editor);
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.own));
    editor.view.dispatch(editor.state.tr.insertText(words.typed));

    editor.commands.undo();
    expect(shownLines(editor)[0]).toBe(words.own);
    expect(said).toEqual([]);

    editor.commands.undo();
    expect(said).toEqual(["undidHidden"]);
    showMyNotes(editor, false);
    expect(allLines(editor)).toContain(words.summary);
    showMyNotes(editor, true);

    fillNext = true;
    const before = editor.state.doc;
    editor.commands.redo();
    expect(said).toEqual(["undidHidden", "fillRedo"]);
    expect(editor.state.doc.eq(before)).toBe(true);
    editor.destroy();
  });

  // protects=before the fill lands, and after it is taken back or fails, My notes shows the Note as typed, every line of it (#138); fails_when=a typed line hides with no fill to hide; no_claim=the fill's own states, which the window test reads.
  test("with no AI line, everything typed shows", () => {
    const doc = new Y.Doc();
    const source = new Editor({ element: null, extensions: noteExtensions() });
    const typedOnly = source.schema.nodeFromJSON({
      type: "doc",
      content: [paragraph(typed(words.own)), paragraph(), paragraph(typed(words.last))],
    });
    prosemirrorToYXmlFragment(typedOnly, doc.getXmlFragment(MIND_CONTENT_FIELD));
    source.destroy();
    const editor = noteOf(doc);
    showMyNotes(editor, true);
    expect(shownLines(editor)).toEqual([words.own, "", words.last]);
    expect(myNotesEmpty(editor.state)).toBe(false);
    editor.destroy();
  });

  // protects=with no typed line, My notes says the User typed none; with one, it doesn't (#138); fails_when=an empty My notes says nothing, or one with lines says it is empty; no_claim=the line's wording, which the window test reads.
  test("with no typed line it says so", () => {
    const empty = noteOf(filledDoc(words, false));
    showMyNotes(empty, true);
    expect(shownLines(empty)).toEqual([]);
    expect(myNotesEmpty(empty.state)).toBe(true);
    const full = noteOf(filledDoc(words));
    showMyNotes(full, true);
    expect(myNotesEmpty(full.state)).toBe(false);
    empty.destroy();
    full.destroy();
  });
});
