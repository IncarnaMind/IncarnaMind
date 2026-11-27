/**
 * A Word file written into the file a Note came from, made fit for an outside agent (#3751): what
 * makes its look stays (styles, numbering, settings, headers and footers, theme, fonts, its own
 * layout), and what the agent was never given goes. That is what other people wrote in it or are
 * named by: comments and the parts that name their people, tracked changes' authors and the words
 * they deleted, the people and words its properties hold, editing permissions given to a person.
 * And the file's own data that no text shows: its custom properties and document variables, custom
 * XML and the bindings to it, building blocks, picture of its first page, mail merge source,
 * template, signatures, and what an embedded object or a chart's workbook holds beyond what it
 * shows. A part of a kind not known here goes too, and what points at it. A property or variable
 * that a field in the text shows stays, holding what the field shows: the agent read that there.
 */
import { deflateRawSync } from "node:zlib";
import { relationshipsPartOf } from "../../documents/formats/officePackage";
import { elements, local, textOf, walk, type XmlElement } from "../../documents/formats/xml";
import { openPackage, resolvePart } from "../../documents/formats/zip";
import { checkWellFormed, PackageWriter } from "../packagePatch/package";
import { applySplices, endOf, parentsOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";

/**
 * The relationships kept, by the last part of their type: the text and what makes its look. Any
 * other goes, with what it reaches: comments, people, custom XML, building blocks, signatures, a
 * template, a mail merge source, an embedded object or workbook, and any kind not known here.
 */
const KEPT = new Set([
  "officeDocument",
  "core-properties",
  "extended-properties",
  "custom-properties",
  "styles",
  "stylesWithEffects",
  "numbering",
  "settings",
  "webSettings",
  "fontTable",
  "font",
  "theme",
  "themeOverride",
  "header",
  "footer",
  "footnotes",
  "endnotes",
  "image",
  "hdphoto",
  "media",
  "video",
  "audio",
  "chart",
  "chartEx",
  "chartUserShapes",
  "chartStyle",
  "chartColorStyle",
  "diagramData",
  "diagramLayout",
  "diagramQuickStyle",
  "diagramColors",
  "diagramDrawing",
]);
/** The one kind of relationship kept outside the package: a link in the text. */
const HYPERLINK = "hyperlink";
const RELATIONSHIPS_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const kindOf = (type: string) => type.slice(type.lastIndexOf("/") + 1);
const MAIN = "/officeDocument";
const SETTINGS = "/settings";
const CORE_PROPERTIES = "/metadata/core-properties";
const EXTENDED_PROPERTIES = "/extended-properties";
const CUSTOM_PROPERTIES = "/custom-properties";

/** The core properties that are a person's name or someone's words about the file. */
const CORE_WORDS = [
  "creator",
  "lastModifiedBy",
  "title",
  "subject",
  "description",
  "keywords",
  "category",
  "contentStatus",
  "identifier",
  "version",
];
/** The extended properties that name a person, an organisation or a template. */
const EXTENDED_NAMES = ["Manager", "Company", "Template"];
/** What repeats the title in the extended properties. */
const EXTENDED_TITLE = ["HeadingPairs", "TitlesOfParts"];

/** The property each field shows, by the field's name. */
const FIELD_PROPERTY: Readonly<Record<string, string>> = {
  AUTHOR: "creator",
  LASTSAVEDBY: "lastModifiedBy",
  TITLE: "title",
  SUBJECT: "subject",
  COMMENTS: "description",
  KEYWORDS: "keywords",
  TEMPLATE: "Template",
};
/** The built-in property a DOCPROPERTY field names, by its name in lower case without spaces. */
const DOCPROPERTY_BUILT_IN: Readonly<Record<string, string>> = {
  author: "creator",
  lastsavedby: "lastModifiedBy",
  title: "title",
  subject: "subject",
  comments: "description",
  keywords: "keywords",
  category: "category",
  manager: "Manager",
  company: "Company",
  template: "Template",
};

/**
 * What the file's fields show, the first such field's result for each: built-in properties by
 * element name, custom properties and variables by their names in lower case.
 */
interface Shown {
  builtIn: Map<string, string>;
  custom: Map<string, string>;
  variables: Map<string, string>;
}

interface ListedRelationship {
  element: XmlElement;
  id: string;
  type: string;
  target: string;
  external: boolean;
}

const FIELD = /^\s*([A-Za-z]+)(?:\s+(?:"([^"]*)"|([^\s\\]+)))?/;

const showing = (shown: Map<string, string>, name: string, result: string) => {
  if (name && !shown.has(name)) shown.set(name, result);
};

function readField(instruction: string, result: string, shown: Shown): void {
  const match = FIELD.exec(instruction);
  if (!match) return;
  const kind = (match[1] ?? "").toUpperCase();
  const name = (match[2] ?? match[3] ?? "").trim().toLowerCase();
  if (kind === "DOCPROPERTY") {
    const builtIn = DOCPROPERTY_BUILT_IN[name.replaceAll(" ", "")];
    if (builtIn) showing(shown.builtIn, builtIn, result);
    else showing(shown.custom, name, result);
  } else if (kind === "DOCVARIABLE") {
    showing(shown.variables, name, result);
  } else {
    showing(shown.builtIn, FIELD_PROPERTY[kind] ?? "", result);
  }
}

const textIn = (element: XmlElement) =>
  [...walk(element)]
    .filter((each) => each.name === "w:t")
    .map(textOf)
    .join("");

/** Every field's instruction and result in a part, a field inside another read on its own. */
function readFields(root: XmlElement, shown: Shown): void {
  const open: { instruction: string; result: string; separated: boolean }[] = [];
  for (const element of walk(root)) {
    if (element.name === "w:fldSimple") {
      readField(element.attrs["w:instr"] ?? "", textIn(element), shown);
    } else if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      const top = open.at(-1);
      if (type === "begin") open.push({ instruction: "", result: "", separated: false });
      else if (type === "separate" && top) top.separated = true;
      else if (type === "end" && top) {
        open.pop();
        readField(top.instruction, top.result, shown);
      }
    } else if (element.name === "w:instrText") {
      const top = open.at(-1);
      if (top && !top.separated) top.instruction += textOf(element);
    } else if (element.name === "w:t") {
      for (const each of open) if (each.separated) each.result += textOf(element);
    }
  }
}

