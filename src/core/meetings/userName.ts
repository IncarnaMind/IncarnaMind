/**
 * The User's own items in a Meeting's notes, by the name they set in Settings › General (#2306).
 * The chat consent doesn't list that name, so it never reaches the model: the model writes
 * `USER_TOKEN` for the User, and the name goes in its place on this computer as the notes are
 * written.
 */
import type { NodeJSON } from "../../shared/blockJson";
import { gap } from "../../shared/i18n";

/** What the model writes for the User: no Citation marker, cue mark or Markdown looks like it. */
export const USER_TOKEN = "{{me}}";

// What a model writes for it besides: {{Me}}, {me}, {{ me }}, full-width braces, 我 for me.
const WRITTEN_TOKEN = /[{｛]+\s*(?:me|我)\s*[}｝]+/giu;

const HAN_END = /\p{Script=Han}$/u;
const HAN_START = /^\p{Script=Han}/u;

/** A space where a Latin name meets Chinese, as Chinese text writes one (docs/agents/zh-CN.md). */
const between = (left: string, right: string) =>
  HAN_END.test(left) || HAN_START.test(right) ? gap("zh-CN", left, right) : "";

function named(node: NodeJSON, name: string): NodeJSON {
  if (typeof node.text === "string") {
    const text = node.text.replace(
      WRITTEN_TOKEN,
      (token: string, at: number, whole: string) =>
        `${between(whole.slice(0, at), name)}${name}${between(name, whole.slice(at + token.length))}`,
    );
    return text === node.text ? node : { ...node, text };
  }
  return node.content
    ? { ...node, content: node.content.map((child) => named(child, name)) }
    : node;
}

/** `nodes` with the User's `name` in place of every token the model wrote; as they are with none. */
export function withUserName(nodes: readonly NodeJSON[], name: string | null): NodeJSON[] {
  return name === null ? [...nodes] : nodes.map((node) => named(node, name));
}
