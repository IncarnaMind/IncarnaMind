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

/** What a check's Note shows its reader: its claims that need a look, where each is, and its formulas. */
export interface HandedMarks {
  supported: number;
  needLook: FoundClaim[];
  formulas: HandedCheck["formulas"];
  /** The claims a check is checking now. */
  checking: number;
  /** The results that no longer stand for the reader, by id: a check makes them again. */
  stale: string[];
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
  /** The live Linked folder a path is inside and the live Document at it; null for each there isn't. */
  placeOf(path: string): { linkedFolderId: string | null; documentId: string | null };
  document(documentId: string): Document;
  /** Whether the Document is in the Library still, not deleted. */
  liveDocument(documentId: string): boolean;
  contentHashInUse(contentHash: string, exceptDocumentId: string | null): boolean;
  /** Someone else's file, checked: never the evidence for its own claims, until the User cites it. */
  setNotCited(documentId: string, notCited: boolean): void;
  /** When the agent of this pairing was first connected; null once its pairing is gone. */
  connectedAt(pairingId: string): string | null;
  /**
   * Whether a Citation that can show again points at the Document: in a Note, one in Recently
   * deleted too, in a conversation, or kept by a feature.
   */
  cited(documentId: string): boolean;
  /**
   * Takes a Document the User never deleted out of the Library for good, at once, as Recently
   * deleted's purge does: never listed there, since restoring it would bring the second Document
   * back. Only for a copy whose bytes another Document and a kept version hold.
   */
  retire(documentId: string): void;
  /** Points a version's check at the Document that holds the file now. */
  repoint(mindId: string, documentId: string): void;
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
  /**
   * Throws unless the agent may still write where it is handed over: read when the hand-over's
   * turn comes, as the User may have taken the grant back while it waited.
   */
  allowed(): void;
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

  /** The item's Document, while the Library holds it: null when it has none, or the User deleted it. */
  const liveDocumentOf = (file: StoredHandedFile | null): string | null =>
    file?.documentId && deps.liveDocument(file.documentId) ? file.documentId : null;

