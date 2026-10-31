/**
 * The parts of an imported document that new content goes into (#105): its
 * styles, list numbering and footnotes, each added to only when something new
 * needs it, and the target the native writer (../docx) writes new Blocks into,
 * so a Citation is the same footnote, and a list the same Word list, whichever
 * export made it.
 */
import { elements } from "../../documents/formats/xml";
import {
  type DocxStyles,
  type DocxTarget,
  listDefinition,
  listInstance,
  NEW_DOCUMENT_STYLE_IDS,
  type NewPicture,
  PICTURE_TYPES,
  STYLE_DEFINITIONS,
  type StyleBases,
  type StyleRole,
} from "../docx";
import {
  commentsPart,
  footnotesPart,
  noteBookmark,
  W_NAMESPACE,
  WordIds,
  XML_DECLARATION,
} from "../wordml";
import {
  CONTENT_TYPES,
  type PartRelationships,
  type PartText,
  RELATIONSHIP_TYPES,
  type WordPackageWriter,
  WordPartError,
} from "./package";
import {
  appendInside,
  applySplices,
  closeTag,
  endOf,
  type Splice,
  selfClosing,
  startOf,
} from "./text";

/** A part's name relative to the folder of the document part: "word/styles.xml" → "styles.xml". */
const relativeTo = (owner: string, part: string) => {
  const folder = owner.slice(0, owner.lastIndexOf("/") + 1);
  return part.startsWith(folder) ? part.slice(folder.length) : `/${part}`;
};

// ---------------------------------------------------------------------------
// Styles

interface KnownStyle {
  id: string;
  type: string;
}

/** The document's styles, found by Word's names for them, and those added. */
export class DocumentStyles {
  private readonly byName = new Map<string, KnownStyle>();
  private readonly ids = new Set<string>();
  private readonly added: string[] = [];
  private readonly chosen = new Map<StyleRole, string>();
  readonly bases: StyleBases;

  private constructor(
    private readonly pkg: WordPackageWriter,
    private readonly document: string,
    private readonly relationships: PartRelationships,
    private readonly name: string,
    private readonly part: PartText | null,
  ) {
    const defaults: StyleBases = { paragraph: null, character: null, table: null };
    for (const style of part ? elements(part.root) : []) {
      if (style.name !== "w:style") continue;
      const id = style.attrs["w:styleId"];
      const type = style.attrs["w:type"] ?? "paragraph";
      if (!id) continue;
      this.ids.add(id);
      const name = elements(style).find((each) => each.name === "w:name")?.attrs["w:val"];
      if (name && !this.byName.has(`${type}:${name.toLowerCase()}`)) {
        this.byName.set(`${type}:${name.toLowerCase()}`, { id, type });
      }
      const isDefault = style.attrs["w:default"] === "1" || style.attrs["w:default"] === "true";
      if (isDefault && (type === "paragraph" || type === "character" || type === "table")) {
        defaults[type] ??= id;
      }
    }
    this.bases = defaults;
  }

  static async read(
    pkg: WordPackageWriter,
    document: string,
    relationships: PartRelationships,
  ): Promise<DocumentStyles> {
    const name = relationships.ofType(RELATIONSHIP_TYPES.styles)?.target ?? null;
    const part = name ? await pkg.part(name) : null;
    return new DocumentStyles(pkg, document, relationships, name ?? "word/styles.xml", part);
  }

  /** The id of an existing style, by its type and Word's name for it; null if there is none. */
  find(type: string, name: string): string | null {
    return this.byName.get(`${type}:${name.toLowerCase()}`)?.id ?? null;
  }

  /** The id of the style for a role: the document's own, else one added with the export's definition. */
  id(role: StyleRole): string {
    const known = this.chosen.get(role);
    if (known) return known;
    const definition = STYLE_DEFINITIONS[role];
    let id = this.find(definition.type, definition.name);
    if (!id) {
      const wanted = NEW_DOCUMENT_STYLE_IDS[role];
      id = wanted;
      for (let number = 2; this.ids.has(id); number++) id = `${wanted}${number}`;
      this.ids.add(id);
      this.added.push(definition.xml(id, this.bases));
    }
    this.chosen.set(role, id);
    return id;
  }

