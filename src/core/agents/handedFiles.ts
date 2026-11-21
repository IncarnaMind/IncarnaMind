/**
 * `hand_over_file` (#3412): a deck, workbook, Word file or PDF an outside agent made, named by its
 * path on this computer. IncarnaMind reads that one file there, as it reads a Canvas's files
 * (`readNamed`: a regular file, never through a link, within a size), keeps it with each version,
 * and checks it against the User's Documents as "Check someone else's file" does, on the model set
 * up in IncarnaMind and with nothing asked of the User. The same path handed over again by the same
 * agent is the same item: other bytes make its next version, the same bytes say how its check is
 * going, so the agent calls again while it runs.
 */
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import type { NamedFile } from "../adapters";
import type { HandOverInput } from "../agentFiles/handOver";
import type { AgentToolName, Effect, HandedFile } from "../api";
import { NOT_IN_A_FOLDER_ID } from "../api";
import type { AdmittedPairing } from "./access";
import { AgentRefusedError, MAX_PATH_CHARS, text } from "./refusals";

/** The largest file one hand-over reads. */
export const MAX_HANDED_BYTES = 50 * 1024 * 1024;
/** The most hand-overs, new versions and checks asked for together, one pairing makes in an hour. */
export const MAX_HAND_OVERS_AN_HOUR = 60;
/** The most claims that need a look one answer lists. */
const MAX_LISTED = 30;
const MAX_TITLE_CHARS = 200;
const HOUR_MS = 3_600_000;
const MB = 1024 * 1024;

/** A file's name without its folder or extension, at most a title's length. */
const titleOf = (path: string): string => {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim().slice(0, MAX_TITLE_CHARS);
};

const KIND_OF: Readonly<Record<string, HandedFile["kind"]>> = {
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".docx": "docx",
  ".pdf": "pdf",
};

/** A claim of the file that needs a look, where it is in the file, and what the check found. */
export interface HandedClaim {
  where: string | null;
  text: string;
  result: string;
  says: string | null;
}

/** A claim as its check found it, with the Documents its result rests on. */
export interface FoundClaim extends HandedClaim {
  documents: readonly string[];
}

/** How a version's check stands. */
export interface HandedCheck {
  status: "checked" | "running" | "not-checked";
  why: string | null;
  supported: number;
  needLook: number;
  claims: FoundClaim[];
  formulas: {
    workedOut: number;
    notWorkedOut: number;
    differ: { cell: string; saved: string; worked: string }[];
  } | null;
}

/** What the agent reads of a hand-over: its claims, each said only from Documents it reaches. */
export interface AgentHandedFile extends Omit<HandedCheck, "claims"> {
  claims: HandedClaim[];
  fileId: string;
  title: string;
  folder: string;
  version: number;
  mindId: string | null;
}

/** What handing a file over did: the item, its version, and the Note its check is in. */
export interface HandOverDone {
  file: HandedFile & { pairingId: string };
  version: number;
  mindId: string | null;
  /** Why no Note was made of it: the file can't be read as its kind, in plain words. */
  unread: string | null;
}

export interface HandedFileToolDeps {
  readNamed?(path: string, maxBytes: number): Promise<NamedFile>;
  /** The item this pairing handed over from `path`, if there is one. */
  handedAt(pairingId: string, path: string): (HandedFile & { pairingId: string }) | null;
  /** Keeps the bytes as the item's version, new or the same, and makes its check's Note. */
  handOver(input: HandOverInput): Promise<HandOverDone>;
  /** How the check of the Note stands, waiting up to `waitMs` for it to end, within `reach`. */
  handedCheck(mindId: string, waitMs: number, reach: ReadonlySet<string>): Promise<HandedCheck>;
  doneSince(pairingId: string, tools: readonly AgentToolName[], since: string): number;
  folders(): { id: string; name: string }[];
  now(): string;
}

export interface HandedFileToolContext {
  deps: HandedFileToolDeps;
  t(key: MessageKey, params?: MessageParams): string;
  call<T>(
    tool: AgentToolName,
    summary: string,
    effects: Effect[],
    run: (
      pairing: AdmittedPairing,
    ) => Promise<{ result: T; count: number | null; documentIds: string[] }>,
  ): Promise<T>;
  reached(pairing: AdmittedPairing): ReadonlySet<string>;
  /** The pairing as it is admitted now: what the User grants it may change while a call waits. */
  again(): AdmittedPairing;
  /** The Documents the pairing reaches. */
  documentsIn(pairing: AdmittedPairing): ReadonlySet<string>;
  /** Whether the pairing reaches the Note. */
  noteReached(pairing: AdmittedPairing, mindId: string): boolean;
  placeToWriteIn(pairing: AdmittedPairing, folderId: unknown): { id: string | null; name: string };
  /** How long a call waits for the check before it answers "running". */
  waitMs: number;
}

const WRITES_LIBRARY: Effect = { action: "write", scope: { kind: "library" } };

