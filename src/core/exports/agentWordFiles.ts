/**
 * The Word file IncarnaMind writes for an outside agent (#3751): of a Note, or of the agent's own
 * Blocks as a new Note of them would hold them, by Export › Word with the User's choices for it, and
 * saved in the Output location as Export › Word saves its file. It is written from a copy that
 * nothing stores or lists, which holds only what the agent may read: a Note that cites a Document
 * the agent doesn't reach isn't written, and no comment, check comment, "Checked by" line or waiting
 * change goes in. Its dates are the item's, so the same words give the same bytes.
 */
import { basename } from "node:path";
import * as Y from "yjs";
import type { NodeJSON } from "../../shared/blockJson";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { resolveProposals } from "../../shared/proposals";
import { saveFailureReason } from "../../shared/systemReasons";
import { wordImportProgressOf } from "../../shared/wordFiles";
import {
  type AgentSavedFile,
  DEFAULT_MIND_KIND,
  type ExportMindOptions,
  MIND_COMMENTS_FIELD,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MIND_SIGN_OFFS_FIELD,
  MIND_WORD_FIELD,
  MIND_WORD_SOURCES_FIELD,
  type Mind,
  type MindExport,
} from "../api";
import { LinkedFolderWritesDeclinedError, TranslatableError } from "../errors";
import { safeFileName } from "../fileNames";
import { insertBlocks } from "../noteAdding";
import type { OutputFiles } from "../outputFiles";

/** A Note as an export and its citation style read it: one stored, or a copy nothing stores. */
export interface NoteReader {
  mind(mindId: unknown): Mind;
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  readSettings<T>(mindId: string, look: (settings: Y.Map<unknown>) => T): T;
}

/** What a Word file is written from: a Note, or an agent's Blocks as a new Note of them. */
export type WordSource =
  | {
      kind: "note";
      mindId: string;
      title: string;
      /** Whether the agent may read this Document: the file cites no other. */
      reaches(documentId: string): boolean;
    }
  | { kind: "text"; title: string; nodes: NodeJSON[]; folderId: string | null };

/** The Word file written, or why it isn't: the Note cites a Document the agent doesn't reach. */
export type WordMade = { kind: "made"; data: Uint8Array; fileName: string } | { kind: "unshared" };

/** Where the file was saved for the User, or why it couldn't be, in plain words. */
export type WordSaved =
  | { kind: "saved"; file: AgentSavedFile }
  | { kind: "not-saved"; why: string };

export interface AgentWordFilesDeps {
  mind(mindId: string): Mind;
  /** A stored Note's state, whole, as it is now. */
  noteState(mindId: string): Uint8Array | null;
  /** What Export › Word writes of the Note `notes` reads, with these choices, its dates `at`. */
  wordOf(
    notes: NoteReader,
    mindId: string,
    options: ExportMindOptions,
    at: string,
  ): Promise<MindExport>;
  /** The User's choices for Export › Word. */
  wordChoices(): ExportMindOptions;
  /** A new Note's own settings in a Folder: its citation style and the User's style for new Notes. */
  startSettings(settings: Y.Map<unknown>, folderId: string | null): void;
  outputs: Pick<OutputFiles, "alreadySaved" | "save">;
  say(key: MessageKey, params?: MessageParams): string;
  newId(): string;
}

const clear = (map: Y.Map<unknown>) => {
  for (const key of [...map.keys()]) map.delete(key);
};

/** Every Document named anywhere in a Note's Blocks: a Citation's, a figure's inputs', a chip's. */
function documentsNamedIn(blocks: Y.XmlFragment): Set<string> {
  const named = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return;
      try {
        visit(JSON.parse(text), depth + 1);
      } catch {
        // Words that only look like JSON name no Document.
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const each of value) visit(each, depth + 1);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, each] of Object.entries(value)) {
      if (key === "documentId" && typeof each === "string" && each !== "") named.add(each);
      else if (key === "documentIds" && Array.isArray(each)) {
        for (const id of each) if (typeof id === "string" && id !== "") named.add(id);
      } else visit(each, depth + 1);
    }
  };
  for (const element of blocks.createTreeWalker((node) => node instanceof Y.XmlElement)) {
    if (element instanceof Y.XmlElement) visit(element.getAttributes(), 0);
  }
  return named;
}

