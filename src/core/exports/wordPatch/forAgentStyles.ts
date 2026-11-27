/**
 * Styles' and lists' names in the Word file written for an outside agent (#3751). A style someone
 * named is renamed "Style 1", "Style 2" and so on, its id Style1 and so on, wherever the file names
 * it, so its look stays and its name goes. Word's own styles and the export's keep their names. A
 * list no paragraph or style uses goes, so the words its numbers show are only those of lists the
 * file shows.
 */
import { elements, walk, type XmlElement } from "../../documents/formats/xml";
import { STYLE_DEFINITIONS } from "../docx";
import { endOf, type Splice, startOf } from "../packagePatch/text";
import { withAttribute } from "./forAgentParts";

/** Word's tables and lists that come in six accents besides their own. */
const ACCENTED = [
  "Colorful Grid",
  "Colorful List",
  "Colorful Shading",
  "Dark List",
  "Grid Table 1 Light",
  "Grid Table 2",
  "Grid Table 3",
  "Grid Table 4",
  "Grid Table 5 Dark",
  "Grid Table 6 Colorful",
  "Grid Table 7 Colorful",
  "Light Grid",
  "Light List",
  "Light Shading",
  "List Table 1 Light",
  "List Table 2",
  "List Table 3",
  "List Table 4",
  "List Table 5 Dark",
  "List Table 6 Colorful",
  "List Table 7 Colorful",
  "Medium Grid 1",
  "Medium Grid 2",
  "Medium Grid 3",
  "Medium List 1",
  "Medium List 2",
  "Medium Shading 1",
  "Medium Shading 2",
];
/** Word's styles numbered from 1, by the highest number. */
const NUMBERED: Record<string, number> = {
  "Body Text": 3,
  "Body Text First Indent": 2,
  "Body Text Indent": 3,
  List: 5,
  "List Bullet": 5,
  "List Continue": 5,
  "List Number": 5,
  "Outline List": 3,
  "Plain Table": 5,
  "Table 3D effects": 3,
  "Table Classic": 4,
  "Table Colorful": 3,
  "Table Columns": 5,
  "Table Grid": 8,
  "Table List": 8,
  "Table Simple": 3,
  "Table Subtle": 2,
  "Table Web": 3,
  heading: 9,
  index: 9,
  toc: 9,
};
const NAMED = [
  "Balloon Text",
  "Bibliography",
  "Block Text",
  "Book Title",
  "Closing",
  "Date",
  "Default Paragraph Font",
  "Document Map",
  "E-mail Signature",
  "Emphasis",
  "FollowedHyperlink",
  "Grid Table Light",
  "HTML Acronym",
  "HTML Address",
  "HTML Bottom of Form",
  "HTML Cite",
  "HTML Code",
  "HTML Definition",
  "HTML Keyboard",
  "HTML Preformatted",
  "HTML Sample",
  "HTML Top of Form",
  "HTML Typewriter",
  "HTML Variable",
  "Hashtag",
  "Hyperlink",
  "Intense Emphasis",
  "Intense Quote",
  "Intense Reference",
  "List Paragraph",
  "Mention",
  "Message Header",
  "No List",
  "No Spacing",
  "Normal",
  "Normal (Web)",
  "Normal Indent",
  "Normal Table",
  "Note Heading",
  "Placeholder Text",
  "Plain Text",
  "Quote",
  "Revision",
  "Salutation",
  "Signature",
  "Smart Hyperlink",
  "Smart Link",
  "Strong",
  "Subtitle",
  "Subtle Emphasis",
  "Subtle Reference",
  "TOC Heading",
  "Table Contemporary",
  "Table Elegant",
  "Table Professional",
  "Table Theme",
  "Title",
  "Unresolved Mention",
  "annotation reference",
  "annotation subject",
  "annotation text",
  "caption",
  "endnote reference",
  "endnote text",
  "envelope address",
  "envelope return",
  "footer",
  "footnote reference",
  "footnote text",
  "header",
  "index heading",
  "line number",
  "macro",
  "page number",
  "table of authorities",
  "table of figures",
  "toa heading",
];

/** Word's own styles' names and the export's, in lower case: the file's look, no one's words. */
const KNOWN = new Set(
  [
    ...NAMED,
    ...ACCENTED.flatMap((name) => [
      name,
      ...[1, 2, 3, 4, 5, 6].map((at) => `${name} Accent ${at}`),
    ]),
    ...Object.entries(NUMBERED).flatMap(([name, highest]) =>
      Array.from({ length: highest + 1 }, (_, at) => (at === 0 ? name : `${name} ${at}`)),
    ),
    ...Object.values(STYLE_DEFINITIONS).map((definition) => definition.name),
  ].map((name) => name.toLowerCase()),
);
const NEUTRAL_NAME = /^Style \d+$/;
const NEUTRAL_ID = /^Style\d+$/;
/** Word's ids for its own styles that aren't their names run together. */
const IDS_OF: Record<string, string> = {
  normaltable: "tablenormal",
  annotationtext: "commenttext",
  annotationreference: "commentreference",
  annotationsubject: "commentsubject",
};
const compact = (name: string) => name.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
/** The ids Word and the export give their own styles, run together in lower case. */
const KNOWN_IDS = new Set(
  [...KNOWN].flatMap((name) => {
    const id = IDS_OF[compact(name)] ?? compact(name);
    return [id, `${id}char`];
  }),
);

