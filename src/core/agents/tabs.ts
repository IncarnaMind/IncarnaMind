/**
 * Tabs in the Markdown an outside agent reads and writes (#3414). A tab starts at a ```tab block
 * holding its title, as `read_mind` shows one and as the agent writes one, never at a heading,
 * which `# Title` is. The Blocks after it, up to the next, are the tab.
 */
import type { NodeJSON } from "../answers/blocks";
import { NOTE_TAB_NODE, NOTE_TAB_TITLE_ATTRIBUTE } from "../api";
import { codeFence } from "../exports/markdown";
import type { Block } from "../mindText";

export const TAB_FENCE = "tab";

/** Where a tab starts, as the agent reads and writes it. */
export const tabFence = (title: string): string => codeFence(TAB_FENCE, title);

const TAB_FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*tab(?:[ \t]|$)/m;

/** Whether Markdown starts a tab anywhere. */
export const holdsTab = (text: string): boolean => TAB_FENCE_LINE.test(text);

const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/;

/** Whether a line closes a fenced block opened with `fence`. */
const closes = (line: string, fence: string) => {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed === (fence[0] ?? "`").repeat(trimmed.length);
};

/**
 * Markdown with each tab as `read_mind` shows it: a ```tab block of its title alone, the tab's
 * Markdown after it. Models also write a tab as one block that holds its Markdown, its title on
 * the fence's line or the first inside (#3414); a block inside one of those, opened with its
 * language, is part of the tab's Markdown.
 */
export function openTabs(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let other: string | null = null;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (other !== null) {
      out.push(line);
      if (closes(line, other)) other = null;
      continue;
    }
    const [, fence = "", info = ""] = FENCE_LINE.exec(line) ?? [];
    const words = info.trim();
    if (!fence || words.split(/[ \t]/)[0] !== TAB_FENCE) {
      if (fence) other = fence;
      out.push(line);
      continue;
    }
    let title = words.slice(TAB_FENCE.length).trim();
    // A title inside comes first, before any block the tab holds: "```js" there is a title.
    if (title === "") {
      let next = at + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") next++;
      const first = lines[next] ?? "";
      if (next < lines.length && !closes(first, fence)) {
        title = first.trim();
        at = next;
      }
    }
    const held: string[] = [];
    let inner: string | null = null;
    for (at++; at < lines.length; at++) {
      const each = lines[at] ?? "";
      if (inner === null && closes(each, fence)) break;
      if (inner !== null) {
        if (closes(each, inner)) inner = null;
      } else {
        const opened = FENCE_LINE.exec(each);
        if (opened?.[2]?.trim()) inner = opened[1] ?? null;
      }
      held.push(each);
    }
    out.push(tabFence(title), "", ...held, "");
  }
  return out.join("\n");
}

const isTabFence = (node: NodeJSON) =>
  node.type === "codeBlock" && node.attrs?.language === TAB_FENCE;

/**
 * The Blocks with each top-level ```tab block of a title alone (`openTabs`) made the start of a
 * tab. One holding more stays a code block, its text kept.
 */
export function placeTabs(nodes: readonly NodeJSON[]): NodeJSON[] {
  return nodes.map((node) => {
    if (!isTabFence(node)) return node;
    const text = (node.content ?? []).map((child) => child.text ?? "").join("");
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    if (lines.length > 1) return node;
    return { type: NOTE_TAB_NODE, attrs: { [NOTE_TAB_TITLE_ATTRIBUTE]: (lines[0] ?? "").trim() } };
  });
}

/** Whether any of the Blocks starts a tab that holds none of them. */
export const emptyTab = (nodes: readonly NodeJSON[]): boolean =>
  nodes.some(
    (node, index) =>
      node.type === NOTE_TAB_NODE &&
      (nodes[index + 1] === undefined || nodes[index + 1]?.type === NOTE_TAB_NODE),
  );

/**
 * A Note's Blocks as `read_mind` shows them: each tab's start a ```tab block of the title the
 * User sees, which `untitled` gives a tab without one, by its number from 1.
 */
export function withTabFences(
  blocks: readonly Block[],
  untitled: (number: number) => string,
): Block[] {
  let number = blocks[0] && blocks[0].kind !== "tab" ? 1 : 0;
  return blocks.map((block) => {
    if (block.kind !== "tab") return block;
    number += 1;
    return { kind: "code", language: TAB_FENCE, code: block.title || untitled(number) };
  });
}
