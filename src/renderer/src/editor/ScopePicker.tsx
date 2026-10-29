import { shift } from "@floating-ui/dom";
import { type Editor, Extension, type Range } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ANSWER_BLOCK,
  DOCUMENT_CHIP_NODE,
  QUESTION_BLOCK,
  type SearchScope,
} from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import {
  SCOPE_ATTRIBUTES,
  SCOPE_KINDS,
  type ScopeKind,
  scopeIds,
  searchScopeOf,
} from "../../../shared/searchScope";
import {
  DocumentLineIcon,
  FolderLineIcon,
  LockLineIcon,
  TagLineIcon,
} from "../components/lineIcons";
import { useT } from "../i18n";
import { type ScopeChoice, scopeChoices } from "../scope";
import { useAppStore } from "../store";

const DOCUMENTS_ONLY: readonly ScopeKind[] = ["document"];

/** Moves through a list of choices from the keyboard of the field it opened from. */
export interface ChoiceListHandle {
  /** Arrows move, Enter or Tab chooses. True if the key was used. */
  onKeyDown(event: Pick<KeyboardEvent, "key" | "isComposing">): boolean;
}

type ScopePickerListProps = SuggestionProps<ScopeChoice, ScopeChoice> & {
  ref?: Ref<ChoiceListHandle>;
};

const GROUP_LABELS: Record<ScopeKind, MessageKey> = {
  folder: "scope.picker.folders",
  tag: "scope.picker.tags",
  document: "scope.picker.documents",
};

const isQuestion = (state: EditorState, pos: number) =>
  state.doc.resolve(Math.min(pos, state.doc.content.size)).parent.type.name === QUESTION_BLOCK;

/** The Search scope of the Question that holds position `pos`, or none outside a Question. */
function scopeAt(state: EditorState, pos: number): SearchScope {
  const { parent } = state.doc.resolve(Math.min(pos, state.doc.content.size));
  return searchScopeOf(parent.type.name === QUESTION_BLOCK ? parent.attrs : {});
}

/** Whether an "@" typed here can name a Document: in the text of a Note, not in code or an Answer. */
function inNote(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent || $pos.parent.type.spec.code) return false;
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === ANSWER_BLOCK) return false;
  }
  return true;
}

/**
 * Adds a Folder, Tag or Document to the Search scope of the Question the "@"
 * was typed in, or in a Note puts a chip naming the Document where it was
 * typed; and removes the "@" and what was typed after it (`range`).
 */
