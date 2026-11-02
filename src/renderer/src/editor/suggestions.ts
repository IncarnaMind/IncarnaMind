import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import { CITATION_NODE, GENERATED_MARK, type Suggestion } from "../../../core/api";
import {
  citationNumberAt,
  joinerFor,
  nextWord,
  type SuggestionPlace,
  suggestionPlace,
} from "./suggestionPlace";

/** How long the User pauses before a suggestion is asked for (#282: about 0.8 s). */
export const PAUSE_MS = 800;

/** A suggestion shown after the caret: grey text, then its Citation's marker. */
interface Ghost {
  suggestion: Suggestion;
  /** Where it sits: after the caret, and after any of its words already accepted. */
  pos: number;
  /** The words not accepted yet, with the space before them. */
  rest: string;
  /** Where the words accepted with ⌥→ start; null before any. */
  started: number | null;
  /** The number its Citation will have. */
  number: number;
}

interface SuggestionState {
  ghost: Ghost | null;
  /** Counts the User's own edits, so a reply that comes after another edit is dropped. */
  typed: number;
  /** The last suggestion accepted, and how much of it, for `accepted`. */
  accepted: { suggestionId: string; characters: number } | null;
}

type Meta =
  | { show: Ghost }
  | { advance: Pick<Ghost, "pos" | "rest" | "started"> }
  | { dismiss: true }
  | { accepted: { suggestionId: string; characters: number } };

const suggestionsKey = new PluginKey<SuggestionState>("suggestions");

export interface SuggestionsOptions {
  /**
   * Asks for a suggestion at a pause: the paragraph's text up to the caret.
   * Null when there is none (suggestions off, no support, cancelled).
   */
  request(input: { requestId: string; paragraph: string }): Promise<Suggestion | null>;
  /** The User went on before the reply came: stop asking. */
  cancel(requestId: string): void;
  /** The User accepted a suggestion, `characters` of it. */
  accepted(suggestionId: string, characters: number): void;
  /** Whether to wait: an Answer is being written into this Mind. */
  busy(): boolean;
  /** Words for the suggestion, in the interface's language: its label, its marker's tooltip, its key. */
  describe(suggestion: Suggestion): { label: string; citation: string; key: string };
  reportError(error: unknown): void;
}

/** The Citation node a suggestion's Citation becomes. */
function citationNode(state: EditorState, suggestion: Suggestion): ProseMirrorNode {
  const attrs = Object.fromEntries(
    Object.entries(suggestion.citation).filter(([, value]) => value !== null),
  );
  const type = state.schema.nodes[CITATION_NODE];
  if (!type) throw new Error(`The note's schema has no ${CITATION_NODE} node.`);
  return type.create(attrs);
}

/** Keeps an accepted suggestion one step of Undo of its own: what was typed before it isn't part of it. */
function separateUndo(state: EditorState): void {
  const undo: { undoManager?: { stopCapturing(): void } } | undefined =
    yUndoPluginKey.getState(state);
  undo?.undoManager?.stopCapturing();
}

/** A change that came from the Mind's document (another window, an Answer streaming, Undo), not typing here. */
const fromDocument = (tr: Transaction) => !!tr.getMeta(ySyncPluginKey)?.isChangeOrigin;

/** Takes the next word (⌥→), or all of the rest (Tab), as AI text; the last of it brings its Citation. */
function accept(view: EditorView, ghost: Ghost, all: boolean): void {
  const taken = all ? ghost.rest : nextWord(ghost.rest);
  const rest = ghost.rest.slice(taken.length);
  const tr = view.state.tr.insertText(taken, ghost.pos);
  const end = ghost.pos + taken.length;
  const generated = view.state.schema.marks[GENERATED_MARK];
  if (generated) tr.addMark(ghost.pos, end, generated.create());
  if (rest.trim() === "") {
    tr.insert(end, citationNode(view.state, ghost.suggestion));
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
    const characters = end - (ghost.started ?? ghost.pos);
    tr.setMeta(suggestionsKey, {
      accepted: { suggestionId: ghost.suggestion.suggestionId, characters },
    } satisfies Meta);
  } else {
    tr.setSelection(TextSelection.create(tr.doc, end));
    tr.setMeta(suggestionsKey, {
      advance: { pos: end, rest, started: ghost.started ?? ghost.pos },
    } satisfies Meta);
  }
  if (ghost.started === null) separateUndo(view.state);
  view.dispatch(tr.scrollIntoView());
}

