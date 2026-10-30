/**
 * The labelled Organize set (`tests/fixtures/organize/set.json`) and the Folders and
 * Tags it is labelled against: the app's own starter Folders and preset Tags,
 * read from the source, so a change to their descriptions is measured.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentKind } from "../../../src/core/api";
import type { Language } from "../../../src/core/language";
import type { LibraryGroup } from "../../../src/core/library/types";
import type { TagDefinition } from "../../../src/core/tags/classify";
import { PRESET_TAGS } from "../../../src/core/tags/presets";
import { translate } from "../../../src/shared/i18n";
import { libraryPresetKeys } from "../../../src/shared/libraryPresets";

export type Split = "tune" | "heldout";

export interface SetDocument {
  id: string;
  /** Relative to `SET_DIRECTORY`. */
  file: string;
  language: "en" | "zh";
  kind: DocumentKind;
  /** An image-only PDF: no text layer. */
  scanned?: boolean;
  /** A starter Folder key, or null for Unsorted. */
  folder: string | null;
  /** A second Folder that fits as well (a two-Folder case); strict accuracy ignores it. */
  alsoFolder?: string;
  /** Preset Tag keys: every Tag whose description fits the Document as a whole. */
  tags: string[];
  split: Split;
  hard?: string[];
  pair?: string;
  note?: string;
  sha256: string;
}

export interface OrganizeSet {
  version: number;
  folders: string[];
  tags: string[];
  documents: SetDocument[];
}

/** Where the set and its Documents are, from the repository's root. */
export const SET_DIRECTORY = "tests/fixtures/organize";

const KINDS: readonly DocumentKind[] = ["pdf", "docx", "pptx", "xlsx", "csv", "markdown", "text"];

/** Reads the set and checks it: known keys, both splits, and every file's bytes as labelled. */
export async function readSet(root: string): Promise<OrganizeSet> {
  const directory = join(root, SET_DIRECTORY);
  const set = JSON.parse(await readFile(join(directory, "set.json"), "utf8")) as OrganizeSet;
  const folders = new Set<string>(libraryPresetKeys);
  const tags = new Set(PRESET_TAGS.map((tag) => tag.key));
  const ids = new Set<string>();
  for (const doc of set.documents) {
    const where = `set.json, ${doc.id}`;
    if (ids.has(doc.id)) throw new Error(`${where}: the id is used twice.`);
    ids.add(doc.id);
    if (!KINDS.includes(doc.kind)) throw new Error(`${where}: unknown kind ${doc.kind}.`);
    if (doc.folder !== null && !folders.has(doc.folder))
      throw new Error(`${where}: unknown Folder ${doc.folder}.`);
    if (doc.alsoFolder !== undefined && !folders.has(doc.alsoFolder))
      throw new Error(`${where}: unknown Folder ${doc.alsoFolder}.`);
    if (doc.tags.some((tag) => !tags.has(tag))) throw new Error(`${where}: unknown Tag.`);
    if (doc.split !== "tune" && doc.split !== "heldout")
      throw new Error(`${where}: split must be "tune" or "heldout".`);
    const bytes = await readFile(join(directory, doc.file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== doc.sha256)
      throw new Error(
        `${where}: the file changed since it was labelled. Keep the fixtures frozen.`,
      );
  }
  return set;
}

/** The starter Folders and preset Tags, worded in `language`, keyed by their keys. */
export function definitions(language: Language): {
  folders: LibraryGroup[];
  tags: TagDefinition[];
} {
  return {
    folders: libraryPresetKeys.map((key) => ({
      id: key,
      name: translate(language, `library.preset.${key}`),
      description: translate(language, `library.preset.${key}.description`),
      countsOwnFiles: false,
      keepInside: false,
      createdAt: "",
      updatedAt: "",
    })),
    tags: PRESET_TAGS.map((preset) => ({ id: preset.key, ...preset.text[language] })),
  };
}

/** "pdf", or "pdf (scan)" for an image-only PDF. */
export const formatOf = (doc: Pick<SetDocument, "kind" | "scanned">) =>
  doc.scanned ? "pdf (scan)" : doc.kind;
