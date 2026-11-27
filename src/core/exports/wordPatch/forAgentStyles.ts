/**
 * Styles' and lists' names in the Word file written for an outside agent (#3751). A style someone
 * named is renamed "Style 1", "Style 2" and so on, its id Style1 and so on, wherever the file names
 * it, so its look stays and its name goes. Word's own styles and the export's keep their names. A
 * list no paragraph or style uses goes, so the words its numbers show are only those of lists the
 * file shows.
 */
import { elements, textOf, walk, type XmlElement } from "../../documents/formats/xml";
import { STYLE_DEFINITIONS } from "../docx";
import { endOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";
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
  // The character style Word links to "macro" is "Macro Text Char".
  "Macro Text",
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
/**
 * The names Word shows its own styles by in Chinese and Japanese. It writes them into the name of
 * a style it links to one of them ("页眉 字符" is the header's character style) and into fields.
 */
const LOCALIZED = new Set([
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((at) => [`标题 ${at}`, `標題 ${at}`, `見出し ${at}`]),
  "标题",
  "副标题",
  "页眉",
  "页脚",
  "脚注文本",
  "尾注文本",
  "批注文字",
  "批注主题",
  "批注框文本",
  "正文文本",
  "正文文本 2",
  "正文文本 3",
  "正文文本缩进",
  "正文文本缩进 2",
  "正文文本缩进 3",
  "正文首行缩进",
  "纯文本",
  "引用",
  "明显引用",
  "HTML 预设格式",
  "文档结构图",
  "日期",
  "称呼",
  "结束语",
  "签名",
  "电子邮件签名",
  "注释标题",
  "宏文本",
  "標題",
  "副標題",
  "頁首",
  "頁尾",
  "註腳文字",
  "章節附註文字",
  "註解文字",
  "註解主旨",
  "註解方塊文字",
  "本文",
  "本文 2",
  "本文 3",
  "本文縮排",
  "本文縮排 2",
  "本文縮排 3",
  "純文字",
  "引文",
  "鮮明引文",
  "HTML 預設格式",
  "文件引導模式",
  "問候",
  "結語",
  "簽名",
  "表題",
  "副題",
  "ヘッダー",
  "フッター",
  "脚注文字列",
  "文末脚注文字列",
  "コメント文字列",
  "コメント内容",
  "吹き出し",
  "書式なし",
  "引用文",
]);
/** What Word puts after a style's name to name the character style it links to it. */
const LINKED = / (?:Char|字符|字元|\(文字\))$/i;
const NEUTRAL_NAME = /^Style \d+$/;
const NEUTRAL_ID = /^Style\d+$/;
/** Word's ids for its own styles that aren't their names run together. */
const IDS_OF: Record<string, string> = {
  normaltable: "tablenormal",
  annotationtext: "commenttext",
  annotationreference: "commentreference",
  annotationsubject: "commentsubject",
  macro: "macrotext",
};
const compact = (name: string) => name.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
/** The ids Word and the export give their own styles, run together in lower case. */
const KNOWN_IDS = new Set(
  [...KNOWN].flatMap((name) => {
    const id = IDS_OF[compact(name)] ?? compact(name);
    return [id, `${id}char`, id.replace(/\d+$/, "")];
  }),
);

/**
 * Whether a style's name holds no one's words: none or no letter, Word's, the export's or one
 * written here, or the style Word links to one of its own, in its own words ("Heading 1 Char",
 * "标题 1 字符").
 */
export const isKnownStyleName = (name: string): boolean => {
  if (!/\p{L}/u.test(name) || NEUTRAL_NAME.test(name) || KNOWN.has(name.toLowerCase())) return true;
  if (LOCALIZED.has(name)) return true;
  const base = name.replace(LINKED, "");
  return base !== name && (KNOWN.has(base.toLowerCase()) || LOCALIZED.has(base));
};

/** The short ids Chinese and other Word versions give their own styles: a, a0 to a9, af0 and on. */
const SHORT_ID = /^a[0-9a-f]{0,3}$/;

/**
 * Whether a style's id holds no one's words: no letter, one of Word's (its names run together, or
 * a short id), the export's or one written here. A style someone named has its id renamed whatever
 * it is.
 */
export const isKnownStyleId = (id: string): boolean =>
  !/\p{L}/u.test(id) ||
  NEUTRAL_ID.test(id) ||
  SHORT_ID.test(id) ||
  KNOWN_IDS.has(compact(id).replace(/\d+$/, ""));

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

const ARGUMENTS = /"[^"]*"|\S+/g;

/**
 * Where a field's instruction names styles, as the offsets of each name: the list after a table of
 * contents' \t ("Name,2,Other,3") and STYLEREF's first argument.
 */
