import type { ClaimCheckAttributes } from "../core/api";
import { CITATION_NODE, CLAIM_CHECK_MARK } from "../core/api";
import type { NodeJSON } from "./blockJson";
import { INLINE_NODE, isClaim, sentenceSpans } from "./sentences";

const UNCHECKED: ReadonlySet<string> = new Set(["question", "codeBlock", "blockMath", "heading"]);

export interface Sentence {
  /** An index into each level's content, from the top-level Block down to its paragraph. */
  path: number[];
  from: number;
  to: number;
  /** As checks read it: an inline node as U+FFFC, a line break as "\n". */
  text: string;
  context: string;
  cited: { documentName: string; quote: string; documentId?: string; contentHash?: string }[];
}

export function paragraphText(content: readonly NodeJSON[]): string {
  return content
    .map((node) =>
      node.type === "text" ? (node.text ?? "") : node.type === "hardBreak" ? "\n" : INLINE_NODE,
    )
    .join("");
}

export function inlineLayout(content: readonly NodeJSON[]): { node: NodeJSON; start: number }[] {
  let at = 0;
  return content.map((node) => {
    const start = at;
    at += node.type === "text" ? (node.text ?? "").length : 1;
    return { node, start };
  });
}

export function quoteOf(node: NodeJSON): Sentence["cited"][number] | null {
  const attrs = node.attrs ?? {};
  const { quote, documentName, documentId, contentHash } = attrs;
  if (typeof quote !== "string" || quote === "") return null;
  return {
    documentName: typeof documentName === "string" ? documentName : "",
    quote,
    ...(typeof documentId === "string" && { documentId }),
    ...(typeof contentHash === "string" && { contentHash }),
  };
}

/** The sentences a check reads that the write holds: every sentence with a Citation, and every claim with none. */
export function checkableSentences(blocks: readonly NodeJSON[]): Sentence[] {
  const found: Sentence[] = [];
  const visit = (nodes: readonly NodeJSON[], path: number[]) => {
    nodes.forEach((node, index) => {
      if (UNCHECKED.has(node.type)) return;
      const here = [...path, index];
      const content = node.content ?? [];
      if (node.type !== "paragraph") {
        visit(content, here);
        return;
      }
      const context = paragraphText(content);
      const layout = inlineLayout(content);
      for (const span of sentenceSpans(context)) {
        const text = context.slice(span.from, span.to);
        const cited = layout.flatMap(({ node: inline, start }) => {
          if (inline.type !== CITATION_NODE || start < span.from || start >= span.to) return [];
          return quoteOf(inline) ?? [];
        });
        if (cited.length === 0 && !isClaim(text)) continue;
        found.push({ path: here, from: span.from, to: span.to, text, context, cited });
      }
    });
  };
  visit(blocks, []);
  return found;
}

const withMark = (nodes: readonly NodeJSON[], mark: ClaimCheckAttributes): NodeJSON[] =>
  nodes.map((node) =>
    node.type === "text"
      ? {
          ...node,
          marks: [
            ...(node.marks ?? []).filter((each) => each.type !== CLAIM_CHECK_MARK),
            { type: CLAIM_CHECK_MARK, attrs: { ...mark } },
          ],
        }
      : node,
  );

/** A paragraph's content with the sentence `from`..`to` in it put as `nodes`. */
export function replaced(
  content: readonly NodeJSON[],
  from: number,
  to: number,
  nodes: readonly NodeJSON[],
): NodeJSON[] {
  const out: NodeJSON[] = [];
  let placed = false;
  const place = () => {
    if (placed) return;
    placed = true;
    out.push(...nodes);
  };
  for (const { node, start } of inlineLayout(content)) {
    if (node.type !== "text") {
      if (start >= from && start < to) place();
      else out.push(node);
      continue;
    }
    const text = node.text ?? "";
    const before = text.slice(0, Math.max(0, from - start));
    const after = text.slice(Math.max(0, to - start));
    if (before) out.push({ ...node, text: before });
    if (start + text.length > from && start < to) place();
    if (after && start + text.length > to) out.push({ ...node, text: after });
  }
  place();
  return out;
}

/** A paragraph's content with a check added only to the sentence's own text nodes. */
export function withSentenceMark(
  content: readonly NodeJSON[],
  from: number,
  to: number,
  mark: ClaimCheckAttributes,
): NodeJSON[] {
  const nodes = inlineLayout(content).flatMap(({ node, start }) => {
    if (node.type !== "text") return start >= from && start < to ? [node] : [];
    const text = node.text ?? "";
    if (start + text.length <= from || start >= to) return [];
    return [
      {
        ...node,
        text: text.slice(Math.max(0, from - start), Math.max(0, to - start)),
      },
    ];
  });
  return replaced(content, from, to, withMark(nodes, mark));
}

export { withMark };

export function withoutClaimCheckMarks(blocks: readonly NodeJSON[]): NodeJSON[] {
  return blocks.map((node) => ({
    ...node,
    ...(node.content && { content: withoutClaimCheckMarks(node.content) }),
    ...(node.marks && {
      marks: node.marks.filter((mark) => mark.type !== CLAIM_CHECK_MARK),
    }),
  }));
}

export function paragraphAt(
  blocks: readonly NodeJSON[],
  path: readonly number[],
): NodeJSON | undefined {
  const [top, ...inner] = path;
  let node = top === undefined ? undefined : blocks[top];
  for (const index of inner) node = node?.content?.[index];
  return node;
}
