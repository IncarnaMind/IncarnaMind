import { DOMParser } from "linkedom";
import { describe, expect, test, vi } from "vitest";

/*
 * Ctrl+Shift+Z in a note on Linux (#2691): the keys are read as on that system, so ProseMirror's
 * key names are worked out after `navigator` says Linux.
 */
vi.stubGlobal("navigator", {
  platform: "Linux x86_64",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140",
});
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
Object.assign(page, { getSelection: () => null });
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
const Y = await import("yjs");
const { MIND_CONTENT_FIELD } = await import("../../src/core/api");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { RedoKeys } = await import("../../src/renderer/src/editor/redoKeys");

function noteWith(words: string) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: new Y.Doc(), field: MIND_CONTENT_FIELD }),
      RedoKeys,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.view.dispatch(editor.state.tr.insertText(words, 1));
  return editor;
}

/** Ctrl+Shift+Z as the window reads it: `key` is what the system gives with Shift held. */
function pressRedo(editor: InstanceType<typeof Editor>, key: "z" | "Z"): void {
  const event = {
    type: "keydown",
    key,
    keyCode: 90,
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault() {},
    getModifierState: () => false,
  };
  editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event as never));
}

// protects=Ctrl+Shift+Z in a note on Linux redoes, or does nothing when there is nothing to redo; it never takes back the last change, as it did to a meeting's fill right after it landed (#2691); fails_when=the key falls through to Undo when Redo has nothing; no_claim=the key on macOS, whose names ProseMirror reads another way.
describe.each([
  ["English", "Call Dana back"],
  ["Chinese", "给小王回电话"],
] as const)("Ctrl+Shift+Z in a note with %s words", (_language, words) => {
  test.each(["z", "Z"] as const)(
    'read as "%s": with nothing to redo it leaves the words, and after Undo it redoes',
    (key) => {
      const editor = noteWith(words);
      pressRedo(editor, key);
      expect(editor.getText()).toBe(words);

      editor.commands.undo();
      expect(editor.getText()).toBe("");
      pressRedo(editor, key);
      expect(editor.getText()).toBe(words);
      editor.destroy();
    },
  );
});
