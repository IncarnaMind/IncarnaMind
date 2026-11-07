/**
 * The package a Word export writes into (#105): the stored original, whose
 * entries are copied as they are, compressed bytes and all, unless a part is
 * changed; changed parts are spliced into their own text (./text), and new
 * ones added. Relationships and content types are added the same way, so a
 * part's existing ones keep their bytes.
 */

import { decodePart } from "../../documents/formats/docxImport";
import { relationshipsPartOf } from "../../documents/formats/officePackage";
import { descendants, parseXml, type XmlElement } from "../../documents/formats/xml";
import {
  type Deflate,
  resolvePart,
  writeZip,
  type ZipArchive,
  type ZipWriteEntry,
} from "../../documents/formats/zip";
import {
  COMMENTS_CONTENT_TYPE,
  COMMENTS_EXTENDED_CONTENT_TYPE,
  COMMENTS_EXTENDED_RELATIONSHIP,
  COMMENTS_RELATIONSHIP,
  escapeXml,
} from "../wordml";
import { appendInside, applySplices } from "./text";

/** A part that couldn't be written into: export stops and names it. */
export class WordPartError extends Error {
  override name = "WordPartError";
  constructor(
    readonly part: string,
    message: string,
  ) {
    super(`${part}: ${message}`);
  }
}

export const RELATIONSHIP_TYPES = {
  footnotes: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
  numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  comments: COMMENTS_RELATIONSHIP,
  commentsExtended: COMMENTS_EXTENDED_RELATIONSHIP,
} as const;

const WORDPROCESSING = "application/vnd.openxmlformats-officedocument.wordprocessingml";
export const CONTENT_TYPES = {
  footnotes: `${WORDPROCESSING}.footnotes+xml`,
  numbering: `${WORDPROCESSING}.numbering+xml`,
  styles: `${WORDPROCESSING}.styles+xml`,
  comments: COMMENTS_CONTENT_TYPE,
  commentsExtended: COMMENTS_EXTENDED_CONTENT_TYPE,
} as const;

const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_PART = "[Content_Types].xml";

/** A part's text as stored and its root element, with offsets into that text. */
export interface PartText {
  text: string;
  root: XmlElement;
}

export class WordPackageWriter {
  private readonly read = new Map<string, PartText>();
  private readonly texts = new Map<string, string>();
  private readonly changed = new Map<string, string>();
  private readonly added = new Map<string, string | Uint8Array>();
  private readonly relationships = new Map<string, PartRelationships>();
  /** Defaults and overrides to add to [Content_Types].xml. */
  private contentTypes: string[] = [];

  constructor(readonly zip: ZipArchive) {}

  has(part: string): boolean {
    return this.zip.has(part) || this.added.has(part);
  }

  /** The part as it is now (changed, if it was), parsed; null if there is no such part. */
  async part(name: string): Promise<PartText | null> {
    const changed = this.changed.get(name);
    if (changed !== undefined) return { text: changed, root: parsed(name, changed) };
    const known = this.read.get(name);
    if (known) return known;
    const added = this.added.get(name);
    if (typeof added === "string") return { text: added, root: parsed(name, added) };
    const text = await this.text(name);
    if (text === null) return null;
    const part = { text, root: parsed(name, text) };
    this.read.set(name, part);
    return part;
  }

  /** A stored part's text, without parsing it; null if there is no such part. */
  async text(name: string): Promise<string | null> {
    const known = this.read.get(name)?.text ?? this.texts.get(name);
    if (known !== undefined) return known;
    if (!this.zip.has(name)) return null;
    const bytes = await this.zip.read(name);
    if (!bytes) return null;
    const text = decodePart(bytes);
    // Only text that encodes back to the same bytes can be spliced without changing the rest.
    if (!sameBytes(new TextEncoder().encode(text), bytes)) {
      throw new WordPartError(name, "isn't stored as UTF-8 text.");
    }
    this.texts.set(name, text);
    return text;
  }

  /** Replaces a part's text. */
  set(name: string, text: string): void {
    if (this.added.has(name)) this.added.set(name, text);
    else this.changed.set(name, text);
  }

  /** Adds a new part. */
  add(name: string, data: string | Uint8Array): void {
    this.added.set(name, data);
  }

  /** The parts written as new text, changed or added. */
  changedParts(): string[] {
    return [...this.changed.keys(), ...this.added.keys()];
  }

  /** A part's relationships, to read and add to. */
  async relationshipsOf(part: string): Promise<PartRelationships> {
    let relationships = this.relationships.get(part);
    if (!relationships) {
      relationships = await PartRelationships.read(this, part);
      this.relationships.set(part, relationships);
    }
    return relationships;
  }

  /** Says which content type a new part has, unless its extension already says it. */
  async addContentType(part: string, contentType: string): Promise<void> {
    const types = await this.part(CONTENT_TYPES_PART);
    if (!types) throw new WordPartError(CONTENT_TYPES_PART, "is missing.");
    const has = (name: string, test: (element: XmlElement) => boolean) =>
      descendants(types.root, name).some(test);
    const queued = this.contentTypes.some((added) =>
      added.includes(`PartName="/${escapeXml(part)}"`),
    );
    if (queued || has("Override", (each) => each.attrs.PartName === `/${part}`)) return;
    this.contentTypes.push(
      `<Override PartName="/${escapeXml(part)}" ContentType="${escapeXml(contentType)}"/>`,
    );
  }