  /** The styles the native writer writes in, each added only when it is used. */
  forWriter(): DocxStyles {
    const id = (role: StyleRole) => this.id(role);
    return {
      heading: (level) => id(`heading${Math.min(Math.max(level, 1), 6)}` as StyleRole),
      get quote() {
        return id("quote");
      },
      get question() {
        return id("question");
      },
      get listParagraph() {
        return id("listParagraph");
      },
      get code() {
        return id("code");
      },
      get codeChar() {
        return id("codeChar");
      },
      get math() {
        return id("math");
      },
      get caption() {
        return id("caption");
      },
      get hyperlink() {
        return id("hyperlink");
      },
      get tableGrid() {
        return id("tableGrid");
      },
      footnote: {
        get text() {
          return id("footnoteText");
        },
        get reference() {
          return id("footnoteReference");
        },
      },
      comment: {
        get text() {
          return id("commentText");
        },
        get reference() {
          return id("commentReference");
        },
      },
    };
  }

  /** Writes the styles added into the styles part, or makes one. */
  async flush(): Promise<void> {
    if (this.added.length === 0) return;
    const added = this.added.join("");
    if (this.part) {
      const { text, root } = this.part;
      this.pkg.set(this.name, applySplices(text, [appendInside(text, root, added)]));
      return;
    }
    this.pkg.add(
      this.name,
      `${XML_DECLARATION}<w:styles xmlns:w="${W_NAMESPACE}">${added}</w:styles>`,
    );
    this.relationships.add(RELATIONSHIP_TYPES.styles, relativeTo(this.document, this.name));
    await this.pkg.addContentType(this.name, CONTENT_TYPES.styles);
  }
}

// ---------------------------------------------------------------------------
// Numbering

/** The document's list numbering, and the lists added for new Blocks. */
export class DocumentNumbering {
  private readonly definitions: string[] = [];
  private readonly instances: string[] = [];
  private nextDefinition: number;
  private nextInstance: number;
  /** The definitions added for bullets and for numbers. */
  private readonly own = new Map<boolean, number>();

  private constructor(
    private readonly pkg: WordPackageWriter,
    private readonly document: string,
    private readonly relationships: PartRelationships,
    private readonly name: string,
    private readonly part: PartText | null,
  ) {
    const numbers = (name: string, attribute: string) =>
      (part ? elements(part.root) : [])
        .filter((each) => each.name === name)
        .map((each) => Number(each.attrs[attribute]))
        .filter(Number.isFinite);
    this.nextDefinition = Math.max(-1, ...numbers("w:abstractNum", "w:abstractNumId")) + 1;
    this.nextInstance = Math.max(0, ...numbers("w:num", "w:numId")) + 1;
  }

  static async read(
    pkg: WordPackageWriter,
    document: string,
    relationships: PartRelationships,
  ): Promise<DocumentNumbering> {
    const name = relationships.ofType(RELATIONSHIP_TYPES.numbering)?.target ?? null;
    const part = name ? await pkg.part(name) : null;
    return new DocumentNumbering(pkg, document, relationships, name ?? "word/numbering.xml", part);
  }

  /** A new list: its numId. Each ordered one starts at `start`. */
  list(ordered: boolean, level: number, start: number): number {
    let definition = this.own.get(ordered);
    if (definition === undefined) {
      definition = this.nextDefinition++;
      this.own.set(ordered, definition);
      this.definitions.push(listDefinition(definition, ordered));
    }
    const numId = this.nextInstance++;
    this.instances.push(listInstance(numId, definition, { ordered, level, start }));
    return numId;
  }

  /**
   * Writes the lists added: definitions after the document's (they must all
   * come before any list), lists after its lists.
   */
  async flush(): Promise<void> {
    if (this.instances.length === 0) return;
    const definitions = this.definitions.join("");
    const instances = this.instances.join("");
    if (!this.part) {
      this.pkg.add(
        this.name,
        `${XML_DECLARATION}<w:numbering xmlns:w="${W_NAMESPACE}">${definitions}${instances}</w:numbering>`,
      );
      this.relationships.add(RELATIONSHIP_TYPES.numbering, relativeTo(this.document, this.name));
      await this.pkg.addContentType(this.name, CONTENT_TYPES.numbering);
      return;
    }
    const { text, root } = this.part;
    if (selfClosing(root)) {
      this.pkg.set(
        this.name,
        applySplices(text, [appendInside(text, root, definitions + instances)]),
      );
      return;
    }
    const children = elements(root);
    const lastDefinition = children.filter((each) => each.name === "w:abstractNum").at(-1);
    const firstInstance = children.find((each) => each.name === "w:num");
    const lastInstance = children.filter((each) => each.name === "w:num").at(-1);
    const cleanup = children.find((each) => each.name === "w:numIdMacAtCleanup");
    const end = endOf(root) - closeTag(root).length;
    const definitionsAt = lastDefinition
      ? endOf(lastDefinition)
      : firstInstance
        ? startOf(firstInstance)
        : cleanup
          ? startOf(cleanup)
          : end;
    const instancesAt = lastInstance ? endOf(lastInstance) : cleanup ? startOf(cleanup) : end;
    const splices: Splice[] =
      definitionsAt === instancesAt
        ? [{ from: definitionsAt, to: definitionsAt, text: definitions + instances }]
        : [
            { from: definitionsAt, to: definitionsAt, text: definitions },
            { from: instancesAt, to: instancesAt, text: instances },
          ];
    this.pkg.set(this.name, applySplices(text, splices));
  }
}

