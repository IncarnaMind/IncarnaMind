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
const { NodeSelection, TextSelection } = await import("@tiptap/pm/state");
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
const { selectionForEdit } = await import("../../src/renderer/src/editor/editSelection");

type NoteEditor = InstanceType<typeof Editor>;

const WORDS = {
  en: {
    own: "Agenda for Dana",
    heading: "Action items",
    aiLine: "Dana agreed the launch date",
    bullet: "Launch date",
    facts: ["Moved to 18 November", "UK fee confirmed"],
    last: "Ask about pricing",
    section: "Summary",
    summary: "Summary of the call",
    find: "launch",
    typed: "typed",
    cells: ["Owner", "Date", "Dana", "18 Nov"],
  },
  "zh-CN": {
    own: "和小王的议程",
    heading: "待办",
    aiLine: "小王同意了上线日期",
    bullet: "上线日期",
    facts: ["改到 11 月 18 日", "英国费用已确认"],
    last: "问一下价格",
    section: "摘要",
    summary: "通话摘要",
    find: "上线",
    typed: "补充",
    cells: ["负责人", "日期", "小王", "11 月 18 日"],
  },
} as const;
type Words = (typeof WORDS)[keyof typeof WORDS];

const typed = (text: string) => ({ type: "text", text });
const ai = (text: string) => ({ type: "text", text, marks: [{ type: GENERATED_MARK }] });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const heading = (...content: object[]) => ({ type: "heading", attrs: { level: 2 }, content });
const item = (...content: object[]) => ({ type: "listItem", content });
const list = (...content: object[]) => ({ type: "bulletList", content });
const cell = (role: "tableHeader" | "tableCell", text: object) => ({
  type: role,
  content: [paragraph(text)],
});

/**
 * The Note after the fill, as the fill writes it (core/meetings/fill.ts, `placeUnder`): what it
 * found under a heading of the User's follows the heading; under a line in a list, it goes in the
 * line's own item, after the line; its own sections close the Note, under AI headings.
 */