  /** Says which content type parts with this extension have, unless the package already does. */
  async addDefaultContentType(extension: string, contentType: string): Promise<void> {
    const types = await this.part(CONTENT_TYPES_PART);
    if (!types) throw new WordPartError(CONTENT_TYPES_PART, "is missing.");
    const wanted = extension.toLowerCase();
    const known = descendants(types.root, "Default").some(
      (each) => each.attrs.Extension?.toLowerCase() === wanted,
    );
    const queued = this.contentTypes.some((added) =>
      added.includes(`Extension="${escapeXml(wanted)}"`),
    );
    if (known || queued) return;
    this.contentTypes.push(
      `<Default Extension="${escapeXml(wanted)}" ContentType="${escapeXml(contentType)}"/>`,
    );
  }

  /** A free name for a new part, "word/media/image3.png" from "word/media/image", "png". */
  freeName(stem: string, extension: string): string {
    for (let number = 1; ; number++) {
      const name = `${stem}${number}.${extension}`;
      if (!this.has(name)) return name;
    }
  }

  /**
   * The package with every change made, untouched entries copied byte for
   * byte. `check` sees each part written as text first, and may throw.
   */
  async write(deflate: Deflate, check: (name: string, text: string) => void): Promise<Uint8Array> {
    for (const relationships of this.relationships.values()) relationships.flush();
    if (this.contentTypes.length > 0) {
      const types = await this.part(CONTENT_TYPES_PART);
      if (types) {
        const added = appendInside(types.text, types.root, this.contentTypes.join(""));
        this.set(CONTENT_TYPES_PART, applySplices(types.text, [added]));
      }
      this.contentTypes = [];
    }
    for (const [name, text] of this.changed) check(name, text);
    for (const [name, data] of this.added) if (typeof data === "string") check(name, data);
    const entries: ZipWriteEntry[] = this.zip.names().map((name) => {
      const text = this.changed.get(name);
      if (text !== undefined) return { name, data: text };
      const raw = this.zip.raw(name);
      if (!raw) throw new WordPartError(name, "can't be copied.");
      return { name, raw };
    });
    for (const [name, data] of this.added) entries.push({ name, data });
    return writeZip(entries, deflate);
  }
}

function parsed(name: string, text: string): XmlElement {
  try {
    return parseXml(text);
  } catch (error) {
    throw new WordPartError(name, error instanceof Error ? error.message : String(error));
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

/** A relationship of a part: its target resolved to a part name, unless it is external. */
export interface PartRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** One part's relationships: those it has, and those added, written when the package is. */
export class PartRelationships {
  private readonly ids = new Set<string>();
  private readonly added: string[] = [];
  private next = 1;

  private constructor(
    private readonly pkg: WordPackageWriter,
    private readonly owner: string,
    private readonly part: PartText | null,
    readonly existing: readonly PartRelationship[],
  ) {
    for (const each of existing) {
      this.ids.add(each.id);
      const number = /^rId(\d+)$/.exec(each.id)?.[1];
      if (number) this.next = Math.max(this.next, Number(number) + 1);
    }
  }

  static async read(pkg: WordPackageWriter, owner: string): Promise<PartRelationships> {
    const part = await pkg.part(relationshipsPartOf(owner));
    const existing: PartRelationship[] = [];
    for (const each of part ? descendants(part.root, "Relationship") : []) {
      const { Id: id, Type: type = "", Target: target, TargetMode: mode } = each.attrs;
      if (!id || target === undefined) continue;
      const external = mode === "External";
      existing.push({ id, type, external, target: external ? target : resolvePart(owner, target) });
    }
    return new PartRelationships(pkg, owner, part, existing);
  }

  /** The first relationship of a type, if the part has one. */
  ofType(type: string): PartRelationship | undefined {
    return this.existing.find((each) => each.type === type && !each.external);
  }

  /** Adds a relationship and returns its id. `target` is relative to the owner's folder, or a URL. */
  add(type: string, target: string, external = false): string {
    let id = `rId${this.next++}`;
    while (this.ids.has(id)) id = `rId${this.next++}`;
    this.ids.add(id);
    this.added.push(
      `<Relationship Id="${id}" Type="${escapeXml(type)}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`,
    );
    return id;
  }

  /** Writes what was added into the relationships part, or makes one. */
  flush(): void {
    if (this.added.length === 0) return;
    const name = relationshipsPartOf(this.owner);
    const added = this.added.join("");
    this.added.length = 0;
    const { part } = this;
    if (part) {
      this.pkg.set(name, applySplices(part.text, [appendInside(part.text, part.root, added)]));
    } else {
      this.pkg.add(
        name,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">${added}</Relationships>`,
      );
    }
  }
}
