/**
 * The Word file IncarnaMind writes for an outside agent (#3751): of a Note, or of the agent's own
 * Blocks as a new Note of them would hold them, by Export › Word with the User's choices for it, and
 * saved in the Output location as Export › Word saves its file. It is written from a copy that
 * nothing stores or lists, which holds only what the agent may read: no comment, check comment,
 * "Checked by" line or waiting change goes in, and a file that would name a Document the agent
 * doesn't reach isn't kept. A Note imported from Word is written into the file it came from, as
 * Export › Word writes it, with only what the agent was given of that file (./wordPatch/forAgent);
 * when that can't be told for certain, it is written as a new file, as any other Note is. Its
 * dates are the item's, so the same words give the same bytes.
 */
import { basename } from "node:path";
import * as Y from "yjs";
import type { NodeJSON } from "../../shared/blockJson";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { LIBRARY_FACTS } from "../../shared/libraryFacts";
import { resolveProposals } from "../../shared/proposals";
import { saveFailureReason } from "../../shared/systemReasons";
import { wordFileOf, wordImportProgressOf } from "../../shared/wordFiles";
import type { Logger } from "../adapters";
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
  WORD_CHANGE_ID,
} from "../api";
import {
  FileWriteUnansweredError,
  LinkedFolderWritesDeclinedError,
  TranslatableError,
} from "../errors";
import { safeFileName } from "../fileNames";
import { insertBlocks } from "../noteAdding";
import type { OutputFiles } from "../outputFiles";
import { type AgentWordFile, forAgent, textsOfFile } from "./wordPatch/forAgent";
import { knownIn, vocabularyOf } from "./wordPatch/forAgentWords";

/** A Note as an export and its citation style read it: one stored, or a copy nothing stores. */
export interface NoteReader {
  mind(mindId: unknown): Mind;
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  readSettings<T>(mindId: string, look: (settings: Y.Map<unknown>) => T): T;
  /** The Word file the Note read was imported from, for a copy that has an id of its own. */
  wordPackage?(mindId: string): Promise<Uint8Array>;
}

/** What a Word file is written from: a Note, or an agent's Blocks as a new Note of them. */
export type WordSource =
  | { kind: "note"; mindId: string; title: string }
  | { kind: "text"; title: string; nodes: NodeJSON[]; folderId: string | null };

/** Why a file isn't kept: it would name a Document of a Folder not shared, one deleted, or the Library's facts. */
export type WordUnreached = "unshared" | "deleted" | "library";

/**
 * The Word file written, or why it isn't: it would name what the agent can't read. `unreached`
 * asks that again of what the file names, for a reach read after a wait (#3751).
 */
export type WordMade =
  | {
      kind: "made";
      data: Uint8Array;
      fileName: string;
      unreached(reaches: (documentId: string) => boolean): WordUnreached | null;
    }
  | { kind: "unreached"; why: WordUnreached };

/** Where the file was saved for the User, or why it couldn't be, in plain words. */
export type WordSaved =
  | { kind: "saved"; file: AgentSavedFile }
  | { kind: "not-saved"; why: string };

export interface AgentWordFilesDeps {
  mind(mindId: string): Mind;
  /** A stored Note's state, whole, as it is now. */
  noteState(mindId: string): Uint8Array | null;
  /** The Word file a stored Note was imported from. */
  wordPackage(mindId: string): Promise<Uint8Array>;
  /** The Note as read_mind gives it to an agent, its Citations by their Documents' names. */
  given(mindId: string): string;
  /**
   * What Export › Word writes of the Note `notes` reads, with these choices, its dates `at`, and
   * every Document the file names: in a footnote, a table's note, a figure's sources, the Bibliography.
   */
  wordOf(
    notes: NoteReader,
    mindId: string,
    options: ExportMindOptions,
    at: string,
  ): Promise<{ exported: MindExport; named: readonly string[] }>;
  /** Whether a Document is in the Library, not deleted. */
  isDocument(documentId: string): boolean;
  /** The User's choices for Export › Word. */
  wordChoices(): ExportMindOptions;
  /** A new Note's own settings in a Folder: its citation style and the User's style for new Notes. */
  startSettings(settings: Y.Map<unknown>, folderId: string | null): void;
  outputs: Pick<OutputFiles, "alreadySaved" | "save">;
  say(key: MessageKey, params?: MessageParams): string;
  newId(): string;
  log: Logger;
}

