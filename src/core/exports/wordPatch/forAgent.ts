/**
 * A Word file written into the file a Note came from, made fit for an outside agent (#3751): what
 * makes its look stays (styles, numbering, settings, headers and footers, theme, fonts, its own
 * layout), and what the agent was never given goes. That is what other people wrote in it or are
 * named by: comments and the parts that name their people, tracked changes' authors, the people
 * and words its properties hold, editing permissions given to a person. And the file's own data
 * that no text shows: its custom properties and document variables, custom XML, building blocks,
 * picture of its first page, mail merge source, template path and signatures. A property or
 * variable that a field in the text shows stays: the agent read it there.
 */
import { deflateRawSync } from "node:zlib";
import { relationshipsPartOf } from "../../documents/formats/officePackage";
import { elements, local, textOf, walk, type XmlElement } from "../../documents/formats/xml";
import { openPackage, resolvePart } from "../../documents/formats/zip";
import { checkWellFormed, PackageWriter } from "../packagePatch/package";
import { applySplices, endOf, parentsOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";

/** Relationships to what other people wrote or are named by, or to the file's data no text shows. */
const DROPPED = [
  "/comments",
  "/commentsExtended",
  "/commentsIds",
  "/commentsExtensible",
  "/people",
  "/metadata/thumbnail",
  "/customXml",
  "/glossaryDocument",
  "/digital-signature/origin",
  "/attachedTemplate",
  "/mailMergeSource",
  "/mailMergeHeaderSource",
  "/mailMergeRecipientData",
  "/recipientData",
];
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
];
/** The extended properties that name a person or an organisation. */
const EXTENDED_NAMES = ["Manager", "Company"];
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
};

/**
 * What the file's fields show: built-in properties by element name, custom properties and
 * variables by their names in lower case.
 */
interface Shown {
  builtIn: Set<string>;
  custom: Set<string>;
  variables: Set<string>;
}

interface ListedRelationship {
  element: XmlElement;
  type: string;
  target: string;
  external: boolean;
}

const FIELD = /^\s*([A-Za-z]+)(?:\s+(?:"([^"]*)"|([^\s\\]+)))?/;

function readField(instruction: string, shown: Shown): void {
  const match = FIELD.exec(instruction);
  if (!match) return;
  const kind = (match[1] ?? "").toUpperCase();
  const name = (match[2] ?? match[3] ?? "").trim().toLowerCase();
  if (kind === "DOCPROPERTY") {
    const builtIn = DOCPROPERTY_BUILT_IN[name.replaceAll(" ", "")];
    if (builtIn) shown.builtIn.add(builtIn);
    else if (name) shown.custom.add(name);
  } else if (kind === "DOCVARIABLE") {
    if (name) shown.variables.add(name);
  } else {
    const builtIn = FIELD_PROPERTY[kind];
    if (builtIn) shown.builtIn.add(builtIn);
  }
}

/** Every field's instruction in a part, a field inside another read on its own. */
function readFields(root: XmlElement, shown: Shown): void {
  const open: string[] = [];
  for (const element of walk(root)) {
    if (element.name === "w:fldSimple") readField(element.attrs["w:instr"] ?? "", shown);
    else if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      if (type === "begin") open.push("");
      else if (type === "end" && open.length > 0) readField(open.pop() ?? "", shown);
    } else if (element.name === "w:instrText" && open.length > 0) {
      open[open.length - 1] += textOf(element);
    }
  }
}

const removal = (element: XmlElement): Splice => ({
  from: startOf(element),
  to: endOf(element),
  text: "",
});

const childrenNamed = (root: XmlElement, names: readonly string[]) =>
  elements(root).filter((each) => names.includes(local(each.name)));

/**
 * Comments' marks, a person's editing permission, and each tracked change's author as `author`,
 * in a part of the document's text, its notes, headers and footers, styles or numbering.
 */
function textSplices(root: XmlElement, text: string, author: string): Splice[] {
  const parents = parentsOf(root);
  const removed = new Set<XmlElement>();
  const named = new Set<string>();
  for (const element of walk(root)) {
    if (element.name === "w:commentRangeStart" || element.name === "w:commentRangeEnd") {
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
      if (removed.has(at)) return true;
    }
    return false;
  };
  const splices = [...removed].filter((each) => !within(each)).map(removal);
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
        const { Type: type = "", Target: target, TargetMode: mode } = element.attrs;
        if (target === undefined) return [];
        const external = mode === "External";
        return [
          { element, type, external, target: external ? target : resolvePart(owner, target) },
        ];
      }),
    );
  }
  const dropped = new Set<XmlElement>();
  for (const relationships of listed.values()) {
    for (const each of relationships) {
      if (DROPPED.some((type) => each.type.endsWith(type))) dropped.add(each.element);
    }
  }
  const ofType = (owner: string, type: string) =>
    listed.get(owner)?.find((each) => !each.external && each.type.endsWith(type));

  const reachable = () => {
    const reached = new Set<string>([""]);
    const queue = [""];
    for (let owner = queue.pop(); owner !== undefined; owner = queue.pop()) {
      for (const each of listed.get(owner) ?? []) {
        if (each.external || dropped.has(each.element) || reached.has(each.target)) continue;
        reached.add(each.target);
        queue.push(each.target);
      }
    }
    return reached;
  };
  let reached = reachable();

  const shown: Shown = { builtIn: new Set(), custom: new Set(), variables: new Set() };
  for (const name of names) {
    if (!reached.has(name) || !name.startsWith("word/") || !name.endsWith(".xml")) continue;
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
    reached = reachable();
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

  const settings = ofType(ofType("", MAIN)?.target ?? "", SETTINGS)?.target;
  for (const name of names) {
    if (!reached.has(name) || !name.startsWith("word/") || !name.endsWith(".xml")) continue;
    await splice(name, ({ root, text }) => {
      const made = textSplices(root, text, author);
      if (name !== settings) return made;
      for (const each of childrenNamed(root, ["attachedTemplate", "mailMerge"])) {
        made.push(removal(each));
      }
      for (const variables of childrenNamed(root, ["docVars"])) {
        const out = elements(variables).filter(
          (each) => !shown.variables.has((each.attrs["w:name"] ?? "").toLowerCase()),
        );
        if (out.length === elements(variables).length) made.push(removal(variables));
        else made.push(...out.map(removal));
      }
      return made;
    });
  }

  const core = ofType("", CORE_PROPERTIES)?.target;
  if (core) {
    await splice(core, ({ root }) =>
      childrenNamed(root, CORE_WORDS)
        .filter((each) => !shown.builtIn.has(local(each.name)))
        .map(removal),
    );
  }
  const extended = ofType("", EXTENDED_PROPERTIES)?.target;
  if (extended) {
    await splice(extended, ({ root }) =>
      [
        ...childrenNamed(root, EXTENDED_NAMES).filter(
          (each) => !shown.builtIn.has(local(each.name)),
        ),
        ...(shown.builtIn.has("title") ? [] : childrenNamed(root, EXTENDED_TITLE)),
      ].map(removal),
    );
  }
  if (custom && customPart && customKept.length > 0) {
    await splice(custom.target, ({ root }) =>
      elements(root)
        .filter((each) => !customKept.includes(each))
        .map(removal),
    );
  }

  for (const name of removed) writer.remove(name);
  return writer.write(deflateRawSync, checkWellFormed);
}
