/**
 * A Mind used as a source (#335): a snapshot of it saved as a Document marked
 * "Your note", in the Mind's Folder, which Citations can point at and checks
 * can use. It is a copy, never a live link: the file is the Document's own, so
 * edits to the Mind leave what was cited as it was. Updating the snapshot
 * writes over that file, which the Document reads as a new version: the text
 * of the version a Citation quotes stays for that Citation (ADR-0010, #79).
 *
 * A Mind's own snapshot is never evidence for that Mind (see ./documents/evidence).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatDate, formatTime } from "../shared/dates";
import { translate } from "../shared/i18n";
import { mindName } from "../shared/naming";
import type { Document, Mind, MindSourceUpdate } from "./api";
import { hashBytes } from "./documents/files";
import type { SnapshotFile } from "./documents/web";
import { writeWholeFile } from "./documents/writeWhole";
import { NotFoundError } from "./errors";
import { exportLabels } from "./exports/labels";
import { renderMarkdown } from "./exports/markdown";
import type { Language } from "./language";
import type { MindContent } from "./mindContent";
import { type Block, type Inline, readBlocks } from "./mindText";

export interface MindSourcesDependencies {
  dataDir: string;
  now(): string;
  language(): Language;
  minds: { get(mindId: string): Mind };
  content: Pick<MindContent, "read">;
  documents: {
    yourNoteDocument(mindId: string): Document | null;
    addYourNote(id: string, name: string, file: SnapshotFile, mindId: string): Document;
    get(id: string): Document;
    checkNow(path: string): Promise<void>;
    rename(id: string, name: string): Document;
    setYourNoteAt(id: string, at: string): Document;
    announce(id: string): void;
    contentHashInUse(contentHash: string, exceptDocumentId: string | null): boolean;
  };
  /** Files a new Document in the Mind's Folder. */
  assign(documentId: string, folderId: string): void;
  /** Sends a Document to Recently deleted, as any delete does. */
  removeDocument(documentId: string): void;
}

/** Where a snapshot's file is, in the data folder: one file a Document, written over on each update. */
const snapshotPath = (dataDir: string, documentId: string) =>
  join(dataDir, "Notes", `${documentId}.md`);

const textOf = (content: readonly Inline[]): string =>
  content.flatMap((inline) => (inline.kind === "text" ? [inline.text] : [])).join("");

const startsWithItsTitle = (blocks: readonly Block[], title: string): boolean => {
  const first = blocks.find((block) =>
    block.kind === "paragraph" || block.kind === "heading"
      ? textOf(block.content).trim() !== ""
      : block.kind !== "rule",
  );
  return (
    first?.kind === "heading" && first.level === 1 && textOf(first.content).trim() === title.trim()
  );
};

/**
 * A Mind as the Markdown file its snapshot is: its Blocks as the Markdown
 * export writes them, without its Citations (the snapshot is its own words,
 * not what it cites), titled with the Mind's name unless its first heading
 * already is, and ending with when the snapshot was taken.
 */
export function mindSnapshotMarkdown(input: {
  name: string;
  snapshotAt: string;
  blocks: readonly Block[];
  language: Language;
}): string {
  const { name, snapshotAt, blocks, language } = input;
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const titled = startsWithItsTitle(blocks, name) ? "" : name;
  const body = renderMarkdown(titled, blocks, exportLabels(language), {
    pictures: false,
    citations: false,
  }).text.trimEnd();
  const taken = t("mindSource.fileLine", {
    date: formatDate(snapshotAt, language),
    time: formatTime(snapshotAt, language),
  });
  return `${body}\n\n${taken}\n`;
}

