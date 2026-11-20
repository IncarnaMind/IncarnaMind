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
import type { AgentToolName, Effect, HandedFile } from "../api";
import { NOT_IN_A_FOLDER_ID } from "../api";
import type { AdmittedPairing } from "./access";
import { AgentRefusedError, text } from "./refusals";

/** The largest file one hand-over reads. */
export const MAX_HANDED_BYTES = 50 * 1024 * 1024;
/** The most hand-overs, new versions and checks asked for together, one pairing makes in an hour. */
export const MAX_HAND_OVERS_AN_HOUR = 60;
/** The most claims that need a look one answer lists. */
const MAX_LISTED = 30;
const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 4096;
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

/** How a version's check stands, as the agent reads it. */
export interface HandedCheck {
  status: "checked" | "running" | "not-checked";
  why: string | null;
  supported: number;
  needLook: number;
  claims: HandedClaim[];
  formulas: {
    workedOut: number;
    notWorkedOut: number;
    differ: { cell: string; saved: string; worked: string }[];
  } | null;
}

export interface AgentHandedFile extends HandedCheck {
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
  handOver(input: {
    pairingId: string;
    agent: string;
    path: string;
    title: string;
    kind: HandedFile["kind"];
    bytes: Uint8Array;
    folderId: string | null;
  }): Promise<HandOverDone>;
  /** How the check of the Note stands, waiting up to `waitMs` for it to end. */
  handedCheck(mindId: string, waitMs: number): Promise<HandedCheck>;
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
  placeToWriteIn(pairing: AdmittedPairing, folderId: unknown): { id: string | null; name: string };
  /** How long a call waits for the check before it answers "running". */
  waitMs: number;
}

const WRITES_LIBRARY: Effect = { action: "write", scope: { kind: "library" } };

export function createHandedFileTool(context: HandedFileToolContext) {
  const { deps, t, call } = context;

  const kindOf = (path: string): HandedFile["kind"] => {
    const dot = path.lastIndexOf(".");
    const kind = dot < 0 ? undefined : KIND_OF[path.slice(dot).toLowerCase()];
    if (!kind) throw new AgentRefusedError("invalid", t("agents.handOver.kind"));
    return kind;
  };

  const folderName = (folderId: string | null) =>
    folderId === null
      ? t("library.unsorted")
      : (deps.folders().find((folder) => folder.id === folderId)?.name ?? "");

  return {
    handOverFile(input: { path?: unknown; folderId?: unknown }): Promise<AgentHandedFile> {
      const named = typeof input?.path === "string" ? titleOf(input.path) : "";
      return call("hand_over_file", named, [WRITES_LIBRARY], async (pairing) => {
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
        if (deps.doneSince(pairing.id, ["hand_over_file"], since) >= MAX_HAND_OVERS_AN_HOUR) {
          throw new AgentRefusedError(
            "too-many",
            t("agents.handOver.tooMany", { max: MAX_HAND_OVERS_AN_HOUR }),
          );
        }
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
          title,
          kind,
          bytes: read.bytes,
          folderId: folder.id,
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
            : await deps.handedCheck(done.mindId, context.waitMs);
        return {
          result: {
            fileId: done.file.id,
            title: done.file.title,
            folder: folder.name,
            version: done.version,
            mindId: done.mindId,
            ...check,
            claims: check.claims.slice(0, MAX_LISTED),
          },
          count: 1,
          documentIds: done.file.documentId === null ? [] : [done.file.documentId],
        };
      });
    },
  };
}