// ---------------------------------------------------------------------------
// Footnotes

/** The document's footnotes part, and the footnotes added for new Citations. */
export class DocumentFootnotes {
  private readonly added: string[] = [];
  private readonly edits: Splice[] = [];

  private constructor(
    private readonly pkg: WordPackageWriter,
    private readonly document: string,
    private readonly relationships: PartRelationships,
    readonly name: string,
    private readonly part: PartText | null,
  ) {}

  static async read(
    pkg: WordPackageWriter,
    document: string,
    relationships: PartRelationships,
  ): Promise<DocumentFootnotes> {
    const known = relationships.ofType(RELATIONSHIP_TYPES.footnotes)?.target ?? null;
    const part = known ? await pkg.part(known) : null;
    const name =
      known ??
      (pkg.has("word/footnotes.xml")
        ? pkg.freeName("word/footnotes", "xml")
        : "word/footnotes.xml");
    return new DocumentFootnotes(pkg, document, relationships, name, part);
  }

  /** Reserves the ids the document's footnotes (and their separators) have. */
  reserveIds(ids: WordIds): void {
    for (const note of this.part ? elements(this.part.root) : []) {
      const id = Number(note.attrs["w:id"]);
      if (Number.isInteger(id)) ids.reserve("footnote", id);
    }
  }

  add(footnotes: readonly string[]): void {
    this.added.push(...footnotes);
  }

  /** Changes to the footnotes the part has (#746), made to its text as `text` read it. */
  edit(text: string, splices: readonly Splice[]): void {
    if (splices.length === 0) return;
    if (this.part?.text !== text) {
      throw new WordPartError(this.name, "changed while its footnotes were written.");
    }
    this.edits.push(...splices);
  }

  /** Writes the footnotes added into the footnotes part, or makes one with Word's separators. */
  async flush(): Promise<void> {
    if (this.added.length === 0 && this.edits.length === 0) return;
    if (this.part) {
      const { text, root } = this.part;
      const added = this.added.length > 0 ? [appendInside(text, root, this.added.join(""))] : [];
      this.pkg.set(this.name, applySplices(text, [...this.edits, ...added]));
      return;
    }
    this.pkg.add(this.name, footnotesPart(this.added));
    this.relationships.add(RELATIONSHIP_TYPES.footnotes, relativeTo(this.document, this.name));
    await this.pkg.addContentType(this.name, CONTENT_TYPES.footnotes);
  }
}

// ---------------------------------------------------------------------------
// Comments

/** The document's comments part, and IncarnaMind's comments added (#107). */
export class DocumentComments {
  private constructor(
    private readonly pkg: WordPackageWriter,
    private readonly document: string,
    private readonly relationships: PartRelationships,
    private readonly name: string,
    private readonly part: PartText | null,
  ) {}

  static async read(
    pkg: WordPackageWriter,
    document: string,
    relationships: PartRelationships,
  ): Promise<DocumentComments> {
    const known = relationships.ofType(RELATIONSHIP_TYPES.comments)?.target ?? null;
    const part = known ? await pkg.part(known) : null;
    const name =
      known ??
      (pkg.has("word/comments.xml") ? pkg.freeName("word/comments", "xml") : "word/comments.xml");
    return new DocumentComments(pkg, document, relationships, name, part);
  }

