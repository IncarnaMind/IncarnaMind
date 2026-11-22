/**
 * The Canvases an outside agent publishes (#3406), within its reach as its Notes are: it publishes
 * only where it may write, in a Folder it reaches or, given Not in a Folder, in no Folder, where it
 * alone reaches what it published (#3364). Every publish is a version; an update is built on the
 * version the agent read, and refused, naming the newest, once there is a newer one. The files a
 * version uses are read from the paths named in that call alone, each on its own.
 */
import { CANVAS_LIMITS } from "../../shared/canvases";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import type { AgentCanvasChange, AgentToolName, Effect } from "../api";
import { NOT_IN_A_FOLDER_ID } from "../api";
import {
  type CanvasCitation,
  type Canvases,
  CanvasesUnavailableError,
  type CanvasFileRecord,
  type RefusedFile,
  type StoredCanvas,
} from "../canvases";
import { tokensOutsideText } from "../canvases/markers";
import { networkReferences } from "../canvases/references";
import type { AdmittedPairing } from "./access";
import { AgentRefusedError, MAX_PATH_CHARS, NotReachedError, text, whole } from "./refusals";

/** The most versions, first publishes and updates together, one pairing publishes in an hour. */
export const MAX_CANVAS_VERSIONS_AN_HOUR = 60;
/** The most characters of a Canvas's HTML one `read_canvas` returns. */
export const CANVAS_PAGE_CHARS = 20_000;
/** The longest name of a Canvas, as of a Note an agent writes. */
const MAX_TITLE_CHARS = 200;
const HOUR_MS = 3_600_000;
const MB = 1024 * 1024;
/** A picture or font inline in the page, as a `data:` address. */
const INLINE_DATA = /data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*,[^"'\s)>]*/g;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export interface CanvasesInput {
  title?: unknown;
  html?: unknown;
  files?: unknown;
  folderId?: unknown;
}

export interface CanvasRefusal {
  /** The path of a file named, or an address the HTML loads from. */
  item: string;
  reason: string;
}

export interface AgentCanvasPublished {
  canvasId: string;
  title: string;
  folder: string;
  version: number;
  /** The files the version has, by the names the HTML refers to them by. */
  files: string[];
  /** Each `[cite:…]` its text cites, and whether it is one IncarnaMind gave this agent. */
  citations: { cite: string; found: boolean }[];
  refused: CanvasRefusal[];
}

export interface AgentCanvasText {
  canvasId: string;
  title: string;
  folder: string;
  version: number;
  html: string;
  offset: number;
  nextOffset: number | null;
  files: { name: string; type: string; size: number }[];
}

/** A Canvas as `list_minds` lists it, in its Folder. */
export interface AgentCanvasListed {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
}

export interface CanvasToolDeps {
  canvases: Pick<Canvases, "list" | "get" | "version" | "publish" | "update">;
  canvasChanged(change: AgentCanvasChange): void;
  /** How many calls of these Tools the pairing made that were done since `since` (ISO 8601, UTC). */
  doneSince(pairingId: string, tools: readonly AgentToolName[], since: string): number;
  folders(): { id: string; name: string }[];
  now(): string;
}

/** What a call returns, with what its activity row says of it, as ./access records it. */
interface Done<T> {
  result: T;
  count: number | null;
  documentIds: string[];
}

export interface CanvasToolContext {
  deps: CanvasToolDeps;
  t(key: MessageKey, params?: MessageParams): string;
  call<T>(
    tool: AgentToolName,
    summary: string,
    effects: Effect[],
    run: (pairing: AdmittedPairing) => Promise<Done<T>>,
  ): Promise<T>;
  /** The Folders the pairing reaches, `NOT_IN_A_FOLDER_ID` among them when it was given that. */
  reached(pairing: AdmittedPairing): ReadonlySet<string>;
  /** Where it may write: a Folder it reaches by `folderId`, or none; a refusal otherwise. */
  placeToWriteIn(pairing: AdmittedPairing, folderId: unknown): { id: string | null; name: string };
  /**
   * The Citations the HTML's text cites, each token with the Citation IncarnaMind minted for this
   * pairing of a Document it reaches, or null.
   */
  cited(
    pairing: AdmittedPairing,
    html: string,
  ): { token: string; citation: CanvasCitation | null }[];
  /** The pairing as it is admitted now: what the User grants may change while a call waits. */
  again(): AdmittedPairing;
}

const WRITES_LIBRARY: Effect = { action: "write", scope: { kind: "library" } };
const READS_LIBRARY: Effect = { action: "read", scope: { kind: "library" } };

/** Whether the pairing reaches a Canvas: in a Folder it reaches, or in none when it published it. */
export const canvasReached = (
  canvas: StoredCanvas,
  pairing: AdmittedPairing,
  reached: ReadonlySet<string>,
): boolean =>
  canvas.folderId === null
    ? reached.has(NOT_IN_A_FOLDER_ID) && canvas.pairingId === pairing.id
    : reached.has(canvas.folderId);

