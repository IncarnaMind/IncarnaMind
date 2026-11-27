/**
 * A Word file written into the file a Note came from, made fit for an outside agent (#3751). It
 * keeps only what it knows makes the file's look and what the agent was given: the text and its
 * notes, headers and footers, styles, numbering, theme, fonts, pictures, charts' cached values, the
 * settings that make the layout, and a custom property a field in the text shows, holding what the
 * field shows. Everything else goes: other people's comments, tracked changes and names, the
 * file's data no text shows, parts and relationships of kinds not known here, and whatever nothing
 * points at once the rest is gone. A part it can't clean with certainty makes the whole file
 * unkept, and the agent's file is written new from the Note instead.
 */
import { deflateRawSync } from "node:zlib";
import { relationshipsPartOf } from "../../documents/formats/officePackage";
import {
  elements,
  local,
  parseXml,
  textOf,
  walk,
  type XmlElement,
} from "../../documents/formats/xml";
import { openPackage, resolvePart } from "../../documents/formats/zip";
import { checkWellFormed, PackageWriter } from "../packagePatch/package";
import { applySplices, endOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";
import {
  checkNamespaces,
  emptyLinks,
  isWebLink,
  partSplices,
  referenced,
  UnkeptPart,
} from "./forAgentParts";
import { leftIn, textsOf } from "./forAgentWords";

/** The relationships kept, by the last part of their type: the text and what makes its look. */
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
/** Kinds whose parts hold no XML to clean. */
const BINARY = new Set(["image", "hdphoto", "media", "video", "audio", "font"]);
/** Kinds a part reaches by being there, not by an element naming them. */
const IMPLICIT = new Set([
  "styles",
  "stylesWithEffects",
  "numbering",
  "settings",
  "webSettings",
  "fontTable",
  "theme",
  "themeOverride",
  "footnotes",
  "endnotes",
  "chartStyle",
  "chartColorStyle",
  "diagramDrawing",
]);
/** The content types of binary parts kept: pictures, sound and film, fonts. */
const BINARY_TYPES = [
  /^image\/(?:png|x-png|jpeg|pjpeg|jpg|gif|bmp|tiff|x-emf|emf|x-wmf|wmf|vnd\.ms-photo)$/,
  /^(?:video|audio)\//,
  /^application\/(?:vnd\.openxmlformats-officedocument\.obfuscatedFont|x-fontdata|x-font-ttf|vnd\.ms-opentype)$/,
];
const kindOf = (type: string) => type.slice(type.lastIndexOf("/") + 1);
const MAIN = "officeDocument";

/** The core properties kept: when the file was made and saved, and how often. */
const CORE_KEPT = new Set(["created", "modified", "revision"]);
/** The extended properties kept: counts and the program, nothing anyone wrote. */
const APP_KEPT = new Set([
  "TotalTime",
  "Pages",
  "Words",
  "Characters",
  "CharactersWithSpaces",
  "Lines",
  "Paragraphs",
  "Application",
  "AppVersion",
  "DocSecurity",
  "ScaleCrop",
  "LinksUpToDate",
  "SharedDoc",
  "HyperlinksChanged",
]);
/** The settings kept: what makes the layout and how Word behaves with it, nobody's data. */
const SETTINGS_KEPT = new Set([
  "w:view",
  "w:zoom",
  "w:removePersonalInformation",
  "w:removeDateAndTime",
  "w:doNotDisplayPageBoundaries",
  "w:displayBackgroundShape",
  "w:embedTrueTypeFonts",
  "w:embedSystemFonts",
  "w:saveSubsetFonts",
  "w:mirrorMargins",
  "w:alignBordersAndEdges",
  "w:bordersDoNotSurroundHeader",
  "w:bordersDoNotSurroundFooter",
  "w:gutterAtTop",
  "w:hideSpellingErrors",
  "w:hideGrammaticalErrors",
  "w:proofState",
  "w:defaultTabStop",
  "w:autoHyphenation",
  "w:consecutiveHyphenLimit",
  "w:hyphenationZone",
  "w:doNotHyphenateCaps",
  "w:evenAndOddHeaders",
  "w:bookFoldRevPrinting",
  "w:bookFoldPrinting",
  "w:bookFoldPrintingSheets",
  "w:drawingGridHorizontalSpacing",
  "w:drawingGridVerticalSpacing",
  "w:displayHorizontalDrawingGridEvery",
  "w:displayVerticalDrawingGridEvery",
  "w:doNotUseMarginsForDrawingGridOrigin",
  "w:drawingGridHorizontalOrigin",
  "w:drawingGridVerticalOrigin",
  "w:doNotShadeFormData",
  "w:noPunctuationKerning",
  "w:characterSpacingControl",
  "w:printTwoOnOne",
  "w:strictFirstAndLastChars",
  "w:noLineBreaksAfter",
  "w:noLineBreaksBefore",
  "w:updateFields",
  "w:hdrShapeDefaults",
  "w:footnotePr",
  "w:endnotePr",
  "w:compat",
  "m:mathPr",
  "w:themeFontLang",
  "w:clrSchemeMapping",
  "w:doNotIncludeSubdocsInStats",
  "w:doNotAutoCompressPictures",
  "w:shapeDefaults",
  "w:decimalSymbol",
  "w:listSeparator",
  "w:defaultTableStyle",
  "w:styleLockTheme",
  "w:styleLockQFSet",
  "w:doNotTrackMoves",
  "w:doNotTrackFormatting",
  "w:autoFormatOverride",
  "w14:defaultImageDpi",
  "w14:discardImageEditingData",
  "w15:chartTrackingRefBased",
]);

const FIELD = /^\s*DOCPROPERTY\s+(?:"([^"]*)"|([^\s\\]+))/i;
/** Elements whose content is gone from the agent's file: a field there shows nothing. */
const GOING = new Set(["w:del", "w:ins", "w:moveFrom"]);