function addToScope(editor: Editor, range: Range, choice: ScopeChoice): void {
  if (!isQuestion(editor.state, range.from)) {
    editor
      .chain()
      .focus()
      .insertContentAt(range, [
        { type: DOCUMENT_CHIP_NODE, attrs: { documentId: choice.id, name: choice.name } },
        { type: "text", text: " " },
      ])
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .command(({ tr }) => {
      const $at = tr.doc.resolve(tr.mapping.map(range.from));
      const question = $at.parent;
      if (question.type.name !== QUESTION_BLOCK) return false;
      const ids = scopeIds(searchScopeOf(question.attrs), choice.kind);
      if (!ids.includes(choice.id)) {
        tr.setNodeMarkup($at.before(), undefined, {
          ...question.attrs,
          [SCOPE_ATTRIBUTES[choice.kind]]: [...ids, choice.id],
        });
      }
      return true;
    })
    .run();
}

/**
 * Typing `@` in a Question (at its start or after a space) opens a picker of
 * Folders, Tags and Documents, filtered by what is typed after it. Arrows
 * choose, Enter or Tab adds the choice to the Question's Search scope, where
 * it shows as a chip; Esc closes. In a Note it offers Documents only, and
 * the choice becomes a chip in the text that opens the Document.
 */
export const ScopePicker = Extension.create({
  name: "scopePicker",
  // Before `QuestionCommands`: while the picker is open, Enter chooses instead of asking.
  priority: 1100,

  addProseMirrorPlugins() {
    return [
      Suggestion<ScopeChoice, ScopeChoice>({
        editor: this.editor,
        pluginKey: new PluginKey("scopePicker"),
        char: "@",
        // In a Question, or in the text of a Note: in code or an Answer an "@" is just an "@".
        allow: ({ state, range }) => isQuestion(state, range.from) || inNote(state, range.from),
        // The list reads the Folders, Tags and Documents from the app store itself.
        items: () => [],
        command: ({ editor, range, props: choice }) => addToScope(editor, range, choice),
        floatingUi: { strategy: "fixed", middleware: [shift({ padding: 8 })] },
        render: () => {
          let renderer: ReactRenderer<ChoiceListHandle, ScopePickerListProps> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart(props) {
              renderer = new ReactRenderer(ScopePickerList, { editor: props.editor, props });
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

/** A choice's icon: the sidebar's line icons, in its muted ink. */
function ChoiceIcon({ choice }: { choice: ScopeChoice }) {
  const className = "size-4 text-ink-meta";
  if (choice.walled) return <LockLineIcon className={className} />;
  if (choice.kind === "folder") return <FolderLineIcon className={className} />;
  if (choice.kind === "tag") return <TagLineIcon className={className} />;
  return <DocumentLineIcon kind={choice.documentKind ?? "text"} className={className} />;
}

function ScopePickerList({ editor, range, query, command, ref }: ScopePickerListProps) {
  return (
    <ScopeChoiceList
      scope={scopeAt(editor.state, range.from)}
      kinds={isQuestion(editor.state, range.from) ? undefined : DOCUMENTS_ONLY}
      query={query}
      onChoose={command}
      ref={ref}
    />
  );
}

/**
 * The Folders, Tags and Documents a Search scope can add, under their labels,
 * filtered by `query`, leaving out those `scope` has already. The first is
 * chosen; arrows move and Enter or Tab chooses (see `ChoiceListHandle`). The
 * "@" picker of a Question, and of the composer.
 */
export function ScopeChoiceList({
  scope,
  ownFolderId = null,
  onOpenNote,
  query,
  onChoose,
  id,
  onSelect,
  kinds,
  ref,
}: {
  scope: SearchScope;
  /** The current Note's Folder, used to tell an inside wall from an outside one. */
  ownFolderId?: string | null;
  /** Opens a Note in a walled Folder without adding it to this scope. */
  onOpenNote?(folderId: string): void;
  /** Only these kinds, e.g. Documents for a chip in a Note; all by default. */
  kinds?: readonly ScopeKind[];
  query: string;
  onChoose(choice: ScopeChoice): void;
  /** The listbox's id, and its options' (`${id}-${index}`), for a field's `aria-activedescendant`. */
  id?: string;
  /** Hears which option is chosen, by its index (-1: none), for `aria-activedescendant`. */
  onSelect?(index: number): void;
  ref?: Ref<ChoiceListHandle>;
}) {
  const t = useT();
  const folders = useAppStore((state) => state.folders);
  const groups = useAppStore((state) => state.library?.groups);
  const currentWalled =
    groups?.find((group) => group.id === ownFolderId && group.keepInside)?.id ?? null;
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  const assignments = useAppStore((state) => state.library?.assignments);
  const library = { folders, groups, tags, documents, assignments };
  const shown = scopeChoices(library, scope, query).filter(
    (choice) => !kinds || kinds.includes(choice.kind),
  );
  const isBlocked = (item: ScopeChoice) => {
    if (item.walled === undefined || item.walled === null) return false;
    if (item.walled !== currentWalled) return true;
    if (item.kind !== "document") return false;
    const filings = (assignments ?? []).filter(
      (each) => each.documentId === item.id && each.groupId === currentWalled,
    );
    return !filings.some((each) => each.source === "user");
  };
  const nothing = kinds
    ? documents.length === 0
    : folders.length + (groups?.length ?? 0) + tags.length + documents.length === 0;
  // The choice belongs to a query: typing more starts again from the top.
  const [choice, setChoice] = useState({ query, index: 0 });
  const selected = choice.query === query ? Math.min(choice.index, shown.length - 1) : 0;
  const selectedItem = shown[selected];
  const setSelected = (index: number) => setChoice({ query, index });
  const options = useRef<(HTMLElement | null)[]>([]);
  const reportSelected = useRef(onSelect);
  reportSelected.current = onSelect;

  useEffect(() => {
    options.current[selected]?.scrollIntoView({ block: "nearest" });
    reportSelected.current?.(selected);
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      // Nothing to choose: Enter asks the Question, "@" and all.
      if (event.isComposing || shown.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((selected + step + shown.length) % shown.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = shown[selected];
        if (item && !isBlocked(item)) onChoose(item);
        else if (item?.kind === "folder" && onOpenNote) onOpenNote(item.id);
        return true;
      }
      return false;
    },
  }));

  return (
    <>
      <div
        id={id}
        role="listbox"
        data-testid="scope-picker"
        aria-label={t(kinds ? "scope.picker.documents" : "scope.picker.label")}
        className="editor-menu scope-picker"
      >
        {shown.length === 0 && (
          <p className="scope-picker-empty">
            {t(
              kinds
                ? nothing
                  ? "editor.chip.picker.none"
                  : "editor.chip.picker.empty"
                : nothing
                  ? "scope.picker.none"
                  : "scope.picker.empty",
            )}
          </p>
        )}
        {SCOPE_KINDS.map((kind) => {
          const ofKind = shown.filter((item) => item.kind === kind);
          if (ofKind.length === 0) return null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a group of a listbox's options, which a fieldset can't hold.
            <div key={kind} role="group" aria-label={t(GROUP_LABELS[kind])}>
              <p aria-hidden="true" className="scope-picker-heading">
                {t(GROUP_LABELS[kind])}
              </p>
              {ofKind.map((item) => {
                const index = shown.indexOf(item);
                if (isBlocked(item)) {
                  return (
                    <div
                      key={`${item.kind}:${item.id}`}
                      ref={(element) => {
                        options.current[index] = element;
                      }}
                      id={id && `${id}-${index}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === selected}
                      aria-disabled="true"
                      data-testid="scope-choice"
                      data-kind={item.kind}
                      data-id={item.id}
                      data-walled="true"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setSelected(index)}
                      className="editor-menu-item scope-picker-item--walled"
                    >
                      <span className="scope-picker-icon">
                        <ChoiceIcon choice={item} />
                      </span>
                      <span className="truncate" aria-disabled="true">
                        {item.name}
                      </span>
                      {item.count !== undefined && (
                        <span data-testid="scope-choice-count" className="scope-picker-path">
                          {item.count === 0 ? t("scope.picker.empty.hint") : item.count}
                        </span>
                      )}
                    </div>
                  );
                }
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    ref={(element) => {
                      options.current[index] = element;
                    }}
                    id={id && `${id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    data-testid="scope-choice"
                    data-kind={item.kind}
                    data-id={item.id}
                    // Keep the cursor where it is typed in.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => onChoose(item)}
                    data-empty={item.count === 0 ? "true" : undefined}
                    className={`editor-menu-item ${item.count === 0 ? "scope-picker-item--empty" : ""}`}
                  >
                    <span className="scope-picker-icon">
                      <ChoiceIcon choice={item} />
                    </span>
                    <span className="truncate">{item.name}</span>
                    {item.count !== undefined && (
                      <span data-testid="scope-choice-count" className="scope-picker-path">
                        {item.count === 0 ? t("scope.picker.empty.hint") : item.count}
                      </span>
                    )}
                    {(item.path.length > 0 || item.sourceLocation) && (
                      <span className="scope-picker-path">
                        {[
                          ...(item.sourceLocation ? [t("library.sources")] : []),
                          ...item.path,
                        ].join(" / ")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {selectedItem?.kind === "folder" && isBlocked(selectedItem) && onOpenNote && (
        <button
          type="button"
          data-testid="scope-open-note"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onOpenNote(selectedItem.id)}
          className="editor-menu-item"
        >
          {t("scope.openNote")}
        </button>
      )}
    </>
  );
}
