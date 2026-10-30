/**
 * Outside agents (#351, experimental): AI agents the User runs themselves,
 * such as Claude Code or Codex, that use IncarnaMind as an MCP server (ADR-0013,
 * addendum of 2026-10-11). Each is a pairing the User makes: a name, the
 * Folders it may read (none until the User picks some; Not in a Folder is one
 * of the list's entries, as `NOT_IN_A_FOLDER_ID`, so storing it needs no
 * migration, and an older version drops it as a Folder that doesn't exist),
 * its own consent (the "agents" data flow, one service per pairing) and a
 * token only it holds, kept by ../secrets. Off by default: nothing listens
 * until the User turns it on, and Local mode pauses every pairing, because
 * an agent sends what it reads to a model IncarnaMind can't see.
 *
 * Calls arrive through the shim on the socket (./socket, ./mcp) and go
 * through one interface (./access), which checks the pairing at every call
 * and keeps each call for the pairing's activity list. Unpairing deletes the
 * token, closes the pairing's connections and revokes its consent at once.
 * The token is never logged, stored in the database or shown in the activity.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { AGENT_SOCKET_ENV, AGENT_TOKEN_ENV } from "../../shared/agentSocket";
import type { Logger } from "../adapters";
import {
  AGENT_TOOLS,
  type AgentActivity,
  type AgentLaunch,
  type AgentPairing,
  type AgentProblem,
  type AgentSettings,
  type AgentToolName,
  type ConnectedAgent,
  type DataKind,
  type Effect,
  type ExternalService,
  NOT_IN_A_FOLDER_ID,
} from "../api";
import type { Consent } from "../consent";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Secrets } from "../secrets";
import type { Database } from "../storage";
import {
  type AdmittedPairing,
  type AgentAccess,
  type AgentAccessDeps,
  AgentRefusedError,
  createAgentAccess,
} from "./access";
import { createAgentCitations } from "./citations";
import type { ServedConnection } from "./mcp";
import { type AgentListener, listenForAgents } from "./socket";

export { type AgentAccess, AgentRefusedError } from "./access";
export { agentSocketPath } from "./socket";

/** What the "agents" flow sends to a paired agent. */
export const AGENT_FLOW_SENDS: readonly DataKind[] = ["scoped-passages", "scoped-minds", "answers"];

/** The device setting that turns connecting agents on. */
const ENABLED_KEY = "agentsEnabled";
/** Each pairing's token, in ../secrets. */
const secretName = (pairingId: string) => `agent-pairing:${pairingId}`;
/** How a pairing is named as a service of the "agents" data flow. */
const serviceOf = (pairing: { id: string; name: string }): ExternalService => ({
  id: `agent:${pairing.id}`,
  name: pairing.name,
});
/** The activity kept per pairing; older calls go. */
const ACTIVITY_KEPT = 500;
/** How often a pairing's "last used" time is written while it keeps calling. */
const LAST_USED_EVERY_MS = 60_000;
const MAX_NAME_CHARS = 80;

/** How an agent starts the shim: the command and arguments for its MCP settings. */
export interface AgentLauncher {
  command: string;
  args: string[];
  /** Set for the shim besides the pairing's own, e.g. `ELECTRON_RUN_AS_NODE`. */
  env?: Record<string, string>;
}

export interface AgentsOptions {
  offered: boolean;
  log: Logger;
  db: Database;
  now(): string;
  clock(): number;
  secrets: Pick<Secrets, "set" | "tryGet" | "delete">;
  consent: Pick<Consent, "status" | "choose" | "revoke" | "registry">;
  readValue(key: string): unknown;
  writeValue(key: string, value: unknown): void;
  /** Local mode is on: every pairing is paused. */
  localOnly(): boolean;
  /** Where the shim reaches the app (see ./socket). */
  socketPath: string;
  launcher: AgentLauncher;
  /** This build's version, as the server names itself to agents. */
  version: string;
  /** What the calls read (see ./access). */
  access: Omit<AgentAccessDeps, "admit" | "record" | "citations" | "clock" | "reportError">;
  /** Whether this agent has IncarnaMind's Skill installed (see ./setup). */
  skillInstalled(client: string | null): boolean;
  changed(settings: AgentSettings): void;
  called(activity: AgentActivity): void;
  reportError(error: unknown): void;
}

