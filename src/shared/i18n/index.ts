/**
 * The in-house typed dictionary. Every UI string goes through `translate`, in
 * the renderer and in the main process (e.g. error dialogs).
 */
import type { Language } from "../../core/language";
import { en } from "./en";
import { gap } from "./join";
import type { Dictionary, MessageKey, MessageParams } from "./types";
import { zhCN } from "./zh-CN";

export type { MessageKey, MessageParams } from "./types";
export { gap };

const dictionaries: { readonly [L in Language]: Dictionary } = {
  en,
  "zh-CN": zhCN,
};

/**
 * Values that can be Chinese or Latin, so a space beside one depends on the value
 * (docs/agents/zh-CN.md): "文档写的是 2万美元，不是人民币两万元。", "已花 $0.38 后停止",
 * "已花不到 $0.01 后停止".
 */
const NAMES: ReadonlySet<string> = new Set([
  "agent",
  "provider",
  "format",
  "names",
  "person",
  "label",
  "amount",
  "spent",
  "cost",
  "figure",
  "measure",
  "claimed",
  "host",
  "connector",
  "page",
  "region",
]);

// A space only where the template's own Chinese meets a value: "约 ¥{amount}" stays "约 ¥0.12".
const HAN_END = /\p{Script=Han}$/u;
const HAN_START = /^\p{Script=Han}/u;

export const isMessageKey = (value: unknown): value is MessageKey =>
  typeof value === "string" && Object.hasOwn(en, value);

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[language][key];
  if (!params) return template;
  let text = "";
  let literal = "";
  let spaced = false;
  for (const [at, part] of template.split(/(\{\w+\})/).entries()) {
    const name = at % 2 === 1 ? part.slice(1, -1) : null;
    const filled = name !== null && Object.hasOwn(params, name);
    const piece = filled ? String(params[name]) : part;
    const named = filled && language === "zh-CN" && NAMES.has(name);
    const beside = named ? HAN_END.test(literal) : spaced && HAN_START.test(piece);
    text += (beside ? gap(language, text, piece) : "") + piece;
    literal = named ? "" : piece;
    spaced = named;
  }
  return text;
}

/** Names in a run, as a sentence lists them: "A and B", "A, B and C"; "A 和 B", "A、B 和 C". */
export function andList(language: Language, names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return translate(language, "list.and", {
    first: names.slice(0, -1).join(translate(language, "list.separator")),
    last: names.at(-1) ?? "",
  });
}
