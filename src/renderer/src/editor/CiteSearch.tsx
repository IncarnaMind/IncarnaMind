import type { VirtualElement } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { CITATION_NODE, type FoundPassage, type TextRange } from "../../../core/api";
import { citedSpeakers } from "../../../shared/citations";
import { formatLocation } from "../../../shared/locations";
import { hasSearchScope, mindSearchScope } from "../../../shared/searchScope";
import { INLINE_NODE, lastSentence } from "../../../shared/sentences";
import { DocumentLineIcon } from "../components/lineIcons";
import { Marked } from "../components/Marked";
import { core } from "../core";
import { useT } from "../i18n";
import { useMindScope } from "../keptScope";
import { scopeWithin } from "../scope";
import { useFolderHoldsDocuments, useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import { useTurnWall } from "../turnWall";
import type { CitePlace } from "./citeRequest";
import { asOneStep } from "./editorUndo";
import { Popover } from "./Popover";

const SEARCH_PAUSE_MS = 200;
const MOST_PASSAGES = 6;

const SCALES = ["thousand", "million", "billion", "trillion", "千", "万", "亿", "兆"] as const;

function sentenceAt(editor: Editor, pos: number): string {
  const $pos = editor.state.doc.resolve(Math.min(Math.max(pos, 0), editor.state.doc.content.size));
  if (!$pos.parent.isTextblock) return "";
  return lastSentence($pos.parent.textBetween(0, $pos.parentOffset, "\n", INLINE_NODE));
}

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

/** The scale a number is written at, right after it: "million" in "$12.3 million". */
function scaleAfter(text: string, at: number): string | null {
  const words = text
    .slice(at)
    .toLocaleLowerCase()
    .match(/[a-z一-鿿]+/u);
  if (!words) return null;
  const word = words[0] ?? "";
  return (SCALES as readonly string[]).includes(word) ? word : null;
}

/**
 * The matches to show in bold: a number the Passage writes at another scale
 * than the words searched for ("12.3 thousand" for "$12.3 million") is not
 * shown as a match (#281).
 */
export function matchesToShow(
  quote: string,
  matches: readonly string[],
  searched: string,
): string[] {
  const lowerQuote = quote.toLocaleLowerCase();
  const lowerSearched = searched.toLocaleLowerCase();
  return matches.filter((match) => {
    if (!/^\d/u.test(match)) return true;
    const wanted = match.toLocaleLowerCase();
    const atQuote = lowerQuote.indexOf(wanted);
    const atSearched = lowerSearched.indexOf(wanted);
    if (atQuote === -1 || atSearched === -1) return true;
    const inQuote = scaleAfter(lowerQuote, atQuote + wanted.length);
    const inSearched = scaleAfter(lowerSearched, atSearched + wanted.length);
    return inQuote === null || inSearched === null || inQuote === inSearched;
  });
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
  /** A search is on its way: later words keep the rows shown, with a sign it is looking. */
  const [searching, setSearching] = useState(true);
  const [choice, setChoice] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const anchor = useMemo(() => caretAnchor(place.editor, place.to), [place]);
  // The "/" and what was typed after it, kept where the Note's own changes move it: an
  // Answer, another window or Undo above the caret must not make the Citation replace a word.
  const from = useRef(place.from);
  const to = useRef(place.to);
  const slash = useRef(place.editor.state.doc.textBetween(place.from, place.to));

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
  const documents = useAppStore((state) => state.documents);
  const scopeLabel = !named
    ? t("composer.scope.all")
    : named.more > 0
      ? t("steps.scope.more", { scope: named.name, count: named.more, total: named.more + 1 })
      : named.name;

  useEffect(() => {
    const editor = place.editor;
    const follow = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      from.current = transaction.mapping.map(from.current, 1);
      to.current = transaction.mapping.map(to.current, -1);
    };
    editor.on("transaction", follow);
    return () => {
      editor.off("transaction", follow);
    };
  }, [place.editor]);

  // Starts with the sentence being written, all of it selected, so typing replaces it.
  useEffect(() => {
    field.current?.select();
  }, []);

  useEffect(() => {
    rows.current[choice]?.scrollIntoView({ block: "nearest" });
  }, [choice]);

  // One search at a time, the words typed last winning: a chosen reranking service is not
  // sent a request for every pause in typing.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef<string | null>(null);
  const latest = useRef(query);
  latest.current = query;
  const scopeNow = useRef(scope);
  scopeNow.current = scope;
  const mindNow = useRef(mindId);
  mindNow.current = mindId;

  function search(words: string, mine: number) {
    if (inFlight.current) {
      pending.current = words;
      return;
    }
    inFlight.current = true;
    core
      .findPassages({ text: words, mindId: mindNow.current, scope: scopeNow.current })
      .then(
        (passages) => {
          if (generation.current !== mine) return;
          setFound(passages.slice(0, MOST_PASSAGES));
          setChoice(0);
        },
        (error: unknown) => {
          if (generation.current !== mine) return;
          // Saying nothing matched would be wrong: the search didn't run.
          setFailed(true);
          setFound([]);
          useAppStore.getState().reportError(error);
        },
      )
      .finally(() => {
        inFlight.current = false;
        const next = pending.current;
        pending.current = null;
        if (next !== null) search(next, generation.current);
        else if (generation.current === mine) setSearching(false);
      });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `search` reads the words and the refs; these are what ask again.
  useEffect(() => {
    const mine = ++generation.current;
    setFailed(false);
    // A Passage gone, or a search that failed, is about the words that asked for it.
    setProblem(null);
    setSearching(true);
    const timer = setTimeout(() => search(query, mine), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [query, mindId, scope]);

  const close = (how: "escape" | "outside") => {
    const editor = place.editor;
    onDone();
    // A press elsewhere in the Note is the User's to place, not this to undo.
    if (editor.isDestroyed || how === "outside") return;
    editor
      .chain()
      .focus()
      .setTextSelection(Math.min(to.current, editor.state.doc.content.size))
      .run();
  };

  const choose = async (passage: FoundPassage) => {
    if (placing) return;
    const editor = place.editor;
    const range = { from: from.current, to: to.current };
    const typed = editor.state.doc.textBetween(range.from, range.to);
    if (range.from > range.to || typed !== slash.current) {
      // The "/" was taken away while the search was open: there is nowhere to put the Citation.
      setProblem(t("editor.cite.gone"));
      return;
    }
    setPlacing(true);
    try {
      const cited = await core.citePassage({ passageId: passage.passageId, text: query });
      const type = editor.state.schema.nodes[CITATION_NODE];
      if (!cited || !type) {
        setProblem(t("editor.cite.gone"));
        return;
      }
      asOneStep(editor, () => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, type.create({ ...cited }))
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
        role="combobox"
        aria-label={t("editor.cite.label")}
        aria-autocomplete="list"
        aria-expanded={found !== null && found.length > 0}
        aria-controls={listId}
        aria-activedescendant={found?.[choice] !== undefined ? `${listId}-${choice}` : undefined}
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
          <div role="listbox" id={listId} aria-label={t("editor.cite.results")}>
            {found.map((passage, index) => {
              const where =
                passage.location &&
                formatLocation(passage.location, t, {
                  speakers: citedSpeakers(passage, documents),
                });
              const shown = matchesToShow(passage.quote, passage.matches, query);
              return (
                <button
                  key={passage.passageId}
                  ref={(element) => {
                    rows.current[index] = element;
                  }}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === choice}
                  data-testid="cite-result"
                  data-document-name={passage.documentName}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setChoice(index)}
                  onClick={() => void choose(passage)}
                  title={passage.quote}
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
                      <Marked
                        text={passage.quote || passage.text.replace(/\s+/g, " ").trim()}
                        ranges={rangesIn(passage.quote, shown)}
                      />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {searching && found !== null && !failed && problem === null && (
          <p data-testid="cite-progress" className="cite-note">
            {t("sources.searching")}
          </p>
        )}
      </div>
    </Popover>
  );
}
