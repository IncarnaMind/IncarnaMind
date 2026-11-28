/**
 * Handing a file over (#3412): the bytes `hand_over_file` read from the path the agent named are
 * kept as the item's version (a copy in the data folder's "Handed files", one folder an item), the
 * Library's one Document for the item takes them as its new version, and a Note of the version is
 * made and checked as "Check someone else's file" makes and checks one: a deck slide by slide, a
 * workbook whole, its formulas worked out again. The check runs on the model set up in IncarnaMind
 * only when nothing need be asked of the User, and one verify run goes at a time, so a check the
 * User is running is waited for.
 */
import { basename, dirname, join } from "node:path";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import type { Logger } from "../adapters";
import type { FoundClaim, HandedCheck, HandOverDone } from "../agents/handedFiles";
import { AgentRefusedError } from "../agents/refusals";
import type { UnaskedCheck, UnaskedOptions } from "../answers/checks/verify";
import type { Document, HandedFile, VerifyDocumentResult } from "../api";
import { hashBytes, hashFile, isGone } from "../documents/files";
import { type WrittenFile, writeWholeFile } from "../documents/writeWhole";
import type { AgentFiles, StoredHandedFile, StoredHandedVersion } from "./index";

/** The data folder's folder of handed-over files. */
export const HANDED_FOLDER = "Handed files";
/** How long a new version's text may take to be read before its check gives up on it. */
const READ_WAIT_MS = 120_000;
/** How often a check waits for a verify run the User started, and for how many times. */
const BUSY_WAIT_MS = 3_000;
const BUSY_TRIES = 100;
/** How many times in a row a hand-over starts again because its item was deleted for good meanwhile. */
const MAX_ENDED = 2;

/** The item a hand-over was making a version of was deleted for good while it waited (#3505). */
class ItemEnded extends Error {}

/** What a check's Note shows its reader: its claims that need a look, where each is, and its formulas. */
export interface HandedMarks {
  supported: number;
  needLook: FoundClaim[];
  formulas: HandedCheck["formulas"];
  /** The claims a check is checking now. */
  checking: number;
  /** The results that no longer stand for the reader, by id: a check makes them again. */
  stale: string[];
  /** The claims that hold a result of any kind, the writer's own views too. */
  judged: number;
}

/**
 * A Document as the User shapes it (`HandOverDeps.shapeOf`): its name, and as one text the rest of
 * what they can set on it, from its Folder to its Tags.
 */
export interface DocumentShape {
  name: string;
  rest: string;
}

/** Where a handed-over file is, as the Library sees it (`HandOverDeps.placeOf`). */
export interface Place {
  linkedFolderId: string | null;
  paused: boolean;
  documentId: string | null;
}

export interface HandOverDeps {
  store: AgentFiles;
  dataDir: string;
  now(): string;
  newId(): string;
  addHanded(id: string, name: string, file: WrittenFile, kind: HandedFile["kind"]): Document;
  /**
   * Reads the Document's file again, a new version when its bytes changed; in a Linked folder, a
   * file the folder's scan hasn't found yet too.
   */
  readAgain(path: string): Promise<unknown>;
  /** The live Linked folder a path is inside and whether it is paused, and the live Document at it. */
  placeOf(path: string): Place;
  /** The Folder a Document is filed in; null for one in none ("Not in a Folder"). */
  filedIn(documentId: string): string | null;
  /** The Folder a Linked folder's file at this path is filed in as it arrives (ADR-0030); null: none. */
  filedOnArrival(path: string): string | null;
  document(documentId: string): Document;
  /** Whether the Document is in the Library still, not deleted. */
  liveDocument(documentId: string): boolean;
  shapeOf(documentId: string): DocumentShape;
  /** Whether another Document holds these bytes; IncarnaMind's own export copies only `withExports`. */
  contentHashInUse(
    contentHash: string,
    exceptDocumentId: string | null,
    withExports: boolean,
  ): boolean;
  /** Removes the copies of what was deleted for good, as `Documents.dropPurged` does. */
  dropPurged(): Promise<void>;
  /**
   * Deletes for good what a refused hand-over made (#3751): its Document and its check's Note,
   * never shown as deleted, and its copies in "Handed files" that no Document holds.
   */
  discard(made: { documentIds: string[]; mindIds: string[]; copies: string[] }): Promise<void>;
  /** A copy kept in "Handed files", as bytes. */
  readKept(path: string): Promise<Uint8Array>;
  /** Someone else's file, checked: never the evidence for its own claims; false: a source again. */
  setNotCited(documentId: string, notCited: boolean): void;
  rename(documentId: string, name: string): void;
  assign(documentId: string, folderId: string): void;
  verify(input: {
    documentId: string;
    folderId: string | null;
    allSheets?: boolean;
  }): Promise<VerifyDocumentResult>;
  checkUnasked(mindId: string, options: UnaskedOptions): Promise<UnaskedCheck>;
  mindTitle(mindId: string): string;
  /**
   * A Note's name, Folder and content as they are now (`content`: a hash of all of it but a check's
   * results, so a check on it leaves it as it was; `kept`: whether the User kept a sentence of it
   * as their own view, which is stored with a result); null once it is deleted.
   */
  noteAt(
    mindId: string,
  ): { title: string; folderId: string | null; content: string; kept: boolean } | null;
  /**
   * The start's removal of what the data folder keeps of what was deleted for good, and of the
   * copies a take-back cut short left, but the version folders in `keep`: in the hand-overs' turn,
   * before any hand-over writes one.
   */
  startUp(keep: readonly string[]): Promise<void>;
  /** Aborted once the core closes: the start writes nothing after. */
  signal: AbortSignal;
  nameMind(mindId: string, title: string): void;
  /** Tells the windows the Notes changed: which of them a later version's check now stands for. */
  notesChanged(): void;
  /** Records the agent as the writer of the check's Note, by which one in no Folder is reached. */
  recordWriter(mindId: string, writer: { agent: string; pairingId: string }): void;
  /** The check's Note as whoever reaches `reach` reads it. */
  marks(mindId: string, reach: ReadonlySet<string>): HandedMarks;
  say(key: MessageKey, params?: MessageParams): string;
  sleep(ms: number): Promise<void>;
  /** Whether what is written is checked as it lands (Settings › AI); off, a version waits for the User's Check. */
  checksWritten(): boolean;
  log: Logger;
}

