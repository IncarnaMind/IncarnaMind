import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { myNotesHidden } from "./myNotes";
import { tabHiddenRanges } from "./noteTabs";

export interface Heading {
  /** Where the heading starts in the document. */
  pos: number;
  level: number;
  text: string;
}

/** The Mind's headings in order, Answers' included; an empty one has nothing to jump to. */
export function outlineOf(editor: Editor): Heading[] {
  return headingsIn(editor.state, false);
}

/**
 * The headings the page shows: those of the tab open (#3414); in My notes (#138), those it hides
 * are left out.
 */
export function shownHeadings(state: EditorState): Heading[] {
  return headingsIn(state, true);
}

function headingsIn(state: EditorState, shownOnly: boolean): Heading[] {
  const hidden = shownOnly ? [...myNotesHidden(state), ...tabHiddenRanges(state)] : [];
  const headings: Heading[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return !node.isTextblock;
    const text = node.textContent.trim();
    const shown = !hidden.some((range) => pos >= range.from && pos < range.to);
    if (text !== "" && shown) headings.push({ pos, level: Number(node.attrs.level) || 1, text });
    return false;
  });
  return headings;
}

/** Whether two lists of headings read the same: where they start may differ. */
export const sameHeadings = (a: readonly Heading[], b: readonly Heading[]): boolean =>
  a.length === b.length &&
  a.every((heading, index) => heading.level === b[index]?.level && heading.text === b[index]?.text);

/**
 * The outline's entries, each keyed by its heading's index: indented by the levels the Note uses,
 * so its highest level is flush and a level it skips takes no indent (H1 and H3 indent once).
 */
export function outlineEntries(
  headings: readonly Heading[],
): { key: number; title: string; depth: number }[] {
  const levels = [...new Set(headings.map((heading) => heading.level))].sort((a, b) => a - b);
  return headings.map((heading, index) => ({
    key: index,
    title: heading.text,
    depth: levels.indexOf(heading.level),
  }));
}

/** The heading being read: the last whose top is at or above the reading line; null above the first. */
export function headingAt(tops: readonly number[], line: number): number | null {
  let at: number | null = null;
  for (const [index, top] of tops.entries()) if (top <= line) at = index;
  return at;
}

/** Moves the cursor to the start of a heading and scrolls it into view. */
export function jumpTo(editor: Editor, pos: number): void {
  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
      return true;
    })
    .scrollIntoView()
    .run();
}
