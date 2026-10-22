/**
 * What the core writes to the log (see `Logger`): Documents' processing and
 * its failures, and the errors of model providers and Connectors, by kind.
 *
 * Entries are built from the core's own events, field by field, so nothing
 * but what is picked here reaches the log: ids, statuses, kinds and counts.
 * Never a Document's name, path or text, Mind content, a Question or an Answer, nor
 * the messages providers and Connectors send back, which can quote any of
 * them, or a key: a failed Answer's message only as `redactMessage` leaves it,
 * so its cause can be found (#1487).
 */
import type { Logger } from "./adapters";
import type {
  Connector,
  CoreEventListener,
  CoreEventName,
  Document,
  Task,
  Unsubscribe,
} from "./api";
import { redactMessage } from "./redact";

/** Logs nothing: the core's log when the host gives none. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface EventSource {
  on<E extends CoreEventName>(event: E, listener: CoreEventListener<E>): Unsubscribe;
}

export interface ActivityLog {
  /** A Document was deleted. */
  documentDeleted(documentId: string): void;
  /** A test of a provider's settings failed, e.g. "chat" with the kind of error. */
  testFailed(what: "chat" | "embedding" | "rerank" | "jev", errorKind: string): void;
  stop(): void;
}

/** Starts logging the core's events. */
export function logActivity(
  events: EventSource,
  log: Logger,
  /** The secrets the core has handled, which no logged message keeps. */
  secrets: ReadonlySet<string> = new Set(),
): ActivityLog {
  /** What was last logged about each Document, Connector…, so only changes are logged. */
  const documents = new Map<string, string>();
  const files = new Map<string, string>();
  const tagging = new Map<string, string>();
  const connectors = new Map<string, string>();
  const signIns = new Map<string, string>();
  const tasks = new Map<string, string>();
  let embeddingError: string | null = null;
  let modelState: string | null = null;

  /** True if `key`'s state is new, and remembers it. */
  const changed = (seen: Map<string, string>, key: string, state: string) => {
    if (seen.get(key) === state) return false;
    seen.set(key, state);
    return true;
  };

  const onDocument = (document: Document) => {
    // Its file went missing, can't be reached, or is back: by status, never by path.
    const knownFile = files.get(document.id);
    if (changed(files, document.id, document.fileStatus) && knownFile !== undefined) {
      log.info("document.file", { documentId: document.id, file: document.fileStatus });
    }
    const first = !documents.has(document.id);
    if (!changed(documents, document.id, document.status)) return;
    const fields = { documentId: document.id, kind: document.kind };
    if (document.status === "failed") {
      log.warn("document.failed", { ...fields, reason: document.failure?.reason ?? null });
      return;
    }
    log.info("document.status", {
      ...fields,
      status: document.status,
      bytes: first ? document.size : undefined,
      pages: document.pageCount ?? undefined,
    });
  };

  const onTagged = (list: Document[]) => {
    for (const document of list) {
      const error = document.tagging === "failed" ? (document.taggingError?.kind ?? "unknown") : "";
      if (!changed(tagging, document.id, `${document.tagging}:${error}`)) continue;
      if (error) log.warn("tagging.failed", { documentId: document.id, errorKind: error });
    }
  };

  const onConnectors = (list: Connector[]) => {
    const present = new Set(list.map((connector) => connector.id));
    for (const seen of [connectors, signIns]) {
      for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
    }
    for (const connector of list) {
      const fields = { connectorId: connector.id, transport: connector.transport };
      const errorKind = connector.state === "error" ? (connector.error?.kind ?? "failed") : "";
      if (changed(connectors, connector.id, `${connector.state}:${errorKind}`)) {
        if (errorKind) {
          log.warn("connector.failed", {
            ...fields,
            errorKind,
            retrying: connector.error?.retrying ?? false,
          });
        } else {
          log.info("connector.state", { ...fields, state: connector.state });
        }
      }
      if (connector.transport !== "http") continue;
      const signInError = connector.signIn.error?.kind ?? "";
      if (changed(signIns, connector.id, signInError) && signInError) {
        log.warn("connector.signInFailed", { ...fields, errorKind: signInError });
      }
    }
  };

  // A Task's state as it changes (#126): ids, kinds and statuses, never what it works on.
  const onTask = (task: Task) => {
    const state = `${task.status}:${task.pausedReason ?? ""}:${task.ask?.kind ?? ""}`;
    if (!changed(tasks, task.id, state)) return;
    const fields = {
      taskId: task.id,
      kind: task.kind,
      status: task.status,
      reason: task.pausedReason ?? undefined,
      ask: task.ask?.kind,
      problem: task.problem ?? undefined,
    };
    if (task.status === "failed") log.warn("task.failed", fields);
    else log.info("task.status", fields);
    if (task.finishedAt) tasks.delete(task.id);
  };

  const stops = [
    events.on("document.status", onDocument),
    events.on("task.changed", onTask),
    events.on("documents.tagged", onTagged),
    events.on("connectors.changed", onConnectors),
    events.on("answer.failed", ({ answerId, error }) =>
      log.warn("answer.failed", {
        answerId,
        errorKind: error.kind,
        status: error.status,
        message: redactMessage(error.message, [...secrets]),
      }),
    ),
    events.on("embedding.changed", ({ provider, error }) => {
      const kind = error?.kind ?? null;
      if (kind === embeddingError) return;
      embeddingError = kind;
      if (kind) log.warn("embedding.failed", { provider: provider.kind, errorKind: kind });
      else log.info("embedding.recovered", { provider: provider.kind });
    }),
    events.on("embeddingModel.status", ({ state, error }) => {
      if (state === modelState) return;
      modelState = state;
      if (state === "failed") log.warn("embeddingModel.failed", { errorKind: error?.kind ?? null });
      else log.info("embeddingModel.status", { state });
    }),
  ];

  return {
    documentDeleted(documentId) {
      documents.delete(documentId);
      files.delete(documentId);
      tagging.delete(documentId);
      log.info("document.deleted", { documentId });
    },
    testFailed(what, errorKind) {
      log.warn(`${what}.testFailed`, { errorKind });
    },
    stop() {
      for (const stop of stops) stop();
    },
  };
}