const filledNote = (words: Words, withTyped = true) => ({
  type: "doc",
  content: [
    ...(withTyped ? [paragraph(typed(words.own)), heading(typed(words.heading))] : []),
    paragraph(ai(words.aiLine)),
    list(
      item(
        ...(withTyped ? [paragraph(typed(words.bullet))] : []),
        paragraph(ai(words.facts[0])),
        list(item(paragraph(ai(words.facts[1])))),
      ),
    ),
    ...(withTyped ? [paragraph(typed(words.last))] : []),
    heading(ai(words.section)),
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
        fillState: () => null,
        tell: history.tell ?? (() => undefined),
      }),
      FindInMind,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

function docOf(content: object): InstanceType<typeof Y.Doc> {
  const source = new Editor({ element: null, extensions: noteExtensions() });
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(
    source.schema.nodeFromJSON(content),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  source.destroy();
  return doc;
}

const filledDoc = (words: Words, withTyped = true) => docOf(filledNote(words, withTyped));

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

/** The lines of the list item whose first line is `first`. */
const itemOf = (editor: NoteEditor, first: string) => {
  let lines: string[] | null = null;
  editor.state.doc.descendants((node) => {
    if (lines || node.type.name !== "listItem" || node.firstChild?.textContent !== first) {
      return !lines;
    }
    const found: string[] = [];
    node.descendants((line) => {
      if (line.isTextblock) found.push(line.textContent);
    });
    lines = found;
    return false;
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

/** A key My notes answers, before the editor's own keys: true when it took it. */
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

const nonEmpty = (lines: readonly string[]) => lines.filter((line) => line !== "");

describe.each(["en", "zh-CN"] as const)("My notes (%s)", (language) => {
  const words = WORDS[language];
  const notesLines = [
    words.own,
    words.heading,
    words.aiLine,
    words.bullet,
    ...words.facts,
    words.last,
    words.section,
    words.summary,
  ];
  const fillLines = [words.aiLine, ...words.facts, words.section, words.summary];

  // protects=My notes shows exactly the lines the User typed, a heading the fill wrote under and a line whose own item holds the fill's facts among them, and nothing the fill wrote; Notes shows the same document whole (#138); fails_when=an AI line shows in My notes, a typed one doesn't, or leaving My notes leaves a line hidden; no_claim=the styling of AI text.
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
    expect(allLines(notes)).toEqual(
      notesLines.map((line) => (line === words.bullet ? `${line} ${words.typed}` : line)),
    );
    editor.destroy();
    notes.destroy();
  });

  // protects=Select all then Delete, or typing over it, or a paste over it, in My notes takes out only the words that show: the fill's lines stay in Notes, each in its place (#138); fails_when=a hidden line is deleted, replaced or moved; no_claim=the browser's own selection drawing.
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
      const first = how === "delete" ? "" : how === "type" ? "x" : words.typed;
      showMyNotes(editor, false);
      // The User's lines go, as in Notes, but the first, which takes what is typed, and the
      // empty line of the item that holds the fill's facts.
      expect(allLines(editor)).toEqual([
        first,
        words.aiLine,
        "",
        ...words.facts,
        words.section,
        words.summary,
      ]);
      expect(itemOf(editor, "")).toEqual(["", ...words.facts]);
      editor.destroy();
    },
  );

  // protects=a copy from a selection across hidden lines, or from a selected Block holding some, holds only the lines that show, in their order; such a Block selection acts on what shows (#138); fails_when=the copy holds the fill's lines; no_claim=the clipboard's formats, which the window test reads.
  test("a copy across hidden lines, or of a Block holding some, holds what shows", () => {
    const editor = noteOf(filledDoc(words));
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.own, 0), inLine(editor, words.last));
    const copied = editor.state.selection.content();
    expect(copied.content.textBetween(0, copied.content.size, "\n")).toBe(
      [words.own, words.heading, words.bullet, words.last].join("\n"),
    );
    const listAt = inLine(editor, words.bullet, 0) - 3;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, listAt)),
    );
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    const block = editor.state.selection.content();
    expect(block.content.textBetween(0, block.content.size, "\n")).toBe(words.bullet);
    editor.destroy();
  });

  // protects=AI words selected inside a line the User typed are copied, and a cut takes out exactly them and keeps them: only lines the page hides are left out of a copy (#138); fails_when=the copy is empty while the cut deletes the words; no_claim=the clipboard's HTML.
  test("AI words inside a typed line copy and cut as they show", () => {
    const mixed = `${words.own}${words.aiLine}`;
    const editor = noteOf(
      docOf({ type: "doc", content: [paragraph(typed(words.own), ai(words.aiLine))] }),
    );
    showMyNotes(editor, true);
    select(editor, inLine(editor, mixed, words.own.length), inLine(editor, mixed));
    const copied = editor.view.serializeForClipboard(editor.state.selection.content());
    expect(copied.text).toBe(words.aiLine);
    editor.view.dispatch(editor.state.tr.deleteSelection());
    expect(shownLines(editor)).toEqual([words.own]);
    editor.destroy();
  });

  // protects=Enter in the User's line whose own item holds the fill's facts starts the next item after them, the rest of the line in it, so no fact moves under the new line (#138); fails_when=Enter splits the item and the facts follow the new line; no_claim=list styling.
  test.each([
    ["at its end", undefined],
    ["in its middle", 2],
  ] as const)(
    "Enter %s in a line whose item holds hidden facts keeps them with the line",
    (_where, at) => {
      const editor = noteOf(filledDoc(words));
      showMyNotes(editor, true);
      select(editor, inLine(editor, words.bullet, at));
      expect(press(editor, "Enter")).toBe(true);
      editor.view.dispatch(editor.state.tr.insertText(words.typed));
      const head = at === undefined ? words.bullet : words.bullet.slice(0, at);
      const tail = at === undefined ? "" : words.bullet.slice(at);
      expect(shownLines(editor)).toEqual([
        words.own,
        words.heading,
        head,
        `${words.typed}${tail}`,
        words.last,
      ]);
      expect(itemOf(editor, head)).toEqual([head, ...words.facts]);
      expect(itemOf(editor, `${words.typed}${tail}`)).toEqual([`${words.typed}${tail}`]);
      editor.destroy();
    },
  );

  // protects=Backspace or Delete beside hidden lines joins the nearest line that shows, never a hidden one, and the facts stay in their item (#138); fails_when=a join takes words into a hidden line; no_claim=list styling.
  test("Backspace and Delete beside hidden lines join the lines that show", () => {
    const editor = noteOf(filledDoc(words));
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.last, 0));
    expect(press(editor, "Backspace")).toBe(true);
    expect(shownLines(editor)).toEqual([words.own, words.heading, `${words.bullet}${words.last}`]);
    expect(itemOf(editor, `${words.bullet}${words.last}`)).toEqual([
      `${words.bullet}${words.last}`,
      ...words.facts,
    ]);
    select(editor, inLine(editor, words.heading));
    expect(press(editor, "Delete")).toBe(true);
    expect(shownLines(editor)).toEqual([words.own, `${words.heading}${words.bullet}${words.last}`]);
    showMyNotes(editor, false);
    expect(nonEmpty(allLines(editor))).toEqual([
      words.own,
      `${words.heading}${words.bullet}${words.last}`,
      ...fillLines,
    ]);
    editor.destroy();
  });

  // protects=no change of the User's in My notes reaches a hidden line: a mark across one, a direct deletion of one, ⇧Tab lifting a line onto its hidden siblings, a drag of a selection across one; the cursor never rests in one; the Mind's document still changes it (#138); fails_when=a hidden line is bolded, deleted, moved or dragged from My notes, or a change from another copy is refused; no_claim=what the browser draws while dragging.
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

  // protects=⇧Tab on the User's nested line whose siblings after it are hidden is refused, so they don't move under it (#138); fails_when=the hidden siblings become the User's line's children; no_claim=Tab, which keeps a line's own hidden facts with it.
  test("⇧Tab doesn't lift a line onto its hidden siblings", () => {
    const editor = noteOf(
      docOf({
        type: "doc",
        content: [
          list(
            item(
              paragraph(typed(words.own)),
              list(
                item(paragraph(typed(words.bullet))),
                item(paragraph(ai(words.facts[0]))),
                item(paragraph(ai(words.facts[1]))),
              ),
            ),
          ),
        ],
      }),
    );
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.bullet, 1));
    const before = editor.state.doc;
    editor.commands.liftListItem("listItem");
    expect(editor.state.doc.eq(before)).toBe(true);
    select(editor, inLine(editor, words.bullet, 1));
    editor.commands.sinkListItem("listItem");
    expect(editor.state.doc.eq(before)).toBe(true);
    editor.destroy();
  });

  // protects=in a table the cells keep their places under their headers: an AI line in a cell hides, the cell stays; a table of AI text only hides whole, and a copy of the table holds only what shows (#138); fails_when=a hidden cell shifts the cells after it under the wrong header, or the copy holds the AI cell's words; no_claim=table styling.
  test("a table keeps its cells in place and hides its AI lines", () => {
    const [owner, date, dana, day] = words.cells;
    const editor = noteOf(
      docOf({
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [cell("tableHeader", typed(owner)), cell("tableHeader", typed(date))],
              },
              {
                type: "tableRow",
                content: [cell("tableCell", ai(dana)), cell("tableCell", typed(day))],
              },
            ],
          },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [cell("tableCell", ai(dana)), cell("tableCell", ai(day))],
              },
            ],
          },
          paragraph(typed(words.own)),
        ],
      }),
    );
    showMyNotes(editor, true);
    expect(shownLines(editor)).toEqual([owner, date, day, words.own]);
    const tables = [...editor.view.dom.querySelectorAll("table")];
    expect(tables[0]?.closest(".my-notes-hidden")).toBeNull();
    expect(tables[0]?.querySelectorAll("th, td").length).toBe(4);
    expect(
      [...(tables[0]?.querySelectorAll("th, td") ?? [])].filter((each) =>
        each.classList.contains("my-notes-hidden"),
      ),
    ).toEqual([]);
    expect(tables[1]?.closest(".my-notes-hidden")).not.toBeNull();

    const table = editor.state.doc.firstChild;
    if (!table) throw new Error("No table.");
    let copied = editor.state.doc.slice(0, table.nodeSize);
    editor.view.someProp("transformCopied", (transform) => {
      copied = transform(copied, editor.view);
    });
    expect(copied.content.textBetween(0, copied.content.size, "|")).toBe(
      [owner, date, "", day].join("|"),
    );
    editor.destroy();
  });

  // protects=a line the User typed into AI text stays shown, the cursor in it, when its last typed word is deleted, and hides once the cursor leaves it (#138); fails_when=the line hides under the cursor and the next keys land elsewhere; no_claim=the cursor's drawing.
  test("the line the cursor is in stays shown until the cursor leaves it", () => {
    const editor = noteOf(
      docOf({
        type: "doc",
        content: [paragraph(typed(words.own)), paragraph(ai(words.aiLine), typed(words.typed))],
      }),
    );
    showMyNotes(editor, true);
    expect(shownLines(editor)).toEqual([words.own, `${words.aiLine}${words.typed}`]);
    const end = inLine(editor, `${words.aiLine}${words.typed}`);
    select(editor, end);
    editor.view.dispatch(editor.state.tr.delete(end - words.typed.length, end));
    expect(shownLines(editor)).toEqual([words.own, words.aiLine]);
    expect(editor.state.selection.$head.parent.textContent).toBe(words.aiLine);
    select(editor, inLine(editor, words.own));
    expect(shownLines(editor)).toEqual([words.own]);
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

  // protects=Edit with AI and the other selection actions aren't offered over a selection across hidden lines, whose from and to are only its first part; over one that doesn't span them they are (#138); fails_when=an action reads part of the selection, or reads hidden lines; no_claim=the menu's drawing.
  test("selection actions aren't offered across hidden lines", () => {
    const editor = noteOf(filledDoc(words));
    showMyNotes(editor, true);
    select(editor, inLine(editor, words.own, 0), inLine(editor, words.last));
    expect(selectionForEdit(editor.state)).toBeNull();
    select(editor, inLine(editor, words.own, 0), inLine(editor, words.own));
    expect(selectionForEdit(editor.state)).not.toBeNull();
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
    const editor = noteOf(
      docOf({
        type: "doc",
        content: [paragraph(typed(words.own)), paragraph(), paragraph(typed(words.last))],
      }),
    );
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