const LINK = /\b(?:https?|ftp):\/\/[^\s<>()[\]"']+|\b(?:mailto|tel):[^\s<>()[\]"']+/gi;
/** The links a Note holds as the agent reads it: its links' targets, and addresses in its words. */
const linksIn = (markdown: string): Set<string> =>
  new Set([...markdown.matchAll(LINK)].map(([link]) => link.replace(/[.,;:!?]+$/, "")));

/** A tracked deletion or move imported from a Word file, by its Proposal's id. */
const MOVED_OR_DELETED = new RegExp(`^${WORD_CHANGE_ID}w:(?:del|moveFrom|moveTo)#`);

/**
 * Why the cleaned file isn't the agent's: a part not cleaned, a text the agent wasn't given or a
 * link the Note doesn't hold, by the part's name only; null when it is.
 */
function unconfirmed(
  file: Extract<AgentWordFile, { kind: "written" }>,
  given: string,
  also: readonly string[],
): { part: string; why: string } | null {
  const vocabulary = vocabularyOf([given, ...also]);
  const links = linksIn(given);
  for (const { part, texts } of file.texts) {
    if (!texts.every((text) => knownIn(text, vocabulary))) {
      return { part, why: "a text the agent wasn't given" };
    }
  }
  for (const { part, target } of file.links) {
    if (!links.has(target)) return { part, why: "a link the Note doesn't hold" };
  }
  return null;
}

const clear = (map: Y.Map<unknown>) => {
  for (const key of [...map.keys()]) map.delete(key);
};

export function createAgentWordFiles(deps: AgentWordFilesDeps) {
  /** What the agent's file holds of a stored Note: its words as they read now, nothing more. */
  const copyNote = (doc: Y.Doc, source: Extract<WordSource, { kind: "note" }>) => {
    const state = deps.noteState(source.mindId);
    if (state) Y.applyUpdate(doc, state);
    // As Export › Word refuses it: the Note's words aren't all there yet.
    if (wordImportProgressOf(doc) !== null) {
      throw new TranslatableError({ key: "error.export.wordImporting" });
    }
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    doc.transact(() => {
      // Someone's deletion or move from the Word file stands; what anyone else proposed doesn't.
      resolveProposals(blocks, (proposal) => MOVED_OR_DELETED.test(proposal.id), "accept");
      resolveProposals(blocks, () => true, "reject");
      // The comments and sign-offs are people's own words about the Note, which the agent doesn't
      // read.
      for (const field of [MIND_COMMENTS_FIELD, MIND_SIGN_OFFS_FIELD]) clear(doc.getMap(field));
    });
  };

  type Written = { exported: MindExport; named: readonly string[] };
  /**
   * The Word file written into the one the Note came from, made fit for the agent; or the copy
   * written as a new file (`anew`) when that can't be confirmed: an edit the export couldn't write
   * there, a part that couldn't be cleaned, a text or a link the agent wasn't given.
   */
  const forAgentOf = async (
    mindId: string,
    exported: MindExport,
    anew: () => Promise<Written>,
  ): Promise<{ data: Uint8Array; named: readonly string[] }> => {
    let written: Written | null = null;
    const writtenNew = async (part: string, why: string) => {
      deps.log.info("agentWordFile.writtenNew", { part, why });
      written ??= await anew();
      return { data: written.exported.data, named: written.named };
    };
    const report = exported.word;
    if (report?.notKept.some((each) => each.kind === "edit")) {
      return writtenNew("document", "an edit the export couldn't write");
    }
    const file = await forAgent(exported.data, { furniture: report?.furnitureParts ?? [] });
    if (file.kind === "unkept") {
      if (file.error !== undefined) {
        deps.log.warn("agentWordFile.cleaningFailed", {
          part: file.part,
          message: file.error instanceof Error ? file.error.message : String(file.error),
        });
      }
      return writtenNew(file.part, file.why);
    }
    const given = deps.given(mindId);
    if (unconfirmed(file, given, []) === null) return { data: file.data, named: [] };
    // Words IncarnaMind writes of the Note in any Word file, such as a Citation's footnote.
    written = await anew();
    const still = unconfirmed(file, given, await textsOfFile(written.exported.data));
    return still === null ? { data: file.data, named: [] } : writtenNew(still.part, still.why);
  };

  /** Why a file naming these Documents isn't kept for an agent reaching `reaches`; null when it is. */
  const unreached = (
    named: readonly string[],
    reaches: (documentId: string) => boolean,
  ): WordUnreached | null => {
    const out = named.filter((documentId) => !reaches(documentId));
    if (out.some((documentId) => documentId !== LIBRARY_FACTS && deps.isDocument(documentId)))
      return "unshared";
    if (out.some((documentId) => documentId !== LIBRARY_FACTS)) return "deleted";
    return out.length > 0 ? "library" : null;
  };

  return {
    /**
     * The Word file of `source`, dated `at`, or why it isn't kept: it would name a Document the
     * agent doesn't reach (`reaches`), as Export › Word writes its sources.
     */
    async write(
      source: WordSource,
      at: string,
      reaches: (documentId: string) => boolean,
    ): Promise<WordMade> {
      const doc = new Y.Doc();
      try {
        const mindSettings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
        const folderId =
          source.kind === "note" ? deps.mind(source.mindId).folderId : source.folderId;
        if (source.kind === "note") copyNote(doc, source);
        else {
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
        const original = source.kind === "note" && wordFileOf(doc) ? source.mindId : null;
        const reader: NoteReader = {
          mind: () => mind,
          read: (_, look) => look(blocks),
          readSettings: (_, look) => look(mindSettings),
        };
        const copy: NoteReader =
          original === null ? reader : { ...reader, wordPackage: () => deps.wordPackage(original) };
        const options = {
          ...deps.wordChoices(),
          markAiText: false,
          commentFailedChecks: false,
          includeMyComments: false,
          trackChanges: false,
        };
        const { exported, named } = await deps.wordOf(copy, mind.id, options, at);
        let data = exported.data;
        let names = named;
        if (original !== null) {
          /** The copy written as a new file, without the Word file it came from. */
          const anew = async () => {
            doc.transact(() => {
              for (const field of [MIND_WORD_FIELD, MIND_WORD_SOURCES_FIELD]) {
                clear(doc.getMap(field));
              }
            });
            return deps.wordOf(reader, mind.id, options, at);
          };
          const made = await forAgentOf(original, exported, anew);
          data = made.data;
          names = [...new Set([...named, ...made.named])];
        }
        const why = unreached(names, reaches);
        if (why) return { kind: "unreached", why };
        return {
          kind: "made",
          data,
          fileName: `${safeFileName(source.title, "Note")}.docx`,
          unreached: (now) => unreached(names, now),
        };
      } finally {
        doc.destroy();
      }
    },

    /**
     * Saves the file in the Output location as Export › Word does (#124): the next free name, a
     * Linked folder's permission; the same bytes saved again are the file saved before. `fromFolder`:
     * the Folder whose wall it stays behind. Only `asks`, with the User at the window, may a save
     * ask them where it goes; otherwise it says what they would answer, and saves nothing.
     */
    async save(
      fileName: string,
      data: Uint8Array,
      fromFolder: string | null,
      asks: boolean,
    ): Promise<WordSaved> {
      try {
        const file =
          (await deps.outputs.alreadySaved(fileName, data)) ??
          (await deps.outputs.save({
            name: fileName,
            data,
            ownFile: "export",
            fromFolder,
            ...(!asks && { unasked: true }),
          }));
        return { kind: "saved", file: { path: file.path, name: file.name } };
      } catch (error) {
        const couldnt = (reason: string) => deps.say("export.failed.save", { reason });
        if (error instanceof FileWriteUnansweredError) {
          const { question } = error;
          return {
            kind: "not-saved",
            why:
              question.kind === "linked-folder"
                ? deps.say("agents.handOver.word.askLinked", { folder: basename(question.path) })
                : deps.say("agents.handOver.word.askLocation"),
          };
        }
        if (error instanceof LinkedFolderWritesDeclinedError) {
          return {
            kind: "not-saved",
            why: couldnt(
              deps.say("export.failed.notAllowed", { folder: basename(error.linkedFolderPath) }),
            ),
          };
        }
        // These are whole sentences already, not reasons after "Couldn't save:" (no folder chosen, one it may not write in).
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
