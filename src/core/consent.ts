/**
 * Data-flow consent: nothing leaves the machine on a flow until the User has
 * accepted that flow for that service (ADR-0022).
 *
 * Core modules register their external flows here and call `ensure` before
 * every request. Choosing a service where a line says what goes to it (the
 * chat model's provider in setup or Settings, a search service, a Connector)
 * allows its flows at once: `choose`. A flow the User hasn't allowed asks
 * once: `ensure` raises a "consent.requested" event and waits for the UI to
 * answer with `respondToConsent`, except on a background flow, which never
 * asks and throws `ConsentNeededError`, so its work waits. Decisions are kept
 * per flow and service. A flow that starts sending a new kind of data asks
 * again; a declined flow stays unused until the User revokes the decision or
 * allows it in Settings (the Privacy page lists every registered flow).
 */
import { randomUUID } from "node:crypto";
import {
  type ConsentRequest,
  type DataFlow,
  type DataFlowId,
  type DataFlowStatus,
  type DataKind,
  dataFlowIds,
  dataKinds,
  type ExternalService,
  type RegisteredDataFlow,
} from "./api";
import {
  ConsentDeclinedError,
  ConsentNeededError,
  InvalidInputError,
  NotFoundError,
} from "./errors";
import type { createEventHub } from "./events";
import type { Database } from "./storage";

export interface DataFlowDefinition {
  id: DataFlowId;
  /** Every kind of data the flow sends. When this grows, the User is asked again. */
  sends: readonly DataKind[];
  /** What it sends to one service besides (GovInfo is sent the User's key), asked about for that service alone. */
  sendsTo?(serviceId: string): readonly DataKind[];
  /** The external services the flow currently goes to; empty when everything stays on this computer. */
  services(): Promise<ExternalService[]>;
  /** Background work, which never asks (ADR-0022): it waits until the User allows the flow. */
  background?: boolean;
  /** Whether a service the flow goes to runs on this computer, so Local mode doesn't stop it. Absent: none does. */
  onThisComputer?(serviceId: string): boolean;
}

/** The registry of every external data flow. Registering an id again replaces it. */
export interface DataFlowRegistry {
  register(definition: DataFlowDefinition): void;
  get(id: DataFlowId): DataFlowDefinition | undefined;
  list(): DataFlowDefinition[];
}

type Decision = "accepted" | "declined";

interface ConsentRow {
  decision: Decision;
  data_kinds: string;
  chosen: number;
  updated_at: string;
}

interface Pending {
  key: string;
  request: ConsentRequest;
  promise: Promise<void>;
  settle(): void;
  fail(error: Error): void;
}

export type ConsentStatus = DataFlowStatus["consent"];

export type Consent = ReturnType<typeof createConsent>;

const isDataKind = (value: unknown): value is DataKind => dataKinds.some((kind) => kind === value);
const isDataFlowId = (value: unknown): value is DataFlowId =>
  dataFlowIds.some((id) => id === value);

