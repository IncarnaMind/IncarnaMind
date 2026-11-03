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
  /** A new list for `place`'s item; `startLevel`, the level of its scheme it starts at, from 0. */
  list(place: WordListPlace, startLevel: number): Node;
  item(list: Node, block: Node): void;
  /** Puts `list` inside the last item of `parent`. */
  nest(parent: Node, list: Node): void;
}

/**
 * Consecutive items of one list, nested by their Word levels (a level deeper than the one before
 * goes one deeper only), each list numbered from where Word's numbering has got to. A numbered list
 * in a scheme that isn't in another numbered list draws its numbers from its own start level, so
 * an item shallower than that starts a list of its own; any other list takes in a shallower item,
 * as it is drawn by how deep it is nested.
 */
export function groupWordLists<Node>(
  blocks: readonly { node: Node; list: WordListPlace | null }[],
  build: ListBuilder<Node>,
): Node[] {
  const out: Node[] = [];
  const open: {
    list: Node;
    ordered: boolean;
    listId: string;
    level: number;
    startLevel: number;
  }[] = [];
  for (const { node, list } of blocks) {
    if (!list) {
      open.length = 0;
      out.push(node);
      continue;
    }
    let depth = 0;
    while (depth < open.length && (open[depth]?.level ?? 0) < list.level) depth++;
    const at = open[depth];
    if (at && at.level > list.level) {
      if (at.startLevel > 0) open.length = depth;
      else at.level = list.level;
    }
    open.length = Math.min(open.length, depth + 1);
    const top = open[depth];
    if (top && (top.ordered !== list.ordered || (depth === 0 && top.listId !== list.listId))) {
      open.length = depth;
    }
    if (open.length === depth) {
      const parent = open[depth - 1];
      // The editor draws a numbered list in a numbered list a level on from it, any other from
      // its own start level.
      const startLevel =
        list.ordered && list.scheme !== undefined && !parent?.ordered
          ? (list.startLevel ?? list.level)
          : 0;
      const created = build.list(list, startLevel);
      if (parent) build.nest(parent.list, created);
      else out.push(created);
      open.push({
        list: created,
        ordered: list.ordered,
        listId: list.listId,
        level: list.level,
        startLevel,
      });
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
 * run's numbers are written in, with its number and the level of the scheme it is drawn at. Null
 * when no scheme writes them all ("1)", "Article 1"): the run stays paragraphs, its markers typed.
 */
export function drawnMarkers(
  run: readonly { marker: string; level: number }[],
):
  | (
      | { ordered: false }
      | { ordered: true; scheme: NumberingScheme; number: number; startLevel: number }
    )[]
  | null {
  const numbers = run.filter(({ marker }) => !BULLET.test(marker));
  if (numbers.length === 0) return run.map(() => ({ ordered: false }));
  // Read at Word's own levels first; else from the first level, as a numbered list under a bullet
  // starts its numbering again ("1." a level in).
  for (const shift of [0, Math.min(...numbers.map(({ level }) => level))]) {
    const scheme = schemeOfMarkers(
      numbers.map(({ marker, level }) => ({ marker, level: level - shift })),
    );
    if (!scheme) continue;
    return run.map(({ marker, level }) =>
      BULLET.test(marker)
        ? { ordered: false }
        : {
            ordered: true,
            scheme,
            number: markerNumber(scheme, level - shift, marker) ?? 1,
            startLevel: level - shift,
          },
    );
  }
  return null;
}
