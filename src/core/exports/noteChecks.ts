/**
 * What a note says of the people who checked it (#2292): a "Checked by" line belongs on a note
 * only when every Citation the note stands for carries it on screen, so an export never shows a
 * check the Note doesn't. A Citation a change still waiting adds or removes stands for itself,
 * as its own note (#107).
 */
import { type FootnoteSubject, footnoteSubjectKey } from "../../shared/citations";
import type { Block, Inline } from "../mindText";

type Citation = Extract<Inline, { kind: "citation" }>;

/** Whether a Citation is written as a note of its own because a change still waiting adds or removes it. */
export const inChange = (citation: Citation, inside: boolean): boolean =>
  inside || citation.inserted !== undefined || citation.deleted !== undefined;

/** A Citation's footnote subject, as the writers name it. */
export const subjectOf = (citation: Citation): FootnoteSubject => ({
  documentId: citation.work.documentId,
  contentHash: citation.work.contentHash ?? null,
  location: citation.work.location,
  unverified: citation.footnote.unverified,
  link: citation.footnote.link ?? null,
});

/**
 * The "Checked by" lines each note carries, by `footnoteSubjectKey`: those that every Citation
 * the note stands for carries, in the first one's order. A note whose Citations carried
 * different checks, or one of them none, carries no line at all: it fails closed.
 */
export function noteChecks(blocks: readonly Block[]): Map<string, readonly string[]> {
  const common = new Map<string, { lines: readonly string[]; kept: Set<string> }>();
  const content = (inline: readonly Inline[], inside: boolean) => {
    for (const item of inline) {
      if (item.kind !== "citation" || inChange(item, inside)) continue;
      const key = footnoteSubjectKey(subjectOf(item));
      const lines = item.footnote.checked ?? [];
      const known = common.get(key);
      if (!known) {
        common.set(key, { lines, kept: new Set(lines) });
        continue;
      }
      for (const line of known.kept) if (!lines.includes(line)) known.kept.delete(line);
    }
  };
  const visit = (block: Block, inside: boolean) => {
    const pending = inside || block.inserted !== undefined || block.deleted !== undefined;
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        content(block.content, pending);
        break;
      case "list":
        for (const item of block.items) for (const child of item) visit(child, pending);
        break;
      case "quote":
        for (const child of block.content) visit(child, pending);
        break;
      case "table":
        for (const row of block.rows)
          for (const cell of row) for (const child of cell.content) visit(child, pending);
        break;
      case "chart":
        content(block.sources, pending);
        break;
      default:
        break;
    }
  };
  for (const block of blocks) visit(block, false);
  return new Map(
    [...common].map(([key, { lines, kept }]) => [key, lines.filter((line) => kept.has(line))]),
  );
}