/** The grey text after the caret, and its Citation's marker. */
function ghostWidget(ghost: Ghost, words: ReturnType<SuggestionsOptions["describe"]>) {
  return () => {
    const root = document.createElement("span");
    root.className = "suggestion";
    root.dataset.testid = "suggestion";
    root.contentEditable = "false";
    root.setAttribute("aria-label", words.label);
    root.append(ghost.rest);
    const marker = document.createElement("span");
    marker.className = "suggestion-citation";
    marker.dataset.testid = "suggestion-citation";
    marker.textContent = String(ghost.number);
    marker.title = words.citation;
    const key = document.createElement("kbd");
    key.className = "suggestion-key";
    key.textContent = words.key;
    root.append(marker, key);
    return root;
  };
}

/**
 * Suggest as I write (#282). After a pause of `PAUSE_MS` at the end of a
 * paragraph of body text, it asks for a suggestion, and shows one as grey
 * text after the caret with its Citation's marker. Tab accepts it, with a
 * real, checked Citation, as one step of Undo; ⌥→ accepts the next word
 * (its Citation follows the words taken when the rest goes); Esc, typing or
 * moving the caret dismisses it. Nothing is asked while an input method is
 * composing, with a selection, or while an Answer is being written; typing
 * cancels a request still waiting for its reply. The grey text is a
 * decoration, never part of the Mind until accepted.
 */
