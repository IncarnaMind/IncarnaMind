import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { focusNow } from "./footnoteSchema";
import { keepMenuClosed } from "./selectionDismissal";

/** How find matches, as the bar offers it (⌘F, ⌥⌘F): Word's Match case and Whole word. */
export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

/** One match: the stretches of text it covers (more than one when marks split it). */
export interface FindMatch {
  from: number;
  to: number;
  parts: readonly { from: number; to: number }[];
}

export interface FindState {
  query: string;
  options: FindOptions;
  matches: readonly FindMatch[];
  /** The match the next and previous steps start from; -1 with none. */
  current: number;
}

/** A character a word is made of, for Whole word: Chinese characters are words of their own. */
const WORD_CHAR = /[\p{Script=Latin}\p{Nd}_]/u;

const KEY = new PluginKey<FindState>("findInMind");

/** How many matches are drawn at once; the count still names every one. */
const MOST_DECORATED = 400;

/** Stands between text that has a node between it, so a match never runs across one. */
const BREAK = "\u0000";

/**
 * A character's case-insensitive key, one code point for one, so a match's
 * places stay where the text's are. İ lowercases to i and a combining dot;
 * its base letter stands for it, as a reader would match it.
 */
function fold(char: string): string {
  const lower = char.toLowerCase();
  if (lower.length === 1) return lower;
  const base = lower.normalize("NFD").replace(/\p{M}/gu, "");
  return [...base][0] ?? char;
}

interface TextUnit {
  /** The unit's place in the document; -1 for a break between nodes. */
  pos: number;
  char: string;
  key: string;
  /** The text node it came from, so a match split by marks keeps its parts apart. */
  run: number;
}

/** The block's characters, each with the place it came from. */
function unitsOf(block: ProseMirrorNode, blockPos: number, matchCase: boolean): TextUnit[] {
  const units: TextUnit[] = [];
  let end = -1;
  let run = 0;
  block.forEach((child, offset) => {
    const pos = blockPos + 1 + offset;
    if (!child.isText || !child.text) return;
    if (pos !== end) units.push({ pos: -1, char: BREAK, key: BREAK, run: -1 });
    let at = 0;
    for (const char of child.text) {
      units.push({ pos: pos + at, char, key: matchCase ? char : fold(char), run });
      at += char.length;
    }
    run++;
    end = pos + child.nodeSize;
  });
  return units;
}

/**
 * Every place `query` occurs in the document's text, in order. It matches
 * letters without regard to case unless asked to, and takes the characters as
 * they come, with no idea of words unless Whole word is asked for, so Chinese
 * (which has none) is found like any other text. A node in the text, a
 * Citation among them, breaks a match: a replacement can never cross one.
 * Letters whose case changes their length, such as İ, are folded one
 * character at a time, so their block is searched like any other.
 */
export function findMatches(
  doc: ProseMirrorNode,
  query: string,
  options: FindOptions = {},
): FindMatch[] {
  const wanted = [...query];
  if (wanted.length === 0) return [];
  const keys = wanted.map((char) => (options.matchCase ? char : fold(char)));
  const matches: FindMatch[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const units = unitsOf(block, blockPos, options.matchCase === true);
    for (let at = 0; at + keys.length <= units.length; at++) {
      let found = true;
      for (let step = 0; step < keys.length; step++) {
        const unit = units[at + step];
        if (!unit || unit.pos < 0 || unit.key !== keys[step]) {
          found = false;
          break;
        }
      }
      if (!found) continue;
      const first = units[at] as TextUnit;
      const last = units[at + keys.length - 1] as TextUnit;
      if (options.wholeWord) {
        const before = units[at - 1]?.key ?? "";
        const after = units[at + keys.length]?.key ?? "";
        if (WORD_CHAR.test(first.key) && WORD_CHAR.test(before)) continue;
        if (WORD_CHAR.test(last.key) && WORD_CHAR.test(after)) continue;
      }
      const parts: { from: number; to: number }[] = [];
      let part: { from: number; to: number; run: number } | null = null;
      for (let step = 0; step < keys.length; step++) {
        const unit = units[at + step] as TextUnit;
        if (part && unit.run === part.run) {
          part.to = unit.pos + unit.char.length;
        } else {
          if (part) parts.push({ from: part.from, to: part.to });
          part = { from: unit.pos, to: unit.pos + unit.char.length, run: unit.run };
        }
      }
      if (part) parts.push({ from: part.from, to: part.to });
      const from = parts[0]?.from;
      const to = parts.at(-1)?.to;
      if (from !== undefined && to !== undefined) matches.push({ from, to, parts });
    }
    return true;
  });
  return matches;
}

/**
 * Replaces each match, as one step of the note's Undo, without ever cutting a
 * Citation's marker or another inline node: a match that would (which find
 * never makes) is left as it is. Each text block is written once, its marks
 * kept by position, so the words replaced keep the formatting they started in.
 * Returns how many were replaced.
 */