/** A take-back a quit cut short: the item, its own Document, its newest version and the one taken back. */
interface CutShort {
  file: StoredHandedFile;
  documentId: string;
  standing: StoredHandedVersion;
  taken: StoredHandedVersion;
}

/** Why a start left a take-back a quit cut short as it was; `message`: the error of a failed read. */
interface NotFinished {
  why: string;
  message?: string;
}

/** A check started on a version's Note, with what it was given, to start it again. */
interface CheckRun {
  done: Promise<UnaskedCheck>;
  outcome: UnaskedCheck | null;
  options: UnaskedOptions;
  /** The results that no longer stood, which it was started to make again. */
  remakes: string;
}

/** How a check ended that another can't change: its results made, or the User stopped it. */
const SETTLED: ReadonlySet<UnaskedCheck["kind"]> = new Set(["checked", "nothing", "cancelled"]);

/** A set of results by their ids, as one key. */
const idsKey = (ids: readonly string[]): string => [...ids].sort().join(" ");

/** A check Note as a hand-over left it, to tell whether the User has touched it since. */
interface Left {
  name: string;
  folderId: string | null;
  content: string;
}

/**
 * What one hand-over made so far, so a refusal part way takes all of it back (#3751): a refused
 * call keeps nothing, as one refused at its start does, and leaves nothing no one can see.
 */
interface Made {
  /** The item, when this hand-over made it. */
  item: boolean;
  version: StoredHandedVersion | null;
  /** What it wrote in "Handed files" that no Document holds: a version's folder, a file. */
  copies: string[];
  /** The Document it added for the version, as it left it, and the item's Document before it. */
  added: { documentId: string; before: string | null; shape: DocumentShape } | null;
  /**
   * The item's own Document it wrote the version into, as it left it: the copy of the bytes it
   * held before and their hash, and its name then.
   */
  rewrote: {
    documentId: string;
    copy: string;
    contentHash: string;
    name: string;
    shape: DocumentShape;
  } | null;
  /**
   * The Linked folder's Document the version is, the agent's own file there, as it was read for the
   * version: never taken back, only looked at for what the User did to it since.
   */
  linked: { documentId: string; shape: DocumentShape } | null;
  /** The Linked folder's Document it made Not cited, as the file it first became an item's. */
  notCited: string | null;
  /** The check's Note it made, as it left it, and the Note before it with its name and the one given. */
  checked: {
    mindId: string;
    left: Left;
    renamed: { mindId: string; title: string; as: string } | null;
  } | null;
  /** The item's title before this version gave it its own. */
  title: string | null;
}

const nothingMade = (item: boolean): Made => ({
  item,
  version: null,
  copies: [],
  added: null,
  rewrote: null,
  linked: null,
  notCited: null,
  checked: null,
  title: null,
});

const NOTHING_TO_UNDO = async (): Promise<void> => {};

/**
 * How the item of a file IncarnaMind wrote for an agent is known, in place of a path (#3751): no
 * path `hand_over_file` takes starts so, since it takes only a full one.
 */
export const WRITTEN_ITEM = "incarnamind:";

/** A hand-over: the bytes the agent's file held, and what may be done with them now. */
export interface HandOverInput {
  pairingId: string;
  agent: string;
  path: string;
  /** Where the file is, links in its folders followed: what a Linked folder knows it by. */
  place: string;
  /** When this agent was first connected (its pairing made). ISO 8601, UTC. */
  connectedAt: string;
  title: string;
  kind: HandedFile["kind"];
  bytes: Uint8Array;
  folderId: string | null;
  /** When a new item is made: the date a file IncarnaMind wrote for it carries (#3751). */
  createdAt?: string;
  /**
   * IncarnaMind wrote the bytes, as `save_as_word` does (#3751): its own export copy of them, as
   * Export › Word saves one into a Linked folder, is no file the Library holds already.
   */
  written?: boolean;
  /**
   * Throws unless the agent may still write where it is handed over: read when the hand-over's
   * turn comes, as the User may have taken the grant back while it waited.
   */
  allowed(): void;
  /** Whether the agent reaches this Folder (null: Not in a Folder) as the User grants it now. */
  reaches(folderId: string | null): boolean;
  /** Whether the agent reaches this Note as the User grants it now. */
  reachesNote(mindId: string): boolean;
  /** The Documents the agent reaches now, the only evidence its check may have. */
  reach(): ReadonlySet<string>;
}

/**
 * Whether the Document a hand-over finds in a Linked folder is the agent's file, Not cited until
 * the User cites it (#3499). Handing it over is the agent saying it made it; its word stands unless
 * what IncarnaMind recorded says otherwise: the Library held the file before that agent was first
 * connected, or the file was last modified before then. Then it is the User's, and stays a source.
 */
export function agentMadeIt(
  document: Pick<Document, "createdAt" | "modifiedAt">,
  connectedAt: string,
): boolean {
  const connected = Date.parse(connectedAt);
  if (Date.parse(document.createdAt) < connected) return false;
  return document.modifiedAt === null || Date.parse(document.modifiedAt) >= connected;
}

/**
 * The copy in the data folder of the file handed over last from `path` (#3499), or null. Once
 * `path` is in a Linked folder, its scan makes that copy the file's Document there: the same
 * Document, only at the file's place. `isCopy`: live, and in no Linked folder.
 */
