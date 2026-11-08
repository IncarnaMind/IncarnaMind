/**
 * The User's own items in a Meeting's notes, by the name they set in Settings › General (#2306).
 * The chat consent doesn't list that name, so the fill never sends it: the model writes
 * `USER_TOKEN` for the User, and the name goes in its place on this computer as the notes are
 * written.
 */
import type { NodeJSON } from "../../shared/blockJson";
import { gap } from "../../shared/i18n";

/** What the model writes for the User: no Citation marker, cue mark or Markdown looks like it. */
export const USER_TOKEN = "{{me}}";

// What a model writes for it besides: {{Me}}, {me}, {{ me }}, full-width braces, 我 for me.
const WRITTEN_TOKEN = /[{｛]+\s*(?:me|我)\s*[}｝]+/giu;
// The User by another word, left after that: {{user}}, {{用户}}. Other braced text stays as written.
const LEFTOVER = /[{｛]+\s*(?:user|用户)\s*[}｝]+/giu;

const HAN_END = /\p{Script=Han}$/u;
const HAN_START = /^\p{Script=Han}/u;

/** A space where a Latin name meets Chinese, as Chinese text writes one (docs/agents/zh-CN.md). */
const between = (left: string, right: string) =>
  HAN_END.test(left) || HAN_START.test(right) ? gap("zh-CN", left, right) : "";

/** `name` in place of `match`, within `text`. */
const nameFor = (name: string, match: RegExpExecArray, text: string) =>
  `${between(text.slice(0, match.index), name)}${name}${between(name, text.slice(match.index + match[0].length))}`;

/**
 * `run`, adjacent text nodes, with each match of `pattern` in their joined text replaced in the
 * node where it starts: formatting can split a token over several ("{{**me**}}").
 */
function replaceAcross(
  run: readonly NodeJSON[],
  pattern: RegExp,
  replacement: (match: RegExpExecArray, text: string) => string,
): { run: NodeJSON[]; count: number } {
  const text = run.map((node) => node.text ?? "").join("");
  const matches = [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    replacement: replacement(match, text),
  }));
  if (matches.length === 0) return { run: [...run], count: 0 };
  const edited: NodeJSON[] = [];
  let from = 0;
  for (const node of run) {
    const to = from + (node.text ?? "").length;
    let kept = "";
    let at = from;
    for (const { start, end, replacement } of matches) {
      if (end <= from || start >= to) continue;
      if (start >= from) kept += text.slice(at, start) + replacement;
      at = Math.min(end, to);
    }
    kept += text.slice(at, to);
    if (kept !== "") edited.push({ ...node, text: kept });
    from = to;
  }
  return { run: edited, count: matches.length };
}

const isCode = (node: NodeJSON) =>
  node.type === "codeBlock" || (node.marks ?? []).some((mark) => mark.type === "code");

/** `node` with each run of adjacent text nodes in it through `edit`; code is left as written. */
function eachRun(node: NodeJSON, edit: (run: NodeJSON[]) => NodeJSON[]): NodeJSON {
  if (!node.content || isCode(node)) return node;
  const content: NodeJSON[] = [];
  let run: NodeJSON[] = [];
  const flush = () => {
    if (run.length > 0) content.push(...edit(run));
    run = [];
  };
  for (const child of node.content) {
    if (typeof child.text === "string" && !isCode(child)) run.push(child);
    else {
      flush();
      content.push(eachRun(child, edit));
    }
  }
  flush();
  return { ...node, content };
}

/**
 * `nodes` with the User's `name` in place of every token the model wrote, as they are with none.
 * A last pass names the User where the model wrote them by another word: `leftovers` counts it.
 */
export function withUserName(
  nodes: readonly NodeJSON[],
  name: string | null,
): { nodes: NodeJSON[]; leftovers: number } {
  if (name === null) return { nodes: [...nodes], leftovers: 0 };
  let leftovers = 0;
  const named = nodes.map((node) =>
    eachRun(node, (run) => {
      const tokens = replaceAcross(run, WRITTEN_TOKEN, (match, text) => nameFor(name, match, text));
      const rest = replaceAcross(tokens.run, LEFTOVER, (match, text) => nameFor(name, match, text));
      leftovers += rest.count;
      return rest.run;
    }),
  );
  return { nodes: named, leftovers };
}

/** `text` with the User's `name` in place of every token the model wrote. */
export const textWithUserName = (text: string, name: string): string =>
  (
    withUserName([{ type: "paragraph", content: [{ type: "text", text }] }], name).nodes[0]
      ?.content ?? []
  )
    .map((node) => node.text ?? "")
    .join("");