export function createConsent(
  db: Database,
  events: ReturnType<typeof createEventHub>,
  now: () => string,
) {
  const definitions = new Map<DataFlowId, DataFlowDefinition>();
  const pending = new Map<string, Pending>();

  const registry: DataFlowRegistry = {
    register(definition) {
      definitions.set(definition.id, { ...definition, sends: [...definition.sends] });
    },
    get: (id) => definitions.get(id),
    list: () => [...definitions.values()],
  };

  const flowFor = (id: DataFlowId, service: ExternalService): DataFlow => {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`No data flow "${id}" is registered.`);
    const sends = [...new Set([...definition.sends, ...(definition.sendsTo?.(service.id) ?? [])])];
    return {
      id,
      service: {
        id: service.id,
        name: service.name,
        ...(service.catalogId ? { catalogId: service.catalogId } : {}),
      },
      sends,
    };
  };

  const find = (flow: DataFlowId, serviceId: string) =>
    db.get<ConsentRow>(
      `SELECT decision, data_kinds, chosen, updated_at FROM data_flow_consents
       WHERE flow = ? AND service_id = ? AND deleted_at IS NULL`,
      [flow, serviceId],
    );

  const acceptedKinds = (row: ConsentRow): DataKind[] => {
    try {
      const kinds: unknown = JSON.parse(row.data_kinds);
      return Array.isArray(kinds) ? kinds.filter(isDataKind) : [];
    } catch {
      return [];
    }
  };

  /** The User's decision on a flow, and what it sends that they haven't accepted. */
  const statusOf = (flow: DataFlow) => {
    const row = find(flow.id, flow.service.id);
    if (!row) {
      return { consent: "not-asked" as const, decidedAt: null, chosen: false, missing: flow.sends };
    }
    if (row.decision === "declined") {
      return {
        consent: "declined" as const,
        decidedAt: row.updated_at,
        chosen: false,
        missing: [],
      };
    }
    const accepted = acceptedKinds(row);
    const missing = flow.sends.filter((kind) => !accepted.includes(kind));
    const chosen = row.chosen === 1;
    return missing.length === 0
      ? { consent: "accepted" as const, decidedAt: row.updated_at, chosen, missing }
      : // Allowed before it sent more: when, so the Privacy page can say it asks again.
        { consent: "not-asked" as const, decidedAt: row.updated_at, chosen, missing };
  };

  /** `chosen`: allowed by choosing the service (ADR-0022), not in a dialog or in Settings › Privacy. */
  const record = (
    flow: DataFlow,
    decision: Decision,
    kinds: readonly DataKind[],
    chosen = false,
  ) => {
    const at = now();
    const json = JSON.stringify(kinds);
    const chosenValue = chosen ? 1 : 0;
    db.transaction(() => {
      if (find(flow.id, flow.service.id)) {
        db.run(
          `UPDATE data_flow_consents
           SET decision = ?, data_kinds = ?, chosen = ?, service_name = ?, updated_at = ?
           WHERE flow = ? AND service_id = ? AND deleted_at IS NULL`,
          [decision, json, chosenValue, flow.service.name, at, flow.id, flow.service.id],
        );
      } else {
        db.run(
          `INSERT INTO data_flow_consents
             (id, flow, service_id, service_name, decision, data_kinds, chosen, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            flow.id,
            flow.service.id,
            flow.service.name,
            decision,
            json,
            chosenValue,
            at,
            at,
          ],
        );
      }
    });
  };

  const keyOf = (flow: DataFlow) => `${flow.id}\n${flow.service.id}`;

  /** The request already waiting for this flow and service, if any. */
  const waitingFor = (flow: DataFlow): Pending | undefined => {
    const key = keyOf(flow);
    for (const entry of pending.values()) if (entry.key === key) return entry;
    return undefined;
  };

  /** Raises a consent request, or joins the one already waiting for this flow and service. */
  const ask = (flow: DataFlow, newKinds: DataKind[]): Pending => {
    const waiting = waitingFor(flow);
    if (waiting) return waiting;
    const key = keyOf(flow);

    let settle!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const request: ConsentRequest = { requestId: randomUUID(), flow, newKinds };
    const entry: Pending = { key, request, promise, settle, fail };
    pending.set(request.requestId, entry);
    events.emit("consent.requested", request);
    return entry;
  };

  /** Accepts everything the flow sends, keeping the kinds accepted before. */
  const recordAccepted = (flow: DataFlow, chosen = false) => {
    const row = find(flow.id, flow.service.id);
    const previous = row?.decision === "accepted" ? acceptedKinds(row) : [];
    record(flow, "accepted", [...new Set([...previous, ...flow.sends])], chosen);
  };

  const close = (entry: Pending, accepted: boolean) => {
    const { requestId } = entry.request;
    pending.delete(requestId);
    events.emit("consent.resolved", { requestId, accepted });
    entry.settle();
  };

  /** Records the User's answer to a waiting request, and lets the requests waiting on it go on. */
  const answer = (entry: Pending, accepted: boolean, chosen = false) => {
    const { flow } = entry.request;
    if (accepted) recordAccepted(flow, chosen);
    else record(flow, "declined", []);
    close(entry, accepted);
  };

  /**
   * A decision brought back answers the request waiting on the same flow and service, as allowing
   * it does, unless the flow has grown since: that still asks about what is new.
   */
  const settleWaiting = (flowId: DataFlowId, serviceId: string) => {
    for (const entry of [...pending.values()]) {
      const { flow } = entry.request;
      if (flow.id !== flowId || flow.service.id !== serviceId) continue;
      const { consent } = statusOf(flowFor(flowId, flow.service));
      if (consent !== "not-asked") close(entry, consent === "accepted");
    }
  };

  /**
   * The services a flow goes to now, then every other service the User has
   * decided on (e.g. a provider tested but not kept), each once.
   */
  const servicesOf = async (definition: DataFlowDefinition): Promise<ExternalService[]> => {
    const decided = db.all<{ service_id: string; service_name: string }>(
      `SELECT service_id, service_name FROM data_flow_consents
       WHERE flow = ? AND deleted_at IS NULL ORDER BY created_at, rowid`,
      [definition.id],
    );
    const services = [
      ...(await definition.services()),
      ...decided.map((row) => ({ id: row.service_id, name: row.service_name })),
    ];
    const seen = new Set<string>();
    return services.filter((service) => {
      if (seen.has(service.id)) return false;
      seen.add(service.id);
      return true;
    });
  };

  const named = (flowId: unknown, serviceId: unknown) => {
    if (!isDataFlowId(flowId)) throw new InvalidInputError(`Unknown data flow "${flowId}".`);
    if (typeof serviceId !== "string") throw new InvalidInputError("serviceId must be text.");
    return { flowId, serviceId };
  };

  /** Every registered flow, including one going nowhere now, with each service and its decision. */
  const listRegistered = async (): Promise<RegisteredDataFlow[]> => {
    const result: RegisteredDataFlow[] = [];
    for (const definition of definitions.values()) {
      const services = (await servicesOf(definition)).map((service): DataFlowStatus => {
        const flow = flowFor(definition.id, service);
        const { consent, decidedAt, chosen } = statusOf(flow);
        return { flow, consent, decidedAt, chosen };
      });
      result.push({ id: definition.id, sends: [...definition.sends], services });
    }
    return result;
  };

  return {
    registry,

    /** The User's decision on a flow to a service. */
    status(flowId: DataFlowId, service: ExternalService): ConsentStatus {
      return statusOf(flowFor(flowId, service)).consent;
    },

    /** Whether the flow is background work, which never asks. */
    isBackground: (flowId: DataFlowId) => definitions.get(flowId)?.background === true,

    onThisComputer: (flowId: DataFlowId, serviceId: string) =>
      definitions.get(flowId)?.onThisComputer?.(serviceId) === true,

    dataFlow: flowFor,

    /** When the User accepted the flow to the service, if their acceptance stands; else null. */
    acceptedAt(flowId: DataFlowId, service: ExternalService): string | null {
      const row = find(flowId, service.id);
      return row?.decision === "accepted" ? row.updated_at : null;
    },

    /**
     * Whether the User's acceptance of the flow to the service still stands. A flow that has
     * since grown to send more still counts: work started before it grew doesn't send the more.
     */
    allows(flowId: DataFlowId, service: ExternalService): boolean {
      return find(flowId, service.id)?.decision === "accepted";
    },

    /**
     * Resolves once the User has accepted everything the flow sends to the
     * service, asking them first if needed. Throws `ConsentDeclinedError` if
     * they declined, and, on a background flow, which never asks,
     * `ConsentNeededError` if they haven't allowed it: the caller must not
     * send anything.
     */
    async ensure(flowId: DataFlowId, service: ExternalService): Promise<void> {
      for (;;) {
        const flow = flowFor(flowId, service);
        const { consent, missing } = statusOf(flow);
        if (consent === "accepted") return;
        if (consent === "declined") throw new ConsentDeclinedError(flow);
        if (definitions.get(flowId)?.background) throw new ConsentNeededError(flow);
        // The decision is recorded before the request settles, so the loop re-checks it.
        await ask(flow, missing).promise;
      }
    },

    /**
     * The User chose `service` where a line said what goes to it (ADR-0022):
     * each of `flowIds` to it is allowed, as chosen, and requests waiting for
     * one are answered. The choice is the consent, so it replaces an earlier
     * decline too. `unnamed`: kinds of data the line doesn't name, which
     * still ask. A flow that isn't registered is left out.
     */
    choose(
      flowIds: readonly DataFlowId[],
      service: ExternalService,
      unnamed: readonly DataKind[] = [],
    ): void {
      for (const flowId of flowIds) {
        if (!definitions.has(flowId)) continue;
        const flow = flowFor(flowId, service);
        const named = { ...flow, sends: flow.sends.filter((kind) => !unnamed.includes(kind)) };
        const waiting = waitingFor(flow);
        if (waiting && named.sends.length === flow.sends.length) answer(waiting, true, true);
        else recordAccepted(named, true);
      }
    },

    respond(requestId: unknown, accept: unknown): void {
      if (typeof requestId !== "string") throw new InvalidInputError("requestId must be text.");
      if (typeof accept !== "boolean") throw new InvalidInputError("accept must be true or false.");
      const entry = pending.get(requestId);
      if (!entry) return; // Already answered, e.g. in another window.
      answer(entry, accept);
    },

    /**
     * The User allows a flow to a service from Settings, without being asked.
     * The service must be one the flow goes to now, or one already decided on.
     */
    async allow(flowInput: unknown, serviceInput: unknown): Promise<void> {
      const { flowId, serviceId } = named(flowInput, serviceInput);
      const definition = definitions.get(flowId);
      const services = definition ? await servicesOf(definition) : [];
      const service = services.find((each) => each.id === serviceId);
      if (!service)
        throw new NotFoundError(`The "${flowId}" data flow doesn't go to ${serviceId}.`);
      const flow = flowFor(flowId, service);
      const waiting = waitingFor(flow);
      if (waiting) answer(waiting, true);
      else recordAccepted(flow);
    },

    /** Forgets the decision. Returns when, for `restore`; null when there was none. */
    revoke(flowInput: unknown, serviceInput: unknown): string | null {
      const { flowId, serviceId } = named(flowInput, serviceInput);
      return db.transaction(() => {
        if (!find(flowId, serviceId)) return null;
        const at = now();
        // updated_at stays: it is the date the Privacy page gives for the decision, and Undo
        // brings the decision back with it. Consent is per device and never syncs.
        db.run(
          `UPDATE data_flow_consents SET deleted_at = ?
           WHERE flow = ? AND service_id = ? AND deleted_at IS NULL`,
          [at, flowId, serviceId],
        );
        return at;
      });
    },

    /**
     * Brings back the decision `revoke` forgot at `revokedAt`, as it was: the same kinds of data
     * and date, chosen or not, even for a service the flow no longer goes to. A decision made since
     * stands, and so does a later forgetting. A request waiting on it is answered.
     */
    restore(flowInput: unknown, serviceInput: unknown, revokedAt: unknown): void {
      const { flowId, serviceId } = named(flowInput, serviceInput);
      if (typeof revokedAt !== "string" || revokedAt === "") {
        throw new InvalidInputError("revokedAt must be the time the decision was revoked.");
      }
      db.transaction(() => {
        if (find(flowId, serviceId)) return;
        // Only the newest forgetting comes back: an older one is stale once a later decision was made.
        db.run(
          `UPDATE data_flow_consents SET deleted_at = NULL
           WHERE id = (
             SELECT id FROM data_flow_consents
             WHERE flow = ? AND service_id = ? AND deleted_at IS NOT NULL
             ORDER BY deleted_at DESC, rowid DESC LIMIT 1
           ) AND deleted_at = ?`,
          [flowId, serviceId, revokedAt],
        );
      });
      settleWaiting(flowId, serviceId);
    },

    listRegistered,

    /**
     * Each flow to every service it currently goes to, then every other
     * service the User has decided on, so every decision can be seen and
     * revoked: `listRegistered`, as one list.
     */
    async list(): Promise<DataFlowStatus[]> {
      return (await listRegistered()).flatMap((flow) => flow.services);
    },

    requests(): ConsentRequest[] {
      return [...pending.values()].map((entry) => entry.request);
    },

    /**
     * Fails each waiting request `refuses` names with `error`, and closes its prompt: what the User
     * would answer no longer matters, e.g. once Local mode is on.
     */
    refuseWaiting(refuses: (request: ConsentRequest) => boolean, error: () => Error): void {
      for (const entry of [...pending.values()]) {
        if (!refuses(entry.request)) continue;
        pending.delete(entry.request.requestId);
        events.emit("consent.resolved", { requestId: entry.request.requestId, accepted: false });
        entry.fail(error());
      }
    },

    /** Fails every request still waiting, so nothing is left hanging after the core closes. */
    close(): void {
      for (const entry of pending.values()) entry.fail(new Error("IncarnaMind closed."));
      pending.clear();
    },
  };
}