  /**
   * The file's own Document in the Linked folder it is in (#3499), read now if the folder's scan
   * hasn't found it yet: the handed file is that one Document, never a copy beside it. Null when
   * the folder doesn't take it (paused, or a file it leaves out).
   */
  async function linkedDocument(
    file: StoredHandedFile,
    input: HandOverInput,
  ): Promise<string | null> {
    let { documentId } = deps.placeOf(input.place);
    if (documentId === null) {
      await deps.readAgain(input.place);
      documentId = deps.placeOf(input.place).documentId;
    }
    if (documentId === null) return null;
    // Set once, as the Document first becomes a handed file's: what the User chose since stands.
    if (
      store.holding(documentId).length === 0 &&
      agentMadeIt(deps.document(documentId), input.connectedAt)
    ) {
      deps.setNotCited(documentId, true);
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
    if (documentId === null && deps.placeOf(input.place).linkedFolderId !== null) {
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
      const written = await writeWholeFile(path, input.bytes, deps.now());
      const document = deps.addHanded(deps.newId(), input.title, written, file.kind);
      documentId = document.id;
      deps.setNotCited(documentId, true);
      if (file.folderId !== null) deps.assign(documentId, file.folderId);
      store.setDocument(file.id, documentId);
    } else if (deps.document(documentId).contentHash !== contentHash) {
      const was = deps.document(documentId);
      // A Linked folder's Document is the agent's file itself: it is read again, never written.
      const own = was.linkedFolderId === null;
      if (own) await writeWholeFile(was.path, input.bytes, deps.now());
      await deps.readAgain(was.path);
      if (own && deps.document(documentId).name !== input.title)
        deps.rename(documentId, input.title);
      const read = await versionRead(documentId, contentHash, was);
      if (read !== true) {
        store.setUnread(version.id, read);
        return doneOf(file, { ...version, unread: read });
      }
    }
    const made = await deps.verify({
      documentId,
      folderId: file.folderId,
      ...(file.kind === "xlsx" && { allSheets: true }),
    });
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
    startCheck(made.mind.id, { carryFrom: before?.mindId ?? null, reach });
    return doneOf(file, { ...version, mindId: made.mind.id });
  }

  async function handOverNow(input: HandOverInput): Promise<HandOverDone> {
    input.allowed();
    const reach = input.reach();
    const contentHash = hashBytes(input.bytes);
    const place = deps.placeOf(input.place);
    // A file in a Linked folder is known by its Document there too, which follows it when renamed.
    const known =
      store.atPath(input.pairingId, input.place) ??
      store.atPath(input.pairingId, input.path) ??
      (place.documentId === null ? null : store.ofDocument(input.pairingId, place.documentId));
    const newest = known ? store.versions(known.id).at(-1) : undefined;
    if (known && newest && newest.contentHash === contentHash) {
      if (newest.mindId !== null || newest.unread !== null) return doneOf(known, newest);
      return complete(known, newest, input, contentHash, reach);
    }
    // Two Documents never hold the same file (ADR-0003); in a Linked folder its Document is this.
    if (deps.contentHashInUse(contentHash, place.documentId ?? liveDocumentOf(known))) {
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
      });
    const name = fileNameOf(input.title, file.kind);
    const relative = join(HANDED_FOLDER, file.id, `v${(file.version ?? 0) + 1}`, name);
    await writeWholeFile(join(deps.dataDir, relative), input.bytes, deps.now());
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
    /**
     * A file a Linked folder's scan has just found, which an agent handed over (#3499): at the path
     * a live handed file was handed from, holding exactly the bytes of one of its versions. It is that
     * handed file's Document, not another: the handed file takes it, Not cited as its copy was left
     * by the User, or, with none, as `agentMadeIt` says; the copy is taken out of the Library and the
     * checks of its versions point at the folder's Document. A file edited since it was handed over
     * holds bytes no version has: an ordinary Document, since nothing says who changed it. A copy a
     * Citation points at stays, and so does the folder's Document beside it.
     */
    adopt(documentId: string): void {
      const found = deps.document(documentId);
      if (found.linkedFolderId === null) return;
      const file = store
        .handedFrom(found.path)
        .find((each) =>
          store.versions(each.id).some((version) => version.contentHash === found.contentHash),
        );
      if (!file || file.documentId === documentId) return;
      const before = liveDocumentOf(file);
      // The copy's Citations would no longer open: the User cited it, so both stay as they are.
      if (before !== null && deps.cited(before)) return;
      if (before !== null) {
        deps.setNotCited(documentId, deps.document(before).notCited);
        deps.retire(before);
      } else {
        const connectedAt = deps.connectedAt(file.pairingId);
        if (connectedAt !== null && agentMadeIt(found, connectedAt)) {
          deps.setNotCited(documentId, true);
        }
      }
      store.setDocument(file.id, documentId);
      for (const version of store.versions(file.id)) {
        if (version.mindId !== null) deps.repoint(version.mindId, documentId);
      }
      deps.notesChanged();
    },

    /**
     * Each handed file whose folder's Document the Library holds already beside a copy, as a scan
     * before #3499 left them: adopted as `adopt` does a file it has just found. Run at start.
     */
    adoptKept(): void {
      for (const file of store.list()) {
        const { documentId } = deps.placeOf(file.path);
        if (documentId !== null && documentId !== file.documentId) this.adopt(documentId);
      }
    },

    handOver(input: HandOverInput): Promise<HandOverDone> {
      const next = queue.then(() => handOverNow(input));
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
      if (
        (earlier === undefined && found !== null && found.version.checkedAt === null) ||
        (earlier?.outcome && !SETTLED.has(earlier.outcome.kind))
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
      } else if (earlier?.outcome !== null) {
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