export function replaceMatches(
  editor: Editor,
  matches: readonly FindMatch[],
  replacement: string,
): number {
  if (matches.length === 0) return 0;
  const { state } = editor;
  const tr = state.tr;
  const blocks: { pos: number; node: ProseMirrorNode; matches: FindMatch[] }[] = [];
  let at = 0;
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const end = pos + node.nodeSize;
    const group: FindMatch[] = [];
    while (at < matches.length && (matches[at] as FindMatch).from < end) {
      const match = matches[at] as FindMatch;
      if (match.from >= pos + 1 && match.to <= end - 1) group.push(match);
      at++;
    }
    if (group.length > 0) {
      const atoms: { from: number; to: number }[] = [];
      let childPos = pos + 1;
      node.forEach((child) => {
        if (child.isInline && !child.isText)
          atoms.push({ from: childPos, to: childPos + child.nodeSize });
        childPos += child.nodeSize;
      });
      const safe = group.filter(
        (match) => !atoms.some((atom) => match.from < atom.to && match.to > atom.from),
      );
      if (safe.length > 0) blocks.push({ pos, node, matches: safe });
    }
    return false;
  });

  let replaced = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (!block) continue;
    const content: ProseMirrorNode[] = [];
    let childPos = block.pos + 1;
    let current = 0;
    block.node.forEach((child) => {
      const childEnd = childPos + child.nodeSize;
      if (child.isText && child.text) {
        let local = 0;
        while (local < child.text.length) {
          const absolute = childPos + local;
          const match = block.matches[current];
          if (match && absolute >= match.to) {
            current++;
            continue;
          }
          if (match && absolute >= match.from) {
            if (absolute === match.from) {
              if (replacement !== "") content.push(state.schema.text(replacement, child.marks));
              replaced++;
            }
            local = Math.min(child.text.length, match.to - childPos);
          } else {
            const stop = match
              ? Math.min(child.text.length, match.from - childPos)
              : child.text.length;
            if (stop > local)
              content.push(state.schema.text(child.text.slice(local, stop), child.marks));
            local = stop;
          }
        }
      } else {
        content.push(child);
      }
      childPos = childEnd;
    });
    tr.replaceWith(
      block.pos,
      block.pos + block.node.nodeSize,
      block.node.type.create(block.node.attrs, content, block.node.marks),
    );
  }
  if (replaced > 0 && tr.docChanged) editor.view.dispatch(tr);
  return replaced;
}

/** Replaces every match of `query`, in one step: Word's Replace all. Returns how many. */
export function replaceAllInMind(
  editor: Editor,
  query: string,
  replacement: string,
  options: FindOptions,
): number {
  const matches = findMatches(editor.state.doc, query, options);
  return replaceMatches(editor, matches, replacement);
}

/**
 * Replaces the match the bar is on, then goes on to the next one, as Word
 * does. Null when there is no match to replace.
 */
export function replaceCurrentInMind(
  editor: Editor,
  query: string,
  replacement: string,
  options: FindOptions,
): number | null {
  const state = findStateOf(editor);
  const match = state.matches[state.current];
  if (!match) return null;
  const replaced = replaceMatches(editor, [match], replacement);
  if (replaced === 0) return null;
  // The match after what was written, never the new words themselves, and the first again at the end.
  const matches = findMatches(editor.state.doc, query, options);
  const next = matches.findIndex((each) => each.from >= match.from + replacement.length);
  editor.view.dispatch(editor.state.tr.setMeta(KEY, { at: next === -1 ? 0 : next }));
  scrollToCurrent(editor);
  return replaced;
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

type FindMeta =
  | { query: string; options?: FindOptions }
  | { step: 1 | -1 }
  | { at: number }
  | { clear: true };

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
          init: () => ({ query: "", options: {}, matches: [], current: -1 }),
          apply(tr, state) {
            const meta = tr.getMeta(KEY) as FindMeta | undefined;
            if (meta && "clear" in meta)
              return { query: "", options: {}, matches: [], current: -1 };
            if (meta && "query" in meta) {
              const options = meta.options ?? state.options;
              const matches = findMatches(tr.doc, meta.query, options);
              return {
                query: meta.query,
                options,
                matches,
                current: matches.length > 0 ? 0 : -1,
              };
            }
            if (meta && "step" in meta) {
              const count = state.matches.length;
              if (count === 0) return state;
              return { ...state, current: (state.current + meta.step + count) % count };
            }
            if (meta && "at" in meta) {
              if (state.matches.length === 0) return state;
              const at = Math.min(Math.max(meta.at, 0), state.matches.length - 1);
              return { ...state, current: at };
            }
            if (!tr.docChanged || state.query === "") return state;
            const kept = state.matches[state.current];
            const matches = findMatches(tr.doc, state.query, state.options);
            const from = kept ? tr.mapping.map(kept.from) : -1;
            return {
              query: state.query,
              options: state.options,
              matches,
              current: stayAt(matches, from, state.current),
            };
          },
        },
        props: {
          decorations(editorState) {
            const state = KEY.getState(editorState);
            if (!state || state.matches.length === 0) return DecorationSet.empty;
            // Replace all can leave 10,000 matches: draw a bounded stretch of them, and the current
            // one wherever it is, so the editor stays responsive; the count still names them all.
            const shown: { match: (typeof state.matches)[number]; index: number }[] = [];
            for (let index = 0; index < state.matches.length && index < MOST_DECORATED; index++) {
              const match = state.matches[index];
              if (match) shown.push({ match, index });
            }
            if (state.current >= MOST_DECORATED) {
              const match = state.matches[state.current];
              if (match) shown.push({ match, index: state.current });
            }
            return DecorationSet.create(
              editorState.doc,
              shown.flatMap(({ match, index }) =>
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
  KEY.getState(editor.state) ?? { query: "", options: {}, matches: [], current: -1 };

export function setFindQuery(editor: Editor, query: string, options?: FindOptions): void {
  editor.view.dispatch(editor.state.tr.setMeta(KEY, { query, options }));
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
  if (select) tr.scrollIntoView();
  editor.view.dispatch(tr);
  if (select) focusNow(editor);
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
  try {
    const { node } = editor.view.domAtPos(match.from);
    const element = node instanceof Element ? node : node.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "instant" });
  } catch {
    // A headless editor has no page.
  }
}
