import { NAME_IN_LINE_COLUMNS, shortenMiddle } from "../../shared/naming";
import type { Translate } from "./objects";

/** The placeholders of the dictionary that hold something the User named. */
const NAME_PARAMS: ReadonlySet<string> = new Set([
  "name",
  "title",
  "label",
  "document",
  "mind",
  "folder",
  "tag",
  "into",
  "item",
]);

const cutting =
  (t: Translate): Translate =>
  (key, params) =>
    t(
      key,
      params &&
        Object.fromEntries(
          Object.entries(params).map(([each, value]) => [
            each,
            typeof value === "string" && NAME_PARAMS.has(each)
              ? shortenMiddle(value, NAME_IN_LINE_COLUMNS)
              : value,
          ]),
        ),
    );

/** What a line says from the interface's words, kept in place of its text so a language switch reaches it. */
export type Words = (t: Translate) => string;

/** `Words` for a line a name in it is cut in (`saidInLine`). */
export type WordsInLine = (t: Translate, cut: (name: string) => string) => string;

export interface Said {
  message: string;
  /** `message` with every name whole, for the tooltip and the accessible name; absent when none was cut. */
  fullMessage?: string;
}

/**
 * What `build` says with every name in it cut in the middle, for a line (DESIGN.md, Words on
 * screen). A name given to `t` as a placeholder is cut by it; one made part of a bigger value
 * first, such as a quoted list, goes through `cut`.
 */
export function saidInLine(t: Translate, build: WordsInLine): Said {
  const message = build(cutting(t), (name) => shortenMiddle(name, NAME_IN_LINE_COLUMNS));
  const fullMessage = build(t, (name) => name);
  return message === fullMessage ? { message } : { message, fullMessage };
}
