import { type Editor, Extension, Node, type NodeViewRenderer } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import { Fragment, type Node as ProseMirrorNode, type Schema, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { numberedFootnotes } from "./citationNumbers";
import { Citation } from "./citationSchema";
import { FOOTNOTE_CONTENT } from "./footnoteSchema";
import { InFootnoteContext } from "./mindContext";
import { wordAtomView } from "./WordAtomView";
import { WordAtom } from "./wordSchema";

/** Marks a change to the footnote's text that came from the Mind, so it isn't sent back. */
const FROM_MIND = "fromMind";

/** A footnote's text, as the editor of it holds it: the text is the whole document. */
const FootnoteDocument = Node.create({
  name: "doc",
  topNode: true,
  content: FOOTNOTE_CONTENT,
});

/** How the User leaves a footnote's text by keyboard: Enter, or Esc. */
export type FootnoteLeave = "enter" | "escape";

interface KeyOptions {
  onLeave: (how: FootnoteLeave) => void;
  /** The Mind's editor, whose Undo history the footnote's changes are part of. */
  mind: Editor | null;
}

/**
 * The keys of a footnote's text: Enter and Esc leave it (Shift+Enter breaks
 * the line, as StarterKit has it), and Undo and Redo are the Mind's, as every
 * change to the text is a change to the Mind. Nothing acts while an input
 * method is composing, so Enter there commits the Chinese text instead.
 */
const FootnoteTextKeys = Extension.create<KeyOptions>({
  name: "footnoteTextKeys",

  addOptions() {
    return { onLeave: () => undefined, mind: null };
  },

  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin({
        key: new PluginKey("footnoteTextKeys"),
        props: {
          handleKeyDown: (view, event) => {
            if (view.composing || event.isComposing || event.keyCode === 229) return false;
            const mod = event.metaKey || event.ctrlKey;
            const key = event.key.toLowerCase();
            if (event.key === "Enter" && !event.shiftKey && !mod) {
              options.onLeave("enter");
              return true;
            }
            if (event.key === "Escape") {
              // Already handled: it closed something opened from here, like a Citation's card.
              if (event.defaultPrevented) return true;
              // Handled here, so the popover doesn't also close on its own.
              event.preventDefault();
              options.onLeave("escape");
              return true;
            }
            const mind = options.mind;
            if (!mod || event.altKey || !mind || mind.isDestroyed) return false;
            if (key === "z" && !event.shiftKey) return mind.commands.undo() || true;
            if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) {
              return mind.commands.redo() || true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * What a footnote's text can hold, for its own editor: the marks of a Note,
 * line breaks, Citations, and what a Word file's note keeps as is (#746), the
 * same node and mark types as in the Mind, so its content moves between the
 * two as it is.
 */
function footnoteTextExtensions(citationView: NodeViewRenderer | null, keys: KeyOptions) {
  return [
    StarterKit.configure({
      document: false,
      paragraph: false,
      heading: false,
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      codeBlock: false,
      horizontalRule: false,
      undoRedo: false,
      trailingNode: false,
      dropcursor: false,
      gapcursor: false,
    }),
    FootnoteDocument,
    Highlight,
    Citation.configure({ view: citationView }),
    WordAtom.configure({ view: wordAtomView }),
    FootnoteTextKeys.configure(keys),
  ];
}

/** The footnote's node in the Mind, by its ID, from the numbers worked out once per change. */
const footnoteIn = (mind: Editor, id: string) =>
  numberedFootnotes(mind.state).find((each) => each.id === id) ?? null;

/**
 * The change that turns `from` into `to`, as where it starts and ends in
 * each: unchanged text before and after stays as it is, with its marks and
 * the Citations in it.
 */
function difference(from: Fragment, to: Fragment) {
  const start = from.findDiffStart(to);
  if (start === null) return null;
  const end = from.findDiffEnd(to);
  if (!end) return null;
  let { a: endFrom, b: endTo } = end;
  // Repeated text can make the two ends overlap the start: move them past it.
  const overlap = start - Math.min(endFrom, endTo);
  if (overlap > 0) {
    endFrom += overlap;
    endTo += overlap;
  }
  return { start, endFrom, endTo };
}

/** `node`'s content in another schema with the same node and mark types. */
const contentIn = (schema: Schema, node: ProseMirrorNode) =>
  Fragment.fromJSON(schema, node.content.toJSON());

/** The attributes of a footnote's text: what it is, its name, and what to write while it is empty. */
const textAttributes = (
  variant: FootnoteTextProps["variant"],
  label: string,
  placeholder: string,
) => ({
  class: `footnote-text footnote-text--${variant}`,
  role: "textbox",
  "aria-multiline": "true",
  "aria-label": label,
  "data-testid": "footnote-text",
  "data-placeholder": placeholder,
});

/** What a footnote's text offers the place it is shown in. */
export interface FootnoteTextHandle {
  focus(): void;
}

interface FootnoteTextProps {
  /** The Mind's editor, which holds the footnote. */
  mind: Editor;
  id: string;
  label: string;
  placeholder: string;
  /** Where it is shown: a field in the popover at the marker, or text in the footnote area. */
  variant: "popover" | "area";
  /** Its focus, which goes to the end of its text, e.g. for a popover to give it once shown. */
  ref?: Ref<FootnoteTextHandle>;
  citationView: NodeViewRenderer | null;
  onLeave(how: FootnoteLeave): void;
  /** The footnote is no longer in the Mind: deleted, or taken back with Undo. */
  onGone?(): void;
}

/**
 * A footnote's text, edited in place: a small editor of its own, in the
 * popover at its marker or in the footnote area. Every change is made in the
 * Mind at once, as a change to the footnote's node, so it is stored, synced
 * and undone with the Mind; a change to the node from elsewhere (Undo, the
 * other place it is shown, another computer) comes back into it. Only what
 * changed is replaced, so the cursor stays where it is.
 */
export function FootnoteText({
  mind,
  id,
  label,
  placeholder,
  variant,
  ref,
  citationView,
  onLeave,
  onGone,
}: FootnoteTextProps) {
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const gone = useRef(onGone);
  gone.current = onGone;
  /** The footnote's node as the text last matched it: as it was when the editor was made, at first. */
  const seen = useRef<ProseMirrorNode | null>(null);
  const initial = useMemo(() => footnoteIn(mind, id)?.node ?? null, [mind, id]);

  const editor = useEditor(
    {
      extensions: footnoteTextExtensions(citationView, {
        onLeave: (how) => leave.current(how),
        mind,
      }),
      editable: mind.isEditable,
      shouldRerenderOnTransaction: false,
      content: { type: "doc", content: initial?.content.toJSON() ?? [] },
      onCreate: () => {
        seen.current = initial;
      },
      editorProps: { attributes: textAttributes(variant, label, placeholder) },
      onUpdate: ({ editor: text, transaction }) => {
        if (transaction.getMeta(FROM_MIND) || mind.isDestroyed) return;
        const found = footnoteIn(mind, id);
        if (!found) return;
        const next = contentIn(mind.schema, text.state.doc);
        const change = difference(found.node.content, next);
        if (!change) return;
        const inside = found.pos + 1;
        const tr = mind.state.tr.replace(
          inside + change.start,
          inside + change.endFrom,
          new Slice(next.cut(change.start, change.endTo), 0, 0),
        );
        mind.view.dispatch(tr);
        seen.current = footnoteIn(mind, id)?.node ?? null;
      },
    },
    [mind, id],
  );

  // At once, with the cursor at the end: the keys pressed next are the footnote's.
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (editor.isDestroyed) return;
        editor.view.focus();
        editor.commands.setTextSelection(editor.state.doc.content.size);
      },
    }),
    [editor],
  );

  // Changes to the footnote from elsewhere come into its text.
  useEffect(() => {
    const follow = () => {
      if (editor.isDestroyed) return;
      const found = footnoteIn(mind, id);
      if (!found) {
        gone.current?.();
        return;
      }
      if (found.node === seen.current) return;
      seen.current = found.node;
      const next = contentIn(editor.schema, found.node);
      const change = difference(editor.state.doc.content, next);
      if (!change) return;
      editor.view.dispatch(
        editor.state.tr
          .replace(
            change.start,
            change.endFrom,
            new Slice(next.cut(change.start, change.endTo), 0, 0),
          )
          .setMeta(FROM_MIND, true),
      );
    };
    mind.on("transaction", follow);
    return () => {
      mind.off("transaction", follow);
    };
  }, [mind, editor, id]);

  // The label follows the number, and the interface's language.
  useEffect(() => {
    editor.setOptions({ editorProps: { attributes: textAttributes(variant, label, placeholder) } });
  }, [editor, variant, label, placeholder]);

  const empty = useEditorState({ editor, selector: ({ editor: text }) => text.isEmpty });

  return (
    <InFootnoteContext.Provider value={id}>
      <EditorContent
        editor={editor}
        className={`footnote-text-frame ${empty ? "footnote-text-frame--empty" : ""}`}
      />
    </InFootnoteContext.Provider>
  );
}
