import { Editor, type Extensions } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import type { PluginView, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { onTestFinished } from "vitest";
import type * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { SmartTypography } from "../../src/renderer/src/editor/typography";
import type { MindClient } from "./mindClient";

/** The extensions of the Mind editor that make or change content: its schema, and smart typography. */
export const editorExtensions = (): Extensions => [...noteExtensions(), SmartTypography];

/** A headless Tiptap editor, starting with an empty paragraph: the Mind editor minus the screen. */
export function headlessEditor(extensions = editorExtensions()): Editor {
  const content = { type: "doc", content: [{ type: "paragraph" }] };
  const editor = new Editor({ element: null, extensions, content });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

/**
 * A headless editor bound to a client's copy of the Mind by the Collaboration
 * extension, as the Mind editor is. ProseMirror's view would run the binding;
 * here it runs by hand: it renders what the Yjs document holds into the
 * editor, applies the changes the core pushes, and writes the editor's own
 * changes back to Yjs, which the client sends to the core.
 */
export function boundEditor(client: MindClient): Editor {
  return boundEditorTo(client.doc);
}

/**
 * A headless editor bound to a Mind's Yjs document, as the Mind editor is: this
 * module graph's note extensions, so a test with two windows can give each its own
 * store and lock, and the document a window's own copy holds.
 */
export function boundEditorTo(doc: Y.Doc): Editor {
  const editor = headlessEditor([
    ...editorExtensions(),
    Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
  ]);
  const sync = editor.state.plugins.find((plugin) => plugin.spec.key === ySyncPluginKey);
  const view = {
    get state() {
      return editor.state;
    },
    dispatch: (transaction: Transaction) => editor.view.dispatch(transaction),
    hasFocus: () => false,
  } as unknown as EditorView;
  let binding: PluginView | undefined;
  editor.on("transaction", () => binding?.update?.(view, editor.state));
  binding = sync?.spec.view?.(view);
  if (!binding) throw new Error("The editor has no Yjs binding.");
  onTestFinished(() => binding?.destroy?.());
  return editor;
}

/**
 * Types `text` over the selection, a character at a time, as the editor's
 * view does: the input rules (smart typography among them) see each
 * character first, and it is inserted as typed when none of them takes it.
 */
export function typeText(editor: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const taken = editor.state.plugins.some((plugin) =>
      plugin.props.handleTextInput?.call(plugin, editor.view, from, to, character, () =>
        editor.state.tr.insertText(character, from, to),
      ),
    );
    if (!taken) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}