  /** Writes the comments added after the document's own, or makes the part. */
  async flush(comments: readonly string[]): Promise<void> {
    if (comments.length === 0) return;
    if (this.part) {
      const { text, root } = this.part;
      this.pkg.set(this.name, applySplices(text, [appendInside(text, root, comments.join(""))]));
      return;
    }
    this.pkg.add(this.name, commentsPart(comments));
    this.relationships.add(RELATIONSHIP_TYPES.comments, relativeTo(this.document, this.name));
    await this.pkg.addContentType(this.name, CONTENT_TYPES.comments);
  }
}

// ---------------------------------------------------------------------------
// Ids

/** The parts whose drawings share one set of ids with the main document's. */
const STORY_PART = /^word\/(?:document\d*|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

/**
 * Reserves the ids the document's drawings have, so a new picture's is its
 * own, and every `w:id` its stories have (their changes, comments and
 * bookmarks), so a new tracked change's or comment's is its own.
 */
export async function reserveIds(
  pkg: WordPackageWriter,
  ids: WordIds,
  bookmarks: Set<string>,
): Promise<void> {
  for (const name of pkg.zip.names()) {
    if (!STORY_PART.test(name)) continue;
    const text = (await pkg.text(name)) ?? "";
    for (const match of text.matchAll(/<(?:[\w.-]+:)?docPr\b[^>]*?\sid\s*=\s*"(\d+)"/g)) {
      ids.reserve("drawing", Number(match[1]));
    }
    for (const match of text.matchAll(/\bw:id\s*=\s*"(-?\d+)"/g)) {
      ids.reserve("annotation", Number(match[1]));
    }
    for (const match of text.matchAll(/<w:bookmarkStart\b[^>]*\bw:name="([^"]+)"/g))
      bookmarks.add(match[1] ?? "");
  }
}

// ---------------------------------------------------------------------------
// The target

/** An imported document as the native writer's target: new Blocks go into its own parts. */
export class PatchTarget implements DocxTarget {
  readonly ids = new WordIds();
  readonly styles: DocxStyles;
  private readonly links = new Map<string, string>();
  private readonly noteLinks = new Map<string, string>();
  private readonly bookmarkNames = new Set<string>();
  private readonly noteBookmarks = new Map<number, string>();
  private readonly contentTypes: Promise<void>[] = [];

  constructor(
    private readonly pkg: WordPackageWriter,
    private readonly document: string,
    private readonly relationships: PartRelationships,
    /** The footnotes part's: links in footnotes are its own. */
    private readonly noteRelationships: PartRelationships,
    readonly documentStyles: DocumentStyles,
    private readonly numbering: DocumentNumbering,
  ) {
    this.styles = documentStyles.forWriter();
  }

  link(href: string, inNote: boolean): string {
    const known = inNote ? this.noteLinks : this.links;
    let id = known.get(href);
    if (!id) {
      const relationships = inNote ? this.noteRelationships : this.relationships;
      id = relationships.add(RELATIONSHIP_TYPES.hyperlink, href, true);
      known.set(href, id);
    }
    return id;
  }

  picture(picture: NewPicture): { id: string; name: string } {
    const folder = this.document.slice(0, this.document.lastIndexOf("/") + 1);
    const part = this.pkg.freeName(`${folder}media/image`, picture.extension);
    this.pkg.add(part, picture.data);
    this.contentTypes.push(
      this.pkg.addDefaultContentType(picture.extension, PICTURE_TYPES[picture.extension]),
    );
    const name = part.slice(part.lastIndexOf("/") + 1);
    return { id: this.relationships.add(RELATIONSHIP_TYPES.image, `media/${name}`), name };
  }

  list(ordered: boolean, level: number, start: number): number {
    return this.numbering.list(ordered, level, start);
  }

  /** A note's bookmark, named so it can't resolve to one the file already has. */
  noteBookmark(note: number): string {
    const known = this.noteBookmarks.get(note);
    if (known) return known;
    let name = noteBookmark(note);
    for (let again = 2; this.bookmarkNames.has(name); again++)
      name = `${noteBookmark(note)}_${again}`;
    this.bookmarkNames.add(name);
    this.noteBookmarks.set(note, name);
    return name;
  }

  /** The bookmark names the file's parts have, which a note's must not take. */
  reserveBookmarks(names: Iterable<string>): void {
    for (const name of names) this.bookmarkNames.add(name);
  }

  async flush(): Promise<void> {
    await Promise.all(this.contentTypes);
    await this.documentStyles.flush();
    await this.numbering.flush();
  }
}
