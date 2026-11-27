/**
 * One part of the Word file written for an outside agent (#3751), made to hold only what the
 * agent was given: what someone deleted goes as if accepted, what someone inserted and every other
 * tracked change's mark goes, as do comments' marks, a person's editing permission, content
 * controls' ties, names and choices not shown, smart tags' and custom XML's data, legacy form
 * fields' names, help and lists (a check box stays as ☒ or ☐), watermarks, links' tips, drawings'
 * and shapes' names, lists' names, styles' other names, embedded objects (their picture stays),
 * fields that read another file, program or the file's properties (their result stays), a chart's
 * tie to its workbook (its cached values stay) and whatever points at a relationship that goes.
 */
import { elements, textOf, walk, type XmlElement } from "../../documents/formats/xml";
import { endOf, parentsOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";

/** Why a part can't be made fit for the agent, by what it holds: the file is written new instead. */
export class UnkeptPart extends Error {}

export const RELATIONSHIPS_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);

/** The prefix each namespace the cleaning matches by name must have. */
const PREFIXES: Readonly<Record<string, string>> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://schemas.microsoft.com/office/word/2010/wordml": "w14",
  "http://schemas.microsoft.com/office/word/2012/wordml": "w15",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://schemas.openxmlformats.org/drawingml/2006/chart": "c",
  "urn:schemas-microsoft-com:vml": "v",
  "urn:schemas-microsoft-com:office:office": "o",
};
const MATCHED_PREFIXES = new Set(Object.values(PREFIXES));

/**
 * Throws unless every namespace matched by name has its usual prefix, and every such prefix its
 * usual namespace: what is matched as `w:del` is then WordprocessingML's deletion and nothing else.
 */
export function checkNamespaces(root: XmlElement): void {
  for (const element of [root, ...walk(root)]) {
    for (const [name, value] of Object.entries(element.attrs)) {
      if (name === "xmlns") {
        if (PREFIXES[value] !== undefined) throw new UnkeptPart("a default namespace");
      } else if (name.startsWith("xmlns:")) {
        const prefix = name.slice("xmlns:".length);
        const expected = PREFIXES[value];
        if (expected !== undefined ? expected !== prefix : MATCHED_PREFIXES.has(prefix)) {
          throw new UnkeptPart(`the namespace of the prefix ${prefix}`);
        }
      }
    }
  }
}

/** The prefixes, with their colon, a part names its relationships by. */
export function relationshipPrefixes(root: XmlElement): string[] {
  const prefixes = new Set<string>();
  for (const element of [root, ...walk(root)]) {
    for (const [name, value] of Object.entries(element.attrs)) {
      if (name.startsWith("xmlns:") && RELATIONSHIPS_NAMESPACES.has(value)) {
        prefixes.add(`${name.slice("xmlns:".length)}:`);
      }
    }
  }
  return [...prefixes];
}

/** The ids of the part's relationships that its elements name. */
export function referenced(root: XmlElement): Set<string> {
  const prefixes = relationshipPrefixes(root);
  const ids = new Set<string>();
  for (const element of [root, ...walk(root)]) {
    for (const [name, value] of Object.entries(element.attrs)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) ids.add(value);
    }
  }
  return ids;
}