export function handedCopyAt(
  store: Pick<AgentFiles, "handedFrom">,
  path: string,
  isCopy: (documentId: string) => boolean,
): string | null {
  const [last] = store
    .handedFrom(path)
    .filter((file) => file.documentId !== null && isCopy(file.documentId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return last?.documentId ?? null;
}

/** Whether the Document's read failed, and since `was`, as it stood before the new version. */
const failedSince = (was: Document, now: Document, read: boolean): boolean =>
  now.status === "failed" &&
  (read || was.status !== "failed" || JSON.stringify(was.failure) !== JSON.stringify(now.failure));

/** The copy's file name: the item's title, kept to what every file system takes. */
function fileNameOf(title: string, kind: HandedFile["kind"]): string {
  const plain = [...title]
    .map((each) => (each.charCodeAt(0) < 0x20 || /[\\/:*?"<>|]/.test(each) ? " " : each))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 120);
  return `${plain || "file"}.${kind}`;
}

/**
 * Where a version keeps the bytes the item's own Document held before it was written in, when
 * they were no newest version's (#3751): beside the version's copy, in a folder no copy's name is.
 */
const beforeCopyOf = (dataDir: string, version: StoredHandedVersion, kind: HandedFile["kind"]) =>
  join(dataDir, dirname(version.file), "before", `file.${kind}`);

export function createHandOver(deps: HandOverDeps) {
  const { store } = deps;
  /** Each check started, by its Note, while this run of IncarnaMind lasts. */
  const runs = new Map<string, CheckRun>();
  /**
   * The Linked folders' Documents a hand-over made Not cited while this run lasts, rather than the
   * User, for a refusal of a later try to take back. One a quit cut short is told by nothing stored.
   */
  const notCitedHere = new Set<string>();
  // The turn starts with the start, called now: it reads the tables before the core can close, and
  // every hand-over and hand edit waits for it.
  let queue: Promise<unknown> = start().catch((error: unknown) =>
    deps.log.error("handedFile.startUp.failed", {
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };

  /**
   * Throws unless the item is still there: the User may delete its Document for good while a write
   * is awaited, and deleting never waits for the queue (#3505).
   */
  const stillThere = (file: StoredHandedFile): void => {
    if (store.get(file.id) === null) throw new ItemEnded();
  };

  /** Writes a copy in the item's folder; once the item has ended, the write's outcome doesn't matter. */
  async function keep(
    file: StoredHandedFile,
    path: string,
    bytes: Uint8Array,
    options: { durable?: boolean } = {},
  ): Promise<WrittenFile> {
    let written: WrittenFile;
    try {
      written = await writeWholeFile(path, bytes, deps.now(), options);
    } catch (error) {
      stillThere(file);
      throw error;
    }
    stillThere(file);
    return written;
  }

  /**
   * Waits until the Document holds `contentHash`, its text read: true, or why it couldn't be. A
   * read that failed after the hand-over is this version's, and ends the wait at once.
   */
  async function versionRead(
    documentId: string,
    contentHash: string,
    was: Document,
  ): Promise<true | string> {
    const until = Date.parse(deps.now()) + READ_WAIT_MS;
    let read = false;
    for (;;) {
      const document = deps.document(documentId);
      if (document.contentHash === contentHash) return true;
      if (document.status === "queued" || document.status === "extracting") read = true;
      if (failedSince(was, document, read)) {
        return deps.say(
          document.failure?.reason === "password-protected"
            ? "agents.handOver.unread.password-protected"
            : "agents.handOver.unread.unreadable",
        );
      }
      if (Date.parse(deps.now()) > until) return deps.say("agents.handOver.unread.unreadable");
      await deps.sleep(250);
    }
  }

  async function checkRun(mindId: string, options: UnaskedOptions): Promise<UnaskedCheck> {
    for (let tried = 0; ; tried++) {
      const outcome = await deps.checkUnasked(mindId, options);
      if (outcome.kind !== "busy" || tried >= BUSY_TRIES) return outcome;
      await deps.sleep(BUSY_WAIT_MS);
    }
  }

  function startCheck(mindId: string, options: UnaskedOptions, remakes = ""): void {
    const run: CheckRun = {
      options,
      remakes,
      done: checkRun(mindId, options).catch((error: unknown): UnaskedCheck => {
        deps.log.warn("handedFile.check.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        const failed: UnaskedCheck = {
          kind: "failed",
          error: {
            kind: "provider",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        return failed;
      }),
      outcome: null,
    };
    run.done.then((outcome) => {
      run.outcome = outcome;
      // Kept, so that after a quit a check that ended reads as checked and one that didn't is resumed.
      if (outcome.kind === "checked" || outcome.kind === "nothing") {
        const version = store.ofMind(mindId)?.version;
        if (version) store.setChecked(version.id, deps.now());
      }
    });
    runs.set(mindId, run);
  }

  const unreadWords = (result: Exclude<VerifyDocumentResult, { ok: true }>): string => {
    switch (result.reason) {
      case "too-many":
        return deps.say("agents.handOver.unread.too-many", {
          typed: result.typed,
          most: result.most,
        });
      case "password-protected":
      case "no-text":
      case "range":
      case "word":
        return deps.say(`agents.handOver.unread.${result.reason}`);
      default:
        return deps.say("agents.handOver.unread.unreadable");
    }
  };

  const doneOf = (
    file: StoredHandedFile,
    version: StoredHandedVersion,
    undo: () => Promise<void> = NOTHING_TO_UNDO,
  ): HandOverDone => ({
    file: store.get(file.id) ?? file,
    version: version.number,
    mindId: version.mindId,
    unread: version.unread,
    undo,
  });

  /** Whether the file holds these bytes now; one that can't be read can't be told to, so doesn't. */
  async function holds(path: string, contentHash: string): Promise<boolean> {
    try {
      return (await hashFile(path)).contentHash === contentHash;
    } catch (error) {
      deps.log.warn("handedFile.takeBack.unreadFile", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Whether the version's Document is as the hand-over left it, by what the Library holds of it:
   * there, holding the version, with the name and the rest the User sets as they were. Its file is
   * read apart, before, as reading it is awaited.
   */
  const documentAsLeft = (
    document: { documentId: string; shape: DocumentShape },
    version: StoredHandedVersion,
  ): boolean => {
    if (!deps.liveDocument(document.documentId)) return false;
    const shape = deps.shapeOf(document.documentId);
    return (
      deps.document(document.documentId).contentHash === version.contentHash &&
      shape.name === document.shape.name &&
      shape.rest === document.shape.rest
    );
  };

  /**
   * Whether the check Note is as the hand-over left it: its name, Folder and content, a check's
   * results aside, and no sentence the User kept as their own view.
   */
  const noteAsLeft = (checked: NonNullable<Made["checked"]>): boolean => {
    const now = deps.noteAt(checked.mindId);
    return (
      now !== null &&
      !now.kept &&
      now.title === checked.left.name &&
      now.folderId === checked.left.folderId &&
      now.content === checked.left.content
    );
  };

  /**
   * Whether anyone built on what a hand-over made since it made it: a later version of the item
   * (a hand edit's, #149, or another call's), or its Document or check Note no longer as it left
   * them (written, renamed, moved, tagged, annotated or deleted by the User). Then all of it is
   * theirs, and stays. Nothing here is awaited, so what it reads stands until the step after it.
   */
  const builtOn = (file: StoredHandedFile, made: Made): boolean => {
    const { version, checked } = made;
    if (version === null) return false;
    if (store.versions(file.id).some((each) => each.number > version.number)) return true;
    const document = made.added ?? made.rewrote ?? made.linked;
    if (document && !documentAsLeft(document, version)) return true;
    return checked !== null && !noteAsLeft(checked);
  };

  /**
   * Whether the Document's file holds the version's bytes now, as another app may have saved it
   * since IncarnaMind last read it; true for a Document deleted, which `documentAsLeft` tells.
   */
  const fileHoldsVersion = async (
    documentId: string,
    version: StoredHandedVersion,
  ): Promise<boolean> =>
    !deps.liveDocument(documentId) ||
    (await holds(deps.document(documentId).path, version.contentHash));

  /**
   * Takes back what a refused hand-over made and no one built on (#3751). What it writes back is
   * read first, and the records go before anything is removed or written: a step up to there that
   * fails keeps all of it, as the User would find a hand-over that was built on. Then the bytes it
   * wrote into the item's Document, the earlier check Note's name, its check Note, the Not cited
   * it gave a Linked folder's file, the Document it added and its copies, each standing alone, in
   * an order that keeps what a quit leaves part way something the User sees and can delete; bytes
   * a quit left unwritten, the next start writes back. Each thing is looked at again just before
   * it is written over or deleted, with nothing awaited between: one the User changed meanwhile is
   * theirs, and stays.
   */
  async function takeBack(file: StoredHandedFile, made: Made): Promise<void> {
    const { version, checked, added, rewrote } = made;
    // A try before that failed set it, and this one, going on from there, found it set.
    const own = store.get(file.id)?.documentId ?? null;
    const notCited = made.notCited ?? (own !== null && notCitedHere.has(own) ? own : null);
    // The refusal is still the call's answer; what couldn't be taken back is named for the log.
    const failed = (step: string, error: unknown) =>
      deps.log.error("handedFile.takeBack.failed", {
        fileId: file.id,
        version: version?.number ?? null,
        step,
        message: error instanceof Error ? error.message : String(error),
      });
    const kept = (what: string) =>
      deps.log.info("handedFile.takeBack.kept", {
        fileId: file.id,
        version: version?.number ?? null,
        what,
      });
    let before: Uint8Array | null = null;
    try {
      const document = made.added ?? made.rewrote ?? made.linked;
      const fileHolds =
        !document || !version || (await fileHoldsVersion(document.documentId, version));
      if (rewrote) before = await deps.readKept(rewrote.copy);
      if (!fileHolds || builtOn(file, made)) {
        deps.log.info("handedFile.takeBack.builtOn", {
          fileId: file.id,
          version: version?.number ?? null,
        });
        return;
      }
      if (rewrote && before && hashBytes(before) !== rewrote.contentHash) {
        throw new Error("The copy to write back holds other bytes than the Document held.");
      }
    } catch (error) {
      failed("look", error);
      return;
    }
    const title = store.get(file.id)?.title ?? file.title;
    try {
      store.takeBack(file.id, {
        versionId: version?.id ?? null,
        ...(added && !made.item && { documentBefore: added.before }),
        ...(made.title !== null && { title: made.title }),
        made: made.item,
      });
    } catch (error) {
      failed("records", error);
      return;
    }
    // Bytes of neither version in the file after a failed write: left unread, with the copies, for
    // the next start, which tells such a file by the Document's last read and leaves it as it is.
    let unsure = false;
    if (rewrote && before && version) {
      const { path } = deps.document(rewrote.documentId);
      try {
        if (!(await holds(path, version.contentHash))) {
          throw new Error("The Document's file changed after the take-back looked at it.");
        }
        await writeWholeFile(path, before, deps.now());
      } catch (error) {
        failed("bytes before", error);
        // A write can fail after its file is in place: what the file holds says which it was.
        const holding = await hashFile(path).then(
          (hashed) => hashed.contentHash,
          () => null,
        );
        if (holding === version.contentHash) {
          // Not written: the version stands again, so the item's newest version is what its
          // Document holds.
          try {
            store.putBack(file.id, { versionId: version.id, title });
          } catch (again) {
            failed("records put back", again);
          }
          return;
        }
        if (holding !== rewrote.contentHash) {
          unsure = true;
          deps.log.warn("handedFile.takeBack.unsure", {
            fileId: file.id,
            version: version.number,
          });
        }
      }
    }
    const step = async (name: string, run: () => unknown) => {
      try {
        await run();
      } catch (error) {
        failed(name, error);
      }
    };
    if (rewrote && !unsure) {
      await step("read again", async () => {
        const was = deps.document(rewrote.documentId);
        await deps.readAgain(was.path);
        const read = await versionRead(rewrote.documentId, rewrote.contentHash, was);
        if (read !== true) {
          deps.log.warn("handedFile.takeBack.unread", { fileId: file.id, why: read });
        }
        if (
          rewrote.shape.name !== rewrote.name &&
          deps.document(rewrote.documentId).name === rewrote.shape.name
        )
          deps.rename(rewrote.documentId, rewrote.name);
      });
    }
    const renamed = checked?.renamed;
    if (renamed) {
      await step("earlier note's name", () => {
        if (deps.noteAt(renamed.mindId)?.title === renamed.as)
          deps.nameMind(renamed.mindId, renamed.title);
      });
    }
    if (checked) {
      // One the User changed since is theirs, a Note no version is the check of.
      if (noteAsLeft(checked)) {
        await step("check note", () =>
          deps.discard({ documentIds: [], mindIds: [checked.mindId], copies: [] }),
        );
      } else kept("check note");
    }
    // The file in its Linked folder stays; with no item it is no agent's file, and a source again.
    if (notCited !== null) {
      await step("not cited", () => {
        if (
          store.holding(notCited).length === 0 &&
          deps.liveDocument(notCited) &&
          deps.document(notCited).notCited
        ) {
          deps.setNotCited(notCited, false);
          notCitedHere.delete(notCited);
        }
      });
    }
    if (added && version) {
      // Its file read first, so nothing is awaited between how it is and its deletion.
      const holdsIt = await fileHoldsVersion(added.documentId, version);
      if (holdsIt && documentAsLeft(added, version)) {
        await step("document", () =>
          deps.discard({ documentIds: [added.documentId], mindIds: [], copies: [] }),
        );
      } else kept("document");
    }
    // A Document kept holds its file still, and its file stays.
    if (!unsure) {
      await step("copies", () =>
        deps.discard({ documentIds: [], mindIds: [], copies: made.copies }),
      );
    }
    deps.notesChanged();
  }

  /**
   * The start: the take-backs a quit cut short finished, then the clean-up. The tables are read at
   * once, so a core closed as it starts reads nothing closed and removes nothing.
   */
  function start(): Promise<void> {
    let cut: CutShort[];
    try {
      cut = cutShortTakeBacks();
    } catch (error) {
      // Which copies a cut-short take-back still needs isn't known: the clean-up waits for a start
      // that can tell.
      return Promise.reject(error);
    }
    if (cut.length === 0) return deps.startUp([]);
    return finishTakeBacks(cut).then((keep) =>
      deps.signal.aborted ? undefined : deps.startUp(keep),
    );
  }

  /**
   * The take-backs a quit cut short after their records (#3751), told apart by what is kept: the
   * item back on its newest version, its own Document still holding the version taken back, whose
   * row has its bytes' hash. An item whose Document holds its newest version is passed by with no
   * file read.
   */
  function cutShortTakeBacks(): CutShort[] {
    return store.list().flatMap((file) => {
      const { documentId } = file;
      if (documentId === null || !deps.liveDocument(documentId)) return [];
      const document = deps.document(documentId);
      const standing = store.versions(file.id).at(-1);
      if (
        !standing ||
        document.linkedFolderId !== null ||
        document.contentHash === standing.contentHash
      )
        return [];
      const taken = store.takenBack(file.id, standing.number + 1, document.contentHash);
      return taken ? [{ file, documentId, standing, taken }] : [];
    });
  }

  /** Finishes each take-back a quit cut short; returns the version folders of those left as they are. */
  async function finishTakeBacks(cut: readonly CutShort[]): Promise<string[]> {
    const keep: string[] = [];
    for (const each of cut) {
      if (deps.signal.aborted) break;
      let left: NotFinished | null;
      try {
        left = await finishTakeBack(each);
      } catch (error) {
        left = { why: "failed" };
        deps.log.error("handedFile.takeBack.finishFailed", {
          fileId: each.file.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (left === null) continue;
      // Its copy stays with the version's row, for a later start or the User to finish it from.
      keep.push(dirname(join(deps.dataDir, each.taken.file)));
      deps.log.warn("handedFile.takeBack.notFinished", {
        fileId: each.file.id,
        version: each.taken.number,
        ...left,
      });
    }
    return keep;
  }

  /**
   * Writes back into the item's Document the bytes it held before the version taken back, as the
   * take-back would have: the copy kept of them when they were no version's, or else the newest
   * version's. Only while the file holds just the version taken back and that copy holds just
   * those bytes, read again before the write. Null once done; otherwise why it wrote nothing more.
   */
  async function finishTakeBack({
    file,
    documentId,
    standing,
    taken,
  }: CutShort): Promise<NotFinished | null> {
    const document = deps.document(documentId);
    let kept: Uint8Array | null = null;
    try {
      kept = await deps.readKept(beforeCopyOf(deps.dataDir, taken, file.kind));
    } catch (error) {
      if (!isGone(error)) {
        const message = error instanceof Error ? error.message : String(error);
        return { why: "copy-unreadable", message };
      }
    }
    const target = kept === null ? standing.contentHash : hashBytes(kept);
    let onDisk: string;
    try {
      onDisk = (await hashFile(document.path)).contentHash;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { why: "file-unreadable", message };
    }
    // Holding the bytes before already (a quit after the write, before the read), it is only read.
    if (onDisk !== target) {
      if (onDisk !== taken.contentHash) return { why: "file-changed" };
      let before = kept;
      if (before === null) {
        try {
          before = await deps.readKept(join(deps.dataDir, standing.file));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { why: isGone(error) ? "copy-missing" : "copy-unreadable", message };
        }
        if (hashBytes(before) !== standing.contentHash) return { why: "copy-changed" };
      }
      if (!(await holds(document.path, taken.contentHash))) return { why: "file-changed" };
      if (deps.signal.aborted) return { why: "closed" };
      await writeWholeFile(document.path, before, deps.now());
    }
    // A closed Library reads nothing: the next start finds the bytes before in the file, and only
    // reads them.
    if (deps.signal.aborted) return { why: "closed" };
    try {
      await deps.readAgain(document.path);
      const read = await versionRead(documentId, target, document);
      if (read !== true) {
        deps.log.warn("handedFile.takeBack.unread", { fileId: file.id, why: read });
      }
      // The records gave the item its title before back; the hand-over named its Document by the
      // version's, which its copy's name keeps. Any other name is one the User gave since.
      const { name } = deps.document(documentId);
      if (name !== file.title && fileNameOf(name, file.kind) === basename(taken.file))
        deps.rename(documentId, file.title);
    } catch (error) {
      if (deps.signal.aborted) return { why: "closed" };
      deps.log.error("handedFile.takeBack.failed", {
        fileId: file.id,
        version: taken.number,
        step: "read again",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    deps.log.info("handedFile.takeBack.finished", { fileId: file.id, version: taken.number });
    return null;
  }

  /**
   * A hand-over's work from where it has made something: refused part way, it takes back what it
   * made before the refusal is told; done, its `undo` does so for a refusal after it.
   */
  async function taking(
    file: StoredHandedFile,
    made: Made,
    work: () => Promise<HandOverDone>,
  ): Promise<HandOverDone> {
    let done: HandOverDone;
    try {
      done = await work();
    } catch (error) {
      if (error instanceof AgentRefusedError) await takeBack(file, made);
      throw error;
    }
    return { ...done, undo: () => inTurn(() => takeBack(file, made)) };
  }

  /** This agent's item whose newest version IncarnaMind wrote with these bytes, its check begun (#3751). */
  const writtenWith = (pairingId: string, contentHash: string) => {
    for (const file of store.list()) {
      if (file.pairingId !== pairingId || !file.path.startsWith(WRITTEN_ITEM)) continue;
      const newest = store.versions(file.id).at(-1);
      if (newest?.contentHash !== contentHash) continue;
      if (newest.mindId !== null || newest.unread !== null) return { file, newest };
    }
    return null;
  };

  /** The item's Document, while the Library holds it: null when it has none, or the User deleted it. */
  const liveDocumentOf = (file: StoredHandedFile | null): string | null =>
    file?.documentId && deps.liveDocument(file.documentId) ? file.documentId : null;

  /**
   * What a try cut short made of the item's Document for `version` before it stopped: the Document
   * it added for it, or the bytes it wrote into the item's own, whose version before is the copy.
   */
  const madeBefore = async (
    file: StoredHandedFile,
    version: StoredHandedVersion,
  ): Promise<Pick<Made, "added" | "rewrote">> => {
    const documentId = liveDocumentOf(file);
    const document = documentId === null ? null : deps.document(documentId);
    if (
      !document ||
      document.contentHash !== version.contentHash ||
      document.linkedFolderId !== null
    )
      return { added: null, rewrote: null };
    const shape = deps.shapeOf(document.id);
    if (basename(document.path) === `file-${version.number}.${file.kind}`) {
      return { added: { documentId: document.id, before: null, shape }, rewrote: null };
    }
    const before = await writtenOver(file, version);
    return {
      added: null,
      rewrote: before && { documentId: document.id, ...before, name: document.name, shape },
    };
  };

  /**
   * The bytes the item's own Document held before `version` was written into it: the copy kept of
   * them (`keptBefore`), or else the newest version's before it; null when there is none.
   */
  async function writtenOver(
    file: StoredHandedFile,
    version: StoredHandedVersion,
  ): Promise<{ copy: string; contentHash: string } | null> {
    const copy = beforeCopyOf(deps.dataDir, version, file.kind);
    try {
      return { copy, contentHash: hashBytes(await deps.readKept(copy)) };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
    return newestBefore(file, version);
  }

  /** The newest version before `version` as what a refusal writes back: its copy and its hash. */
  const newestBefore = (file: StoredHandedFile, version: StoredHandedVersion) => {
    const newest = store
      .versions(file.id)
      .filter((each) => each.number < version.number)
      .at(-1);
    return newest
      ? { copy: join(deps.dataDir, newest.file), contentHash: newest.contentHash }
      : null;
  };

  /**
   * Keeps what a refusal writes back before `version` is written into the item's own Document
   * `was`: its file's bytes as they are, which the newest version before keeps already when they
   * are its, or else a copy of them beside the version's (#3751). A file gone stands for the
   * newest version while the Library last read that. Throws, before anything is written, when the
   * bytes can't be read or kept.
   */
  async function keptBefore(
    file: StoredHandedFile,
    version: StoredHandedVersion,
    was: Document,
  ): Promise<{ copy: string; contentHash: string }> {
    const ofNewest = newestBefore(file, version);
    let bytes: Uint8Array;
    try {
      bytes = await deps.readKept(was.path);
    } catch (error) {
      if (isGone(error) && ofNewest?.contentHash === was.contentHash) return ofNewest;
      throw error;
    }
    const contentHash = hashBytes(bytes);
    const copy = beforeCopyOf(deps.dataDir, version, file.kind);
    // A copy an earlier try of this version kept is what a refusal would write back: it is made
    // to hold these bytes too.
    if (ofNewest?.contentHash === contentHash && !(await keptAlready(copy))) return ofNewest;
    // On the disk before the User's file is written over, as a deck kept for a hand edit is (#149).
    await keep(file, copy, bytes, { durable: true });
    return { copy, contentHash };
  }

  const keptAlready = (path: string): Promise<boolean> =>
    deps.readKept(path).then(
      () => true,
      (error: unknown) => {
        if (isGone(error)) return false;
        throw error;
      },
    );

  /**
   * Refuses unless the agent reaches, as the User grants it now, the Folder the call named, the
   * item's Folder, where its Notes go, and the Folder the file's Document is filed in (#3458): it
   * changes nothing where it has no reach. A Linked folder's file with no Document yet is where it
   * is filed once read: its bound Folder, or none. Read again after every wait. A Linked
   * folder the User paused isn't read, so nothing in it is handed over until it is resumed (#3499).
   */
  function requireReach(input: HandOverInput, file: StoredHandedFile | null): Place {
    input.allowed();
    if (file && !input.reaches(file.folderId)) {
      throw new AgentRefusedError("not-found", deps.say("agents.handOver.notFound"));
    }
    const place = deps.placeOf(input.place);
    const folders = [
      liveDocumentOf(file),
      place.linkedFolderId === null ? null : place.documentId,
    ].flatMap((id) => (id === null ? [] : [deps.filedIn(id)]));
    if (place.linkedFolderId !== null && place.documentId === null) {
      folders.push(deps.filedOnArrival(input.place));
    }
    if (folders.some((folderId) => !input.reaches(folderId))) {
      throw new AgentRefusedError("outside-scope", deps.say("agents.handOver.notShared"));
    }
    if (place.paused) throw new AgentRefusedError("invalid", deps.say("agents.handOver.paused"));
    return place;
  }

  /**
   * The file's own Document in the Linked folder it is in (#3499), read now if the folder's scan
   * hasn't found it yet: the handed file is that one Document, never a copy beside it. Null when
   * the folder doesn't take it (a file it leaves out).
   */
  async function linkedDocument(
    file: StoredHandedFile,
    input: HandOverInput,
    takes: Made,
  ): Promise<string | null> {
    let { documentId } = deps.placeOf(input.place);
    if (documentId === null) {
      await deps.readAgain(input.place);
      documentId = requireReach(input, file).documentId;
    }
    if (documentId === null) return null;
    stillThere(file);
    // Set once, as the Document first becomes a handed file's: what the User chose since stands.
    if (
      store.holding(documentId).length === 0 &&
      agentMadeIt(deps.document(documentId), input.connectedAt)
    ) {
      if (!deps.document(documentId).notCited) {
        takes.notCited = documentId;
        notCitedHere.add(documentId);
      }
      deps.setNotCited(documentId, true);
    }
    store.setDocument(file.id, documentId);
    return documentId;
  }

  /**
   * Makes a kept version the item's Document's newest, and the Note of its check, from wherever
   * an earlier try stopped: a failure leaves the version kept, and the same bytes handed over again
   * go on from there. What it makes goes in `takes`, for a refusal to take back.
   */
  async function complete(
    file: StoredHandedFile,
    version: StoredHandedVersion,
    input: HandOverInput,
    contentHash: string,
    takes: Made,
  ): Promise<HandOverDone> {
    let documentId = liveDocumentOf(file);
    if (documentId === null && requireReach(input, file).linkedFolderId !== null) {
      documentId = await linkedDocument(file, input, takes);
    }
    if (documentId === null) {
      // The first version, or one after the User deleted the item's Document: a Document of its
      // own, at a path the deleted one doesn't hold.
      const path = join(
        deps.dataDir,
        HANDED_FOLDER,
        file.id,
        `file-${version.number}.${file.kind}`,
      );
      takes.copies.push(path);
      const written = await keep(file, path, input.bytes);
      requireReach(input, file);
      documentId = deps.addHanded(deps.newId(), input.title, written, file.kind).id;
      deps.setNotCited(documentId, true);
      if (file.folderId !== null) deps.assign(documentId, file.folderId);
      store.setDocument(file.id, documentId);
      takes.added = { documentId, before: file.documentId, shape: deps.shapeOf(documentId) };
    } else if (deps.document(documentId).contentHash !== contentHash) {
      const was = deps.document(documentId);
      // A Linked folder's Document is the agent's file itself: it is read again, never written.
      if (was.linkedFolderId === null) {
        const shape = deps.shapeOf(documentId);
        const before = await keptBefore(file, version, was);
        takes.rewrote = { documentId, ...before, name: was.name, shape };
        await keep(file, was.path, input.bytes);
      }
      await deps.readAgain(was.path);
      if (was.linkedFolderId === null && deps.document(documentId).name !== input.title)
        deps.rename(documentId, input.title);
      if (takes.rewrote) takes.rewrote.shape = { ...takes.rewrote.shape, name: input.title };
      const read = await versionRead(documentId, contentHash, was);
      stillThere(file);
      if (read !== true) {
        store.setUnread(version.id, read);
        return doneOf(file, { ...version, unread: read });
      }
    }
    if (deps.document(documentId).linkedFolderId !== null) {
      takes.linked = { documentId, shape: deps.shapeOf(documentId) };
    }
    requireReach(input, file);
    const made = await deps.verify({
      documentId,
      folderId: file.folderId,
      ...(file.kind === "xlsx" && { allSheets: true }),
    });
    stillThere(file);
    if (!made.ok) {
      const words = unreadWords(made);
      store.setUnread(version.id, words);
      return doneOf(file, { ...version, unread: words });
    }
    store.setMind(version.id, made.mind.id);
    const note = deps.noteAt(made.mind.id);
    takes.checked = {
      mindId: made.mind.id,
      left: {
        name: note?.title ?? "",
        folderId: note?.folderId ?? file.folderId,
        content: note?.content ?? "",
      },
      renamed: null,
    };
    const before = store
      .versions(file.id)
      .filter((each) => each.number < version.number && each.mindId !== null)
      .at(-1);
    // The newest version's check is the file's one Note in the lists, named for the file; the one
    // before it, opened from its card, says its version, unless the User has named it (#3412).
    const named = deps.say("verify.mindTitle", { name: file.title });
    if (
      before?.mindId &&
      input.reachesNote(before.mindId) &&
      deps.mindTitle(before.mindId) === named
    ) {
      const as = deps.say("verify.handed.mindTitle", { name: file.title, version: before.number });
      deps.nameMind(before.mindId, as);
      takes.checked.renamed = { mindId: before.mindId, title: named, as };
    }
    deps.notesChanged();
    deps.recordWriter(made.mind.id, { agent: input.agent, pairingId: input.pairingId });
    // A line the version before had too, checked with the same context, keeps that result while it
    // still stands (#3412): only what changed, or what its Documents changed under, is checked again.
    // With checking as it lands off, the version waits for the User's Check (#3576). Its evidence
    // is what the agent reaches now, after the wait for the Note.
    if (deps.checksWritten())
      startCheck(made.mind.id, { carryFrom: before?.mindId ?? null, reach: input.reach() });
    return doneOf(file, { ...version, mindId: made.mind.id });
  }

  /**
   * A hand-over whose item was deleted for good while it ran is as if it came after the delete, as
   * a path handed over after one does: a new item at version 1. What it wrote goes with the cleanup.
   */
  async function handOverNow(input: HandOverInput): Promise<HandOverDone> {
    for (let ended = 0; ; ended++) {
      try {
        return await handOverOnce(input);
      } catch (error) {
        if (!(error instanceof ItemEnded)) throw error;
        await deps.dropPurged();
        if (ended + 1 >= MAX_ENDED) {
          throw new AgentRefusedError("not-found", deps.say("agents.handOver.notFound"));
        }
      }
    }
  }

  async function handOverOnce(input: HandOverInput): Promise<HandOverDone> {
    const contentHash = hashBytes(input.bytes);
    const at = deps.placeOf(input.place).documentId;
    // A file in a Linked folder is known by its Document there too, which follows it when renamed.
    const known =
      store.atPath(input.pairingId, input.place) ??
      store.atPath(input.pairingId, input.path) ??
      (at === null ? null : store.ofDocument(input.pairingId, at));
    const place = requireReach(input, known);
    const newest = known ? store.versions(known.id).at(-1) : undefined;
    if (known && newest && newest.contentHash === contentHash) {
      if (newest.mindId !== null || newest.unread !== null) return doneOf(known, newest);
      // A version a failure cut short goes on here, and is this call's to take back if refused,
      // with what the try before made of its Document.
      const takes: Made = {
        ...nothingMade(false),
        version: newest,
        copies: [dirname(join(deps.dataDir, newest.file))],
        ...(await madeBefore(known, newest)),
      };
      return taking(known, takes, () => complete(known, newest, input, contentHash, takes));
    }
    // A file IncarnaMind wrote for this agent, handed over again from where it saved it: that item.
    const written =
      known || input.written === true ? null : writtenWith(input.pairingId, contentHash);
    if (written) {
      requireReach(input, written.file);
      return doneOf(written.file, written.newest);
    }
    // Two Documents never hold the same file (ADR-0003); in a Linked folder its Document is this.
    if (
      deps.contentHashInUse(
        contentHash,
        place.documentId ?? liveDocumentOf(known),
        input.written !== true,
      )
    ) {
      throw new AgentRefusedError("invalid", deps.say("agents.handOver.inLibrary"));
    }
    const file =
      known ??
      store.create({
        title: input.title,
        kind: input.kind,
        path: input.place,
        folderId: input.folderId,
        pairingId: input.pairingId,
        agent: input.agent,
        ...(input.createdAt !== undefined && { createdAt: input.createdAt }),
      });
    const takes = nothingMade(known === null);
    return taking(file, takes, async () => {
      const name = fileNameOf(input.title, file.kind);
      const relative = join(HANDED_FOLDER, file.id, `v${(file.version ?? 0) + 1}`, name);
      takes.copies.push(dirname(join(deps.dataDir, relative)));
      await keep(file, join(deps.dataDir, relative), input.bytes);
      requireReach(input, file);
      if (known) takes.title = known.title;
      takes.version = store.addVersion(file.id, {
        contentHash,
        size: input.bytes.byteLength,
        file: relative,
        agent: input.agent,
        title: input.title,
      });
      return complete(file, takes.version, input, contentHash, takes);
    });
  }

  const notChecked = (outcome: UnaskedCheck): string | null => {
    switch (outcome.kind) {
      case "checked":
      case "nothing":
        return null;
      case "not-asked":
        return deps.say(
          `agents.handOver.notChecked.${
            outcome.reason === "consent-needed" || outcome.reason === "local-mode"
              ? outcome.reason
              : outcome.reason === "no-documents"
                ? "no-documents"
                : "not-ready"
          }`,
        );
      case "no-documents":
        return deps.say("agents.handOver.notChecked.no-documents");
      case "local-mode":
        return deps.say("agents.handOver.notChecked.local-mode");
      case "failed":
        return deps.say("agents.handOver.notChecked.failed", { message: outcome.error.message });
      case "cancelled":
        return deps.say("agents.check.stopped.user");
      default:
        return deps.say("agents.handOver.notChecked.not-ready");
    }
  };

  return {
    handOver: (input: HandOverInput): Promise<HandOverDone> => inTurn(() => handOverNow(input)),

    /** Runs a write of a handed file's Document in turn with hand-overs, never between two of theirs (#149). */
    inTurn,

    /**
     * How the check of the Note stands for an agent that reaches `reach`, waiting up to `waitMs`
     * for a run still going to end. One that couldn't run or failed (no model then, no consent, a
     * service down), or that a quit cut short, starts again here, keeping the results that still
     * stand. Once one has ended, the results that no longer stand for the agent (`marks.stale`: its
     * Documents changed, what they were judged with, or it doesn't reach them) are checked again
     * the same way, once for each set of them.
     */
    async handedCheck(
      mindId: string,
      waitMs: number,
      reach: ReadonlySet<string>,
    ): Promise<HandedCheck> {
      const earlier = runs.get(mindId);
      const found = store.ofMind(mindId);
      // With checking as it lands off, nothing starts here: a check the User started shows by its marks.
      const asItLands = deps.checksWritten();
      if (
        asItLands &&
        ((earlier === undefined && found !== null && found.version.checkedAt === null) ||
          (earlier?.outcome && !SETTLED.has(earlier.outcome.kind)))
      ) {
        const before = found
          ? store
              .versions(found.file.id)
              .filter((each) => each.number < found.version.number && each.mindId !== null)
              .at(-1)
          : undefined;
        startCheck(mindId, {
          ...(earlier?.options ?? { carryFrom: before?.mindId ?? null, keep: true }),
          reach,
        });
      } else if (asItLands && earlier?.outcome !== null) {
        const { stale, checking } = deps.marks(mindId, reach);
        const remakes = idsKey(stale);
        if (stale.length > 0 && checking === 0 && remakes !== earlier?.remakes) {
          startCheck(mindId, { keep: true, reach }, remakes);
        }
      }
      const run = runs.get(mindId);
      if (run && run.outcome === null) {
        await Promise.race([run.done, deps.sleep(waitMs)]);
      }
      const marks = deps.marks(mindId, reach);
      const formulas = marks.formulas;
      if ((run && run.outcome === null) || marks.checking > 0) {
        return { status: "running", why: null, supported: 0, needLook: 0, claims: [], formulas };
      }
      if (!run && !asItLands && found?.version.checkedAt == null && marks.judged === 0) {
        const waits = deps.say("agents.handOver.notChecked.waits");
        return {
          status: "not-checked",
          why: waits,
          supported: 0,
          needLook: 0,
          claims: [],
          formulas,
        };
      }
      const why = run?.outcome ? notChecked(run.outcome) : null;
      const stop = run?.outcome?.kind === "checked" ? run.outcome.stop : null;
      // A result shows only once a check of this version said it stands.
      if (why !== null) {
        return { status: "not-checked", why, supported: 0, needLook: 0, claims: [], formulas };
      }
      return {
        status: "checked",
        why: stop ? deps.say(`agents.check.stopped.${stop.reason}`) : null,
        supported: marks.supported,
        needLook: marks.needLook.length,
        claims: marks.needLook,
        formulas,
      };
    },

    /** The item a check's Note is of, its version, and every version, for the window. */
    ofMind: store.ofMind,
  };
}

export type HandOver = ReturnType<typeof createHandOver>;
