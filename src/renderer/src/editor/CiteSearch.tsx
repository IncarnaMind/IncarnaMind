import type { VirtualElement } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { CITATION_NODE, type FoundPassage, type TextRange } from "../../../core/api";
import { formatLocation } from "../../../shared/locations";
import { hasSearchScope, mindSearchScope } from "../../../shared/searchScope";
import { INLINE_NODE, lastSentence } from "../../../shared/sentences";
import { DocumentLineIcon } from "../components/lineIcons";
import { Marked } from "../components/Marked";
import { core } from "../core";
import { useT } from "../i18n";
import { useMindScope } from "../keptScope";
import { foundLine } from "../libraryPage";
import { scopeWithin } from "../scope";
import { useFolderHoldsDocuments, useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import { useTurnWall } from "../turnWall";
import { asOneStep } from "./editorUndo";
import { Popover } from "./Popover";

/** Where Cite… is: the "/" and what was typed after it, which the Citation replaces. */
export interface CitePlace {
  editor: Editor;
  from: number;
  to: number;
}

/** How long typing settles before a search runs: a reranked search costs about a second. */
const SEARCH_PAUSE_MS = 200;

/** The most Passages Cite… lists (#281). */
const MOST_PASSAGES = 6;

/** How much of a Passage before its first matching word a result shows. */
const SNIPPET_LEAD = 60;

/** The sentence being written: its paragraph's text up to `pos`, its last sentence. */
function sentenceAt(editor: Editor, pos: number): string {
  const $pos = editor.state.doc.resolve(Math.min(Math.max(pos, 0), editor.state.doc.content.size));
  if (!$pos.parent.isTextblock) return "";
  return lastSentence($pos.parent.textBetween(0, $pos.parentOffset, "\n", INLINE_NODE));
}

/** A point at the caret, which the popover follows as the Mind scrolls. */
function caretAnchor(editor: Editor, pos: number): VirtualElement {
  return {
    contextElement: editor.view.dom,
    getBoundingClientRect: () => {
      const at = Math.min(Math.max(pos, 0), editor.state.doc.content.size);
      const { left, top, right, bottom } = editor.view.coordsAtPos(at);
      return new DOMRect(left, top, right - left, bottom - top);
    },
  };
}

/** Where each of these words is in `text`, case aside, every time it appears. */
function rangesIn(text: string, words: readonly string[]): TextRange[] {
  const lower = text.toLocaleLowerCase();
  const ranges: TextRange[] = [];
  for (const word of words) {
    const wanted = word.toLocaleLowerCase();
    if (wanted === "") continue;
    for (
      let at = lower.indexOf(wanted);
      at !== -1;
      at = lower.indexOf(wanted, at + wanted.length)
    ) {
      ranges.push({ start: at, end: at + wanted.length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Cite… (#281): the search of the Mind's Search scope for the sentence being
 * written, at the caret. It starts with that sentence, selected, so typing
 * replaces it; the arrows move through the Passages found, and Enter or a
 * click puts a Citation of the chosen one where the "/" was, checked at once.
 * Esc closes it and leaves the "/" as typed text, at the caret.
 */
export function CiteSearch({
  place,
  mindId,
  doc,
  onDone,
}: {
  place: CitePlace;
  mindId: string;
  doc: Y.Doc;
  onDone(): void;
}) {
  const t = useT();
  const [query, setQuery] = useState(() => sentenceAt(place.editor, place.from));
  const [found, setFound] = useState<FoundPassage[] | null>(null);
  /** The search couldn't run: what is shown says so, never that nothing matched. */
  const [failed, setFailed] = useState(false);
  const [choice, setChoice] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const anchor = useMemo(() => caretAnchor(place.editor, place.to), [place]);

  const chosen = useMindScope(doc);
  const folderId = useAppStore(
    (state) => state.minds.find((each) => each.id === mindId)?.folderId ?? null,
  );
  const folderHolds = useFolderHoldsDocuments(folderId);
  const wall = useTurnWall({ mindId, conversationId: null });
  const scope = useMemo(
    () => scopeWithin(wall ?? null, mindSearchScope(chosen, folderId, folderHolds)),
    [wall, chosen, folderId, folderHolds],
  );
  const named = useScopeName(hasSearchScope(scope) ? scope : null);
  const scopeLabel = !named
    ? t("composer.scope.all")
    : named.more > 0
      ? t("steps.scope.more", { scope: named.name, count: named.more, total: named.more + 1 })
      : named.name;

  // Starts with the sentence being written, all of it selected, so typing replaces it.
  useEffect(() => {
    field.current?.select();
  }, []);

  useEffect(() => {
    let current = true;
    setFailed(false);
    // A Passage gone, or a search that failed, is about the words that asked for it.
    setProblem(null);
    const timer = setTimeout(() => {
      core.findPassages({ text: query, mindId, scope }).then(
        (passages) => {
          if (!current) return;
          setFound(passages.slice(0, MOST_PASSAGES));
          setChoice(0);
        },
        (error: unknown) => {
          if (!current) return;
          // Saying nothing matched would be wrong: the search didn't run.
          setFailed(true);
          setFound([]);
          useAppStore.getState().reportError(error);
        },
      );
    }, SEARCH_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, mindId, scope]);

  const close = (how: "escape" | "outside") => {
    const editor = place.editor;
    onDone();
    // A press elsewhere in the Note is the User's to place, not this to undo.
    if (editor.isDestroyed || how === "outside") return;
    // The "/" stays as typed text, with the caret after it.
    editor
      .chain()
      .focus()
      .setTextSelection(Math.min(place.to, editor.state.doc.content.size))
      .run();
  };

  const choose = async (passage: FoundPassage) => {
    if (placing) return;
    setPlacing(true);
    try {
      const cited = await core.citePassage({ passageId: passage.passageId, text: query });
      const type = place.editor.state.schema.nodes[CITATION_NODE];
      if (!cited || !type) {
        setProblem(t("editor.cite.gone"));
        return;
      }
      asOneStep(place.editor, () => {
        place.editor
          .chain()
          .focus()
          .insertContentAt({ from: place.from, to: place.to }, type.create({ ...cited }))
          .run();
      });
      onDone();
    } catch (error) {
      useAppStore.getState().reportError(error);
    } finally {
      setPlacing(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // A Chinese input method's keys choose its characters, not a result.
    if (event.nativeEvent.isComposing || found === null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (found.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setChoice((choice + step + found.length) % found.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const passage = found[choice];
      if (passage) void choose(passage);
    }
  };

  return (
    <Popover
      anchor={anchor}
      placement="bottom-start"
      onDismiss={close}
      initialFocus={field}
      className="editor-menu cite-menu"
      aria-label={t("editor.cite.label")}
      data-testid="cite-search"
    >
      <input
        ref={field}
        type="text"
        spellCheck={false}
        data-testid="cite-query"
        aria-label={t("editor.cite.label")}
        placeholder={t("editor.cite.placeholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setChoice(0);
        }}
        onKeyDown={onKeyDown}
        className="cite-input"
      />
      <p data-testid="cite-scope" className="cite-scope">
        {t("editor.cite.searches", { scope: scopeLabel })}
      </p>
      <div className="cite-list">
        {problem !== null ? (
          <p data-testid="cite-problem" className="cite-note">
            {problem}
          </p>
        ) : failed ? (
          <p data-testid="cite-failed" className="cite-note">
            {t("search.failed")}
          </p>
        ) : found === null ? (
          <p data-testid="cite-searching" className="cite-note">
            {t("sources.searching")}
          </p>
        ) : found.length === 0 ? (
          <p data-testid="cite-nothing" className="cite-note">
            {t("editor.cite.nothingClose")}
          </p>
        ) : (
          <div role="listbox" aria-label={t("editor.cite.results")}>
            {found.map((passage, index) => {
              const where = passage.location && formatLocation(passage.location, t);
              const text = passage.text.replace(/\s+/g, " ").trim();
              const line = foundLine(
                { excerpt: text, highlights: rangesIn(text, passage.matches) },
                SNIPPET_LEAD,
              );
              return (
                <button
                  key={passage.passageId}
                  type="button"
                  role="option"
                  aria-selected={index === choice}
                  data-testid="cite-result"
                  data-document-name={passage.documentName}
                  // Keep the caret in the search field while the pointer moves.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setChoice(index)}
                  onClick={() => void choose(passage)}
                  title={passage.text}
                  className="cite-result"
                >
                  <DocumentLineIcon
                    kind={passage.documentKind}
                    className="cite-result-icon size-3.5"
                  />
                  <span className="cite-result-body">
                    <span className="cite-result-head">
                      <b>{passage.documentName}</b>
                      {where && <span data-testid="cite-result-where"> · {where}</span>}
                    </span>
                    <span data-testid="cite-result-text" className="cite-result-text">
                      <Marked text={line.text} ranges={line.ranges} />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Popover>
  );
}
