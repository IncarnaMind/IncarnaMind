/**
 * The core properties of an Office package (.docx, .pptx, .xlsx): the part
 * the package's relationships name, usually docProps/core.xml: its creation
 * date (#53), its title (#213), its author and language for its reference
 * record (#286), and its modified date, which only a check of a sentence about
 * the file reads (#2458).
 */
import { parseRelationships, partOfType } from "./officePackage";
import { child, parseXml, textOf } from "./xml";
import { openPackage } from "./zip";

/**
 * The end of the relationship type that names the part: writers use the
 * package namespace (…/package/2006/relationships/…), the officeDocument
 * one, or Strict's.
 */
const CORE_PROPERTIES = "/metadata/core-properties";

/** The part's usual place, for a package whose relationships don't say. */
const DEFAULT_PART = "docProps/core.xml";

/** The core properties part is a few hundred bytes: more than this isn't one. */
const MAX_BYTES = 1024 * 1024;

/** What an Office package's core properties say, as written. */
export interface OfficeProperties {
  /** dcterms:created. */
  created: string | null;
  /** dcterms:modified. */
  modified: string | null;
  /** dc:title. */
  title: string | null;
  /** dc:creator: the author, as the person who made the file set it (or their computer did). */
  creator: string | null;
  /** dc:language. */
  language: string | null;
}

/** The package's core properties as written, each null if absent. */
export async function officeProperties(bytes: Uint8Array): Promise<OfficeProperties> {
  const zip = openPackage(bytes);
  const rels = parseRelationships(await zip.readText("_rels/.rels", MAX_BYTES), "");
  const xml = await zip.readText(partOfType(rels, CORE_PROPERTIES, DEFAULT_PART), MAX_BYTES);
  if (xml === undefined) {
    return { created: null, modified: null, title: null, creator: null, language: null };
  }
  const root = parseXml(xml);
  const property = (name: string) => {
    const element = child(root, name);
    return element ? textOf(element).trim() : null;
  };
  return {
    created: property("created"),
    modified: property("modified"),
    title: property("title"),
    creator: property("creator"),
    language: property("language"),
  };
}