export function createHandedFileTool(context: HandedFileToolContext) {
  const { deps, t, call } = context;
  /** Hand-overs a pairing has under way, each holding its place in the hour's count until it ends. */
  const underWay = new Map<string, number>();
  const release = (pairingId: string) => {
    const left = (underWay.get(pairingId) ?? 1) - 1;
    if (left > 0) underWay.set(pairingId, left);
    else underWay.delete(pairingId);
  };

  const kindOf = (path: string): HandedFile["kind"] => {
    const dot = path.lastIndexOf(".");
    const kind = dot < 0 ? undefined : KIND_OF[path.slice(dot).toLowerCase()];
    if (!kind) throw new AgentRefusedError("invalid", t("agents.handOver.kind"));
    return kind;
  };

  const folderName = (folderId: string | null) =>
    deps.folders().find((folder) => folder.id === folderId)?.name ?? "";

  return {
    handOverFile(input: { path?: unknown; folderId?: unknown }): Promise<AgentHandedFile> {
      const named = typeof input?.path === "string" ? titleOf(input.path) : "";
      let reserved: string | null = null;
      const asked = call("hand_over_file", named, [WRITES_LIBRARY], async (pairing) => {
        if (!pairing.propose) {
          throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
        }
        const path = text(input?.path, "path", MAX_PATH_CHARS);
        const kind = kindOf(path);
        // The file's own name is its title, as a Document's is.
        const title = titleOf(path) || t("agents.handOver.untitled");
        const known = deps.handedAt(pairing.id, path);
        const reached = context.reached(pairing);
        if (
          known &&
          !(known.folderId === null ? reached.has(NOT_IN_A_FOLDER_ID) : reached.has(known.folderId))
        ) {
          throw new AgentRefusedError("not-found", t("agents.handOver.notFound"));
        }
        const folder = known
          ? { id: known.folderId, name: folderName(known.folderId) }
          : context.placeToWriteIn(pairing, input?.folderId);
        const since = new Date(Date.parse(deps.now()) - HOUR_MS).toISOString();
        const going = underWay.get(pairing.id) ?? 0;
        // Calls at once each count before any is recorded: a place is taken before the file is read.
        if (
          deps.doneSince(pairing.id, ["hand_over_file"], since) + going >=
          MAX_HAND_OVERS_AN_HOUR
        ) {
          throw new AgentRefusedError(
            "too-many",
            t("agents.handOver.tooMany", { max: MAX_HAND_OVERS_AN_HOUR }),
          );
        }
        underWay.set(pairing.id, going + 1);
        reserved = pairing.id;
        if (!deps.readNamed)
          throw new AgentRefusedError("failed", t("agents.handOver.unavailable"));
        const read = await deps.readNamed(path, MAX_HANDED_BYTES);
        if (read.kind === "too-large") {
          throw new AgentRefusedError(
            "invalid",
            t("agents.handOver.tooLarge", { max: MAX_HANDED_BYTES / MB }),
          );
        }
        if (read.kind !== "read") {
          throw new AgentRefusedError("invalid", t("agents.handOver.unreadable"));
        }
        const done = await deps.handOver({
          pairingId: pairing.id,
          agent: pairing.name,
          path,
          place: read.path,
          connectedAt: pairing.createdAt,
          title,
          kind,
          bytes: read.bytes,
          folderId: folder.id,
          // The grant as it is when the hand-over's turn comes: the User may have taken it back.
          allowed: () => {
            const now = context.again();
            if (!now.propose)
              throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
            const reach = context.reached(now);
            if (!(folder.id === null ? reach.has(NOT_IN_A_FOLDER_ID) : reach.has(folder.id))) {
              throw new AgentRefusedError("not-found", t("agents.handOver.notFound"));
            }
          },
          reaches: (folderId) => {
            const reach = context.reached(context.again());
            return folderId === null ? reach.has(NOT_IN_A_FOLDER_ID) : reach.has(folderId);
          },
          reachesNote: (mindId) => context.noteReached(context.again(), mindId),
          reach: () => context.documentsIn(context.again()),
        });
        const check: HandedCheck =
          done.mindId === null
            ? {
                status: "not-checked",
                why: done.unread,
                supported: 0,
                needLook: 0,
                claims: [],
                formulas: null,
              }
            : await deps.handedCheck(
                done.mindId,
                context.waitMs,
                context.documentsIn(context.again()),
              );
        // What the agent reaches may have changed while the check ran, as check_mind reads it.
        const granted = context.again();
        if (done.mindId !== null && !context.noteReached(granted, done.mindId)) {
          throw new AgentRefusedError("not-found", t("agents.handOver.notFound"));
        }
        const inScope = context.documentsIn(granted);
        const claims = check.claims
          .slice(0, MAX_LISTED)
          .map(
            ({ documents, ...claim }): HandedClaim =>
              documents.every((id) => inScope.has(id)) ? claim : { ...claim, says: null },
          );
        return {
          result: {
            fileId: done.file.id,
            title: done.file.title,
            folder: folder.name,
            version: done.version,
            mindId: done.mindId,
            ...check,
            claims,
          },
          count: 1,
          documentIds: done.file.documentId === null ? [] : [done.file.documentId],
        };
      });
      // Its place in the hour's count is the call's record from now on.
      return asked.finally(() => {
        if (reserved !== null) release(reserved);
      });
    },
  };
}
