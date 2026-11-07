/**
 * A Word file's styles part as one table: each style as written, and the
 * chain of styles it is based on. The index, the import, Page view and the
 * Word look each read their own facts from it (#2620). Pure.
 */
import { child, elements, type XmlElement } from "./xml";

/** How deep a style's `basedOn` chain is followed. */
const MAX_STYLE_DEPTH = 20;

export interface WordStyle {
  id: string;
  /** `w:type` as written ("paragraph", "character", "table", "numbering"); null when the file doesn't say. */
  type: string | null;
  basedOn: string | null;
  element: XmlElement;
}

export interface WordStyleTable {
  /** Every style with an id, in the file's order. */
  styles: readonly WordStyle[];
  /** `w:docDefaults`, below every style. */
  docDefaults: XmlElement | undefined;
  /** The style a paragraph (or table, or run) that names none has: the last marked default. */
  defaultOf(type: string): string | null;
  /** The style itself first, then each it is based on, as far as `MAX_STYLE_DEPTH` and never twice. */
  chain(type: string | null, id: string | null): WordStyle[];
}

const keyOf = (type: string | null, id: string) => `${type ?? ""}:${id}`;

export function readStyleTable(root: XmlElement | undefined): WordStyleTable {
  const styles: WordStyle[] = [];
  const byKey = new Map<string, WordStyle>();
  const defaults = new Map<string, string>();
  for (const element of root ? elements(root) : []) {
    if (element.name !== "w:style") continue;
    const id = element.attrs["w:styleId"];
    if (!id) continue;
    const type = element.attrs["w:type"] ?? null;
    const style = {
      id,
      type,
      basedOn: child(element, "w:basedOn")?.attrs["w:val"] ?? null,
      element,
    };
    styles.push(style);
    byKey.set(keyOf(type, id), style);
    const isDefault = element.attrs["w:default"] === "1" || element.attrs["w:default"] === "true";
    if (isDefault && type) defaults.set(type, id);
  }
  return {
    styles,
    docDefaults: root && child(root, "w:docDefaults"),
    defaultOf: (type) => defaults.get(type) ?? null,
    chain(type, id) {
      const chain: WordStyle[] = [];
      const seen = new Set<string>();
      for (let at = id; at && !seen.has(at) && chain.length < MAX_STYLE_DEPTH; ) {
        seen.add(at);
        const style = byKey.get(keyOf(type, at));
        if (!style) break;
        chain.push(style);
        at = style.basedOn;
      }
      return chain;
    },
  };
}