interface PairingRow {
  id: string;
  name: string;
  folder_ids: string;
  client: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface ActivityRow {
  id: string;
  pairing_id: string;
  tool: string;
  summary: string;
  outcome: string;
  problem: string | null;
  result_count: number | null;
  document_ids: string;
  effects: string;
  duration_ms: number;
  created_at: string;
}

function parseList<T>(json: string): T[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

const toPairing = (row: PairingRow): AgentPairing => ({
  id: row.id,
  name: row.name,
  folderIds: parseList<string>(row.folder_ids).filter((id) => typeof id === "string"),
  client: row.client,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
});

const isTool = (tool: string): tool is AgentToolName =>
  (AGENT_TOOLS as readonly string[]).includes(tool);

const toActivity = (row: ActivityRow): AgentActivity => ({
  id: row.id,
  pairingId: row.pairing_id,
  tool: isTool(row.tool) ? row.tool : "search",
  summary: row.summary,
  outcome: row.outcome === "refused" || row.outcome === "failed" ? row.outcome : "done",
  problem: (row.problem as AgentProblem | null) ?? null,
  count: row.result_count,
  documentIds: parseList<string>(row.document_ids),
  effects: parseList<Effect>(row.effects),
  durationMs: row.duration_ms,
  at: row.created_at,
});

const digest = (token: string) => createHash("sha256").update(token).digest();

export function createAgents(options: AgentsOptions) {
  const { db } = options;
  const citations = createAgentCitations(db, options.now);
  /** Tokens read from ../secrets, by pairing, so a connection needn't read the keychain. */
  const tokens = new Map<string, string>();
  /** The connections being served, by pairing (null: a token that belongs to none). */
  const connections = new Map<string | null, Set<ServedConnection>>();
  /** When each pairing's "last used" time was last written. */
  const lastWritten = new Map<string, number>();
  let listener: AgentListener | null = null;
  /** Starting and stopping the listener, one after another, so two quick toggles can't race. */
  let listening: Promise<void> = Promise.resolve();
  let closed = false;
  let mcp: Promise<typeof import("./mcp")> | null = null;

  const turnedOn = () => options.readValue(ENABLED_KEY) === true;
  const enabled = () => options.offered && turnedOn();
  const say = options.access.say;

  const livePairings = () =>
    db
      .all<PairingRow>(
        `SELECT id, name, folder_ids, client, last_used_at, created_at FROM agent_pairings
         WHERE deleted_at IS NULL ORDER BY created_at, rowid`,
      )
      .map(toPairing);

  const findPairing = (pairingId: string): AgentPairing | null => {
    const row = db.get<PairingRow>(
      `SELECT id, name, folder_ids, client, last_used_at, created_at FROM agent_pairings
       WHERE id = ? AND deleted_at IS NULL`,
      [pairingId],
    );
    return row ? toPairing(row) : null;
  };

  const createdPaths = (pairingId: string): string[] => {
    const row = db.get<{ created_paths: string }>(
      "SELECT created_paths FROM agent_pairings WHERE id = ?",
      [pairingId],
    );
    return parseList<string>(row?.created_paths ?? "[]").filter((each) => typeof each === "string");
  };

  const requirePairing = (pairingId: unknown): AgentPairing => {
    if (typeof pairingId !== "string" || pairingId === "") {
      throw new InvalidInputError("A pairing id must be text.");
    }
    const pairing = findPairing(pairingId);
    if (!pairing) throw new NotFoundError({ key: "error.agent.notConnected" });
    return pairing;
  };

  const settings = (): AgentSettings => {
    const pairings = livePairings();
    return {
      enabled: enabled(),
      paused: options.localOnly() ? "local-mode" : null,
      pairings,
      skills: pairings.filter((each) => options.skillInstalled(each.client)).map((each) => each.id),
    };
  };

  const changed = () => options.changed(settings());

  if (options.offered) {
    options.consent.registry.register({
      id: "agents",
      sends: AGENT_FLOW_SENDS,
      services: async () => livePairings().map(serviceOf),
    });
  }

  const parseName = (value: unknown, exceptId: string | null): string => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new InvalidInputError({ key: "error.agent.nameEmpty" });
    }
    const name = value.trim();
    if (name.length > MAX_NAME_CHARS) {
      throw new InvalidInputError({
        key: "error.agent.nameTooLong",
        values: { max: MAX_NAME_CHARS },
      });
    }
    const taken = livePairings().some(
      (pairing) =>
        pairing.id !== exceptId && pairing.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (taken) throw new InvalidInputError({ key: "error.agent.nameTaken", values: { name } });
    return name;
  };

  const parseClient = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) {
      throw new InvalidInputError("client must be an agent's id, such as codex.");
    }
    return value;
  };

  const assertFoldersCanShare = (folderIds: readonly string[]) => {
    if (folderIds.length < 2) return;
    const walled = options.access
      .folders()
      .find((folder) => folder.keepInside === true && folderIds.includes(folder.id));
    if (walled) {
      throw new AgentRefusedError(
        "outside-scope",
        say("agents.problem.wallShared", { folder: walled.name }),
      );
    }
  };

  const parseFolders = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
      throw new InvalidInputError("folderIds must be a list of Folder ids.");
    }
    const live = new Set(options.access.folders().map((folder) => folder.id));
    const unknown = value.find((id) => id !== NOT_IN_A_FOLDER_ID && !live.has(id));
    if (unknown !== undefined) throw new NotFoundError({ key: "error.folder.notFound" });
    assertFoldersCanShare(value as string[]);
    return [...new Set(value as string[])];
  };

  /** The pairing's token, from memory or ../secrets; null when it can't be read. */
  const tokenOf = async (pairingId: string): Promise<string | null> => {
    const known = tokens.get(pairingId);
    if (known) return known;
    const stored = await options.secrets.tryGet(secretName(pairingId));
    if (stored) tokens.set(pairingId, stored);
    return stored;
  };

  /** The pairing a token belongs to, compared in constant time; null for none. */
  const pairingOfToken = async (token: string): Promise<string | null> => {
    const given = digest(token);
    for (const pairing of livePairings()) {
      const own = await tokenOf(pairing.id);
      if (own && timingSafeEqual(digest(own), given)) return pairing.id;
    }
    return null;
  };

  const launchFor = (token: string): AgentLaunch => ({
    command: options.launcher.command,
    args: [...options.launcher.args],
    env: {
      ...options.launcher.env,
      [AGENT_SOCKET_ENV]: options.socketPath,
      [AGENT_TOKEN_ENV]: token,
    },
  });

  const refusal = (problem: AgentProblem) =>
    new AgentRefusedError(problem, say(`agents.problem.${problem}`));

  /** Notes that a pairing called, at most once a minute. */
  const touch = (pairingId: string) => {
    const now = options.clock();
    if (now - (lastWritten.get(pairingId) ?? Number.NEGATIVE_INFINITY) < LAST_USED_EVERY_MS) return;
    lastWritten.set(pairingId, now);
    const at = options.now();
    db.run("UPDATE agent_pairings SET last_used_at = ?, updated_at = ? WHERE id = ?", [
      at,
      at,
      pairingId,
    ]);
    changed();
  };

  const admit = (pairingId: string): AdmittedPairing => {
    if (closed) throw refusal("off");
    const pairing = findPairing(pairingId);
    if (!pairing) throw refusal("unpaired");
    if (!enabled()) throw refusal("off");
    if (options.localOnly()) throw refusal("local-mode");
    if (options.consent.status("agents", serviceOf(pairing)) !== "accepted") {
      throw refusal("consent");
    }
    touch(pairing.id);
    const live = new Set(options.access.folders().map((folder) => folder.id));
    const folderIds = pairing.folderIds.filter((id) => id === NOT_IN_A_FOLDER_ID || live.has(id));
    assertFoldersCanShare(folderIds);
    return {
      id: pairing.id,
      name: pairing.name,
      folderIds,
    };
  };

  /** Keeps a call for the activity list, and lets the list's oldest go. */
  const record = (activity: Omit<AgentActivity, "id" | "at">) => {
    if (!findPairing(activity.pairingId)) return;
    const at = options.now();
    const id = randomUUID();
    db.transaction(() => {
      db.run(
        `INSERT INTO agent_activity (id, pairing_id, tool, summary, outcome, problem, result_count,
           document_ids, effects, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          activity.pairingId,
          activity.tool,
          activity.summary,
          activity.outcome,
          activity.problem,
          activity.count,
          JSON.stringify(activity.documentIds),
          JSON.stringify(activity.effects),
          activity.durationMs,
          at,
          at,
        ],
      );
      db.run(
        `UPDATE agent_activity SET deleted_at = ?, updated_at = ?
         WHERE pairing_id = ? AND deleted_at IS NULL AND id NOT IN (
           SELECT id FROM agent_activity WHERE pairing_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        [at, at, activity.pairingId, activity.pairingId, BigInt(ACTIVITY_KEPT)],
      );
    });
    options.called({ ...activity, id, at });
  };

  const accessDeps: AgentAccessDeps = {
    ...options.access,
    admit,
    record,
    citations,
    clock: options.clock,
    reportError: options.reportError,
  };

  /** The core interface for a token's calls: refused at every call when the token is no pairing's. */
  const open = async (
    token: string,
  ): Promise<{ pairingId: string | null; access: AgentAccess }> => {
    const pairingId = await pairingOfToken(token);
    return { pairingId, access: createAgentAccess(accessDeps, pairingId ?? "") };
  };

  const closeConnections = async (pairingId: string | null) => {
    const open = connections.get(pairingId);
    connections.delete(pairingId);
    await Promise.all([...(open ?? [])].map((connection) => connection.close()));
  };

  const serve = (socket: Socket) => {
    mcp ??= import("./mcp");
    mcp.then(
      ({ serveConnection }) =>
        serveConnection(socket, {
          open,
          version: options.version,
          paired: (pairingId, connection) => {
            if (closed) {
              void connection.close();
              return;
            }
            const list = connections.get(pairingId) ?? new Set<ServedConnection>();
            list.add(connection);
            connections.set(pairingId, list);
            socket.once("close", () => list.delete(connection));
          },
          reportError: options.reportError,
        }),
      (error: unknown) => {
        options.reportError(error);
        socket.destroy();
      },
    );
  };

  /** Listens while connecting agents is on; stops when it is turned off. */
  const syncListening = (): Promise<void> => {
    listening = listening.then(async () => {
      if (closed) return;
      if (enabled() && !listener) {
        try {
          listener = await listenForAgents(options.socketPath, serve);
        } catch (error) {
          // Another copy of IncarnaMind on this data folder is listening already.
          options.reportError(error);
        }
      } else if (!enabled() && listener) {
        await stopListening();
      }
    });
    return listening;
  };

  const stopListening = async () => {
    const stopping = listener;
    listener = null;
    await Promise.all([...connections.keys()].map((pairingId) => closeConnections(pairingId)));
    await stopping?.close();
  };

  return {
    settings,

    /** The core interface for a token (see ./access); for transports other than the socket. */
    open,

    /** How the server starts with this token (see `AgentLaunch`). */
    launchFor,

    async setEnabled(value: unknown): Promise<AgentSettings> {
      if (typeof value !== "boolean") throw new InvalidInputError("enabled must be true or false.");
      options.writeValue(ENABLED_KEY, value);
      await syncListening();
      changed();
      return settings();
    },

    async connect(input: unknown) {
      if (!isRecord(input)) throw new InvalidInputError("connectAgent expects an object.");
      const name = parseName(input.name, null);
      const folderIds = parseFolders(input.folderIds);
      const client = parseClient(input.client);
      const id = randomUUID();
      const token = `im_${randomBytes(32).toString("base64url")}`;
      // The token is stored first: a pairing without one could never be used.
      await options.secrets.set(secretName(id), token);
      const at = options.now();
      db.run(
        `INSERT INTO agent_pairings (id, name, folder_ids, client, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, JSON.stringify(folderIds), client, at, at],
      );
      tokens.set(id, token);
      // The User confirmed what it may read and where that goes before this was called.
      options.consent.choose(["agents"], serviceOf({ id, name }));
      changed();
      return { pairing: requirePairing(id), launch: launchFor(token) } satisfies ConnectedAgent;
    },

    update(pairingIdInput: unknown, input: unknown): AgentPairing {
      const pairing = requirePairing(pairingIdInput);
      if (!isRecord(input)) throw new InvalidInputError("updateAgent expects an object.");
      const name = input.name === undefined ? pairing.name : parseName(input.name, pairing.id);
      const folderIds =
        input.folderIds === undefined ? pairing.folderIds : parseFolders(input.folderIds);
      const at = options.now();
      db.run("UPDATE agent_pairings SET name = ?, folder_ids = ?, updated_at = ? WHERE id = ?", [
        name,
        JSON.stringify(folderIds),
        at,
        pairing.id,
      ]);
      changed();
      return requirePairing(pairing.id);
    },

    async disconnect(pairingIdInput: unknown): Promise<void> {
      const pairing = requirePairing(pairingIdInput);
      const at = options.now();
      db.transaction(() => {
        db.run(
          "UPDATE agent_pairings SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
          [at, at, pairing.id],
        );
        db.run(
          `UPDATE agent_activity SET deleted_at = ?, updated_at = ?
           WHERE pairing_id = ? AND deleted_at IS NULL`,
          [at, at, pairing.id],
        );
      });
      tokens.delete(pairing.id);
      options.consent.revoke("agents", serviceOf(pairing).id);
      await closeConnections(pairing.id);
      await options.secrets.delete(secretName(pairing.id));
      changed();
    },

    /** Records the settings files and folders that setting this pairing's agent up created. */
    recordCreated(pairingId: string, paths: readonly string[]): void {
      const all = new Set([...createdPaths(pairingId), ...paths]);
      db.run("UPDATE agent_pairings SET created_paths = ? WHERE id = ?", [
        JSON.stringify([...all]),
        pairingId,
      ]);
    },

    created: createdPaths,

    async launch(pairingIdInput: unknown): Promise<AgentLaunch> {
      const pairing = requirePairing(pairingIdInput);
      const token = await tokenOf(pairing.id);
      if (!token) {
        throw new NotFoundError({ key: "error.agent.keyUnreadable" });
      }
      return launchFor(token);
    },

    activity(pairingIdInput: unknown): AgentActivity[] {
      const pairing = requirePairing(pairingIdInput);
      return db
        .all<ActivityRow>(
          `SELECT id, pairing_id, tool, summary, outcome, problem, result_count, document_ids,
             effects, duration_ms, created_at
           FROM agent_activity WHERE pairing_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          [pairing.id, BigInt(ACTIVITY_KEPT)],
        )
        .map(toActivity);
    },

    /** Local mode was turned on or off: pairings are paused or go on. */
    localModeChanged: changed,

    /** Starts listening, if connecting agents was left on. */
    start: () => {
      if (!options.offered && (turnedOn() || livePairings().length > 0)) {
        options.log.info("agents.notOffered", {
          turnedOn: turnedOn(),
          pairings: livePairings().length,
        });
      }
      return syncListening();
    },

    /** Stops listening and closes every connection. Safe to call twice. */
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await listening;
      await stopListening();
    },
  };
}

export type Agents = ReturnType<typeof createAgents>;
