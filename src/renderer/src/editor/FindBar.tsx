import { type Editor, useEditorState } from "@tiptap/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findHandle, useHandle } from "../commands/handles";
import { ChevronDownLineIcon, ChevronUpLineIcon, CloseLineIcon } from "../components/lineIcons";
import { ProblemMark } from "../components/ProblemLine";
import { useT } from "../i18n";
import { useMindTools } from "../mindTools";
import { asOneStep } from "./editorUndo";
import {
  clearFind,
  closeFind,
  findStateOf,
  replaceAllInMind,
  replaceCurrentInMind,
  setFindQuery,
  stepFind,
} from "./findInMind";

/** The words selected in one line, to start the search with. */
function selectedWords(editor: Editor): string {
  const { from, to, empty, $from } = editor.state.selection;
  if (empty || !$from.sameParent(editor.state.selection.$to)) return "";
  const text = editor.state.doc.textBetween(from, to);
  return text.length <= 100 ? text : "";
}

/** Where the bar sits: the top right of what shows of the Mind. */
function useCorner(editor: Editor) {
  const [corner, setCorner] = useState({ top: 0, right: 0 });
  useEffect(() => {
    const scroller = editor.view.dom.closest(".mind-scroller");
    if (!scroller) return;
    const place = () => {
      const box = scroller.getBoundingClientRect();
      setCorner({ top: box.top + 8, right: window.innerWidth - box.right + 16 });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(scroller);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [editor]);
  return corner;
}

/**
 * Find and replace in the Mind (⌘F, ⌥⌘F): a field, how many matches there are
 * and which is current; next and previous; and Replace, with the options Word
 * has, Match case and Whole word. Replace and Replace all are one step of the
 * note's Undo, and the line says how many were replaced ("Replaced 14 ·
 * Undo"). Enter goes on, Shift+Enter goes back, Esc closes it and puts the
 * cursor on the current match. The matches are marked in the text
 * (`findInMind`), and counted again as the text changes.
 */
export function FindBar({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => selectedWords(editor));
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaced, setReplaced] = useState<number | null>(null);
  const replacing = useRef(false);
  const corner = useCorner(editor);
  const requests = useMindTools((state) => state.findRequests);
  const withReplace = useMindTools((state) => state.findReplace);
  const { count, current } = useEditorState({
    editor,
    selector: ({ editor: now }) => {
      const state = findStateOf(now);
      return { count: state.matches.length, current: state.current };
    },
  });

  // Each ⌘F puts the cursor in the field, with what is in it selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `requests` is what asks for it.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
    // The editor takes the focus back a frame after Esc closes the outline or a menu: not from the field.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== field.current) field.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [requests]);

  // Also when the editor is made again (the Mind's document changed), which starts without marks.
  useEffect(() => {
    if (!editor.isDestroyed) setFindQuery(editor, query, { matchCase, wholeWord });
  }, [editor, query, matchCase, wholeWord]);

  useEffect(
    () => () => {
      if (!editor.isDestroyed) clearFind(editor);
    },
    [editor],
  );

  // Typing in the note after a replacement means its Undo no longer takes back only that.
  useEffect(() => {
    const changed = () => {
      if (!replacing.current) setReplaced(null);
    };
    editor.on("update", changed);
    return () => {
      editor.off("update", changed);
    };
  }, [editor]);

  const handle = useMemo(
    () => ({
      next: () => stepFind(editor, 1),
      previous: () => stepFind(editor, -1),
    }),
    [editor],
  );
  useHandle(findHandle, handle);

  const close = () => {
    closeFind(editor);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    if (event.key === "Enter") {
      event.preventDefault();
      stepFind(editor, event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onReplaceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    if (event.key === "Enter") {
      event.preventDefault();
      replaceOne();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const undoReplace = () => {
    editor.commands.undo();
    setReplaced(null);
    field.current?.focus();
  };

  // Esc closes the bar from any of its controls, not only its fields.
  const onBarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const asReplace = <T,>(replace: () => T): T => {
    replacing.current = true;
    try {
      return asOneStep(editor, replace);
    } finally {
      replacing.current = false;
    }
  };

  function replaceOne() {
    if (query === "" || count === 0) return;
    const done = asReplace(() =>
      replaceCurrentInMind(editor, query, replacement, { matchCase, wholeWord }),
    );
    if (done !== null && done > 0) setReplaced(done);
  }

  function replaceAll() {
    if (query === "") return;
    const done = asReplace(() =>
      replaceAllInMind(editor, query, replacement, { matchCase, wholeWord }),
    );
    if (done > 0) setReplaced(done);
  }

  const status =
    query === ""
      ? ""
      : count === 0
        ? t("editor.find.none")
        : t("editor.find.count", { current: current + 1, total: count });

  return createPortal(
    <search
      data-testid="find-bar"
      aria-label={t(withReplace ? "editor.replace.label" : "editor.find.label")}
      style={corner}
      className="find-bar"
      onKeyDown={onBarKeyDown}
    >
      <div className="find-row">
        <input
          ref={field}
          type="text"
          data-testid="find-field"
          aria-label={t("editor.find.label")}
          placeholder={t("editor.find.placeholder")}
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setReplaced(null);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          data-testid="find-match-case"
          title={t("editor.find.matchCase")}
          aria-label={t("editor.find.matchCase")}
          aria-pressed={matchCase}
          className={`find-option ${matchCase ? "find-option--on" : ""}`}
          onClick={() => {
            setMatchCase((on) => !on);
            setReplaced(null);
          }}
        >
          Aa
        </button>
        <button
          type="button"
          data-testid="find-whole-word"
          title={t("editor.find.wholeWord")}
          aria-label={t("editor.find.wholeWord")}
          aria-pressed={wholeWord}
          className={`find-option ${wholeWord ? "find-option--on" : ""}`}
          onClick={() => {
            setWholeWord((on) => !on);
            setReplaced(null);
          }}
        >
          ab
        </button>
        <span
          data-testid="find-count"
          aria-live="polite"
          className={`find-count ${count === 0 && query !== "" ? "find-count--none" : ""}`}
        >
          {count === 0 && query !== "" && <ProblemMark />}
          {status}
        </span>
        <button
          type="button"
          data-testid="find-previous"
          title={t("editor.find.previous")}
          aria-label={t("editor.find.previous")}
          disabled={count === 0}
          onClick={handle.previous}
        >
          <ChevronUpLineIcon className="size-4" />
        </button>
        <button
          type="button"
          data-testid="find-next"
          title={t("editor.find.next")}
          aria-label={t("editor.find.next")}
          disabled={count === 0}
          onClick={handle.next}
        >
          <ChevronDownLineIcon className="size-4" />
        </button>
        <button
          type="button"
          data-testid="find-close"
          title={t("editor.find.close")}
          aria-label={t("editor.find.close")}
          onClick={close}
        >
          <CloseLineIcon className="size-4" />
        </button>
      </div>
      {withReplace && (
        <div className="find-row find-row--replace">
          <input
            type="text"
            data-testid="replace-field"
            aria-label={t("editor.replace.placeholder")}
            placeholder={t("editor.replace.placeholder")}
            value={replacement}
            spellCheck={false}
            onChange={(event) => {
              setReplacement(event.target.value);
              setReplaced(null);
            }}
            onKeyDown={onReplaceKeyDown}
          />
          <button
            type="button"
            data-testid="replace-one"
            className="find-action"
            disabled={count === 0}
            onClick={replaceOne}
          >
            {t("editor.replace.one")}
          </button>
          <button
            type="button"
            data-testid="replace-all"
            className="find-action"
            disabled={count === 0}
            onClick={replaceAll}
          >
            {t("editor.replace.all")}
          </button>
        </div>
      )}
      {replaced !== null && (
        <button
          type="button"
          data-testid="find-replaced"
          className="find-replaced"
          onClick={undoReplace}
        >
          {t("editor.find.replaced", { count: replaced })}
        </button>
      )}
    </search>,
    document.body,
  );
}