/** The element written again holding `value` as its text, in place of what it held. */
function holding(element: XmlElement, text: string, value: string): Splice {
  const from = startOf(element);
  const opening = text.slice(from, element.openEnd ?? from).replace(/\s*\/>$/, ">");
  return {
    from,
    to: endOf(element),
    text: `${opening}${escapeXml(value)}</${element.name}>`,
  };
}

const removal = (element: XmlElement): Splice => ({
  from: startOf(element),
  to: endOf(element),
  text: "",
});

const childrenNamed = (root: XmlElement, names: readonly string[]) =>
  elements(root).filter((each) => names.includes(local(each.name)));

/** What an embedded object holds rather than shows, in Word's two ways of writing one. */
const EMBEDDED = new Set(["o:OLEObject", "w:objectEmbed", "w:objectLink", "w:control", "w:movie"]);

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

/** Elements of a part that go whole wherever they are. */
const REMOVED = new Set([
  "w:commentRangeStart",
  "w:commentRangeEnd",
  // What a tracked change deleted, as if the deletion were accepted.
  "w:del",
  "w:moveFrom",
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  // A content control's tie to the custom XML and the building block its placeholder is.
  "w:dataBinding",
  "w:placeholder",
]);

/**
 * In a part of the document's text, its notes, headers and footers, styles, numbering or charts:
 * the elements `REMOVED` names, comments' marks, a person's editing permission, every element
 * pointing at a relationship of the part that goes (`gone`) and those in `also`; each embedded
 * object as the picture it shows; and each tracked change's author as `author`.
 */
