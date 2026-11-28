import { GENERATED_MARK } from "../core/api";
import type { NodeJSON } from "./blockJson";

/** Inline code mark name (`code`); carries `GENERATED_MARK` when written by AI (#3839). */
export const INLINE_CODE_MARK = "code";

/** The Blocks with every word in them, at any depth, marked as AI text (`GENERATED_MARK`). */
export function asGenerated(blocks: readonly NodeJSON[]): NodeJSON[] {
  return blocks.map((node) => {
    if (node.type === "text") {
      const marks = node.marks ?? [];
      const alreadyMarked = marks.some((mark) => mark.type === GENERATED_MARK);
      return alreadyMarked ? node : { ...node, marks: [{ type: GENERATED_MARK }, ...marks] };
    }
    return node.content ? { ...node, content: asGenerated(node.content) } : node;
  });
}
