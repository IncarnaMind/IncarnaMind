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
import type { HandedCheck, HandedClaim, HandOverDone } from "../agents/handedFiles";
import { AgentRefusedError } from "../agents/refusals";
import type { UnaskedCheck } from "../answers/checks/verify";
import type { Document, HandedFile, VerifyDocumentResult } from "../api";
import { hashBytes } from "../documents/files";
import { type WrittenFile, writeWholeFile } from "../documents/writeWhole";
import type { AgentFiles } from "./index";

/** The data folder's folder of handed-over files. */
export const HANDED_FOLDER = "Handed files";
/** How long a new version's text may take to be read before its check gives up on it. */
const READ_WAIT_MS = 120_000;
/** How often a check waits for a verify run the User started, and for how many times. */
const BUSY_WAIT_MS = 3_000;
const BUSY_TRIES = 100;

/** What a check's Note shows: its claims that need a look, where each is, and its formulas. */
export interface HandedMarks {
  supported: number;
  needLook: HandedClaim[];
  formulas: HandedCheck["formulas"];
}

export interface HandOverDeps {
  store: AgentFiles;
  dataDir: string;
  now(): string;
  newId(): string;
  addHanded(id: string, name: string, file: WrittenFile, kind: HandedFile["kind"]): Document;
  /** Reads the Document's file again, a new version when its bytes changed. */
  readAgain(path: string): Promise<unknown>;
  document(documentId: string): Document;
  contentHashInUse(contentHash: string, exceptDocumentId: string | null): boolean;
  /** Someone else's file, checked: never the evidence for its own claims. */
  setNotCited(documentId: string): void;
  rename(documentId: string, name: string): void;
  assign(documentId: string, folderId: string): void;
  verify(input: {
    documentId: string;
    folderId: string | null;
    allSheets?: boolean;
  }): Promise<VerifyDocumentResult>;
  checkUnasked(mindId: string): Promise<UnaskedCheck>;
  nameMind(mindId: string, title: string): void;
  /** Records the agent as the writer of the check's Note, by which one in no Folder is reached. */
  recordWriter(mindId: string, writer: { agent: string; pairingId: string }): void;
  marks(mindId: string): HandedMarks;
  say(key: MessageKey, params?: MessageParams): string;
  sleep(ms: number): Promise<void>;
  log: Logger;
}

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
  const runs = new Map<string, { done: Promise<UnaskedCheck>; outcome: UnaskedCheck | null }>();
  /** Why a version made no Note, by the version's id. */
  const unread = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  /** Waits until the Document holds `contentHash` and its text is read, or the wait is over. */
  async function versionRead(documentId: string, contentHash: string): Promise<boolean> {
    const until = Date.parse(deps.now()) + READ_WAIT_MS;
    for (;;) {
      const document = deps.document(documentId);
      if (document.contentHash === contentHash) return true;
      if (Date.parse(deps.now()) > until) return false;
      await deps.sleep(250);
    }
  }

  async function checkRun(mindId: string): Promise<UnaskedCheck> {
    for (let tried = 0; ; tried++) {
      const outcome = await deps.checkUnasked(mindId);
      if (outcome.kind !== "busy" || tried >= BUSY_TRIES) return outcome;
      await deps.sleep(BUSY_WAIT_MS);
    }
  }

  function startCheck(mindId: string): void {
    const run: { done: Promise<UnaskedCheck>; outcome: UnaskedCheck | null } = {
      done: checkRun(mindId).catch((error: unknown): UnaskedCheck => {
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

  async function handOverNow(input: {
    pairingId: string;
    agent: string;
    path: string;
    title: string;
    kind: HandedFile["kind"];
    bytes: Uint8Array;
    folderId: string | null;
  }): Promise<HandOverDone> {
    const contentHash = hashBytes(input.bytes);
    const known = store.atPath(input.pairingId, input.path);
    const newest = known ? store.versions(known.id).at(-1) : undefined;
    if (known && newest && newest.contentHash === contentHash) {
      return {
        file: known,
        version: newest.number,
        mindId: newest.mindId,
        unread: unread.get(newest.id) ?? null,
      };
    }
    // Two Documents never hold the same file (ADR-0003).
    if (deps.contentHashInUse(contentHash, known?.documentId ?? null)) {
      throw new AgentRefusedError("invalid", deps.say("agents.handOver.inLibrary"));
    }
    const file =
      known ??
      store.create({
        title: input.title,
        kind: input.kind,
        path: input.path,
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
    const current = join(deps.dataDir, HANDED_FOLDER, file.id, `file.${file.kind}`);
    const written = await writeWholeFile(current, input.bytes, deps.now());
    let documentId = file.documentId;
    if (documentId === null) {
      const document = deps.addHanded(deps.newId(), input.title, written, file.kind);
      documentId = document.id;
      deps.setNotCited(documentId);
      if (file.folderId !== null) deps.assign(documentId, file.folderId);
      store.setDocument(file.id, documentId);
    } else {
      await deps.readAgain(current);
      if (deps.document(documentId).name !== input.title) deps.rename(documentId, input.title);
      if (!(await versionRead(documentId, contentHash))) {
        unread.set(version.id, deps.say("agents.handOver.unread.unreadable"));
        return {
          file: store.get(file.id) ?? file,
          version: version.number,
          mindId: null,
          unread: unread.get(version.id) ?? null,
        };
      }
    }
    const made = await deps.verify({
      documentId,
      folderId: file.folderId,
      ...(file.kind === "xlsx" && { allSheets: true }),
    });
    if (!made.ok) {
      unread.set(version.id, unreadWords(made));
      return {
        file: store.get(file.id) ?? file,
        version: version.number,
        mindId: null,
        unread: unread.get(version.id) ?? null,
      };
    }
    store.setMind(version.id, made.mind.id);
    // Each version's check is a Note of its own: named by its version, so the User tells them apart.
    deps.nameMind(
      made.mind.id,
      deps.say("verify.handed.mindTitle", { name: input.title, version: version.number }),
    );
    deps.recordWriter(made.mind.id, { agent: input.agent, pairingId: input.pairingId });
    startCheck(made.mind.id);
    return {
      file: store.get(file.id) ?? file,
      version: version.number,
      mindId: made.mind.id,
      unread: null,
    };
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
    handOver(input: Parameters<typeof handOverNow>[0]): Promise<HandOverDone> {
      const next = queue.then(() => handOverNow(input));
      queue = next.catch(() => undefined);
      return next;
    },

    /** How the check of the Note stands, waiting up to `waitMs` for a run still going to end. */
    async handedCheck(mindId: string, waitMs: number): Promise<HandedCheck> {
      const before = runs.get(mindId);
      const unmarked = () => {
        const { supported, needLook } = deps.marks(mindId);
        return supported + needLook.length === 0;
      };
      // A check that couldn't run, or that a quit stopped before it marked anything, runs when asked again.
      if ((before === undefined || before.outcome?.kind === "not-asked") && unmarked()) {
        startCheck(mindId);
      }
      const run = runs.get(mindId);
      if (run && run.outcome === null) {
        await Promise.race([run.done, deps.sleep(waitMs)]);
      }
      const marks = deps.marks(mindId);
      const formulas = marks.formulas;
      if (run && run.outcome === null) {
        return {
          status: "running",
          why: null,
          supported: 0,
          needLook: 0,
          claims: [],
          formulas,
        };
      }
      const why = run?.outcome ? notChecked(run.outcome) : null;
      const stop = run?.outcome?.kind === "checked" ? run.outcome.stop : null;
      return {
        status:
          why === null && (run !== undefined || marks.supported + marks.needLook.length > 0)
            ? "checked"
            : "not-checked",
        why: stop ? deps.say(`agents.check.stopped.${stop.reason}`) : why,
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