function textSplices(
  root: XmlElement,
  text: string,
  author: string,
  gone: ReadonlySet<string>,
  also: readonly XmlElement[] = [],
): Splice[] {
  const parents = parentsOf(root);
  const removed = new Set<XmlElement>(also);
  const named = new Set<string>();
  const pointing = new Set<string>();
  for (const element of [root, ...walk(root)]) {
    for (const [name, value] of Object.entries(element.attrs)) {
      if (name.startsWith("xmlns:") && RELATIONSHIPS_NAMESPACES.has(value)) {
        pointing.add(`${name.slice("xmlns:".length)}:`);
      }
    }
  }
  const pictures = new Map<XmlElement, string>();
  for (const element of walk(root)) {
    if (element.name === "w:object") pictures.set(element, picture(element, text));
    const points = Object.entries(element.attrs).some(
      ([name, value]) => gone.has(value) && [...pointing].some((prefix) => name.startsWith(prefix)),
    );
    if (REMOVED.has(element.name) || points) {
      removed.add(element);
    } else if (element.name === "w:commentReference") {
      const run = parents.get(element);
      // Word gives the mark a run of its own: the run goes with it, but never another's text.
      const alone =
        run?.name === "w:r" &&
        elements(run).every((each) => each === element || each.name === "w:rPr");
      removed.add(alone && run ? run : element);
    } else if (element.name === "w:permStart" && element.attrs["w:ed"] !== undefined) {
      removed.add(element);
      named.add(element.attrs["w:id"] ?? "");
    }
  }
  for (const element of walk(root)) {
    if (element.name === "w:permEnd" && named.has(element.attrs["w:id"] ?? ""))
      removed.add(element);
  }
  const within = (element: XmlElement) => {
    for (let at = parents.get(element); at; at = parents.get(at)) {
      if (removed.has(at) || pictures.has(at)) return true;
    }
    return false;
  };
  const splices = [...removed].filter((each) => !within(each)).map(removal);
  for (const [object, shown] of pictures) {
    if (!removed.has(object) && !within(object)) {
      splices.push({ from: startOf(object), to: endOf(object), text: shown });
    }
  }
  const neutral = `"${escapeXml(author)}"`;
  for (const element of walk(root)) {
    if (element.attrs["w:author"] === undefined || removed.has(element) || within(element)) {
      continue;
    }
    const from = startOf(element);
    const to = element.openEnd ?? from;
    const tag = text.slice(from, to);
    const written = tag.replace(/(\sw:author\s*=\s*)(?:"[^"]*"|'[^']*')/, `$1${neutral}`);
    if (written !== tag) splices.push({ from, to, text: written });
  }
  return splices;
}

/**
 * The Word file `data`, written by Export › Word into the file a Note came from, with only what
 * an outside agent was given of it. `author` stands for every tracked change's author.
 */
export async function forAgent(data: Uint8Array, author: string): Promise<Uint8Array> {
  const zip = openPackage(data);
  const writer = new PackageWriter(zip);
  const names = zip.names().filter((name) => !name.endsWith("/"));

  const listed = new Map<string, ListedRelationship[]>();
  for (const name of names) {
    const match = /^(.*?)_rels\/([^/]*)\.rels$/.exec(name);
    if (!match) continue;
    const owner = `${match[1]}${match[2]}`;
    const part = await writer.part(name);
    listed.set(
      owner,
      (part ? elements(part.root) : []).flatMap((element) => {
        const { Id: id = "", Type: type = "", Target: target, TargetMode: mode } = element.attrs;
        if (target === undefined) return [];
        const external = mode === "External";
        return [
          { element, id, type, external, target: external ? target : resolvePart(owner, target) },
        ];
      }),
    );
  }
  const dropped = new Set<XmlElement>();
  for (const relationships of listed.values()) {
    for (const each of relationships) {
      const kind = kindOf(each.type);
      if (each.external ? kind !== HYPERLINK : !KEPT.has(kind)) dropped.add(each.element);
    }
  }
  const ofType = (owner: string, type: string) =>
    listed.get(owner)?.find((each) => !each.external && each.type.endsWith(type));

  const reachable = (from: string) => {
    const reached = new Set<string>([from]);
    const queue = [from];
    for (let owner = queue.pop(); owner !== undefined; owner = queue.pop()) {
      for (const each of listed.get(owner) ?? []) {
        if (each.external || dropped.has(each.element) || reached.has(each.target)) continue;
        reached.add(each.target);
        queue.push(each.target);
      }
    }
    return reached;
  };
  let reached = reachable("");
  // The document's text and every part it reaches, wherever the package keeps them.
  const main = ofType("", MAIN)?.target;
  const textParts = [...(main === undefined ? [] : reachable(main))].filter((name) =>
    name.endsWith(".xml"),
  );

  const shown: Shown = { builtIn: new Map(), custom: new Map(), variables: new Map() };
  for (const name of textParts) {
    const part = await writer.part(name);
    if (part) readFields(part.root, shown);
  }

  const custom = ofType("", CUSTOM_PROPERTIES);
  const customPart = custom ? await writer.part(custom.target) : null;
  const customKept = customPart
    ? elements(customPart.root).filter((each) =>
        shown.custom.has((each.attrs.name ?? "").toLowerCase()),
      )
    : [];
  if (custom && customPart && customKept.length === 0) {
    dropped.add(custom.element);
    reached = reachable("");
  }

  const isRelationships = (name: string) => /(^|\/)_rels\/[^/]*\.rels$/.test(name);
  const keptRelationships = new Set([...reached].map(relationshipsPartOf));
  keptRelationships.add("_rels/.rels");
  const removed = names.filter(
    (name) =>
      name !== "[Content_Types].xml" &&
      !reached.has(name) &&
      !(isRelationships(name) && keptRelationships.has(name)),
  );

  const splice = async (
    name: string,
    splices: (part: { text: string; root: XmlElement }) => Splice[],
  ) => {
    const part = await writer.part(name);
    if (!part) return;
    const made = splices(part);
    if (made.length > 0) writer.set(name, applySplices(part.text, made));
  };

  for (const [owner, relationships] of listed) {
    const name = relationshipsPartOf(owner);
    if (!keptRelationships.has(name)) continue;
    await splice(name, () =>
      relationships
        .filter((each) => dropped.has(each.element))
        .map((each) => removal(each.element)),
    );
  }
  const gone = new Set(removed.map((name) => `/${name}`));
  await splice("[Content_Types].xml", ({ root }) =>
    elements(root)
      .filter((each) => local(each.name) === "Override" && gone.has(each.attrs.PartName ?? ""))
      .map(removal),
  );

  /** Each property the text shows written as it shows it, the rest gone. */
  const asShown = (
    children: readonly XmlElement[],
    shownAs: (element: XmlElement) => string | undefined,
    text: string,
  ): Splice[] =>
    children.map((each) => {
      const value = shownAs(each);
      return value === undefined ? removal(each) : holding(each, text, value);
    });

  const settings = main === undefined ? undefined : ofType(main, SETTINGS)?.target;
  for (const name of textParts) {
    const gone = new Set(
      (listed.get(name) ?? []).filter((each) => dropped.has(each.element)).map((each) => each.id),
    );
    await splice(name, ({ root, text }) => {
      if (name !== settings) return textSplices(root, text, author, gone);
      const also = childrenNamed(root, ["attachedTemplate", "mailMerge"]);
      const values: Splice[] = [];
      for (const variables of childrenNamed(root, ["docVars"])) {
        const all = elements(variables);
        const value = (each: XmlElement) =>
          shown.variables.get((each.attrs["w:name"] ?? "").toLowerCase());
        if (all.every((each) => value(each) === undefined)) {
          also.push(variables);
          continue;
        }
        for (const each of all) {
          const shownAs = value(each);
          if (shownAs === undefined) {
            also.push(each);
            continue;
          }
          const from = startOf(each);
          const to = each.openEnd ?? from;
          const tag = text.slice(from, to);
          const val = `"${escapeXml(shownAs)}"`;
          values.push({
            from,
            to,
            text: tag.replace(/(\sw:val\s*=\s*)(?:"[^"]*"|'[^']*')/, `$1${val}`),
          });
        }
      }
      return [...textSplices(root, text, author, gone, also), ...values];
    });
  }

  const core = ofType("", CORE_PROPERTIES)?.target;
  if (core) {
    await splice(core, ({ root, text }) =>
      asShown(childrenNamed(root, CORE_WORDS), (each) => shown.builtIn.get(local(each.name)), text),
    );
  }
  const extended = ofType("", EXTENDED_PROPERTIES)?.target;
  if (extended) {
    // Its list of titles holds the title as stored, and Word writes it again on the next save.
    await splice(extended, ({ root, text }) => [
      ...asShown(
        childrenNamed(root, EXTENDED_NAMES),
        (each) => shown.builtIn.get(local(each.name)),
        text,
      ),
      ...childrenNamed(root, EXTENDED_TITLE).map(removal),
    ]);
  }
  if (custom && customPart && customKept.length > 0) {
    await splice(custom.target, ({ root, text }) =>
      elements(root).map((each) => {
        const value = shown.custom.get((each.attrs.name ?? "").toLowerCase());
        if (value === undefined) return removal(each);
        const from = startOf(each);
        const opening = text.slice(from, each.openEnd ?? from);
        const typed = elements(each)[0]?.name ?? "vt:lpwstr";
        const string = typed.includes(":") ? `${typed.split(":")[0]}:lpwstr` : "lpwstr";
        return {
          from,
          to: endOf(each),
          text: `${opening}<${string}>${escapeXml(value)}</${string}></${each.name}>`,
        };
      }),
    );
  }

  for (const name of removed) writer.remove(name);
  return writer.write(deflateRawSync, checkWellFormed);
}