/** Elements that go with all they hold. */
const REMOVED = new Set([
  // What someone deleted, as if accepted, and what someone inserted, as if rejected.
  "w:del",
  "w:ins",
  "w:moveFrom",
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  "w:moveToRangeStart",
  "w:moveToRangeEnd",
  // Formatting changes: what was before goes, what is now stays.
  "w:rPrChange",
  "w:pPrChange",
  "w:sectPrChange",
  "w:tblPrChange",
  "w:tblPrExChange",
  "w:trPrChange",
  "w:tcPrChange",
  "w:tblGridChange",
  "w:numberingChange",
  "w:cellIns",
  "w:cellDel",
  "w:cellMerge",
  "w:customXmlInsRangeStart",
  "w:customXmlInsRangeEnd",
  "w:customXmlDelRangeStart",
  "w:customXmlDelRangeEnd",
  "w:customXmlMoveFromRangeStart",
  "w:customXmlMoveFromRangeEnd",
  "w:customXmlMoveToRangeStart",
  "w:customXmlMoveToRangeEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
  // A content control's tie to custom XML, the building block its placeholder is, and its names.
  "w:dataBinding",
  "w15:dataBinding",
  "w:placeholder",
  "w:tag",
  "w:alias",
  "w:smartTagPr",
  "w:customXmlPr",
  // Other names a style or a building block goes by, and a field's data in its own form.
  "w:aliases",
  "w:docPartCategory",
  "w:fldData",
  // A legacy form field's name, help, status text and list, should one be left outside its field.
  "w:ffData",
  // A chart's workbook and the pivot table it was drawn from.
  "c:externalData",
  "c:pivotSource",
  "c:extLst",
]);
/** Elements that go while what they hold stays: a move's new place, smart tags, inline custom XML. */
const UNWRAPPED = new Set(["w:moveTo", "w:smartTag", "w:customXml"]);
/** What an embedded object holds rather than shows, in Word's two ways of writing one. */
const EMBEDDED = new Set(["o:OLEObject", "w:objectEmbed", "w:objectLink", "w:control", "w:movie"]);

/**
 * A field written as its result, by its instruction: one that reads another file or program, the
 * file's properties or variables (which the agent's file doesn't keep), or a legacy form field,
 * whose name, help and list are no one's words the agent was given.
 */
const OUTSIDE_FIELD =
  /^\s*(?:LINK|INCLUDETEXT|INCLUDEPICTURE|INCLUDE|IMPORT|DDE|DDEAUTO|DOCPROPERTY|DOCVARIABLE|AUTHOR|TITLE|SUBJECT|KEYWORDS|COMMENTS|LASTSAVEDBY|FILENAME|TEMPLATE|USERNAME|USERINITIALS|USERADDRESS|INFO|FORMTEXT|FORMCHECKBOX|FORMDROPDOWN)\b/i;
const HYPERLINK_FIELD = /^\s*HYPERLINK\s+(?!\\l)"?([^"\s]+)/i;
/** A link's target that is a place on the web or an address, not a file on someone's computer. */
export const isWebLink = (target: string): boolean => /^(?:https?|mailto|ftp|tel):/i.test(target);
const readsOutside = (instruction: string): boolean => {
  if (OUTSIDE_FIELD.test(instruction)) return true;
  const link = HYPERLINK_FIELD.exec(instruction)?.[1];
  return link !== undefined && !isWebLink(link);
};

/** Where an element's closing tag starts; its end for one that closes itself. */
function closingAt(element: XmlElement, text: string): number {
  const end = endOf(element);
  if (element.openEnd === end) return end;
  const at = text.lastIndexOf("</", end - 1);
  if (at < 0 || !text.startsWith(`</${element.name}`, at)) {
    throw new UnkeptPart(`the end of ${element.name}`);
  }
  return at;
}

/** What an element holds, as written. */
const inner = (element: XmlElement, text: string) =>
  element.openEnd === endOf(element)
    ? ""
    : text.slice(element.openEnd ?? startOf(element), closingAt(element, text));

/**
 * An embedded object as the picture Word shows of it: its drawing, or its VML shape as a picture,
 * no longer marked as an object's.
 */
