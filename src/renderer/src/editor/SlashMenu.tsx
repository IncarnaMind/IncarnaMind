import { shift } from "@floating-ui/dom";
import { Extension } from "@tiptap/core";
import { type EditorState, PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { QUESTION_BLOCK } from "../../../core/api";
import { useT } from "../i18n";
import { matchSlashItems, noteSlashItems, type SlashItem } from "./slashItems";

/** Where the menu opens: in a Note, or in a Question, where only Skills make sense. */
export type SlashPlace = "note" | "question";

export interface SlashMenuOptions {
  /** Every entry the menu can offer there, read each time it opens or the query changes. */
  items: (place: SlashPlace) => readonly SlashItem[];
}

interface SlashMenuHandle {
  onKeyDown(event: KeyboardEvent): boolean;
}

type SlashMenuListProps = SuggestionProps<SlashItem, SlashItem> & { ref?: Ref<SlashMenuHandle> };

const placeOf = (state: EditorState): SlashPlace =>
  state.selection.$from.parent.type.name === QUESTION_BLOCK ? "question" : "note";

const slashMenuKey = new PluginKey("slashMenu");

/**
 * Typing `/` (at the start of a line or after a space) opens a menu of things
 * to insert, filtered by what is typed after it. Arrows choose, Enter inserts,
 * Esc closes. In a Question it offers only what applies there (Skills), and
 * only if there is something to offer.
 */
export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",
  // Before Enter asks a Question (see QuestionCommands): while the menu is open, Enter chooses.
  priority: 1100,

  addOptions() {
    return { items: (place) => (place === "note" ? noteSlashItems : []) };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashMenuKey,
        char: "/",
        // Not in code, where a slash is just a slash; and never while a Chinese input method
        // is composing, whose "/" or letter is the method's, not the Note's (#281).
        allow: ({ editor, state, range }) => {
          if (editor.view.composing) return false;
          const { parent } = state.doc.resolve(range.from);
          if (parent.type.spec.code) return false;
          return parent.type.name !== QUESTION_BLOCK || this.options.items("question").length > 0;
        },
        items: ({ editor }) => [...this.options.items(placeOf(editor.state))],
        command: ({ editor, range, props: item }) => {
          item.run(editor, range);
          // An item that leaves the text as it was (Cite…) would leave the menu open over it.
          editor.view.dispatch(editor.state.tr.setMeta(slashMenuKey, { exit: true }));
        },
        floatingUi: { strategy: "fixed", middleware: [shift({ padding: 8 })] },
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle, SlashMenuListProps> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart(props) {
              renderer = new ReactRenderer(SlashMenuList, { editor: props.editor, props });
              unmount = props.mount(renderer.element);
            },
            onUpdate(props) {
              renderer?.updateProps(props);
            },
            onKeyDown({ event }) {
              return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit() {
              unmount?.();
              renderer?.destroy();
              renderer = null;
              unmount = null;
            },
          };
        },
      }),
    ];
  },
});

function SlashMenuList({ items, query, command, ref }: SlashMenuListProps) {
  const t = useT();
  const labelOf = (item: SlashItem) =>
    typeof item.label === "string" ? t(item.label) : item.label.text;
  const shown = matchSlashItems(items, query, labelOf);
  // The choice belongs to a query: typing more starts again from the top.
  const [choice, setChoice] = useState({ query, index: 0 });
  const selected = choice.query === query ? Math.min(choice.index, shown.length - 1) : 0;
  const setSelected = (index: number) => setChoice({ query, index });
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  // A menu opened under a resting pointer must not choose the row beneath it: only a
  // pointer that moved chooses.
  const moved = useRef(false);

  useEffect(() => {
    const pointed = () => {
      moved.current = true;
    };
    window.addEventListener("pointermove", pointed, { once: true });
    return () => window.removeEventListener("pointermove", pointed);
  }, []);

  useEffect(() => {
    options.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.isComposing || shown.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((selected + step + shown.length) % shown.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = shown[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      role="listbox"
      data-testid="slash-menu"
      aria-label={t("editor.slash.label")}
      className="editor-menu max-h-[320px] w-[240px] overflow-y-auto"
    >
      {shown.length === 0 && <p className="editor-menu-empty">{t("editor.slash.empty")}</p>}
      {shown.map((item, index) => (
        <button
          key={item.id}
          ref={(element) => {
            options.current[index] = element;
          }}
          type="button"
          role="option"
          aria-selected={index === selected}
          data-testid={`slash-item-${item.id}`}
          // Keep the cursor in the editor.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => {
            if (moved.current) setSelected(index);
          }}
          onClick={() => command(item)}
          title={item.hint}
          className="editor-menu-item"
        >
          <span className="editor-menu-icon">{item.icon}</span>
          <span className="truncate">{labelOf(item)}</span>
        </button>
      ))}
    </div>
  );
}
