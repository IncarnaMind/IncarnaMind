/**
 * The usage events the core derives from its own events (see ./usageEvents):
 * Questions asked and Answers finished, the Connectors and Skills they used,
 * and errors, by kind. Like the activity log (./activityLog), each event is
 * built field by field from what is picked here: kinds, counts and flags,
 * never a name, a path, a message or anything the User wrote.
 *
 * Events the User's actions cause through the core's interface (a Mind made,
 * Documents added, a folder linked, Organize, an export) are recorded where
 * those actions are (./core); events from the interface come through
 * `recordUsage`.
 */
import type {
  AddDocumentsResult,
  ChatProviderKind,
  Connector,
  CoreEventListener,
  CoreEventName,
  Document,
  Unsubscribe,
} from "./api";
import {
  BUILT_IN_SKILL_NAMES,
  DOCUMENT_FORMATS,
  type UsageEvent,
  type UsageEventFields,
} from "./usageEvents";

interface EventSource {
  on<E extends CoreEventName>(event: E, listener: CoreEventListener<E>): Unsubscribe;
}

export interface UsageLookups {
  /** A chat provider's kind, and whether its model runs on this computer; null if it's gone. */
  chatProvider(providerId: string): { kind: ChatProviderKind; local: boolean } | null;
  /** Whether a Connector is remote; null if it's gone. */
  connectorIsRemote(connectorId: string): boolean | null;
  /** Whether the Skill of this name is a built-in one. */
  skillIsBuiltIn(name: string): boolean;
  /** Milliseconds, for how long Answers take. */
  now(): number;
}

const isBuiltInSkillName = (name: string): name is (typeof BUILT_IN_SKILL_NAMES)[number] =>
  BUILT_IN_SKILL_NAMES.some((each) => each === name);

/**
 * `documents_added`'s fields for what adding files did: the Documents made
 * since `since` (an ISO time taken just before), counted by format, those
 * that were in already, and the files that couldn't be added.
 */
export function addedCounts(
  result: Pick<AddDocumentsResult, "documents" | "skipped">,
  since: string,
): UsageEventFields<"documents_added"> {
  const fields: UsageEventFields<"documents_added"> = {
    documents: 0,
    already_added: 0,
    skipped: result.skipped.length,
    ...(Object.fromEntries(DOCUMENT_FORMATS.map((format) => [format, 0])) as Record<
      (typeof DOCUMENT_FORMATS)[number],
      number
    >),
  };
  for (const document of new Map(result.documents.map((each) => [each.id, each])).values()) {
    if (document.createdAt < since) {
      fields.already_added++;
    } else {
      fields.documents++;
      fields[document.kind]++;
    }
  }
  return fields;
}

/** Starts deriving usage events from the core's events. Returns a function that stops it. */
export function trackUsage(
  events: EventSource,
  record: (event: UsageEvent) => void,
  lookups: UsageLookups,
): () => void {
  /** When each Answer being written started. */
  const started = new Map<string, number>();
  /** The Connectors and Skills each Answer being written has used, so each counts once. */
  const used = new Map<string, Set<string>>();
  /** Each Document's and Connector's state when last seen, so only changes count. */
  const documents = new Map<string, string>();
  const connectors = new Map<string, string>();

  const onceFor = (answerId: string, key: string) => {
    let seen = used.get(answerId);
    if (!seen) {
      seen = new Set();
      used.set(answerId, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const ended = (answerId: string) => {
    started.delete(answerId);
    used.delete(answerId);
  };

  const onDocument = (document: Document) => {
    const before = documents.get(document.id);
    documents.set(document.id, document.status);
    // A Document that fails now, not one seen failed from an earlier run.
    if (document.status !== "failed" || before === undefined || before === "failed") return;
    record({
      event: "error_occurred",
      fields: { area: "document", kind: document.failure?.reason ?? "processing-error" },
    });
  };

  const onConnectors = (list: Connector[]) => {
    const present = new Set(list.map((connector) => connector.id));
    for (const id of connectors.keys()) if (!present.has(id)) connectors.delete(id);
    for (const connector of list) {
      const kind = connector.state === "error" ? (connector.error?.kind ?? "failed") : "";
      if (connectors.get(connector.id) === kind) continue;
      connectors.set(connector.id, kind);
      if (kind) record({ event: "error_occurred", fields: { area: "connector", kind } });
    }
  };

  const stops = [
    events.on("answer.started", ({ answerId, model }) => {
      started.set(answerId, lookups.now());
      const provider = lookups.chatProvider(model.providerId);
      if (provider) {
        record({
          event: "question_asked",
          fields: { provider: provider.kind, local: provider.local },
        });
      }
    }),
    events.on("answer.toolCallFinished", ({ answerId, call }) => {
      if (call.status !== "done") return;
      if (call.source === "connector" && call.connector) {
        const remote = lookups.connectorIsRemote(call.connector.id);
        if (remote !== null && onceFor(answerId, `connector:${call.connector.id}`)) {
          record({ event: "connector_used", fields: { remote } });
        }
      } else if (call.source === "skill" && call.tool === "use_skill") {
        const name = typeof call.input.name === "string" ? call.input.name : "";
        if (!name || !onceFor(answerId, `skill:${name}`)) return;
        // Only a built-in Skill is named; the User's own is "own", whatever it is called.
        const skill = isBuiltInSkillName(name) && lookups.skillIsBuiltIn(name) ? name : "own";
        record({ event: "skill_used", fields: { skill, forced: call.forced === true } });
      }
    }),
    events.on("answer.finished", ({ answerId, status, citations }) => {
      const from = started.get(answerId);
      ended(answerId);
      const checked = (check: string) => citations.filter((each) => each.check === check).length;
      record({
        event: "answer_finished",
        fields: {
          outcome: status,
          duration_ms: from === undefined ? 0 : Math.max(0, Math.round(lookups.now() - from)),
          citations: citations.length,
          found: checked("found"),
          not_found: checked("not-found"),
          cant_check: checked("cant-check"),
        },
      });
    }),
    events.on("answer.failed", ({ answerId, error }) => {
      ended(answerId);
      record({ event: "error_occurred", fields: { area: "answer", kind: error.kind } });
    }),
    events.on("document.status", onDocument),
    events.on("documents.removed", (ids) => {
      for (const id of ids) documents.delete(id);
    }),
    events.on("connectors.changed", onConnectors),
  ];

  return () => {
    for (const stop of stops) stop();
  };
}
