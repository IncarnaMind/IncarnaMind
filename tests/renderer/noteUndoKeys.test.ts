import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stubEditorDom } from "../helpers/editorDom";

/*
 * ⌘Z and ⇧⌘Z in a Note's text, and Ctrl+Y off the Mac (#3115): the Note's own history first, and
 * with nothing of the Note's, the app's Undo and Redo. Read as on Linux, where ProseMirror's Mod is Ctrl and Ctrl+Y is a Redo key.
 */

vi.stubGlobal("navigator", {
  platform: "Linux x86_64",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140",
});

vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => undefined },
}));

stubEditorDom();
const { Editor } = await import("@tiptap/core");
const { default: Collaboration } = await import("@tiptap/extension-collaboration");
const Y = await import("yjs");
const { MIND_CONTENT_FIELD } = await import("../../src/core/api");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { NoteUndoKeys } = await import("../../src/renderer/src/editor/noteUndoKeys");
const { registerMindEditor } = await import("../../src/renderer/src/editor/openEditors");
const { pressesShortcut } = await import("../../src/renderer/src/commands/keymap");
const { editCommands, placeAt } = await import("../../src/renderer/src/commands/edit");
const { commands } = await import("../../src/renderer/src/commands/registry");
const { useUndo } = await import("../../src/renderer/src/undo");

beforeEach(() => {
  stubEditorDom();
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  vi.stubGlobal("navigator", {
    platform: "Linux x86_64",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140",
  });
  useUndo.setState({ done: [], undone: [], aside: [], line: null, running: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function noteWith(words: string) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: new Y.Doc(), field: MIND_CONTENT_FIELD }),
      NoteUndoKeys,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.view.dispatch(editor.state.tr.insertText(words, 1));
  return editor;
}

/** A key as the window reads it on Linux, given to the Note: whether the Note took it. */
function press(editor: InstanceType<typeof Editor>, key: "z" | "Z" | "y", shift = false): boolean {
  let prevented = false;
  const event = {
    type: "keydown",
    key,
    keyCode: key === "y" ? 89 : 90,
    ctrlKey: true,
    shiftKey: shift,
    altKey: false,
    metaKey: false,
    preventDefault() {
      prevented = true;
    },
    getModifierState: () => false,
  };
  const handled = editor.view.someProp("handleKeyDown", (handle) =>
    handle(editor.view, event as never),
  );
  return Boolean(handled) || prevented;
}

/** One change of the app's on its Undo, which says each time it is taken back or done again. */
function appChange(log: string[]) {
  useUndo.getState().push({
    said: (t) => t("aiText.markedAsMine"),
    undo: async () => {
      log.push("app undone");
    },
    redo: async () => {
      log.push("app redone");
    },
  });
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Undo and Redo keys in a Note's text", () => {
  // protects=⌘Z in a Note's text takes back the Note's own step first and, with nothing of the Note's left, the app's change; ⇧⌘Z does the Note's step again first and then the app's change, each once, none twice and none lost; a key with nothing to take back anywhere is still the Note's and does nothing (#3115); fails_when=⌘Z in the text stops at the Note's history, takes the app's change before the Note's, or a step is done twice or lost; no_claim=a Comparison's column changes, which tests/renderer/comparisonRows.test.ts holds.
  test.each(["English words", "中文的字"])(
    "the Note's step first, then the app's change, both ways: %s",
    async (words) => {
      const log: string[] = [];
      const editor = noteWith(words);
      appChange(log);

      expect(press(editor, "z")).toBe(true);
      expect(editor.getText()).toBe("");
      await settled();
      expect(log).toEqual([]);
      expect(press(editor, "z")).toBe(true);
      await vi.waitFor(() => expect(log).toEqual(["app undone"]));

      expect(press(editor, "Z", true)).toBe(true);
      expect(editor.getText().trim()).toBe(words);
      await settled();
      expect(log).toEqual(["app undone"]);
      expect(press(editor, "Z", true)).toBe(true);
      await vi.waitFor(() => expect(log).toEqual(["app undone", "app redone"]));

      expect(press(editor, "Z", true)).toBe(true);
      expect(press(editor, "z")).toBe(true);
      expect(editor.getText()).toBe("");
      expect(press(editor, "z")).toBe(true);
      await vi.waitFor(() => expect(log).toEqual(["app undone", "app redone", "app undone"]));
      expect(press(editor, "y")).toBe(true);
      expect(editor.getText().trim()).toBe(words);
      expect(press(editor, "y")).toBe(true);
      await vi.waitFor(() =>
        expect(log).toEqual(["app undone", "app redone", "app undone", "app redone"]),
      );
      editor.destroy();
    },
  );

  // protects=Ctrl+Y off Mac matches edit.redo in the shared shortcut helper, and an empty, non-composing Note input routes Edit menu Undo/Redo to its Note while typed or composing input keeps field Undo (#3839); fails_when=Ctrl+Y is missed in NoteAsk or Edit menu Undo leaves the empty Note input dead
  test("Ctrl+Y matches edit.redo off Mac, and empty Note input routes Edit commands to its Note", () => {
    const unregisterCommands = editCommands.map((command) => commands.register(command));
    const editor = noteWith("Hello");
    const unregister = registerMindEditor("mind-1", editor);
    const input = document.createElement("textarea");
    input.setAttribute("data-note-ask-input", "mind-1");
    document.body.appendChild(input);
    const previousActive = Object.getOwnPropertyDescriptor(document, "activeElement");
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => input,
    });
    try {
      expect(
        pressesShortcut("edit.redo", {
          key: "y",
          code: "KeyY",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
        }),
      ).toBe(true);
      const undoCommand = editCommands.find((command) => command.id === "edit.undo");
      if (!undoCommand) throw new Error("Missing edit.undo command.");
      const context = { focus: null, selection: [], surface: "mind" as const };

      input.value = "";
      expect(placeAt(input)).toBe("note");
      undoCommand.run(context);
      expect(editor.getText()).toBe("");

      editor.commands.redo();
      expect(editor.getText().trim()).toBe("Hello");

      input.value = "draft";
      expect(placeAt(input)).toBe("field");

      input.value = "";
      input.setAttribute("data-composing", "");
      expect(placeAt(input)).toBe("field");
    } finally {
      if (previousActive) Object.defineProperty(document, "activeElement", previousActive);
      else Reflect.deleteProperty(document, "activeElement");
      input.remove();
      unregister();
      for (const stop of unregisterCommands) stop();
      editor.destroy();
    }
  });
});
