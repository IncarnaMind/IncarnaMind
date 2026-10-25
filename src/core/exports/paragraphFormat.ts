/**
 * A paragraph's format (`ParagraphFormat`) as Word's own paragraph properties: `w:spacing`,
 * `w:ind` and `w:jc`, as direct formatting, which the Word import reads back into the same
 * format. Both Word writers use it: a new document's, and the one that writes into an imported
 * file, which replaces only what the format changed.
 */
import type { ParagraphFormat } from "../api";
import { parseXml } from "../documents/formats/xml";
import { escapeXml } from "./wordml";

/** Attribute values to set, and null for those to remove. */
export type AttributeChanges = Record<string, string | null>;

export interface FormatChanges {
  spacing: AttributeChanges;
  ind: AttributeChanges;
  /** `w:jc`'s value; null to remove it; undefined to leave it. */
  jc?: string | null;
}

const JUSTIFICATION: Record<NonNullable<ParagraphFormat["align"]>, string> = {
  left: "left",
  center: "center",
  right: "right",
  justify: "both",
  distribute: "distribute",
};

const twips = (points: number) => String(Math.round(points * 20));
const hundredths = (characters: number) => String(Math.round(characters * 100));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function firstLineAttributes(format: ParagraphFormat): AttributeChanges {
  const { firstLine, firstLineChars: chars } = format;
  return {
    "w:firstLine":
      chars === undefined && firstLine !== undefined && firstLine >= 0 ? twips(firstLine) : null,
    "w:hanging":
      chars === undefined && firstLine !== undefined && firstLine < 0 ? twips(-firstLine) : null,
    "w:firstLineChars": chars !== undefined && chars >= 0 ? hundredths(chars) : null,
    "w:hangingChars": chars !== undefined && chars < 0 ? hundredths(-chars) : null,
  };
}

/**
 * What to write for the properties `now` sets differently from `before`: each with every
 * attribute that says it, so a length replaces the file's characters and the other way round;
 * one `now` leaves unset is removed, so the paragraph's style says it again.
 */
export function formatChanges(now: ParagraphFormat, before: ParagraphFormat): FormatChanges {
  const changes: FormatChanges = { spacing: {}, ind: {} };
  const changed = (...names: (keyof ParagraphFormat)[]) =>
    names.some((name) => !same(now[name], before[name]));
  if (changed("before")) {
    Object.assign(changes.spacing, {
      "w:before": now.before === undefined ? null : twips(now.before),
      "w:beforeLines": null,
      "w:beforeAutospacing": null,
    });
  }
  if (changed("after")) {
    Object.assign(changes.spacing, {
      "w:after": now.after === undefined ? null : twips(now.after),
      "w:afterLines": null,
      "w:afterAutospacing": null,
    });
  }
  if (changed("line")) {
    const { line } = now;
    Object.assign(changes.spacing, {
      "w:line": line
        ? line.rule === "auto"
          ? String(Math.round(line.value * 240))
          : twips(line.value)
        : null,
      "w:lineRule": line ? line.rule : null,
    });
  }
  if (changed("left")) {
    Object.assign(changes.ind, {
      "w:left": now.left === undefined ? null : twips(now.left),
      "w:start": null,
      "w:leftChars": null,
      "w:startChars": null,
    });
  }
  if (changed("right")) {
    Object.assign(changes.ind, {
      "w:right": now.right === undefined ? null : twips(now.right),
      "w:end": null,
      "w:rightChars": null,
      "w:endChars": null,
    });
  }
  if (changed("firstLine", "firstLineChars")) Object.assign(changes.ind, firstLineAttributes(now));
  if (changed("align")) changes.jc = now.align ? JUSTIFICATION[now.align] : null;
  return changes;
}

/** An empty element (`<w:spacing …/>`) with `changes` made to its attributes; null when it has none left. */
export function changedElement(
  name: string,
  xml: string | null,
  changes: AttributeChanges,
): string | null {
  const attributes: Record<string, string> = xml ? { ...parseXml(xml).attrs } : {};
  for (const [attribute, value] of Object.entries(changes)) {
    if (value === null) delete attributes[attribute];
    else attributes[attribute] = value;
  }
  const written = Object.entries(attributes)
    .map(([attribute, value]) => ` ${attribute}="${escapeXml(value)}"`)
    .join("");
  return written ? `<${name}${written}/>` : null;
}
