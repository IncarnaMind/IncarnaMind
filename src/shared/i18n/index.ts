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

/** Names that can be Chinese or Latin, so a space beside one depends on the name (docs/agents/zh-CN.md). */
const NAMES = ["agent", "provider", "format", "names", "person", "label"] as const;

export const isMessageKey = (value: unknown): value is MessageKey =>
  typeof value === "string" && Object.hasOwn(en, value);

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[language][key];
  if (!params) return template;
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder,
    );
  const name =
    language === "zh-CN"
      ? NAMES.find((each) => Object.hasOwn(params, each) && template.includes(`{${each}}`))
      : undefined;
  if (!name) return fill(template);
  const value = String(params[name]);
  return template
    .split(`{${name}}`)
    .map(fill)
    .reduce(
      (text, part) => text + gap(language, text, value) + value + gap(language, value, part) + part,
    );
}
