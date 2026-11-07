/**
 * The parts of an Office package (a Word file, a deck, a workbook) where its
 * relationships say they are (ECMA-376 Part 2), rather than at their usual
 * names: an editor may save the main part as `word/document2.xml` (#2620).
 * Pure, as the viewer reads with it too.
 *
 * `relationshipsOf` throws when a part's relationships can't be read, for a
 * reader that refuses such a file (the Word import). `OfficePackage` is for a
 * reader that goes on without them (indexing, previews): it keeps the names
 * of the relationships parts it couldn't read, for its caller to log.
 */
import { ExtractionError } from "./errors";
import { elements, local, parseXml, type XmlElement } from "./xml";
import { PartTooLargeError, resolvePart, type ZipArchive } from "./zip";

/** An internal target as the part name it resolves to; an external one (a hyperlink) as written. */
export interface Relationship {
  target: string;
  type: string;
  external: boolean;
}

export type Relationships = ReadonlyMap<string, Relationship>;

/** Where a part's relationships are kept: "word/document.xml" → "word/_rels/document.xml.rels"; "" → "_rels/.rels". */
export function relationshipsPartOf(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/**
 * A part's relationships by id ("" for the package's own); none when it has no
 * relationships part. One that can't be read throws an `ExtractionError` naming it.
 */
export async function relationshipsOf(
  zip: ZipArchive,
  part: string,
): Promise<Map<string, Relationship>> {
  const name = relationshipsPartOf(part);
  if (!zip.has(name)) return new Map();
  try {
    return parseRelationships(await zip.readText(name), part);
  } catch (error) {
    // The Word import refuses a part too large to read as too large, not as damaged.
    if (error instanceof PartTooLargeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof ExtractionError ? error.reason : "unreadable";
    throw new ExtractionError(reason, `${name}: ${message}`);
  }
}

/** The relationships a relationships part's XML lists, for the part they belong to. */
export function parseRelationships(
  xml: string | undefined,
  part: string,
): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  for (const rel of xml ? elements(parseXml(xml)) : []) {
    const { Id: id, Target: target, TargetMode: mode, Type: type = "" } = rel.attrs;
    const external = mode === "External";
    // An empty internal target names no part, and would hide the part's usual name.
    if (!id || target === undefined || (!external && target === "")) continue;
    rels.set(id, { target: external ? target : resolvePart(part, target), type, external });
  }
  return rels;
}

/** The first relationship to a part of the package whose type ends with `type` ("/styles"). */
export function relationshipOfType(rels: Relationships, type: string): Relationship | undefined {
  for (const rel of rels.values()) if (!rel.external && rel.type.endsWith(type)) return rel;
  return undefined;
}

/** The part a relationship of `type` names, else the part's usual name. */
export const partOfType = (rels: Relationships, type: string, usual: string): string =>
  relationshipOfType(rels, type)?.target ?? usual;

export const MAIN_DOCUMENT = "/officeDocument";

/**
 * A main part's root element, whose local name must be `name`: the main part
 * a relationship names can be of another kind (a workbook renamed .pptx), so
 * the root, not the part's name, says what the file is.
 */
export function mainRootOf(
  xml: string | undefined,
  part: string,
  name: string,
  notOfKind: string,
): XmlElement {
  if (xml === undefined)
    throw new ExtractionError("unreadable", `${notOfKind}: it has no ${part}.`);
  const root = parseXml(xml);
  if (local(root.name) !== name) {
    throw new ExtractionError("unreadable", `${notOfKind}: ${part} is a ${local(root.name)}.`);
  }
  return root;
}

export class OfficePackage {
  /** The relationships parts that couldn't be read, in the order they were asked for. */
  readonly unreadable: string[] = [];
  private readonly read = new Map<string, Map<string, Relationship>>();

  constructor(readonly zip: ZipArchive) {}

  /** A part's relationships; none, and the part kept in `unreadable`, when they can't be read. */
  async relationships(part: string): Promise<Map<string, Relationship>> {
    const known = this.read.get(part);
    if (known) return known;
    let rels: Map<string, Relationship>;
    try {
      rels = await relationshipsOf(this.zip, part);
    } catch {
      rels = new Map();
      this.unreadable.push(relationshipsPartOf(part));
    }
    this.read.set(part, rels);
    return rels;
  }

  /** Only those to parts of the package: a deck's or a workbook's links are never followed. */
  async internalRelationships(part: string): Promise<Map<string, Relationship>> {
    const rels = new Map(await this.relationships(part));
    for (const [id, rel] of rels) if (rel.external) rels.delete(id);
    return rels;
  }

  /** The main part: the package's main-document relationship's target, else its usual name. */
  async mainPart(usual: string): Promise<string> {
    return partOfType(await this.relationships(""), MAIN_DOCUMENT, usual);
  }
}
