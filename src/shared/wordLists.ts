import { markerNumber, type NumberingScheme, schemeOfMarkers } from "./numbering";

export interface WordListPlace {
  /** The list it belongs to: items of another list never join it at its top level. */
  listId: string;
  /** From 0. */
  level: number;
  ordered: boolean;
  /** Its number, where Word's numbering has got to. */
  number: number;
  /** A numbered list's scheme, when it is written in one (#1419); absent, the default. */
  scheme?: NumberingScheme;
  /** The level of its scheme it starts at, when that isn't its first level; absent, from 0. */
  startLevel?: number;
}

export interface ListBuilder<Node> {
  /** A new list for `place`'s item; `startLevel`, the level an outermost one starts at. */
  list(place: WordListPlace, startLevel: number): Node;
  item(list: Node, block: Node): void;
  /** Puts `list` inside the last item of `parent`. */
  nest(parent: Node, list: Node): void;
}

/**
 * Consecutive items of one list, nested by level (a level deeper than the one before goes one
 * deeper only), each list numbered from where Word's numbering has got to. A numbered list in a
 * scheme whose first item is deeper than the first level starts at that level, and an item of it
 * shallower than that starts a list of its own; other lists start at the first level, as before.
 */
export function groupWordLists<Node>(
  blocks: readonly { node: Node; list: WordListPlace | null }[],
  build: ListBuilder<Node>,
): Node[] {
  const out: Node[] = [];
  const open: { list: Node; ordered: boolean; listId: string; level: number }[] = [];
  for (const { node, list } of blocks) {
    if (!list) {
      open.length = 0;
      out.push(node);
      continue;
    }
    const inScheme = list.ordered && list.scheme !== undefined;
    const level = inScheme ? list.level : Math.min(list.level, open.length);
    let depth = 0;
    while (depth < open.length && (open[depth]?.level ?? 0) < level) depth++;
    if (open[depth] && open[depth]?.level !== level) open.length = depth;
    open.length = Math.min(open.length, depth + 1);
    const top = open[depth];
    if (top && (top.ordered !== list.ordered || (depth === 0 && top.listId !== list.listId))) {
      open.length = depth;
    }
    if (open.length === depth) {
      const created = build.list(
        list,
        depth === 0 && inScheme ? (list.startLevel ?? list.level) : 0,
      );
      const parent = open[depth - 1];
      if (parent) build.nest(parent.list, created);
      else out.push(created);
      open.push({ list: created, ordered: list.ordered, listId: list.listId, level });
    }
    const current = open[depth];
    if (current) build.item(current.list, node);
  }
  return out;
}

// Word's Symbol and Wingdings bullets copy as private-use characters.
const BULLET = /^(?:[·o§•▪■◦●○□➢➤✓*\-–—]|[\uF000-\uF8FF])$/u;

/**
 * How the editor draws a run of Word list paragraphs, from the markers Word typed before them
 * ("3.", "(ii)", "（一）", "·"), each at its level: a bullet, or a number in the one scheme the
 * run's numbers are written in, with its number. Null when no scheme writes them all ("1)",
 * "Article 1"): the run stays paragraphs, its markers typed.
 */
export function drawnMarkers(
  run: readonly { marker: string; level: number }[],
): ({ ordered: false } | { ordered: true; scheme: NumberingScheme; number: number })[] | null {
  const numbers = run.filter(({ marker }) => !BULLET.test(marker));
  const scheme = numbers.length > 0 ? schemeOfMarkers(numbers) : null;
  if (numbers.length > 0 && !scheme) return null;
  return run.map(({ marker, level }) =>
    scheme && !BULLET.test(marker)
      ? { ordered: true, scheme, number: markerNumber(scheme, level, marker) ?? 1 }
      : { ordered: false },
  );
}
