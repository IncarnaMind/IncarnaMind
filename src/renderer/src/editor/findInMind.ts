import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { keepMenuClosed } from "./selectionDismissal";

/** One match: the stretches of text it covers (more than one when marks split it). */
export interface FindMatch {
  from: number;
  to: number;
  parts: readonly { from: number; to: number }[];
}

export interface FindState {
  query: string;
  matches: readonly FindMatch[];
  /** The match the next and previous steps start from; -1 with none. */
  current: number;
}

const KEY = new PluginKey<FindState>("findInMind");

/** Stands between text that has a node between it, so a match never runs across one. */
const BREAK = "\u0000";

/**
 * Every place `query` occurs in the document's text, in order. It matches
 * letters without regard to case and takes the characters as they come, with
 * no idea of words, so Chinese (which has none) is found like any other text.
 */
export function findMatches(doc: ProseMirrorNode, query: string): FindMatch[] {
  const wanted = query.toLowerCase();
  if (wanted === "") return [];
  const matches: FindMatch[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const pieces: { pos: number; start: number; length: number }[] = [];
    let text = "";
    let end = -1;
    block.forEach((child, offset) => {
      const pos = blockPos + 1 + offset;
      if (child.isText && child.text) {
        if (pos !== end) text += BREAK;
        pieces.push({ pos, start: text.length, length: child.text.length });
        text += child.text;
        end = pos + child.nodeSize;
      }
    });
    const haystack = text.toLowerCase();
    if (haystack.length !== text.length) return true;
    for (let at = haystack.indexOf(wanted); at !== -1; at = haystack.indexOf(wanted, at + 1)) {
      const stop = at + wanted.length;
      const parts = pieces.flatMap((piece) => {
        const from = Math.max(at, piece.start);
        const to = Math.min(stop, piece.start + piece.length);
        return from < to
          ? [{ from: piece.pos + from - piece.start, to: piece.pos + to - piece.start }]
          : [];
      });
      const first = parts[0];
      const last = parts.at(-1);
      if (first && last) matches.push({ from: first.from, to: last.to, parts });
    }
    return true;
  });
  return matches;
}

/**
 * The match that stays current when the text changes: the one that still
 * starts where the current did, else the one at the same place in the order,
 * so a streamed Answer, which replaces its block as it grows, doesn't move it.
 */
function stayAt(matches: readonly FindMatch[], from: number, index: number): number {
  if (matches.length === 0) return -1;
  const same = matches.findIndex((match) => match.from === from);
  return same !== -1 ? same : Math.min(Math.max(index, 0), matches.length - 1);
}

type FindMeta = { query: string } | { step: 1 | -1 } | { clear: true };

/**
 * Find in the Mind (#115): the matches of a query are marked in the text, one
 * of them as the current. The text is searched again as it changes, so an
 * Answer that is still being written is searched as it grows, and the current
 * match stays where it was.
 */
export const FindInMind = Extension.create({
  name: "findInMind",

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: KEY,
        state: {
          init: () => ({ query: "", matches: [], current: -1 }),
          apply(tr, state) {
            const meta = tr.getMeta(KEY) as FindMeta | undefined;
            if (meta && "clear" in meta) return { query: "", matches: [], current: -1 };
            if (meta && "query" in meta) {
              const matches = findMatches(tr.doc, meta.query);
              return { query: meta.query, matches, current: matches.length > 0 ? 0 : -1 };
            }
            if (meta && "step" in meta) {
              const count = state.matches.length;
              if (count === 0) return state;
              return { ...state, current: (state.current + meta.step + count) % count };
            }
            if (!tr.docChanged || state.query === "") return state;
            const kept = state.matches[state.current];
            const matches = findMatches(tr.doc, state.query);
            const from = kept ? tr.mapping.map(kept.from) : -1;
            return { query: state.query, matches, current: stayAt(matches, from, state.current) };
          },
        },
        props: {
          decorations(editorState) {
            const state = KEY.getState(editorState);
            if (!state || state.matches.length === 0) return DecorationSet.empty;
            return DecorationSet.create(
              editorState.doc,
              state.matches.flatMap((match, index) =>
                match.parts.map((part) =>
                  Decoration.inline(part.from, part.to, {
                    class:
                      index === state.current ? "find-match find-match--current" : "find-match",
                  }),
                ),
              ),
            );
          },
        },
      }),
    ];
  },
});

export const findStateOf = (editor: Editor): FindState =>
  KEY.getState(editor.state) ?? { query: "", matches: [], current: -1 };

export function setFindQuery(editor: Editor, query: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(KEY, { query }));
  scrollToCurrent(editor);
}

/** Moves to the next match (1) or the previous (-1), round the ends, and shows it. */
export function stepFind(editor: Editor, step: 1 | -1): void {
  editor.view.dispatch(editor.state.tr.setMeta(KEY, { step }));
  scrollToCurrent(editor);
}

/** Clears the marks; with `select`, the cursor goes to the current match, if any, and the editor takes the focus, as the find bar closes. */
export function clearFind(editor: Editor, select = false): void {
  const state = findStateOf(editor);
  const match = state.matches[state.current];
  const tr = editor.state.tr.setMeta(KEY, { clear: true });
  if (select && match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
  editor.view.dispatch(tr);
  if (select) editor.commands.focus();
}

/**
 * Closes find: its marks go, the cursor selects the current match, and the selection menu stays
 * closed over it, since the User didn't select those words (#1355).
 */
export function closeFind(editor: Editor): void {
  const { matches, current } = findStateOf(editor);
  const match = matches[current];
  if (match) keepMenuClosed(editor, match.from, match.to);
  clearFind(editor, true);
}

function scrollToCurrent(editor: Editor): void {
  const state = findStateOf(editor);
  const match = state.matches[state.current];
  if (!match) return;
  const { node } = editor.view.domAtPos(match.from);
  const element = node instanceof Element ? node : node.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "instant" });
}