export function createCanvasTools(context: CanvasToolContext) {
  const { deps, t, call } = context;

  const htmlOf = (value: unknown): string => {
    const html = text(value, "html", Number.MAX_SAFE_INTEGER);
    // A picture an agent draws in the cloud can only come inline: it counts toward the Canvas's
    // whole size, not its page's.
    const page = utf8Bytes(html.replace(INLINE_DATA, ""));
    if (page > CANVAS_LIMITS.htmlBytes || utf8Bytes(html) > CANVAS_LIMITS.totalBytes) {
      throw new AgentRefusedError(
        "invalid",
        t("agents.canvas.htmlTooLarge", {
          max: CANVAS_LIMITS.htmlBytes / MB,
          total: CANVAS_LIMITS.totalBytes / MB,
        }),
      );
    }
    return html;
  };

  const pathsOf = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > CANVAS_LIMITS.files * 2 ||
      !value.every(
        (each) => typeof each === "string" && each !== "" && each.length <= MAX_PATH_CHARS,
      )
    ) {
      throw new AgentRefusedError("invalid", t("agents.canvas.paths"));
    }
    return value as string[];
  };

  /** The Canvas named, if the pairing reaches it; a refusal that tells nothing of the others. */
  const reachedCanvas = (pairing: AdmittedPairing, canvasId: unknown): StoredCanvas => {
    const id = text(canvasId, "canvasId", 200);
    const canvas = deps.canvases.get(id);
    if (!canvas || !canvasReached(canvas, pairing, context.reached(pairing))) {
      throw new NotReachedError(t("agents.canvas.notFound"));
    }
    return canvas;
  };

  const folderName = (folderId: string | null) =>
    deps.folders().find((folder) => folder.id === folderId)?.name ?? "";

  const withinHourlyLimit = (pairing: AdmittedPairing) => {
    const since = new Date(Date.parse(deps.now()) - HOUR_MS).toISOString();
    const done = deps.doneSince(pairing.id, ["publish_canvas", "update_canvas"], since);
    if (done >= MAX_CANVAS_VERSIONS_AN_HOUR) {
      throw new AgentRefusedError(
        "too-many",
        t("agents.canvas.tooMany", { max: MAX_CANVAS_VERSIONS_AN_HOUR }),
      );
    }
  };

  const mayWrite = (pairing: AdmittedPairing) => {
    if (!pairing.propose) throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
  };

  const refusals = (refused: readonly RefusedFile[], html: string | null): CanvasRefusal[] => [
    ...refused.map(({ path, why }) => ({
      item: path,
      reason: t(`agents.canvas.refused.${why}`, {
        max:
          why === "too-large"
            ? CANVAS_LIMITS.fileBytes / MB
            : why === "total"
              ? CANVAS_LIMITS.totalBytes / MB
              : CANVAS_LIMITS.files,
      }),
    })),
    ...(html === null ? [] : networkReferences(html)).map((address) => ({
      item: address,
      reason: t("agents.canvas.refused.network"),
    })),
    ...(html === null ? [] : tokensOutsideText(html)).map((token) => ({
      item: `[cite:${token}]`,
      reason: t("agents.canvas.refused.notInText"),
    })),
  ];

  const unavailable = (error: unknown): never => {
    if (error instanceof CanvasesUnavailableError) {
      throw new AgentRefusedError("failed", t("agents.canvas.unavailable"));
    }
    throw error;
  };

  const names = (files: readonly CanvasFileRecord[]) => files.map((file) => file.name);

  const citationsOf = (pairing: AdmittedPairing, html: string) => {
    const cited = context.cited(pairing, html);
    return {
      kept: cited.flatMap(({ citation }) => (citation ? [citation] : [])),
      told: cited.map(({ token, citation }) => ({
        cite: `[cite:${token}]`,
        found: citation !== null,
      })),
    };
  };

  return {
    publishCanvas(input: CanvasesInput): Promise<AgentCanvasPublished> {
      const named = typeof input?.title === "string" ? input.title.trim() : "";
      return call("publish_canvas", named, [WRITES_LIBRARY], async (pairing) => {
        mayWrite(pairing);
        const title = text(input?.title, "title", MAX_TITLE_CHARS);
        const html = htmlOf(input?.html);
        const paths = pathsOf(input?.files);
        const folder = context.placeToWriteIn(pairing, input?.folderId);
        withinHourlyLimit(pairing);
        const citations = citationsOf(pairing, html);
        const { canvas, files, refused } = await deps.canvases
          .publish({
            title,
            html,
            paths,
            citations: citations.kept,
            folderId: folder.id,
            pairingId: pairing.id,
            agent: pairing.name,
            // The grant as it is once the files are read: the User may have taken it back.
            allowed: () => {
              const now = context.again();
              mayWrite(now);
              if (context.placeToWriteIn(now, input?.folderId).id !== folder.id) {
                throw new AgentRefusedError("outside-scope", t("agents.problem.outside-scope"));
              }
            },
          })
          .catch(unavailable);
        deps.canvasChanged({
          canvasId: canvas.id,
          agent: pairing.name,
          kind: "published",
          version: canvas.version,
        });
        return {
          result: {
            canvasId: canvas.id,
            title: canvas.title,
            folder: folder.name,
            version: canvas.version,
            files: names(files),
            citations: citations.told,
            refused: refusals(refused, html),
          },
          count: 1,
          documentIds: [],
        };
      });
    },

    readCanvas(input: { canvasId?: unknown; offset?: unknown }): Promise<AgentCanvasText> {
      const known = typeof input?.canvasId === "string" ? deps.canvases.get(input.canvasId) : null;
      return call("read_canvas", known?.title ?? "", [READS_LIBRARY], async (pairing) => {
        const canvas = reachedCanvas(pairing, input?.canvasId);
        const offset = whole(input?.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
        const version = await deps.canvases.version(canvas.id).catch(unavailable);
        // What the agent reaches may have changed while the version was read.
        const now = context.again();
        if (!canvasReached(deps.canvases.get(canvas.id) ?? canvas, now, context.reached(now))) {
          throw new AgentRefusedError("outside-scope", t("agents.problem.reachChanged"));
        }
        const end = Math.min(version.html.length, offset + CANVAS_PAGE_CHARS);
        return {
          result: {
            canvasId: canvas.id,
            title: canvas.title,
            folder: folderName(canvas.folderId),
            version: version.number,
            html: version.html.slice(offset, end),
            offset,
            nextOffset: end < version.html.length ? end : null,
            files: version.files.map(({ name, type, size }) => ({ name, type, size })),
          },
          count: 1,
          documentIds: [],
        };
      });
    },

    updateCanvas(
      input: CanvasesInput & { canvasId?: unknown; version?: unknown },
    ): Promise<AgentCanvasPublished> {
      const known = typeof input?.canvasId === "string" ? deps.canvases.get(input.canvasId) : null;
      return call("update_canvas", known?.title ?? "", [WRITES_LIBRARY], async (pairing) => {
        mayWrite(pairing);
        const canvas = reachedCanvas(pairing, input?.canvasId);
        const basedOn = whole(input?.version, "version", 1, Number.MAX_SAFE_INTEGER, 0);
        if (basedOn === 0) throw new AgentRefusedError("invalid", t("agents.canvas.version"));
        const title =
          input?.title === undefined ? undefined : text(input.title, "title", MAX_TITLE_CHARS);
        const html = input?.html === undefined ? undefined : htmlOf(input.html);
        const paths = pathsOf(input?.files);
        if (title === undefined && html === undefined && paths.length === 0) {
          throw new AgentRefusedError("invalid", t("agents.canvas.nothing"));
        }
        withinHourlyLimit(pairing);
        const citations = html === undefined ? null : citationsOf(pairing, html);
        const updated = await deps.canvases
          .update(canvas.id, basedOn, {
            paths,
            pairingId: pairing.id,
            agent: pairing.name,
            // The grant as it is once the files are read: the User may have taken it back.
            allowed: () => {
              const now = context.again();
              mayWrite(now);
              reachedCanvas(now, canvas.id);
            },
            ...(title !== undefined && { title }),
            ...(html !== undefined &&
              citations && { html: { text: html, citations: citations.kept } }),
          })
          .catch(unavailable);
        if (updated.kind === "stale") {
          throw new AgentRefusedError(
            "changed",
            t("agents.canvas.stale", { current: updated.canvas.version, given: basedOn }),
          );
        }
        deps.canvasChanged({
          canvasId: canvas.id,
          agent: pairing.name,
          kind: "updated",
          version: updated.canvas.version,
        });
        return {
          result: {
            canvasId: canvas.id,
            title: updated.canvas.title,
            folder: folderName(canvas.folderId),
            version: updated.canvas.version,
            files: names(updated.files),
            citations: citations?.told ?? [],
            refused: refusals(updated.refused, html ?? null),
          },
          count: 1,
          documentIds: [],
        };
      });
    },

    /** The Canvas named, if the pairing reaches it; a refusal that tells nothing of the others. */
    reached: reachedCanvas,

    /** The Canvases in one of the Folders `list_minds` lists, as the pairing reaches them. */
    listedIn(pairing: AdmittedPairing, folderId: string): AgentCanvasListed[] {
      const reached = context.reached(pairing);
      return deps.canvases
        .list()
        .filter(
          (canvas) =>
            (canvas.folderId ?? NOT_IN_A_FOLDER_ID) === folderId &&
            canvasReached(canvas, pairing, reached),
        )
        .map(({ id, title, version, updatedAt }) => ({ id, title, version, updatedAt }));
    },
  };
}
