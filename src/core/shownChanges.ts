/**
 * Someone's changes from a Word file, read as changes (#734, see
 * `theirChangesReading`): what a model and the reader of an export are
 * shown. Inline content in stretches by the change each is part of, a
 * Block's change on its words, and Blocks with every change accepted.
 */
import { type Block, type Inline, isWordChange, type Pending } from "./mindText";

/** A change as shown: what it does to the words it is on, and who made it when. */
export interface ShownChange {
  kind: "insert" | "delete";
  pending: Pending;
}

/** A stretch of inline content one change is on, or none is. */
export interface ChangeSpan {
  change: ShownChange | null;
  content: Inline[];
}

const changeOf = (inline: Inline): ShownChange | null =>
  inline.deleted
    ? { kind: "delete", pending: inline.deleted }
    : inline.inserted
      ? { kind: "insert", pending: inline.inserted }
      : null;

const sameChange = (a: ShownChange | null, b: ShownChange | null) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.pending.id === b.pending.id);

/** Inline content in stretches, each with the change it is part of, in order. */
export function changeSpans(content: readonly Inline[]): ChangeSpan[] {
  const spans: ChangeSpan[] = [];
  for (const inline of content) {
    const change = changeOf(inline);
    const last = spans.at(-1);
    if (last && sameChange(last.change, change)) last.content.push(inline);
    else spans.push({ change, content: [inline] });
  }
  return spans;
}

/** A Block's words, each with the change the Block is part of as a whole: a paragraph someone added. */
export function changedContent(block: Block & { content: Inline[] }): Inline[] {
  const { inserted, deleted } = block;
  if (!inserted && !deleted) return block.content;
  return block.content.map((inline) => ({
    ...inline,
    ...(inserted && { inserted }),
    ...(deleted && { deleted }),
  }));
}

/** What a change's note says it did: added words, removed them, or replaced some with others. */
export type NotedChange = Omit<ShownChange, "kind"> & { kind: ShownChange["kind"] | "replace" };

/**
 * The change whose note goes after the span at `at`, if it ends one there: the
 * last part of a change, a replacement's words removed and then added.
 */
export function changeEnding(spans: readonly ChangeSpan[], at: number): NotedChange | null {
  const change = spans[at]?.change;
  if (!change || spans[at + 1]?.change?.pending.id === change.pending.id) return null;
  const before = spans[at - 1]?.change;
  const replaced = before?.pending.id === change.pending.id && before.kind !== change.kind;
  return replaced ? { ...change, kind: "replace" } : change;
}

/**
 * Someone else's change from their Word file, which "accepted" applies; the AI's own stays
 * waiting (#2292).
 */
const someoneElses = (pending: Pending | undefined): boolean => isWordChange(pending);

function withoutInserted(value: Inline): Inline;
function withoutInserted(value: Block): Block;
function withoutInserted(value: Inline | Block): Inline | Block {
  const { inserted: _inserted, ...rest } = value;
  return rest;
}

function acceptedInline(content: readonly Inline[]): Inline[] {
  return content.flatMap((inline): Inline[] => {
    if (someoneElses(inline.deleted)) return [];
    const kept = someoneElses(inline.inserted) ? withoutInserted(inline) : inline;
    return kept.kind === "footnote" ? [{ ...kept, content: acceptedInline(kept.content) }] : [kept];
  });
}

/**
 * Blocks with someone else's changes accepted: what they added kept as plain text, what they
 * removed gone. The AI's own changes stay marked (#2292).
 */
export function withTheirChangesAccepted(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((block): Block[] => {
    if (someoneElses(block.deleted)) return [];
    const kept = someoneElses(block.inserted) ? withoutInserted(block) : block;
    switch (kept.kind) {
      case "paragraph":
      case "heading":
      case "question":
        return [{ ...kept, content: acceptedInline(kept.content) }];
      case "list":
        return [{ ...kept, items: kept.items.map(withTheirChangesAccepted) }];
      case "quote":
        return [{ ...kept, content: withTheirChangesAccepted(kept.content) }];
      case "table":
        return [
          {
            ...kept,
            rows: kept.rows.map((row) =>
              row.map((cell) => ({ ...cell, content: withTheirChangesAccepted(cell.content) })),
            ),
          },
        ];
      case "chart":
        return [{ ...kept, sources: acceptedInline(kept.sources) }];
      default:
        return [kept];
    }
  });
}