/**
 * What each custom property's field shows, by the property's name in lower case: the first such
 * field's result, read where the text stays.
 */
function readShown(root: XmlElement, shown: Map<string, string>): void {
  const keep = (element: XmlElement) => !GOING.has(element.name);
  const show = (instruction: string, result: string) => {
    const match = FIELD.exec(instruction);
    const name = (match?.[1] ?? match?.[2] ?? "").trim().toLowerCase();
    if (name && !shown.has(name)) shown.set(name, result);
  };
  const open: { instruction: string; result: string; separated: boolean }[] = [];
  for (const element of walk(root, keep)) {
    if (GOING.has(element.name)) continue;
    if (element.name === "w:fldSimple") {
      show(
        element.attrs["w:instr"] ?? "",
        [...walk(element, keep)]
          .filter((each) => each.name === "w:t")
          .map(textOf)
          .join(""),
      );
    } else if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      const top = open.at(-1);
      if (type === "begin") open.push({ instruction: "", result: "", separated: false });
      else if (type === "separate" && top) top.separated = true;
      else if (type === "end" && top) {
        open.pop();
        show(top.instruction, top.result);
      }
    } else if (element.name === "w:instrText") {
      const top = open.at(-1);
      if (top && !top.separated) top.instruction += textOf(element);
    } else if (element.name === "w:t") {
      for (const each of open) if (each.separated) each.result += textOf(element);
    }
  }
}

interface Listed {
  element: XmlElement;
  id: string;
  kind: string;
  target: string;
  external: boolean;
}

/** What the agent's file is: written, with every text and link it holds to be checked, or unkept. */
export type AgentWordFile =
  | {
      kind: "written";
      data: Uint8Array;
      /** Every text each kept part shows or holds. */
      texts: { part: string; texts: string[] }[];
      /** Every link outside the file, by the part that holds it. */
      links: { part: string; target: string }[];
    }
  | { kind: "unkept"; part: string; why: string };

export interface ForAgentOptions {
  /** Headers and footers whose Blocks the User deleted from the Note: the file has them no more. */
  furniture: readonly ("header" | "footer")[];
}

const removal = (element: XmlElement): Splice => ({
  from: startOf(element),
  to: endOf(element),
  text: "",
});

const parsedOrUnkept = (text: string): XmlElement => {
  try {
    return parseXml(text);
  } catch {
    throw new UnkeptPart("it isn't XML");
  }
};

/**
 * The Word file `data`, written by Export › Word into the file a Note came from, with only what
 * an outside agent was given of it; or why it can't be.
 */
export async function forAgent(data: Uint8Array, options: ForAgentOptions): Promise<AgentWordFile> {
  let at = "";
  try {
    return await cleaned(data, options, (part) => {
      at = part;
    });
  } catch (error) {
    if (error instanceof UnkeptPart) return { kind: "unkept", part: at, why: error.message };
    return { kind: "unkept", part: at, why: "it couldn't be cleaned" };
  }
}