function styleNamesAt(instruction: string): { from: number; to: number }[] {
  const tokens = [...instruction.matchAll(ARGUMENTS)].map((match) => ({
    text: match[0],
    at: match.index,
  }));
  const field = (tokens[0]?.text ?? "").toUpperCase();
  const inner = (token: { text: string; at: number }) => {
    const quoted = token.text.startsWith('"') && token.text.endsWith('"') && token.text.length > 1;
    return quoted
      ? { from: token.at + 1, to: token.at + token.text.length - 1 }
      : { from: token.at, to: token.at + token.text.length };
  };
  if (field === "STYLEREF") {
    const argument = tokens.slice(1).find((token) => !token.text.startsWith("\\"));
    return argument ? [inner(argument)] : [];
  }
  if (field !== "TOC") return [];
  return tokens.flatMap((token, at) => {
    const list = tokens[at + 1];
    if (token.text.toLowerCase() !== "\\t" || !list || list.text.startsWith("\\")) return [];
    const { from, to } = inner(list);
    const spans: { from: number; to: number }[] = [];
    // Names and levels take turns, split by the list separator of the User's region.
    let start = from;
    let item = 0;
    for (let index = from; index <= to; index++) {
      if (index < to && !/[,;，；]/.test(instruction[index] ?? "")) continue;
      if (item % 2 === 0) {
        const name = instruction.slice(start, index);
        const lead = name.length - name.trimStart().length;
        spans.push({ from: start + lead, to: start + name.trimEnd().length });
      }
      item++;
      start = index + 1;
    }
    return spans;
  });
}

/** The styles a field's instruction names. */
export const styleNamesIn = (instruction: string): string[] =>
  styleNamesAt(instruction).map(({ from, to }) => instruction.slice(from, to));

/** A field's instruction with the styles someone named under their new names. */
function renamedInstruction(instruction: string, byName: ReadonlyMap<string, string>): string {
  let written = instruction;
  for (const { from, to } of styleNamesAt(instruction).reverse()) {
    const renamed = byName.get(instruction.slice(from, to).toLowerCase());
    if (renamed !== undefined) written = `${written.slice(0, from)}${renamed}${written.slice(to)}`;
  }
  return written;
}

/** Each field's instruction in a part, whole, with the elements it is written in. */
function instructionsIn(root: XmlElement): { text: string; written: XmlElement[] }[] {
  const found: { text: string; written: XmlElement[] }[] = [];
  const open: { text: string; written: XmlElement[]; separated: boolean }[] = [];
  for (const element of walk(root)) {
    if (element.name === "w:fldSimple") {
      found.push({ text: element.attrs["w:instr"] ?? "", written: [element] });
    } else if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      const top = open.at(-1);
      if (type === "begin") open.push({ text: "", written: [], separated: false });
      else if (type === "separate" && top) top.separated = true;
      else if (type === "end" && top) found.push(open.pop() ?? top);
    } else if (element.name === "w:instrText" || element.name === "w:delInstrText") {
      const top = open.at(-1);
      if (top && !top.separated) {
        top.text += textOf(element);
        top.written.push(element);
      }
    }
  }
  return found;
}

/** The new names and ids of the styles someone named, by their ids in the file and, for fields, by their names in lower case. */
export interface StyleRenames {
  ids: Map<string, string>;
  names: Map<string, string>;
  byName: Map<string, string>;
}

const stylesIn = (root: XmlElement) => [...walk(root)].filter((each) => each.name === "w:style");
const nameOf = (style: XmlElement) =>
  elements(style).find((each) => each.name === "w:name")?.attrs["w:val"] ?? "";

/** A neutral name and id for each style whose name or id isn't known, across these parts. */
export function styleRenames(roots: readonly XmlElement[]): StyleRenames {
  const styles = roots.flatMap(stylesIn);
  const taken = new Set(styles.flatMap((style) => [nameOf(style), style.attrs["w:styleId"] ?? ""]));
  const renames: StyleRenames = { ids: new Map(), names: new Map(), byName: new Map() };
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
    const named = !isKnownStyleName(name);
    if (!named && isKnownStyleId(id)) continue;
    const at = neutral();
    if (named) {
      renames.names.set(id, `Style ${at}`);
      renames.byName.set(name.toLowerCase(), `Style ${at}`);
    }
    if (named || !isKnownStyleId(id)) renames.ids.set(id, `Style${at}`);
  }
  return renames;
}

/**
 * A part's changes for `renames`: each style's id and name, and every reference to one. Word's
 * latent styles name only its own: another name there goes.
 */
export function styleSplices(root: XmlElement, text: string, renames: StyleRenames): Splice[] {
  const splices: Splice[] = [];
  for (const instruction of instructionsIn(root)) {
    const renamed = renamedInstruction(instruction.text, renames.byName);
    if (renamed === instruction.text) continue;
    const first = instruction.written[0];
    if (first?.name === "w:fldSimple") {
      splices.push(withAttribute(first, text, "w:instr", renamed));
      continue;
    }
    // The instruction is written whole in its first run, the others left empty.
    instruction.written.forEach((each, at) => {
      splices.push({
        from: startOf(each),
        to: endOf(each),
        text: `<${each.name} xml:space="preserve">${at === 0 ? escapeXml(renamed) : ""}</${each.name}>`,
      });
    });
  }
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
  const named = instructionsIn(root).some(({ text }) =>
    styleNamesIn(text).some((name) => !isKnownStyleName(name)),
  );
  return (
    named ||
    [...walk(root)].some((element) => {
      if (element.name === "w:style") {
        return (
          !isKnownStyleId(element.attrs["w:styleId"] ?? "") || !isKnownStyleName(nameOf(element))
        );
      }
      if (STYLE_REFERENCES.has(element.name)) return !isKnownStyleId(element.attrs["w:val"] ?? "");
      return (
        element.name === "w:lsdException" &&
        !KNOWN.has((element.attrs["w:name"] ?? "").toLowerCase())
      );
    })
  );
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