export function createAgentWordFiles(deps: AgentWordFilesDeps) {
  /** What the agent's file holds of a stored Note: its words as they read now, nothing more. */
  const copyNote = (doc: Y.Doc, source: Extract<WordSource, { kind: "note" }>): boolean => {
    const state = deps.noteState(source.mindId);
    if (state) Y.applyUpdate(doc, state);
    // As Export › Word refuses it: the Note's words aren't all there yet.
    if (wordImportProgressOf(doc) !== null) {
      throw new TranslatableError({ key: "error.export.wordImporting" });
    }
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    doc.transact(() => {
      resolveProposals(blocks, () => true, "reject");
      // A Word file it came from is written as a new one: that file's own parts, its comments and
      // tracked changes among them, are no words of the Note's.
      for (const field of [
        MIND_COMMENTS_FIELD,
        MIND_SIGN_OFFS_FIELD,
        MIND_WORD_FIELD,
        MIND_WORD_SOURCES_FIELD,
      ]) {
        clear(doc.getMap(field));
      }
    });
    return [...documentsNamedIn(blocks)].every((id) => source.reaches(id));
  };

  return {
    /** The Word file of `source`, dated `at`, or that the Note cites what the agent doesn't reach. */
    async write(source: WordSource, at: string): Promise<WordMade> {
      const doc = new Y.Doc();
      try {
        const mindSettings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
        const folderId =
          source.kind === "note" ? deps.mind(source.mindId).folderId : source.folderId;
        if (source.kind === "note") {
          if (!copyNote(doc, source)) return { kind: "unshared" };
        } else {
          const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
          doc.transact(() => {
            insertBlocks(blocks, source.nodes);
            deps.startSettings(mindSettings, source.folderId);
          });
        }
        const mind: Mind = {
          id: deps.newId(),
          title: source.title,
          autoTitle: "",
          kind: DEFAULT_MIND_KIND,
          createdAt: at,
          updatedAt: at,
          folderId,
        };
        const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
        const copy: NoteReader = {
          mind: () => mind,
          read: (_, look) => look(blocks),
          readSettings: (_, look) => look(mindSettings),
        };
        const exported = await deps.wordOf(
          copy,
          mind.id,
          {
            ...deps.wordChoices(),
            markAiText: false,
            commentFailedChecks: false,
            includeMyComments: false,
            trackChanges: false,
          },
          at,
        );
        return {
          kind: "made",
          data: exported.data,
          fileName: `${safeFileName(source.title, "Note")}.docx`,
        };
      } finally {
        doc.destroy();
      }
    },

    /**
     * Saves the file in the Output location as Export › Word does (#124): the next free name, a
     * Linked folder's permission asked once; the same bytes saved again are the file saved before.
     * `fromFolder`: the Folder whose wall it stays behind.
     */
    async save(fileName: string, data: Uint8Array, fromFolder: string | null): Promise<WordSaved> {
      try {
        const file =
          (await deps.outputs.alreadySaved(fileName, data)) ??
          (await deps.outputs.save({ name: fileName, data, ownFile: "export", fromFolder }));
        return { kind: "saved", file: { path: file.path, name: file.name } };
      } catch (error) {
        const couldnt = (reason: string) => deps.say("export.failed.save", { reason });
        if (error instanceof LinkedFolderWritesDeclinedError) {
          return {
            kind: "not-saved",
            why: couldnt(
              deps.say("export.failed.notAllowed", { folder: basename(error.linkedFolderPath) }),
            ),
          };
        }
        // A location the User didn't choose, and the other words the Output location has.
        if (error instanceof TranslatableError) {
          const { wording } = error;
          return {
            kind: "not-saved",
            why: wording ? deps.say(wording.key, wording.values) : error.message,
          };
        }
        const reason = saveFailureReason(error instanceof Error ? error.message : String(error));
        if (!reason) throw error;
        return { kind: "not-saved", why: couldnt(deps.say(reason.key, reason.values)) };
      }
    },
  };
}

export type AgentWordFiles = ReturnType<typeof createAgentWordFiles>;
