import type * as Y from "yjs";
import type {
  ComparedBlock,
  ComparedChange,
  ComparedPart,
  ComparisonRow,
  MindComparison,
} from "../api";
import { type Block, type Inline, type ReadOptions, readBlocks } from "../mindText";
import { diffSteps, hunksOf, splitWords } from "../proposals/diff";

/**
 * Two versions of a Mind side by side, for History: the Blocks of each read
 * as the exports read them (accepted text only), lined up where they are the
 * same, and the Blocks between compared word by word, the first changed Block
 * of one side beside the first of the other, and so on.
 */

const READ: ReadOptions = {
  includeQuestions: true,
  footnote: () => ({ source: "", unverified: false }),
  trimBeforeCitation: false,
};

/** One part of a Block, before it is compared, with what makes it the same as another. */
interface Token {
  key: string;
  part(change: ComparedChange): ComparedPart;
}

interface Read {
  block: Omit<ComparedBlock, "parts">;
  tokens: Token[];
  /** The Block, whole, to tell whether it is in the other version. */
  key: string;
}

const textTokens = (text: string): Token[] =>
  splitWords(text).map((word) => ({
    key: word,
    part: (change) => ({ kind: "text", text: word, change }),
  }));

const plainOf = (content: readonly Inline[]): string =>
  content
    .map((inline) =>
      inline.kind === "text"
        ? inline.text
        : inline.kind === "figure"
          ? inline.figure.shown
          : inline.kind === "math"
            ? inline.latex
            : inline.kind === "break"
              ? "\n"
              : inline.kind === "footnote"
                ? plainOf(inline.content)
                : "",
    )
    .join("");

function inlineTokens(content: readonly Inline[]): Token[] {
  return content.flatMap((inline): Token[] => {
    switch (inline.kind) {
      case "text":
        return textTokens(inline.text);
      case "figure":
        return textTokens(inline.figure.shown);
      case "math":
        return textTokens(inline.latex);
      case "break":
        return textTokens("\n");
      case "image":
        return textTokens(inline.image.alt);
      case "citation": {
        const { work } = inline;
        return [
          {
            key: `\uFFFC${JSON.stringify([work.documentId, work.documentName, work.location])}`,
            part: (change) => ({ kind: "citation", work, change }),
          },
        ];
      }
      case "footnote": {
        const text = plainOf(inline.content);
        return [{ key: `\uFFFD${text}`, part: (change) => ({ kind: "footnote", text, change }) }];
      }
      default:
        return [];
    }
  });
}

/** A table's rows as lines, its cells split by " · ". */
function rowsTokens(rows: readonly (readonly { content: readonly Block[] }[])[]): Token[] {
  return rows.flatMap((row, index) => [
    ...(index > 0 ? textTokens("\n") : []),
    ...row.flatMap((cell, column) => [
      ...(column > 0 ? textTokens(" · ") : []),
      ...cell.content.flatMap((block, at) => [
        ...(at > 0 ? textTokens(" ") : []),
        ...flatten([block], 0, false).flatMap((each) => each.tokens),
      ]),
    ]),
  ]);
}

/** An item renumbered because one was added above it is still the same item. */
const markerKind = (marker: string) => (marker === "" || marker === "•" ? marker : "1.");

const read = (block: Omit<ComparedBlock, "parts">, tokens: Token[]): Read => ({
  block,
  tokens,
  key: JSON.stringify([
    block.kind,
    block.level,
    markerKind(block.marker),
    ...tokens.map((each) => each.key),
  ]),
});

const plain = (kind: ComparedBlock["kind"], tokens: Token[], level = 0, marker = "") =>
  read({ kind, level, marker }, tokens);

/** A Citation's or a footnote's token. */
const isMarker = (key: string) => /^[\uFFFC\uFFFD]/.test(key);

const isBlank = (tokens: readonly Token[]) =>
  tokens.every((token) => token.key.trim() === "" && !isMarker(token.key));