async function cleaned(
  data: Uint8Array,
  options: ForAgentOptions,
  at: (part: string) => void,
): Promise<AgentWordFile> {
  const zip = openPackage(data);
  const writer = new PackageWriter(zip);
  const names = zip.names().filter((name) => !name.endsWith("/"));

  at("[Content_Types].xml");
  const types = await writer.part("[Content_Types].xml");
  if (!types) throw new UnkeptPart("no content types");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const each of elements(types.root)) {
    const type = each.attrs.ContentType ?? "";
    if (local(each.name) === "Default") {
      defaults.set((each.attrs.Extension ?? "").toLowerCase(), type);
    } else if (local(each.name) === "Override") {
      overrides.set((each.attrs.PartName ?? "").toLowerCase(), type);
    }
  }
  const typeOf = (name: string) =>
    overrides.get(`/${name}`.toLowerCase()) ??
    defaults.get(name.slice(name.lastIndexOf(".") + 1).toLowerCase()) ??
    "";

  const listed = new Map<string, Listed[]>();
  for (const name of names) {
    const match = /^(.*?)_rels\/([^/]*)\.rels$/.exec(name);
    if (!match) continue;
    at(name);
    const owner = `${match[1]}${match[2]}`;
    const part = await writer.part(name);
    listed.set(
      owner,
      (part ? elements(part.root) : []).flatMap((element) => {
        const { Id: id = "", Type: type = "", Target: target, TargetMode: mode } = element.attrs;
        if (target === undefined) return [];
        const external = mode === "External";
        return [
          {
            element,
            id,
            kind: kindOf(type),
            external,
            target: external ? target : resolvePart(owner, target),
          },
        ];
      }),
    );
  }
  const main = listed.get("")?.find((each) => each.kind === MAIN && !each.external)?.target;
  if (main === undefined) throw new UnkeptPart("no document");

  const dropped = new Set<XmlElement>();
  for (const [owner, relationships] of listed) {
    for (const each of relationships) {
      const furniture = owner === main && options.furniture.some((kind) => kind === each.kind);
      const kept = each.external
        ? each.kind === "hyperlink" && isWebLink(each.target)
        : KEPT.has(each.kind);
      if (!kept || furniture) dropped.add(each.element);
    }
  }
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
  const kindsOf = (name: string) =>
    [...listed.values()]
      .flat()
      .filter((each) => !each.external && !dropped.has(each.element) && each.target === name)
      .map((each) => each.kind);
  const ofKind = (kind: string) =>
    listed
      .get("")
      ?.find((each) => each.kind === kind && !each.external && !dropped.has(each.element))?.target;
  const properties = new Set(
    ["core-properties", "extended-properties", "custom-properties"].flatMap(
      (kind) => ofKind(kind) ?? [],
    ),
  );

  // The parts to clean, by the kinds that reach them and their content types, whatever their names.
  const texts = new Map<string, { text: string; root: XmlElement }>();
  for (const name of reachable()) {
    if (name === "" || properties.has(name)) continue;
    at(name);
    const kinds = kindsOf(name);
    const type = typeOf(name);
    if (kinds.every((kind) => BINARY.has(kind))) {
      if (!BINARY_TYPES.some((allowed) => allowed.test(type))) {
        throw new UnkeptPart(`a picture or file of the type ${type || "none"}`);
      }
      continue;
    }
    if (!/[+/]xml$/.test(type)) throw new UnkeptPart(`a part of the type ${type || "none"}`);
    const text = await writer.text(name);
    if (text === null) throw new UnkeptPart("it isn't in the package");
    const root = parsedOrUnkept(text);
    checkNamespaces(root);
    texts.set(name, { text, root });
  }

  const shown = new Map<string, string>();
  for (const { root } of texts.values()) readShown(root, shown);
  const custom = listed
    .get("")
    ?.find((each) => each.kind === "custom-properties" && !dropped.has(each.element));
  const customPart = custom ? await writer.part(custom.target) : null;
  const customKept = customPart
    ? elements(customPart.root).filter((each) => shown.has((each.attrs.name ?? "").toLowerCase()))
    : [];
  if (custom && customKept.length === 0) dropped.add(custom.element);

  const settings = listed
    .get(main)
    ?.find((each) => each.kind === "settings" && !dropped.has(each.element))?.target;
  const finals = new Map<string, { text: string; root: XmlElement }>();
  for (const [name, { text, root }] of texts) {
    at(name);
    const gone = new Set(
      (listed.get(name) ?? []).filter((each) => dropped.has(each.element)).map((each) => each.id),
    );
    const also =
      name === settings ? elements(root).filter((each) => !SETTINGS_KEPT.has(each.name)) : [];
    const once = applySplices(text, partSplices(root, text, gone, also));
    const linked = parsedOrUnkept(once);
    const twice = applySplices(once, emptyLinks(linked));
    const final = parsedOrUnkept(twice);
    const left = leftIn(final);
    if (left !== null) throw new UnkeptPart(`${left} stays`);
    finals.set(name, { text: twice, root: final });
  }

  // A relationship nothing in its part names any more goes, and with it what only it reached.
  for (const [name, { root }] of finals) {
    const named = referenced(root);
    for (const each of listed.get(name) ?? []) {
      if (!IMPLICIT.has(each.kind) && !named.has(each.id)) dropped.add(each.element);
    }
  }
  const reached = reachable();

  for (const [name, { text }] of finals) {
    if (reached.has(name) && text !== texts.get(name)?.text) writer.set(name, text);
  }

  const splice = async (
    name: string,
    made: (part: { text: string; root: XmlElement }) => Splice[],
  ) => {
    at(name);
    const part = await writer.part(name);
    if (!part) return;
    const splices = made(part);
    if (splices.length > 0) writer.set(name, applySplices(part.text, splices));
  };
  const isRelationships = (name: string) => /(^|\/)_rels\/[^/]*\.rels$/.test(name);
  const keptRelationships = new Set([...reached].map(relationshipsPartOf));
  keptRelationships.add("_rels/.rels");
  const removed = names.filter(
    (name) =>
      name !== "[Content_Types].xml" &&
      !reached.has(name) &&
      !(isRelationships(name) && keptRelationships.has(name)),
  );
  for (const [owner, relationships] of listed) {
    const name = relationshipsPartOf(owner);
    if (!keptRelationships.has(name)) continue;
    await splice(name, () =>
      relationships
        .filter((each) => dropped.has(each.element))
        .map((each) => removal(each.element)),
    );
  }
  const gone = new Set(removed.map((name) => `/${name}`.toLowerCase()));
  await splice("[Content_Types].xml", ({ root }) =>
    elements(root)
      .filter(
        (each) =>
          local(each.name) === "Override" && gone.has((each.attrs.PartName ?? "").toLowerCase()),
      )
      .map(removal),
  );

  const core = ofKind("core-properties");
  if (core && reached.has(core)) {
    await splice(core, ({ root }) =>
      elements(root)
        .filter((each) => !CORE_KEPT.has(local(each.name)))
        .map(removal),
    );
  }
  const extended = ofKind("extended-properties");
  if (extended && reached.has(extended)) {
    await splice(extended, ({ root }) =>
      elements(root)
        .filter((each) => !APP_KEPT.has(local(each.name)))
        .map(removal),
    );
  }
  if (custom && customPart && reached.has(custom.target)) {
    await splice(custom.target, ({ root, text }) =>
      elements(root).map((each) => {
        const value = shown.get((each.attrs.name ?? "").toLowerCase());
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
  at("");
  return {
    kind: "written",
    data: await writer.write(deflateRawSync, checkWellFormed),
    texts: [...finals]
      .filter(([name]) => reached.has(name))
      .map(([part, { root }]) => ({ part, texts: textsOf(root) })),
    links: [...listed]
      .filter(([owner]) => reached.has(owner))
      .flatMap(([part, relationships]) =>
        relationships
          .filter((each) => each.external && !dropped.has(each.element))
          .map((each) => ({ part, target: each.target })),
      ),
  };
}

/** Every text a Word file IncarnaMind wrote new shows, in every part: what the Note says in it. */
export async function textsOfFile(data: Uint8Array): Promise<string[]> {
  const zip = openPackage(data);
  const texts: string[] = [];
  for (const name of zip.names()) {
    if (!name.endsWith(".xml")) continue;
    const text = await zip.readText(name);
    if (text !== undefined) texts.push(...textsOf(parseXml(text)));
  }
  return texts;
}