export function createMindSources(deps: MindSourcesDependencies) {
  const { dataDir, now, documents } = deps;

  const blocksOf = (mindId: string): Block[] =>
    deps.content.read(mindId, (fragment) =>
      readBlocks(fragment, {
        includeQuestions: false,
        footnote: () => ({ source: "", unverified: false }),
        trimBeforeCitation: true,
      }),
    );

  /** Its title, as a Document's name may be: a Document's name is at most 500 characters. */
  const nameOf = (mind: Mind): string =>
    (mindName(mind) || translate(deps.language(), "mind.untitled")).slice(0, 500);

  /**
   * The snapshot's words. Two Documents can't hold the same file (ADR-0003), so
   * the rare snapshot whose words and time are another's says which snapshot it is.
   */
  const markdownOf = (
    documentId: string,
    mind: Mind,
    snapshotAt: string,
    exceptDocumentId: string | null,
  ): string => {
    const markdown = mindSnapshotMarkdown({
      name: nameOf(mind),
      snapshotAt,
      blocks: blocksOf(mind.id),
      language: deps.language(),
    });
    const bytes = new TextEncoder().encode(markdown);
    if (!documents.contentHashInUse(hashBytes(bytes), exceptDocumentId)) return markdown;
    return `${markdown}\n${translate(deps.language(), "mindSource.unique", {
      code: documentId.slice(0, 8),
    })}\n`;
  };

  /** The snapshot's file, whole or not at all, dated when it was taken rather than when it was written. */
  async function writeSnapshot(
    documentId: string,
    markdown: string,
    at: string,
  ): Promise<SnapshotFile> {
    const path = snapshotPath(dataDir, documentId);
    await mkdir(join(dataDir, "Notes"), { recursive: true, mode: 0o700 });
    return writeWholeFile(path, new TextEncoder().encode(markdown), at);
  }

  async function create(mindId: string): Promise<Document> {
    const mind = deps.minds.get(mindId);
    const id = randomUUID();
    const at = now();
    const file = await writeSnapshot(id, markdownOf(id, mind, at, null), at);
    const document = documents.addYourNote(id, nameOf(mind), file, mind.id);
    if (mind.folderId !== null) deps.assign(document.id, mind.folderId);
    return documents.get(document.id);
  }

  async function update(mindId: string): Promise<MindSourceUpdate> {
    const mind = deps.minds.get(mindId);
    const document = documents.yourNoteDocument(mind.id);
    if (!document) throw new NotFoundError({ key: "error.mindSource.none" });
    const at = now();
    const previousText = await readFile(document.path, "utf8");
    const previousSnapshotAt = document.yourNote?.snapshotAt ?? at;
    const markdown = markdownOf(document.id, mind, at, document.id);
    await writeSnapshot(document.id, markdown, at);
    await documents.checkNow(document.path);
    if (document.name !== nameOf(mind)) documents.rename(document.id, nameOf(mind));
    const updated = documents.setYourNoteAt(document.id, at);
    documents.announce(document.id);
    return {
      document: updated,
      previousText,
      previousSnapshotAt,
      snapshotText: markdown,
      snapshotAt: at,
    };
  }

  return {
    /**
     * Saves a snapshot of the Mind, or updates the one it has: the issue's
     * "Use as a source" and "Update the snapshot" (#335).
     */
    async use(mindId: string): Promise<Document> {
      const mind = deps.minds.get(mindId);
      if (!documents.yourNoteDocument(mind.id)) return create(mind.id);
      const updated = await update(mind.id);
      return updated.document;
    },

    /** Writes the Mind's words again over its snapshot's file, a new version of the Document. */
    update,

    /** Writes a previous snapshot's text back, as Undo of an update: a new version of it. */
    async restore(
      documentId: string,
      input: { text: string; snapshotAt: string },
    ): Promise<Document> {
      const document = documents.get(documentId);
      if (!document.yourNote) throw new NotFoundError({ key: "error.mindSource.notSnapshot" });
      // The version it was is dated when it was taken, not when Undo wrote it back.
      await writeSnapshot(document.id, input.text, input.snapshotAt);
      await documents.checkNow(document.path);
      const updated = documents.setYourNoteAt(document.id, input.snapshotAt);
      documents.announce(document.id);
      return updated;
    },

    /** Sends the Mind's snapshot to Recently deleted; Undo restores it as a source. */
    remove(mindId: string): void {
      const document = documents.yourNoteDocument(mindId);
      if (!document) throw new NotFoundError({ key: "error.mindSource.none" });
      deps.removeDocument(document.id);
    },
  };
}

export type MindSources = ReturnType<typeof createMindSources>;
