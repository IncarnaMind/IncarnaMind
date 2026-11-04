import { GENERATED_MARK } from "../core/api";
import type { NodeJSON } from "./blockJson";

/** Inline code, which holds no other mark but a Proposal's, so code inside a line is never marked as AI text. */
export const INLINE_CODE_MARK = "code";

/** The Blocks with every word in them, at any depth, marked as AI text (`GENERATED_MARK`). */
export function asGenerated(blocks: readonly NodeJSON[]): NodeJSON[] {
  return blocks.map((node) => {
    if (node.type === "text") {
      const marks = node.marks ?? [];
      const unmarkable = marks.some(
        (mark) => mark.type === GENERATED_MARK || mark.type === INLINE_CODE_MARK,
      );
      return unmarkable ? node : { ...node, marks: [{ type: GENERATED_MARK }, ...marks] };
    }
    return node.content ? { ...node, content: asGenerated(node.content) } : node;
  });
}