function picture(object: XmlElement, text: string): string {
  const shown = elements(object).filter((each) => !EMBEDDED.has(each.name));
  const drawing = shown.find((each) => each.name === "w:drawing");
  if (drawing) return text.slice(startOf(drawing), endOf(drawing));
  const shapes = shown
    .map((each) => {
      const xml = text.slice(startOf(each), endOf(each));
      const opening = xml.slice(0, (each.openEnd ?? startOf(each)) - startOf(each));
      return opening.replace(/\so:ole\s*=\s*(?:"[^"]*"|'[^']*')/, "") + xml.slice(opening.length);
    })
    .join("");
  return shapes === "" ? "" : `<w:pict>${shapes}</w:pict>`;
}

/**
 * A chart's reference into its workbook as the values it cached: numbers and categories as
 * literals, a series' name as its text. Any other reference (a title's, a multi-level category's)
 * can't be told without its workbook.
 */
function chartLiteral(
  element: XmlElement,
  text: string,
  parents: Map<XmlElement, XmlElement>,
): string | null {
  const cached = (name: string) => elements(element).find((each) => each.name === name);
  if (element.name === "c:numRef") {
    const cache = cached("c:numCache");
    return cache ? `<c:numLit>${inner(cache, text)}</c:numLit>` : "<c:numLit/>";
  }
  if (element.name === "c:strRef") {
    const cache = cached("c:strCache");
    const parent = parents.get(element);
    if (parent?.name === "c:tx" && parents.get(parent)?.name === "c:ser") {
      const first = cache && [...walk(cache)].find((each) => each.name === "c:v");
      return `<c:v>${escapeXml(first ? textOf(first) : "")}</c:v>`;
    }
    if (parent?.name === "c:tx") throw new UnkeptPart("a chart's title from its workbook");
    return cache ? `<c:strLit>${inner(cache, text)}</c:strLit>` : "<c:strLit/>";
  }
  if (element.name === "c:multiLvlStrRef") throw new UnkeptPart("a chart's categories");
  return null;
}

/** Attributes that go wherever they are: links' tips, a picture's packed copy, a diagram's prompt. */
const DROPPED_ATTRIBUTES = new Set(["w:tooltip", "tooltip", "o:gfxdata", "phldrT"]);
/** A drawing's name in the selection pane, which anyone can type: written empty. */
const NAMED = /^(?:wp:docPr|\w+:cNvPr)$/;
// The names are this file's own, with no character a pattern reads as more than itself.
const attributeAt = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`);

/** An element's opening tag with one of its attributes holding `value`. */
export function withAttribute(
  element: XmlElement,
  text: string,
  name: string,
  value: string,
): Splice {
  const from = startOf(element);
  const to = element.openEnd ?? from;
  return {
    from,
    to,
    text: text.slice(from, to).replace(attributeAt(name), ` ${name}="${escapeXml(value)}"`),
  };
}

/** VML shapes, whose id is the name the selection pane shows, which anyone can type. */
const SHAPES = new Set([
  "v:shape",
  "v:rect",
  "v:roundrect",
  "v:oval",
  "v:line",
  "v:polyline",
  "v:curve",
  "v:arc",
  "v:group",
  "v:image",
]);
/** An id Word gives a shape or a shape's type itself. */
export const SHAPE_ID = /^_x0000_[a-z]\d+$/i;

/**
 * Word's ids for the shapes that have none, numbered across the whole package above the highest
 * it holds, as no two shapes in one file may share an id.
 */
export function spareShapeIds(parts: Iterable<string>): () => string {
  let highest = 4095;
  for (const text of parts) {
    for (const [, number] of text.matchAll(/_x0000_[a-z](\d+)/gi)) {
      highest = Math.max(highest, Number(number));
    }
  }
  return () => `_x0000_s${++highest}`;
}

/**
 * An element's opening tag without `DROPPED_ATTRIBUTES`, with a drawing's name empty and a VML
 * shape's id Word's own (`spare`: one for a shape Word gave none); null when it keeps all.
 */
function openingCleaned(element: XmlElement, text: string, spare: () => string): Splice | null {
  const from = startOf(element);
  const to = element.openEnd ?? from;
  const opening = text.slice(from, to);
  let written = opening;
  const set = (name: string, value: string) => {
    written = written.replace(attributeAt(name), ` ${name}="${value}"`);
  };
  const { id, "o:spid": spid } = element.attrs;
  const shapeId = spid !== undefined && SHAPE_ID.test(spid) ? spid : undefined;
  for (const name of Object.keys(element.attrs)) {
    if (DROPPED_ATTRIBUTES.has(name)) written = written.replace(attributeAt(name), "");
    else if (name === "name" && NAMED.test(element.name) && element.attrs.name !== "") {
      set(name, "");
    }
  }
  if (SHAPES.has(element.name)) {
    if (spid !== undefined && shapeId === undefined) set("o:spid", spare());
    if (id !== undefined && !SHAPE_ID.test(id)) set("id", shapeId ?? spare());
  }
  return written === opening ? null : { from, to, text: written };
}

/** The words a content control shows. */
const shownIn = (sdt: XmlElement | undefined): string => {
  const content = sdt && elements(sdt).find((each) => each.name === "w:sdtContent");
  return content
    ? [...walk(content)]
        .filter((each) => each.name === "w:t")
        .map(textOf)
        .join("")
    : "";
};

/** A content control's list of choices with only the one it shows. */
function shownChoice(list: XmlElement, parents: Map<XmlElement, XmlElement>): string {
  const shown = shownIn(parents.get(parents.get(list) ?? list));
  const chosen = elements(list).some(
    (each) =>
      each.name === "w:listItem" &&
      shown !== "" &&
      (each.attrs["w:displayText"] ?? each.attrs["w:value"]) === shown,
  );
  const item = chosen
    ? `<w:listItem w:displayText="${escapeXml(shown)}" w:value="${escapeXml(shown)}"/>`
    : "";
  return `<${list.name}>${item}</${list.name}>`;
}

/** A legacy check box as what it shows: ☒ when ticked, ☐ when not, in the field's first run. */
function checkBox(begin: XmlElement, run: XmlElement, text: string): string {
  const box = [...walk(begin)].find((each) => each.name === "w:checkBox");
  const state = (name: string) => {
    const element = box && elements(box).find((each) => each.name === name);
    if (!element) return undefined;
    return !/^(?:0|false|off)$/i.test(element.attrs["w:val"] ?? "true");
  };
  const ticked = state("w:checked") ?? state("w:default") ?? false;
  const look = elements(run).find((each) => each.name === "w:rPr");
  const rPr = look ? text.slice(startOf(look), endOf(look)) : "";
  return `<w:r>${rPr}<w:t>${ticked ? "☒" : "☐"}</w:t></w:r>`;
}

/**
 * What a watermark or WordArt in VML is in: the run that holds it, else its shape. When it is the
 * older program's copy of a drawing, only that copy goes and the drawing stays.
 */
function shapeOfText(path: XmlElement, parents: Map<XmlElement, XmlElement>): XmlElement {
  for (let at = parents.get(path); at; at = parents.get(at)) {
    if (at.name === "w:r" || at.name === "mc:Fallback") return at;
  }
  return parents.get(path) ?? path;
}

/** Whether a hyperlink, once cleaned, shows nothing: no text, picture, tab or symbol. */
const showsNothing = (element: XmlElement) =>
  ![...walk(element)].some((each) =>
    ["w:t", "w:drawing", "w:pict", "w:object", "w:tab", "w:sym", "w:br"].includes(each.name),
  );

/**
 * The changes that make a part hold only what the agent was given. `gone`: the ids of the part's
 * relationships that go; a link to one stays as its text, anything else naming one goes. `also`:
 * more elements that go, such as settings no list keeps. `spareId`: an id for a shape Word gave none.
 */
export function partSplices(
  root: XmlElement,
  text: string,
  gone: ReadonlySet<string>,
  also: readonly XmlElement[],
  spareId: () => string,
): Splice[] {
  const parents = parentsOf(root);
  const prefixes = relationshipPrefixes(root);
  const removed = new Set<XmlElement>(also);
  const unwrapped = new Set<XmlElement>();
  const replaced = new Map<XmlElement, string>();
  const permitted = new Set<string>();
  const runOf = (element: XmlElement) => {
    const parent = parents.get(element);
    return parent?.name === "w:r" ? parent : element;
  };
  const fields: {
    begin: XmlElement;
    instruction: string;
    runs: XmlElement[];
    separated: boolean;
  }[] = [];
  const chart = root.name === "c:chartSpace";

  for (const element of walk(root)) {
    const points = Object.entries(element.attrs).some(
      ([name, value]) => gone.has(value) && prefixes.some((prefix) => name.startsWith(prefix)),
    );
    const literal = chart ? chartLiteral(element, text, parents) : null;
    if (literal !== null) replaced.set(element, literal);
    else if (element.name === "w:hyperlink" && points) unwrapped.add(element);
    else if (REMOVED.has(element.name) || points) removed.add(element);
    else if (UNWRAPPED.has(element.name)) unwrapped.add(element);
    else if (element.name === "w:name" && parents.get(element)?.name === "w:abstractNum") {
      // A list's name someone gave it: its look is in its levels.
      removed.add(element);
    } else if (element.name === "w:object") replaced.set(element, picture(element, text));
    else if (element.name === "w:dropDownList" || element.name === "w:comboBox") {
      replaced.set(element, shownChoice(element, parents));
    } else if (element.name === "v:textpath") removed.add(shapeOfText(element, parents));
    else if (element.name === "w:commentReference") {
      const run = parents.get(element);
      // Word gives the mark a run of its own: the run goes with it, but never another's text.
      const alone =
        run?.name === "w:r" &&
        elements(run).every((each) => each === element || each.name === "w:rPr");
      removed.add(alone && run ? run : element);
    } else if (element.name === "w:permStart" && element.attrs["w:ed"] !== undefined) {
      removed.add(element);
      permitted.add(element.attrs["w:id"] ?? "");
    } else if (element.name === "w:permEnd" && permitted.has(element.attrs["w:id"] ?? "")) {
      removed.add(element);
    } else if (element.name === "w:fldSimple" && readsOutside(element.attrs["w:instr"] ?? "")) {
      unwrapped.add(element);
    } else if (element.name === "w:r") {
      for (const field of fields) if (!field.separated) field.runs.push(element);
    } else if (element.name === "w:instrText") {
      const top = fields.at(-1);
      if (top && !top.separated) top.instruction += textOf(element);
    } else if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      const top = fields.at(-1);
      if (type === "begin") {
        fields.push({ begin: element, instruction: "", runs: [], separated: false });
      } else if (type === "separate" && top) top.separated = true;
      else if (type === "end" && top) {
        fields.pop();
        // The field's result stays as plain runs: what it showed, without what it read from.
        if (readsOutside(top.instruction)) {
          const first = runOf(top.begin);
          if (/^\s*FORMCHECKBOX\b/i.test(top.instruction) && first !== top.begin) {
            replaced.set(first, checkBox(top.begin, first, text));
          } else removed.add(first);
          for (const run of [...top.runs, runOf(element)]) removed.add(run);
        }
      }
    }
  }

  const within = (element: XmlElement) => {
    for (let at = parents.get(element); at; at = parents.get(at)) {
      if (removed.has(at) || replaced.has(at)) return true;
    }
    return false;
  };
  const splices: Splice[] = [];
  for (const element of [root, ...walk(root)]) {
    if (removed.has(element) || replaced.has(element) || unwrapped.has(element)) continue;
    if (within(element)) continue;
    const opening = openingCleaned(element, text, spareId);
    if (opening) splices.push(opening);
  }
  for (const element of removed) {
    if (!within(element)) splices.push({ from: startOf(element), to: endOf(element), text: "" });
  }
  for (const [element, written] of replaced) {
    if (!removed.has(element) && !within(element)) {
      splices.push({ from: startOf(element), to: endOf(element), text: written });
    }
  }
  for (const element of unwrapped) {
    if (removed.has(element) || within(element)) continue;
    const from = startOf(element);
    const open = element.openEnd ?? from;
    const close = closingAt(element, text);
    splices.push({ from, to: open, text: "" });
    if (close < endOf(element)) splices.push({ from: close, to: endOf(element), text: "" });
  }
  return splices;
}

/** The links, once cleaned, that show nothing: they go, so their relationships can too. */
export function emptyLinks(root: XmlElement): Splice[] {
  return [...walk(root)]
    .filter((each) => each.name === "w:hyperlink" && showsNothing(each))
    .map((each) => ({ from: startOf(each), to: endOf(each), text: "" }));
}
