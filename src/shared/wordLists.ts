export interface WordListPlace {
  /** The list it belongs to: items of another list never join it at its top level. */
  listId: string;
  /** From 0. */
  level: number;
  ordered: boolean;
  /** Its number, where Word's numbering has got to. */
  number: number;
}

export interface ListBuilder<Node> {
  list(place: WordListPlace): Node;
  item(list: Node, block: Node): void;
  /** Puts `list` inside the last item of `parent`. */
  nest(parent: Node, list: Node): void;
}

/**
 * Consecutive items of one list, nested by level (a level deeper than the one before goes one
 * deeper only), each list numbered from where Word's numbering has got to.
 */
export function groupWordLists<Node>(
  blocks: readonly { node: Node; list: WordListPlace | null }[],
  build: ListBuilder<Node>,
): Node[] {
  const out: Node[] = [];
  const open: { list: Node; ordered: boolean; listId: string }[] = [];
  for (const { node, list } of blocks) {
    if (!list) {
      open.length = 0;
      out.push(node);
      continue;
    }
    const depth = Math.min(list.level, open.length);
    open.length = Math.min(open.length, depth + 1);
    const top = open[depth];
    if (top && (top.ordered !== list.ordered || (depth === 0 && top.listId !== list.listId))) {
      open.length = depth;
    }
    if (open.length === depth) {
      const created = build.list(list);
      const parent = open[depth - 1];
      if (parent) build.nest(parent.list, created);
      else out.push(created);
      open.push({ list: created, ordered: list.ordered, listId: list.listId });
    }
    const current = open[depth];
    if (current) build.item(current.list, node);
  }
  return out;
}

// The editor draws bullets and plain "N." numbers; Word's Symbol and Wingdings bullets copy as private-use characters.
const BULLET = /^(?:[·o§•▪■◦●○□➢➤✓*\-–—]|[\uF000-\uF8FF])$/u;
const DECIMAL = /^(\d+)\.$/;

/**
 * A list marker as Word types it ("3.", "·"), when the editor can draw it: ordered with its
 * number, or a bullet. Null for a numbering style it can't draw ("1、", "（1）", "a)", "1.1.").
 */
export function drawnMarker(marker: string): { ordered: boolean; number: number } | null {
  if (BULLET.test(marker)) return { ordered: false, number: 1 };
  const decimal = DECIMAL.exec(marker);
  return decimal ? { ordered: true, number: Number(decimal[1]) } : null;
}