export const Suggestions = Extension.create<SuggestionsOptions>({
  name: "suggestions",
  // Before the other keymaps: Tab and Esc are the suggestion's while it shows.
  priority: 1000,

  addOptions() {
    return {
      request: async () => null,
      cancel: () => undefined,
      accepted: () => undefined,
      busy: () => false,
      describe: () => ({ label: "", citation: "", key: "Tab" }),
      reportError: (error: unknown) => console.error(error),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<SuggestionState>({
        key: suggestionsKey,
        state: {
          init: () => ({ ghost: null, typed: 0, accepted: null }),
          apply(tr, value): SuggestionState {
            const meta = tr.getMeta(suggestionsKey) as Meta | undefined;
            const typed = tr.docChanged && !fromDocument(tr) ? value.typed + 1 : value.typed;
            if (meta && "show" in meta) return { ...value, ghost: meta.show };
            if (meta && "advance" in meta && value.ghost) {
              return { ...value, typed, ghost: { ...value.ghost, ...meta.advance } };
            }
            if (meta && "accepted" in meta) return { ghost: null, typed, accepted: meta.accepted };
            const { ghost } = value;
            // Typing, Esc, a change from elsewhere, or the caret moving: it goes.
            const stays =
              ghost &&
              !(meta && "dismiss" in meta) &&
              !tr.docChanged &&
              tr.selection.empty &&
              tr.selection.head === ghost.pos;
            return { ...value, typed, ghost: stays ? ghost : null };
          },
        },

        // Words taken with ⌥→ keep their Citation, after them, however the rest goes.
        appendTransaction(transactions, before, after) {
          const ghost = suggestionsKey.getState(before)?.ghost;
          if (!ghost || ghost.started === null || suggestionsKey.getState(after)?.ghost)
            return null;
          // Ended by accepting the rest, which brought the Citation; or by Undo, which took the words back.
          const metas = transactions.map((tr) => tr.getMeta(suggestionsKey) as Meta | undefined);
          if (metas.some((meta) => meta && !("dismiss" in meta))) return null;
          if (transactions.some((tr) => tr.getMeta(ySyncPluginKey)?.isUndoRedoOperation))
            return null;
          let pos = ghost.pos;
          for (const tr of transactions) pos = tr.mapping.map(pos, -1);
          const tr = after.tr.insert(pos, citationNode(after, ghost.suggestion));
          return tr.setMeta(suggestionsKey, {
            accepted: {
              suggestionId: ghost.suggestion.suggestionId,
              characters: ghost.pos - ghost.started,
            },
          } satisfies Meta);
        },

        props: {
          decorations(state) {
            const ghost = suggestionsKey.getState(state)?.ghost;
            if (!ghost) return null;
            const widget = Decoration.widget(
              ghost.pos,
              ghostWidget(ghost, options.describe(ghost.suggestion)),
              {
                side: 1,
                ignoreSelection: true,
                key: `${ghost.suggestion.suggestionId}:${ghost.rest}`,
              },
            );
            return DecorationSet.create(state.doc, [widget]);
          },

          handleKeyDown(view, event) {
            const ghost = suggestionsKey.getState(view.state)?.ghost;
            if (!ghost || event.isComposing) return false;
            const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey;
            if (event.key === "Tab" && plain && !event.altKey) {
              accept(view, ghost, true);
              return true;
            }
            if (event.key === "ArrowRight" && plain && event.altKey) {
              accept(view, ghost, false);
              return true;
            }
            if (event.key === "Escape") {
              // The innermost thing open: nothing behind it closes too.
              event.stopPropagation();
              view.dispatch(
                view.state.tr.setMeta(suggestionsKey, { dismiss: true } satisfies Meta),
              );
              return true;
            }
            return false;
          },

          handleDOMEvents: {
            // An input method's text goes where the caret is: the grey text makes way.
            compositionstart(view) {
              if (suggestionsKey.getState(view.state)?.ghost) {
                view.dispatch(
                  view.state.tr.setMeta(suggestionsKey, { dismiss: true } satisfies Meta),
                );
              }
              return false;
            },
          },
        },

        view() {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let waiting: string | null = null;
          const stopWaiting = () => {
            clearTimeout(timer);
            if (waiting) options.cancel(waiting);
            waiting = null;
          };

          /** At a pause: asks, then shows the reply if nothing changed meanwhile. */
          const ask = (view: EditorView) => {
            if (view.isDestroyed || !view.editable || !view.hasFocus() || view.composing) return;
            if (options.busy() || suggestionsKey.getState(view.state)?.ghost) return;
            const place = suggestionPlace(view.state);
            if (!place) return;
            const typed = suggestionsKey.getState(view.state)?.typed;
            const requestId = crypto.randomUUID();
            waiting = requestId;
            options.request({ requestId, paragraph: place.text }).then(
              (suggestion) => {
                if (waiting !== requestId) return;
                waiting = null;
                if (suggestion && !view.isDestroyed) show(view, place, typed, suggestion);
              },
              (error: unknown) => {
                if (waiting === requestId) waiting = null;
                options.reportError(error);
              },
            );
          };

          const show = (
            view: EditorView,
            place: SuggestionPlace,
            typed: number | undefined,
            suggestion: Suggestion,
          ) => {
            const now = suggestionPlace(view.state);
            const unchanged =
              suggestionsKey.getState(view.state)?.typed === typed &&
              now?.pos === place.pos &&
              now.text === place.text;
            if (!unchanged || !view.hasFocus() || view.composing || options.busy()) return;
            const ghost: Ghost = {
              suggestion,
              pos: place.pos,
              rest: joinerFor(place.text, suggestion.text) + suggestion.text,
              started: null,
              number: citationNumberAt(view.state, place.pos, suggestion.citation),
            };
            view.dispatch(view.state.tr.setMeta(suggestionsKey, { show: ghost } satisfies Meta));
          };

          return {
            update(view, previous) {
              const before = suggestionsKey.getState(previous);
              const after = suggestionsKey.getState(view.state);
              const justAccepted = !!after?.accepted && after.accepted !== before?.accepted;
              if (justAccepted && after?.accepted) {
                options.accepted(after.accepted.suggestionId, after.accepted.characters);
              }
              if (before?.typed !== after?.typed) {
                // The User typed: whatever was asked is stale; ask again at the next pause (not
                // right after accepting one: the next comes once the User writes on).
                stopWaiting();
                if (!after?.ghost && !justAccepted) timer = setTimeout(() => ask(view), PAUSE_MS);
              } else if (
                view.state.doc !== previous.doc ||
                !view.state.selection.eq(previous.selection)
              ) {
                stopWaiting();
              }
            },
            destroy: stopWaiting,
          };
        },
      }),
    ];
  },
});