function flatten(blocks: readonly Block[], depth: number, inQuote: boolean): Read[] {
  return blocks.flatMap((block): Read[] => {
    switch (block.kind) {
      case "paragraph": {
        const tokens = inlineTokens(block.content);
        if (isBlank(tokens)) return [];
        if (inQuote) return [plain("quote", tokens)];
        return [depth > 0 ? plain("item", tokens, depth) : plain("paragraph", tokens)];
      }
      case "heading":
        return [plain("heading", inlineTokens(block.content), block.level)];
      case "question":
        return [plain("question", inlineTokens(block.content))];
      case "code":
        return [plain("code", textTokens(block.code))];
      case "math":
        return [plain("math", textTokens(block.latex))];
      case "rule":
        return [plain("rule", [])];
      case "image":
        return [plain("image", textTokens(block.image.alt))];
      case "table":
        return [plain("table", rowsTokens(block.rows))];
      case "chart": {
        const title = block.chart.title;
        const lines = rowsTokens(block.table);
        return [
          plain("chart", [...textTokens(title), ...(title ? textTokens("\n") : []), ...lines]),
        ];
      }
      case "quote":
        return flatten(block.content, depth, true);
      case "list":
        return block.items.flatMap((item, index) => {
          const marker = block.ordered ? `${block.start + index}.` : "•";
          const [first, ...rest] = item;
          const lead =
            first?.kind === "paragraph"
              ? [plain("item", inlineTokens(first.content), depth + 1, marker)]
              : flatten(first ? [first] : [], depth + 1, inQuote);
          return [...lead, ...flatten(rest, depth + 1, inQuote)];
        });
      default:
        return [];
    }
  });
}

/** The parts of one side, the tokens kept or changed, joining neighbouring words alike. */
function partsOf(tokens: readonly Token[], changes: readonly ComparedChange[]): ComparedPart[] {
  const parts: ComparedPart[] = [];
  tokens.forEach((token, index) => {
    const part = token.part(changes[index] ?? "same");
    const last = parts.at(-1);
    if (part.kind === "text" && last?.kind === "text" && last.change === part.change) {
      last.text += part.text;
    } else parts.push(part);
  });
  return parts;
}

const whole = (side: Read, change: ComparedChange): ComparedBlock => ({
  ...side.block,
  parts: partsOf(
    side.tokens,
    side.tokens.map(() => change),
  ),
});

/**
 * Two Blocks in the same place, compared word by word. Changes with only
 * spaces and a few letters or signs kept between them read as one, as Edit
 * with AI's changes do (../proposals/write).
 */
function pair(left: Read, right: Read): ComparisonRow {
  const steps = diffSteps(
    left.tokens.map((each) => each.key),
    right.tokens.map((each) => each.key),
  );
  const joined = hunksOf(steps, (from, to) => {
    const kept = left.tokens.slice(from, to).map((each) => each.key);
    return !kept.some(isMarker) && kept.join("").replace(/\s+/g, "").length <= 3;
  });
  const leftChanges: ComparedChange[] = left.tokens.map(() => "same");
  const rightChanges: ComparedChange[] = right.tokens.map(() => "same");
  for (const change of joined) {
    leftChanges.fill("removed", change.oldFrom, change.oldTo);
    rightChanges.fill("added", change.newFrom, change.newTo);
  }
  return {
    left: { ...left.block, parts: partsOf(left.tokens, leftChanges) },
    right: { ...right.block, parts: partsOf(right.tokens, rightChanges) },
    changed: true,
  };
}

/** Compares the Blocks of two versions of a Mind, the earlier on the left. */
export function compareVersions(earlier: Y.XmlFragment, later: Y.XmlFragment): MindComparison {
  const left = flatten(readBlocks(earlier, READ), 0, false);
  const right = flatten(readBlocks(later, READ), 0, false);
  const steps = diffSteps(
    left.map((each) => each.key),
    right.map((each) => each.key),
  );
  const rows: ComparisonRow[] = [];
  let removed: Read[] = [];
  let added: Read[] = [];
  const settle = () => {
    const paired = Math.min(removed.length, added.length);
    for (let index = 0; index < paired; index++) {
      rows.push(pair(removed[index] as Read, added[index] as Read));
    }
    for (const each of removed.slice(paired)) {
      rows.push({ left: whole(each, "removed"), right: null, changed: true });
    }
    for (const each of added.slice(paired)) {
      rows.push({ left: null, right: whole(each, "added"), changed: true });
    }
    removed = [];
    added = [];
  };
  let x = 0;
  let y = 0;
  for (const step of steps) {
    if (step === "delete") removed.push(left[x++] as Read);
    else if (step === "insert") added.push(right[y++] as Read);
    else {
      settle();
      rows.push({
        left: whole(left[x++] as Read, "same"),
        right: whole(right[y++] as Read, "same"),
        changed: false,
      });
    }
  }
  settle();
  return { rows, changes: rows.filter((row) => row.changed).length };
}
