/**
 * A file an outside agent cites by its path (#3509): a file on this computer that isn't in the
 * Library, or isn't in the Folders the agent reaches. IncarnaMind opens it itself, with the guard
 * on a named path (never a copy the agent passes), keeps it as a Document of its own, filed in no
 * Folder and no source, and finds the quote in it as in any Passage. The agent learns nothing of
 * the file through IncarnaMind but whether its quote is there.
 */
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import type { NamedFile } from "../adapters";
import type { Place } from "../agentFiles/handOver";
import type { Citation, Document, DocumentKind } from "../api";
import { AgentRefusedError } from "./refusals";

/** How long a file cited by path may take to be read before it is said to be unreadable. */
const READ_WAIT_MS = 60_000;
/** The largest file cited by path: a handed-over file's limit. */
export const MAX_CITED_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Folders whose files are the system's or an app's, never the User's work: each matched against
 * the file's path, links resolved, with "/" between names. The cloud drives macOS keeps in the
 * User's Library folder (iCloud Drive, and Dropbox, OneDrive or Google Drive) are the User's.
 */
const SYSTEM_FOLDERS = [
  /^\/(System|Library|usr|bin|sbin|etc|dev|proc|sys|boot)\//,
  /^\/private\/(etc|var\/db)\//,
  /^\/Users\/[^/]+\/Library\/(?!Mobile Documents\/|CloudStorage\/)/,
  /^[A-Za-z]:\/(Windows|Program Files|Program Files \(x86\)|ProgramData)\//i,
  /\/AppData\//i,
];

/** Whether a file is hidden, or in a hidden or system folder: never one IncarnaMind reads by path. */
export function hiddenOrSystem(path: string): boolean {
  const slashed = path.replaceAll("\\", "/");
  return (
    slashed.split("/").some((name) => name.startsWith(".") && name !== "." && name !== "..") ||
    SYSTEM_FOLDERS.some((folder) => folder.test(slashed))
  );
}

export interface FileCitingDeps {
  readNamed?: (path: string, maxBytes: number) => Promise<NamedFile>;
  kindOf(path: string): DocumentKind | undefined;
  /** See `HandOverDeps.placeOf`. */
  placeOf(path: string): Place;
  /** Reads the file at `path` now: a file in a Linked folder the scan hasn't found too. */
  readAgain(path: string): Promise<unknown>;
  /** Adds the file at `path` as a Document of its own, cited by the agent named; null when it can't. */
  add(path: string, citedBy: string): Promise<string | null>;
  document(documentId: string): Document;
  /** The Document's Passages, in reading order. */
  passages(documentId: string): { id: string; text: string }[];
  citeQuote(passageId: string, quote: string): Citation | null;
  now(): string;
  sleep(ms: number): Promise<void>;
  say(key: MessageKey, params?: MessageParams): string;
}

/** A quote of a file cited by path: its Document, and the Citation when the quote is there. */
export interface FileCited {
  documentId: string;
  /** The Document's name, as the Library shows it. */
  name: string;
  citation: Citation | null;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export function createFileCiting(deps: FileCitingDeps) {
  const refused = (key: MessageKey) => new AgentRefusedError("invalid", deps.say(key));

  /** The Document the file at `place` is, as the agent may cite it; it is read first if new. */
  async function documentAt(path: string, agent: string, reaches: (id: string) => boolean) {
    let place = deps.placeOf(path);
    if (place.linkedFolderId !== null && place.documentId === null) {
      if (place.paused) throw refused("agents.handOver.paused");
      await deps.readAgain(path);
      place = deps.placeOf(path);
    }
    if (place.documentId !== null) {
      const known = deps.document(place.documentId);
      // The User's own Document, in a Folder they haven't shared with this agent.
      if (known.citedBy === null && !reaches(known.id)) {
        throw new AgentRefusedError("outside-scope", deps.say("agents.handOver.notShared"));
      }
      await deps.readAgain(path);
      return known.id;
    }
    if (place.linkedFolderId !== null) throw refused("agents.handOver.unreadable");
    const added = await deps.add(path, agent);
    if (added === null) throw refused("agents.handOver.unreadable");
    return added;
  }

  /** Waits until the Document's text is read; refuses when it can't be. */
  async function readText(documentId: string): Promise<void> {
    const until = Date.parse(deps.now()) + READ_WAIT_MS;
    for (;;) {
      const { status } = deps.document(documentId);
      if (status === "failed") throw refused("agents.handOver.unreadable");
      if (status !== "queued" && status !== "extracting") return;
      if (Date.parse(deps.now()) > until) throw refused("agents.handOver.unreadable");
      await deps.sleep(250);
    }
  }

  return {
    /**
     * A Citation of `quote` in the file at `path`, which the agent named `agent` cites by path.
     * `reaches`: whether the agent reaches a Document of the Library. Throws a refusal, in plain
     * words, for a file it may not cite this way.
     */
    async cite(
      path: string,
      quote: string,
      agent: string,
      reaches: (documentId: string) => boolean,
    ): Promise<FileCited> {
      if (!deps.kindOf(path)) throw refused("agents.cite.fileKind");
      if (hiddenOrSystem(path)) throw refused("agents.cite.fileHidden");
      if (!deps.readNamed) throw refused("agents.handOver.unavailable");
      const read = await deps.readNamed(path, MAX_CITED_FILE_BYTES);
      if (read.kind === "too-large") {
        throw new AgentRefusedError(
          "invalid",
          deps.say("agents.handOver.tooLarge", { max: MAX_CITED_FILE_BYTES / 1024 / 1024 }),
        );
      }
      if (read.kind !== "read") throw refused("agents.handOver.unreadable");
      if (hiddenOrSystem(read.path)) throw refused("agents.cite.fileHidden");
      const documentId = await documentAt(read.path, agent, reaches);
      await readText(documentId);
      // The Passages most of the quote's words are in first, then every other: a Chinese quote
      // inside a longer sentence shares no word with it, and is found all the same.
      const wanted = words(quote);
      const ranked = deps
        .passages(documentId)
        .map((passage) => {
          const has = words(passage.text);
          return { passage, score: [...wanted].filter((word) => has.has(word)).length };
        })
        .sort((a, b) => b.score - a.score);
      const { name } = deps.document(documentId);
      for (const { passage } of ranked) {
        const citation = deps.citeQuote(passage.id, quote);
        if (citation?.check === "found") return { documentId, name, citation };
      }
      return { documentId, name, citation: null };
    },
  };
}

export type FileCiting = ReturnType<typeof createFileCiting>;