/** Whether a style's name is none, Word's, the export's or one written here; a linked style's " Char" too. */
export const isKnownStyleName = (name: string): boolean =>
  name === "" || NEUTRAL_NAME.test(name) || KNOWN.has(name.toLowerCase().replace(/ char$/, ""));

/** Whether a style's id is one of Word's, the export's or one written here, or holds no letter. */
export const isKnownStyleId = (id: string): boolean =>
  !/\p{L}/u.test(id) || NEUTRAL_ID.test(id) || KNOWN_IDS.has(compact(id).replace(/\d+$/, ""));

/** Elements whose `w:val` names a style by its id. */
export const STYLE_REFERENCES = new Set([
  "w:pStyle",
  "w:rStyle",
  "w:tblStyle",
  "w:numStyleLink",
  "w:styleLink",
  "w:basedOn",
  "w:next",
  "w:link",
  "w:defaultTableStyle",
  "w:clickAndTypeStyle",
]);

/** The new names and ids of the styles someone named, by their ids in the file. */
export interface StyleRenames {
  ids: Map<string, string>;
  names: Map<string, string>;
}

const stylesIn = (root: XmlElement) => [...walk(root)].filter((each) => each.name === "w:style");
const nameOf = (style: XmlElement) =>
  elements(style).find((each) => each.name === "w:name")?.attrs["w:val"] ?? "";

/** A neutral name and id for each style whose name or id isn't known, across these parts. */
export function styleRenames(roots: readonly XmlElement[]): StyleRenames {
  const styles = roots.flatMap(stylesIn);
  const taken = new Set(styles.flatMap((style) => [nameOf(style), style.attrs["w:styleId"] ?? ""]));
  const renames: StyleRenames = { ids: new Map(), names: new Map() };
  let number = 0;
  const neutral = () => {
    do number++;
    while (taken.has(`Style ${number}`) || taken.has(`Style${number}`));
    return number;
  };
  for (const style of styles) {
    const id = style.attrs["w:styleId"] ?? "";
    if (renames.ids.has(id) || renames.names.has(id)) continue;
    const name = nameOf(style);
    if (isKnownStyleName(name) && isKnownStyleId(id)) continue;
    const at = neutral();
    if (!isKnownStyleName(name)) renames.names.set(id, `Style ${at}`);
    if (!isKnownStyleId(id)) renames.ids.set(id, `Style${at}`);
  }
  return renames;
}

/**
 * A part's changes for `renames`: each style's id and name, and every reference to one. Word's
 * latent styles name only its own: another name there goes.
 */
export function styleSplices(root: XmlElement, text: string, renames: StyleRenames): Splice[] {
  const splices: Splice[] = [];
  const set = (element: XmlElement, name: string, value: string | undefined) => {
    if (value !== undefined) splices.push(withAttribute(element, text, name, value));
  };
  for (const element of walk(root)) {
    if (element.name === "w:style") {
      const id = element.attrs["w:styleId"] ?? "";
      set(element, "w:styleId", renames.ids.get(id));
      const name = elements(element).find((each) => each.name === "w:name");
      if (name) set(name, "w:val", renames.names.get(id));
    } else if (STYLE_REFERENCES.has(element.name)) {
      set(element, "w:val", renames.ids.get(element.attrs["w:val"] ?? ""));
    } else if (
      element.name === "w:lsdException" &&
      !KNOWN.has((element.attrs["w:name"] ?? "").toLowerCase())
    ) {
      splices.push({ from: startOf(element), to: endOf(element), text: "" });
    }
  }
  return splices;
}

/** Whether the part still holds a style's name or id that isn't known. */
export function holdsStrangeStyle(root: XmlElement): boolean {
  return [...walk(root)].some((element) => {
    if (element.name === "w:style") {
      return (
        !isKnownStyleId(element.attrs["w:styleId"] ?? "") || !isKnownStyleName(nameOf(element))
      );
    }
    if (STYLE_REFERENCES.has(element.name)) return !isKnownStyleId(element.attrs["w:val"] ?? "");
    return (
      element.name === "w:lsdException" && !KNOWN.has((element.attrs["w:name"] ?? "").toLowerCase())
    );
  });
}

/** The lists any of these parts number a paragraph or a style with, by their ids. */
export function listsUsed(roots: readonly XmlElement[]): Set<string> {
  const used = new Set<string>();
  for (const root of roots) {
    for (const element of walk(root)) {
      if (element.name !== "w:numPr") continue;
      const id = elements(element).find((each) => each.name === "w:numId")?.attrs["w:val"];
      if (id !== undefined) used.add(id);
    }
  }
  return used;
}

/** The numbering part's lists that `used` doesn't hold, and the definitions only they used. */
export function unusedLists(root: XmlElement, used: ReadonlySet<string>): Splice[] {
  const lists = elements(root).filter((each) => each.name === "w:num");
  const kept = lists.filter((each) => used.has(each.attrs["w:numId"] ?? ""));
  const definitions = new Set(
    kept.flatMap(
      (each) =>
        elements(each).find((child) => child.name === "w:abstractNumId")?.attrs["w:val"] ?? [],
    ),
  );
  return elements(root)
    .filter(
      (each) =>
        (each.name === "w:num" && !kept.includes(each)) ||
        (each.name === "w:abstractNum" && !definitions.has(each.attrs["w:abstractNumId"] ?? "")),
    )
    .map((each) => ({ from: startOf(each), to: endOf(each), text: "" }));
}
