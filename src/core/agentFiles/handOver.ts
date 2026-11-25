/**
 * Handing a file over (#3412): the bytes `hand_over_file` read from the path the agent named are
 * kept as the item's version (a copy in the data folder's "Handed files", one folder an item), the
 * Library's one Document for the item takes them as its new version, and a Note of the version is
 * made and checked as "Check someone else's file" makes and checks one: a deck slide by slide, a
 * workbook whole, its formulas worked out again. The check runs on the model set up in IncarnaMind
 * only when nothing need be asked of the User, and one verify run goes at a time, so a check the
 * User is running is waited for.
 */
import { join } from "node:path";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import type { Logger } from "../adapters";
import type { FoundClaim, HandedCheck, HandOverDone } from "../agents/handedFiles";
import { AgentRefusedError } from "../agents/refusals";
import type { UnaskedCheck, UnaskedOptions } from "../answers/checks/verify";
import type { Document, HandedFile, VerifyDocumentResult } from "../api";
import { hashBytes } from "../documents/files";
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
  /** Whether another Document holds these bytes; IncarnaMind's own export copies only `withExports`. */
  contentHashInUse(
    contentHash: string,
    exceptDocumentId: string | null,
    withExports: boolean,
  ): boolean;
  /** Removes the copies of what was deleted for good, as `Documents.dropPurged` does. */
  dropPurged(): Promise<void>;
  /** Someone else's file, checked: never the evidence for its own claims. */
  setNotCited(documentId: string): void;
  rename(documentId: string, name: string): void;
  assign(documentId: string, folderId: string): void;
  verify(input: {
    documentId: string;
    folderId: string | null;
    allSheets?: boolean;
  }): Promise<VerifyDocumentResult>;
  checkUnasked(mindId: string, options: UnaskedOptions): Promise<UnaskedCheck>;
  mindTitle(mindId: string): string;
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

export function createHandOver(deps: HandOverDeps) {
  const { store } = deps;
  /** Each check started, by its Note, while this run of IncarnaMind lasts. */
  const runs = new Map<string, CheckRun>();
  let queue: Promise<unknown> = Promise.resolve();

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
  ): Promise<WrittenFile> {
    let written: WrittenFile;
    try {
      written = await writeWholeFile(path, bytes, deps.now());
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

  const doneOf = (file: StoredHandedFile, version: StoredHandedVersion): HandOverDone => ({
    file: store.get(file.id) ?? file,
    version: version.number,
    mindId: version.mindId,
    unread: version.unread,
  });

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
      deps.setNotCited(documentId);
    }
    store.setDocument(file.id, documentId);
    return documentId;
  }

  /**
   * Makes a kept version the item's Document's newest, and the Note of its check, from wherever
   * an earlier try stopped: a failure leaves the version kept, and the same bytes handed over again
   * go on from there.
   */
  async function complete(
    file: StoredHandedFile,
    version: StoredHandedVersion,
    input: HandOverInput,
    contentHash: string,
    reach: ReadonlySet<string>,
  ): Promise<HandOverDone> {
    let documentId = liveDocumentOf(file);
    if (documentId === null && requireReach(input, file).linkedFolderId !== null) {
      documentId = await linkedDocument(file, input);
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
      const written = await keep(file, path, input.bytes);
      requireReach(input, file);
      const document = deps.addHanded(deps.newId(), input.title, written, file.kind);
      documentId = document.id;
      deps.setNotCited(documentId);
      if (file.folderId !== null) deps.assign(documentId, file.folderId);
      store.setDocument(file.id, documentId);
    } else if (deps.document(documentId).contentHash !== contentHash) {
      const was = deps.document(documentId);
      // A Linked folder's Document is the agent's file itself: it is read again, never written.
      const own = was.linkedFolderId === null;
      if (own) await keep(file, was.path, input.bytes);
      await deps.readAgain(was.path);
      if (own && deps.document(documentId).name !== input.title)
        deps.rename(documentId, input.title);
      const read = await versionRead(documentId, contentHash, was);
      stillThere(file);
      if (read !== true) {
        store.setUnread(version.id, read);
        return doneOf(file, { ...version, unread: read });
      }
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
    const before = store
      .versions(file.id)
      .filter((each) => each.number < version.number && each.mindId !== null)
      .at(-1);
    // The newest version's check is the file's one Note in the lists, named for the file; the one
    // before it, opened from its card, says its version, unless the User has named it (#3412).
    if (
      before?.mindId &&
      input.reachesNote(before.mindId) &&
      deps.mindTitle(before.mindId) === deps.say("verify.mindTitle", { name: file.title })
    ) {
      deps.nameMind(
        before.mindId,
        deps.say("verify.handed.mindTitle", { name: file.title, version: before.number }),
      );
    }
    deps.notesChanged();
    deps.recordWriter(made.mind.id, { agent: input.agent, pairingId: input.pairingId });
    // A line the version before had too, checked with the same context, keeps that result while it
    // still stands (#3412): only what changed, or what its Documents changed under, is checked again.
    // With checking as it lands off, the version waits for the User's Check (#3576).
    if (deps.checksWritten())
      startCheck(made.mind.id, { carryFrom: before?.mindId ?? null, reach });
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
    const reach = input.reach();
    const newest = known ? store.versions(known.id).at(-1) : undefined;
    if (known && newest && newest.contentHash === contentHash) {
      if (newest.mindId !== null || newest.unread !== null) return doneOf(known, newest);
      return complete(known, newest, input, contentHash, reach);
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
    const name = fileNameOf(input.title, file.kind);
    const relative = join(HANDED_FOLDER, file.id, `v${(file.version ?? 0) + 1}`, name);
    await keep(file, join(deps.dataDir, relative), input.bytes);
    requireReach(input, file);
    const version = store.addVersion(file.id, {
      contentHash,
      size: input.bytes.byteLength,
      file: relative,
      agent: input.agent,
      title: input.title,
    });
    return complete(file, version, input, contentHash, reach);
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
    handOver(input: HandOverInput): Promise<HandOverDone> {
      const next = queue.then(() => handOverNow(input));
      queue = next.catch(() => undefined);
      return next;
    },

    /** Runs a write of a handed file's Document in turn with hand-overs, never between two of theirs (#149). */
    inTurn<T>(run: () => Promise<T>): Promise<T> {
      const next = queue.then(run);
      queue = next.catch(() => undefined);
      return next;
    },

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
