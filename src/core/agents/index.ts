/**
 * Outside agents (#351, experimental): AI agents the User runs themselves,
 * such as Claude Code or Codex, that use IncarnaMind as an MCP server (ADR-0013,
 * addendum of 2026-10-11). Each is a pairing the User makes: a name, the
 * Folders it may read (none until the User picks some; Not in a Folder, and all
 * of the User's Documents and Notes (#3544), are entries of the list, as
 * `NOT_IN_A_FOLDER_ID` and `ALL_SHARED_ID`, so storing them needs no
 * migration, and an older version drops them as Folders that don't exist),
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
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import {
  AGENT_SOCKET_ENV,
  AGENT_TOKEN_ENV,
  clientProofInput,
  serverProofInput,
} from "../../shared/agentSocket";
import type { Logger } from "../adapters";
import {
  AGENT_TOOLS,
  type AgentActivity,
  type AgentLaunch,
  type AgentPairing,
  type AgentProblem,
  type AgentRequest,
  type AgentSettings,
  type AgentToolName,
  ALL_SHARED_ID,
  type ConnectedAgent,
  type DataKind,
  type Effect,
  type ExternalService,
  NOT_IN_A_FOLDER_ID,
} from "../api";
import type { Consent } from "../consent";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import { earliestRestorable } from "../recentlyDeleted";
import type { Secrets } from "../secrets";
import type { Database } from "../storage";
import {
  type AdmittedPairing,
  type AgentAccessDeps,
  AgentRefusedError,
  createAgentAccess,
  createCheckRuns,
  documentsForPairing,
  pairingReaches,
  reachedFolders,
} from "./access";
import {
  CHECK_RUN_TOOLS,
  CONVERSATION_TOOLS,
  type ConversationHears,
  type ConversationRun,
  createAskedChecks,
  type RunGrant,
} from "./askedChecks";
import { createAgentCitations } from "./citations";
import { clientDefinition } from "./clients";
import type { AgentChallengeSession, OpenedAgentConnection, ServedConnection } from "./mcp";
import { createAgentRequests, type KeptRequest } from "./requests";
import {
  AgentEndpointError,
  type AgentListener,
  isSocketPathUsable,
  isWindowsPipe,
  listenForAgents,
} from "./socket";
import { createAgentWorkings } from "./workings";

export { type AgentAccess, AgentRefusedError } from "./access";
export { agentSocketPath, isSocketPathUsable, MAX_SOCKET_PATH_BYTES } from "./socket";

/** What the "agents" flow sends to a paired agent. */
export const AGENT_FLOW_SENDS: readonly DataKind[] = ["scoped-passages", "scoped-minds", "answers"];

/**
 * What the "hosted-agents" flow sends when IncarnaMind starts the User's own command-line AI for a
 * check they pressed (ADR-0032): what that agent may read already, the Note's sentences and the
 * Passages its Tools give.
 */
export const HOSTED_CHECK_SENDS: readonly DataKind[] = ["scoped-passages", "scoped-minds"];

/**
 * And for a request typed at a Note's foot (ADR-0034): its words and the words selected. A User
 * who allowed only the check's kinds is asked once more, at their first request.
 */
export const HOSTED_FLOW_SENDS: readonly DataKind[] = [
  ...HOSTED_CHECK_SENDS,
  "note-requests",
  "selection",
];

/** The agents IncarnaMind can start for a check, by the client their pairing was set up for. */
export const HOSTED_CLIENTS: readonly string[] = ["claude-code"];

/** The device setting that turns connecting agents on. */
const ENABLED_KEY = "agentsEnabled";
/** The device setting remembering pairings that last connected with a legacy v1 shim (ADR-0036). */
const LEGACY_SHIMS_KEY = "agentLegacyShims";
/** Each pairing's token, in ../secrets. */
const secretName = (pairingId: string) => `agent-pairing:${pairingId}`;
/** How a pairing is named as a service of the "agents" and "hosted-agents" data flows. */
export const serviceOf = (pairing: { id: string; name: string }): ExternalService => ({
  id: `agent:${pairing.id}`,
  name: pairing.name,
});
/** The activity kept per pairing; older calls go. */
const ACTIVITY_KEPT = 500;
/** How often a pairing's "last used" time is written while it keeps calling. */
const LAST_USED_EVERY_MS = 60_000;
const MAX_NAME_CHARS = 80;

/** What setting an agent up left waiting for its pairing: told when the pairing's agent connects or the pairing goes. */
export interface PairingEvents {
  /** The pairing's agent reached IncarnaMind's server, as it does at every start. */
  connected(pairingId: string): void;
  /** Waited for: the pairing's disconnect is done once it has returned. */
  disconnected(pairingId: string): Promise<void>;
}

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
  /** Whether IncarnaMind has an AI model of its own ready now; `ask` and `check_mind` can only refuse without one. */
  modelReady(): Promise<boolean>;
  /** Where the shim reaches the app (see ./socket). */
  socketPath: string;
  launcher: AgentLauncher;
  /** This build's version, as the server names itself to agents. */
  version: string;
  /** What the calls read (see ./access). */
  access: Omit<
    AgentAccessDeps,
    | "admit"
    | "record"
    | "notesWrittenSince"
    | "checkRuns"
    | "workings"
    | "versions"
    | "citations"
    | "requests"
    | "askedChecks"
    | "clock"
    | "now"
    | "newId"
    | "reportError"
    | "doneSince"
  >;
  /** Whether this agent's Skill is IncarnaMind's current text, or out of date because the User changed it (see ./skillFiles). */
  skillState(client: string | null): { installed: boolean; outOfDate: boolean };
  changed(settings: AgentSettings): void;
  called(activity: AgentActivity): void;
  /** A request to the User's own AI was made or read (#3419). */
  requested(request: AgentRequest): void;
  reportError(error: unknown): void;
}

interface PairingRow {
  id: string;
  name: string;
  folder_ids: string;
  client: string | null;
  propose: number;
  share_tag_names: number;
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
  request_id: string | null;
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
  propose: row.propose === 1,
  ...(row.share_tag_names === 0 && { tagNamesNotShared: true }),
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
});

const isTool = (tool: string): tool is AgentToolName =>
  (AGENT_TOOLS as readonly string[]).includes(tool);

const toActivity = (row: ActivityRow, request: string | null): AgentActivity => ({
  id: row.id,
  pairingId: row.pairing_id,
  tool: isTool(row.tool) ? row.tool : "search",
  summary: row.summary,
  outcome: row.outcome === "refused" || row.outcome === "failed" ? row.outcome : "done",
  problem: (row.problem as AgentProblem | null) ?? null,
  count: row.result_count,
  request,
  documentIds: parseList<string>(row.document_ids),
  effects: parseList<Effect>(row.effects),
  durationMs: row.duration_ms,
  at: row.created_at,
});

/** A request as the windows see it: its text is the agent's to read. */
const shownRequest = (kept: KeptRequest): AgentRequest => ({
  id: kept.id,
  pairingId: kept.pairingId,
  mindId: kept.mindId,
  sentences: kept.sentences,
  createdAt: kept.createdAt,
  readAt: kept.readAt,
});

const digest = (token: string) => createHash("sha256").update(token).digest();
const hmacHex = (token: string, input: string) =>
  createHmac("sha256", token).update(input).digest("hex");
const equalHex = (a: string, b: string) => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

export function createAgents(options: AgentsOptions) {
  const { db } = options;
  const citations = createAgentCitations(db, options.now);
  const requests = createAgentRequests(db, options.now, randomUUID);
  const askedChecks = createAskedChecks(options.now);
  /** Tokens read from ../secrets, by pairing, so a connection needn't read the keychain. */
  const tokens = new Map<string, string>();
  /** The connections being served, by pairing (null: a token that belongs to none). */
  const connections = new Map<string | null, Set<ServedConnection>>();
  /** When each pairing's "last used" time was last written. */
  const lastWritten = new Map<string, number>();
  let listener: AgentListener | null = null;
  let listenProblem: "too-long" | "untrusted" | "unavailable" | null = null;
  let listenProblemPath: string | null = null;
  const readLegacyShims = (): Set<string> => {
    const raw = options.readValue(LEGACY_SHIMS_KEY);
    return new Set(
      Array.isArray(raw) ? raw.filter((each): each is string => typeof each === "string") : [],
    );
  };
  const legacyShims = readLegacyShims();
  const saveLegacyShims = () => {
    options.writeValue(LEGACY_SHIMS_KEY, [...legacyShims]);
  };
  const markHandshakeVersion = (pairingId: string, version: 1 | 2) => {
    const had = legacyShims.has(pairingId);
    if (version === 1 && !had) {
      legacyShims.add(pairingId);
      saveLegacyShims();
    } else if (version === 2 && had) {
      legacyShims.delete(pairingId);
      saveLegacyShims();
    }
  };
  /** Starting and stopping the listener, one after another, so two quick toggles can't race. */
  let listening: Promise<void> = Promise.resolve();
  let closed = false;
  let mcp: Promise<typeof import("./mcp")> | null = null;

  const watchers = new Set<PairingEvents>();

  const turnedOn = () => options.readValue(ENABLED_KEY) === true;
  const enabled = () => options.offered && turnedOn();
  const say = options.access.say;

  const livePairings = () =>
    db
      .all<PairingRow>(
        `SELECT id, name, folder_ids, client, propose, share_tag_names, last_used_at, created_at FROM agent_pairings
         WHERE deleted_at IS NULL ORDER BY created_at, rowid`,
      )
      .map(toPairing);

  const findPairing = (pairingId: string): AgentPairing | null => {
    const row = db.get<PairingRow>(
      `SELECT id, name, folder_ids, client, propose, share_tag_names, last_used_at, created_at FROM agent_pairings
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

  /** The pairings whose agent installs a file IncarnaMind made, hasn't been used and isn't connected now. */
  const awaitingInstall = (pairings: readonly AgentPairing[]): string[] =>
    pairings
      .filter(
        (each) =>
          each.lastUsedAt === null &&
          (connections.get(each.id)?.size ?? 0) === 0 &&
          clientDefinition(each.client)?.setup === "bundle",
      )
      .map((each) => each.id);

  const settings = (): AgentSettings => {
    const pairings = livePairings();
    const skills = pairings.map((each) => ({ id: each.id, ...options.skillState(each.client) }));
    return {
      enabled: enabled(),
      paused: options.localOnly() ? "local-mode" : null,
      pairings,
      skills: skills.filter((each) => each.installed).map((each) => each.id),
      skillsOutOfDate: skills.filter((each) => each.outOfDate).map((each) => each.id),
      awaitingInstall: awaitingInstall(pairings),
      shimsOutOfDate: pairings.filter((each) => legacyShims.has(each.id)).map((each) => each.id),
    };
  };

  const changed = () => options.changed(settings());

  if (options.offered) {
    options.consent.registry.register({
      id: "agents",
      sends: AGENT_FLOW_SENDS,
      services: async () => livePairings().map(serviceOf),
    });
    options.consent.registry.register({
      id: "hosted-agents",
      sends: HOSTED_FLOW_SENDS,
      services: async () =>
        livePairings()
          .filter((pairing) => HOSTED_CLIENTS.includes(pairing.client ?? ""))
          .map(serviceOf),
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

  const parsePropose = (value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean")
      throw new InvalidInputError({ key: "error.agent.proposeChoice" });
    return value;
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
    const folders = options.access.folders();
    const wall = folders
      .filter((folder) => folderIds.includes(folder.id))
      .map((folder) => options.access.wallOf(folder.id))
      .find((id) => id !== null);
    if (wall !== undefined && wall !== null) {
      throw new AgentRefusedError(
        "outside-scope",
        say("agents.problem.wallShared", {
          folder: folders.find((folder) => folder.id === wall)?.name ?? "",
        }),
      );
    }
  };

  /** An entry of a pairing's Folders that is no Folder. */
  const isEntry = (id: string) => id === NOT_IN_A_FOLDER_ID || id === ALL_SHARED_ID;

  const parseFolders = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
      throw new InvalidInputError("folderIds must be a list of Folder ids.");
    }
    const live = new Set(options.access.folders().map((folder) => folder.id));
    const unknown = value.find((id) => !isEntry(id) && !live.has(id));
    if (unknown !== undefined) throw new NotFoundError({ key: "error.folder.notFound" });
    assertFoldersCanShare(value as string[]);
    if (value.includes(ALL_SHARED_ID)) return [ALL_SHARED_ID];
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

  /** The pairing as a call is let in now; `use` notes the call, which a mere look at it isn't. */
  const admissible = (pairingId: string, use?: (pairingId: string) => void): AdmittedPairing => {
    if (closed) throw refusal("off");
    const pairing = findPairing(pairingId);
    if (!pairing) throw refusal("unpaired");
    if (!enabled()) throw refusal("off");
    if (options.localOnly()) throw refusal("local-mode");
    if (options.consent.status("agents", serviceOf(pairing)) !== "accepted") {
      throw refusal("consent");
    }
    use?.(pairing.id);
    const live = new Set(options.access.folders().map((folder) => folder.id));
    const folderIds = pairing.folderIds.filter((id) => isEntry(id) || live.has(id));
    assertFoldersCanShare(folderIds);
    return {
      id: pairing.id,
      name: pairing.name,
      folderIds,
      createdAt: pairing.createdAt,
      shareTagNames: pairing.tagNamesNotShared !== true,
      propose: pairing.propose,
    };
  };
  const admit = (pairingId: string) => admissible(pairingId, touch);

  /** Keeps a call for the activity list, and lets the list's oldest go. */
  const record = (activity: Omit<AgentActivity, "id" | "at" | "request">, requestId?: string) => {
    if (!findPairing(activity.pairingId)) return;
    const at = options.now();
    const id = randomUUID();
    db.transaction(() => {
      db.run(
        `INSERT INTO agent_activity (id, pairing_id, tool, summary, outcome, problem, result_count,
           document_ids, effects, duration_ms, request_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          requestId ?? null,
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
    const request = requestId ? (requests.texts([requestId]).get(requestId) ?? null) : null;
    options.called({ ...activity, request, id, at });
  };

  /** Counted from the calls kept, those the activity list has let go too. */
  const notesWrittenSince = (pairingId: string, since: string): number => {
    const row = db.get<{ written: number | bigint }>(
      `SELECT COUNT(*) AS written FROM agent_activity
       WHERE pairing_id = ? AND tool = 'create_mind' AND outcome = 'done' AND created_at >= ?`,
      [pairingId, since],
    );
    return Number(row?.written ?? 0);
  };

  /** Counted from the calls kept, as `notesWrittenSince` counts. */
  const doneSince = (pairingId: string, tools: readonly AgentToolName[], since: string): number => {
    const row = db.get<{ done: number | bigint }>(
      `SELECT COUNT(*) AS done FROM agent_activity
       WHERE pairing_id = ? AND outcome = 'done' AND created_at >= ?
         AND tool IN (${tools.map(() => "?").join(", ")})`,
      [pairingId, since, ...tools],
    );
    return Number(row?.done ?? 0);
  };

  const accessDeps: AgentAccessDeps = {
    ...options.access,
    admit,
    record,
    notesWrittenSince,
    doneSince,
    checkRuns: createCheckRuns(),
    workings: createAgentWorkings(),
    versions: new Map(),
    citations,
    requests: {
      ofPairing: requests.ofPairing,
      markRead: (id, text) => {
        const read = requests.markRead(id, text);
        if (read) options.requested(shownRequest(read));
        return read;
      },
    },
    askedChecks,
    clock: options.clock,
    now: options.now,
    newId: randomUUID,
    reportError: options.reportError,
  };

  /**
   * The grants of runs IncarnaMind started (`checkGrant`, `conversationGrant`), by their token's
   * digest, each with the connections opened with it.
   */
  const grants = new Map<
    string,
    { pairingId: string; grant: RunGrant; token: string; connections: Set<ServedConnection> }
  >();

  /** A grant admitted as the pairing, held in memory only until `end`, which closes its connections. */
  const grantFor = (pairingId: string, grant: RunGrant) => {
    const token = `im_${randomBytes(32).toString("base64url")}`;
    const key = digest(token).toString("hex");
    const connections = new Set<ServedConnection>();
    grants.set(key, { pairingId, grant, token, connections });
    return {
      launch: launchFor(token),
      end: async () => {
        grants.delete(key);
        await Promise.all([...connections].map((connection) => connection.close()));
      },
    };
  };

  /**
   * The core interface for a token's calls: refused at every call when the token is no pairing's.
   * `grant`: the run grant's key, for a connection opened with one.
   */
  const open = async (token: string): Promise<OpenedAgentConnection> => {
    const key = digest(token).toString("hex");
    const grant = grants.get(key);
    if (grant) {
      return {
        pairingId: grant.pairingId,
        access: createAgentAccess(accessDeps, grant.pairingId, grant.grant),
        grant: key,
      };
    }
    const pairingId = await pairingOfToken(token);
    return { pairingId, access: createAgentAccess(accessDeps, pairingId ?? "") };
  };

  /**
   * Prepares a v2 mutual HMAC challenge-response session (ADR-0036): signs the
   * shim's nonce with each live pairing's and active check grant's token so the
   * shim verifies IncarnaMind before sending its own proof.
   */
  const challenge = async (shimNonce: string): Promise<AgentChallengeSession> => {
    const appNonce = randomBytes(32).toString("base64url");
    const serverInput = serverProofInput(shimNonce, appNonce);
    const candidates: Array<{
      token: string;
      open: () => OpenedAgentConnection | null;
    }> = [];
    for (const [key, grant] of grants.entries()) {
      candidates.push({
        token: grant.token,
        open: () => {
          const active = grants.get(key);
          if (!active) return null;
          return {
            pairingId: active.pairingId,
            access: createAgentAccess(accessDeps, active.pairingId, active.grant),
            grant: key,
          };
        },
      });
    }
    for (const pairing of livePairings()) {
      const token = await tokenOf(pairing.id);
      if (!token) continue;
      candidates.push({
        token,
        open: () => {
          if (!findPairing(pairing.id)) return null;
          return {
            pairingId: pairing.id,
            access: createAgentAccess(accessDeps, pairing.id),
          };
        },
      });
    }
    const proofs = candidates.map((entry) => hmacHex(entry.token, serverInput));
    return {
      appNonce,
      proofs,
      verify: async (clientProofHex: string) => {
        const clientInput = clientProofInput(appNonce, shimNonce);
        let matched: (() => OpenedAgentConnection | null) | null = null;
        for (const entry of candidates) {
          if (equalHex(clientProofHex, hmacHex(entry.token, clientInput)) && matched === null) {
            matched = entry.open;
          }
        }
        return matched ? matched() : null;
      },
    };
  };

  /** Tells the windows the settings changed because a connection opened or closed, unless the core is closing. */
  const connectionsChanged = () => {
    if (closed) return;
    try {
      changed();
    } catch (error) {
      options.reportError(error);
    }
  };

  /** Read at each connection; a model that can't be read is no reason to refuse the agent, which gets every Tool. */
  const modelReady = async (): Promise<boolean> => {
    try {
      return await options.modelReady();
    } catch (error) {
      options.reportError(error);
      return true;
    }
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
          challenge,
          modelReady,
          version: options.version,
          paired: (pairingId, connection, grant, handshakeVersion) => {
            const granted = grant === undefined ? null : grants.get(grant);
            // A grant that ended while its connection opened lets it do nothing.
            if (closed || granted === undefined) {
              void connection.close();
              return;
            }
            granted?.connections.add(connection);
            const list = connections.get(pairingId) ?? new Set<ServedConnection>();
            list.add(connection);
            connections.set(pairingId, list);
            socket.once("close", () => {
              list.delete(connection);
              granted?.connections.delete(connection);
              if (pairingId !== null) connectionsChanged();
            });
            if (pairingId === null) return;
            if (grant === undefined && handshakeVersion !== undefined) {
              markHandshakeVersion(pairingId, handshakeVersion);
            }
            for (const watcher of watchers) watcher.connected(pairingId);
            connectionsChanged();
          },
          reportError: options.reportError,
        }),
      (error: unknown) => {
        options.reportError(error);
        socket.destroy();
      },
    );
  };

  const defaultSocketProblemPath = () =>
    isWindowsPipe(options.socketPath) ? options.socketPath : dirname(options.socketPath);

  const socketError = () => {
    if (listenProblem === "untrusted") {
      return new InvalidInputError({
        key: "error.agent.socketUntrusted",
        values: { path: listenProblemPath ?? defaultSocketProblemPath() },
      });
    }
    if (listenProblem === "too-long" || !isSocketPathUsable(options.socketPath)) {
      return new InvalidInputError({ key: "error.agent.socketTooLong" });
    }
    return new InvalidInputError({
      key: "error.agent.socketUnavailable",
      values: { path: listenProblemPath ?? defaultSocketProblemPath() },
    });
  };

  const ensureReachable = async (): Promise<void> => {
    if (!isSocketPathUsable(options.socketPath)) {
      listenProblem = isWindowsPipe(options.socketPath) ? "untrusted" : "too-long";
      listenProblemPath = defaultSocketProblemPath();
      throw socketError();
    }
    if (enabled() && !listener) {
      await syncListening();
      if (!listener) throw socketError();
    } else if (!enabled() && listenProblem !== null) {
      throw socketError();
    }
  };

  /** Listens while connecting agents is on; stops when it is turned off. */
  const syncListening = (): Promise<void> => {
    listening = listening.then(async () => {
      if (closed) return;
      if (enabled() && !listener) {
        try {
          listener = await listenForAgents(options.socketPath, serve);
          listenProblem = null;
          listenProblemPath = null;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          listenProblem =
            error instanceof AgentEndpointError && error.reason === "untrusted"
              ? "untrusted"
              : (error instanceof AgentEndpointError && error.reason === "too-long") ||
                  !isSocketPathUsable(options.socketPath) ||
                  code === "ENAMETOOLONG"
                ? "too-long"
                : "unavailable";
          listenProblemPath =
            error instanceof AgentEndpointError && error.path
              ? error.path
              : defaultSocketProblemPath();
          // Another copy of IncarnaMind on this data folder is listening already, or the socket can't open.
          options.reportError(error);
        }
      } else if (!enabled() && listener) {
        listenProblem = null;
        listenProblemPath = null;
        await stopListening();
      }
    });
    return listening;
  };

  /**
   * Deletes for good the calls and requests marked deleted `RECENTLY_DELETED_DAYS` ago, by
   * Disconnect or a list's limit, once a later sync has had that long to see them (#3430).
   */
  const forgetGone = () => {
    const before = earliestRestorable(options.now());
    db.transaction(() => {
      db.run("DELETE FROM agent_activity WHERE deleted_at IS NOT NULL AND deleted_at < ?", [
        before,
      ]);
      requests.forgetGone(before);
    });
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

    /** Rejects unless IncarnaMind's local agent socket can be reached (#3598). */
    ensureReachable,

    /**
     * The agents the User can ask about this Note now (#3373): each would be let in, and reads it
     * as `read_mind` does; with no Note, each that would be let in. The one connected or used
     * last comes first.
     */
    askable(mindId: string | null, documentId?: string): AgentPairing[] {
      if (listenProblem !== null) return [];
      const mind =
        mindId === null ? null : options.access.minds().find((each) => each.id === mindId);
      if (mind === undefined) return [];
      const latest = (pairing: AgentPairing) =>
        pairing.lastUsedAt !== null && pairing.lastUsedAt > pairing.createdAt
          ? pairing.lastUsedAt
          : pairing.createdAt;
      return livePairings()
        .reverse()
        .filter((pairing) => {
          try {
            const admitted = admissible(pairing.id);
            const reached = reachedFolders(accessDeps, admitted);
            if (mind && !pairingReaches(accessDeps, admitted, mind, reached)) return false;
            return (
              !documentId ||
              documentsForPairing(accessDeps, admitted, [...reached], reached).includes(documentId)
            );
          } catch (error) {
            if (error instanceof AgentRefusedError) return false;
            throw error;
          }
        })
        .sort((a, b) => latest(b).localeCompare(latest(a)));
    },

    /** Of these Folders and Documents, those this pairing can read now (#3533). */
    reads(
      pairingId: string,
      named: { folderIds: readonly string[]; documentIds: readonly string[] },
    ): { folderIds: string[]; documentIds: string[] } {
      try {
        const admitted = admissible(pairingId);
        const reached = reachedFolders(accessDeps, admitted);
        const readable = new Set(documentsForPairing(accessDeps, admitted, [...reached], reached));
        return {
          folderIds: named.folderIds.filter((id) => reached.has(id)),
          documentIds: named.documentIds.filter((id) => readable.has(id)),
        };
      } catch (error) {
        if (error instanceof AgentRefusedError) return { folderIds: [], documentIds: [] };
        throw error;
      }
    },

    async setEnabled(value: unknown): Promise<AgentSettings> {
      if (typeof value !== "boolean") throw new InvalidInputError("enabled must be true or false.");
      if (value && !isSocketPathUsable(options.socketPath)) {
        listenProblem = isWindowsPipe(options.socketPath) ? "untrusted" : "too-long";
        listenProblemPath = defaultSocketProblemPath();
        throw socketError();
      }
      options.writeValue(ENABLED_KEY, value);
      await syncListening();
      if (value && !listener) {
        options.writeValue(ENABLED_KEY, false);
        changed();
        throw socketError();
      }
      changed();
      return settings();
    },

    async connect(input: unknown) {
      if (!isRecord(input)) throw new InvalidInputError("connectAgent expects an object.");
      const name = parseName(input.name, null);
      const folderIds = parseFolders(input.folderIds);
      const client = parseClient(input.client);
      const propose = parsePropose(input.propose, false);
      await ensureReachable();
      const id = randomUUID();
      const token = `im_${randomBytes(32).toString("base64url")}`;
      // The token is stored first: a pairing without one could never be used.
      await options.secrets.set(secretName(id), token);
      const at = options.now();
      db.run(
        `INSERT INTO agent_pairings (id, name, folder_ids, client, propose, share_tag_names, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, name, JSON.stringify(folderIds), client, propose ? 1 : 0, at, at],
      );
      tokens.set(id, token);
      // The User confirmed what it may read and where that goes before this was called, and, for
      // an agent IncarnaMind can start for a check, that it may (the connect sheet says so).
      options.consent.choose(
        HOSTED_CLIENTS.includes(client ?? "") ? ["agents", "hosted-agents"] : ["agents"],
        serviceOf({ id, name }),
      );
      changed();
      return { pairing: requirePairing(id), launch: launchFor(token) } satisfies ConnectedAgent;
    },

    update(pairingIdInput: unknown, input: unknown): AgentPairing {
      const pairing = requirePairing(pairingIdInput);
      if (!isRecord(input)) throw new InvalidInputError("updateAgent expects an object.");
      const name = input.name === undefined ? pairing.name : parseName(input.name, pairing.id);
      const folderIds =
        input.folderIds === undefined ? pairing.folderIds : parseFolders(input.folderIds);
      const propose = parsePropose(input.propose, pairing.propose);
      const at = options.now();
      db.run(
        "UPDATE agent_pairings SET name = ?, folder_ids = ?, propose = ?, share_tag_names = ?, updated_at = ? WHERE id = ?",
        [
          name,
          JSON.stringify(folderIds),
          propose ? 1 : 0,
          input.shareTagNames === true || !pairing.tagNamesNotShared ? 1 : 0,
          at,
          pairing.id,
        ],
      );
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
        requests.forget(pairing.id, at);
      });
      tokens.delete(pairing.id);
      if (legacyShims.delete(pairing.id)) saveLegacyShims();
      options.consent.revoke("agents", serviceOf(pairing).id);
      options.consent.revoke("hosted-agents", serviceOf(pairing).id);
      changed();
      await closeConnections(pairing.id);
      await options.secrets.delete(secretName(pairing.id));
      await Promise.all(
        [...watchers].map((watcher) => watcher.disconnected(pairing.id).catch(options.reportError)),
      );
    },

    /** Hears each connection of a pairing's agent, and each pairing disconnected. */
    watch(events: PairingEvents): void {
      watchers.add(events);
    },

    /** Every pairing this database has held: those disconnected too, which stay marked deleted. */
    held(): string[] {
      return db.all<{ id: string }>("SELECT id FROM agent_pairings").map((row) => row.id);
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
      const rows = db.all<ActivityRow>(
        `SELECT id, pairing_id, tool, summary, outcome, problem, result_count, document_ids,
           effects, duration_ms, request_id, created_at
         FROM agent_activity WHERE pairing_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        [pairing.id, BigInt(ACTIVITY_KEPT)],
      );
      const texts = requests.texts(
        rows.flatMap((row) => (row.request_id === null ? [] : [row.request_id])),
      );
      return rows.map((row) =>
        toActivity(row, row.request_id === null ? null : (texts.get(row.request_id) ?? null)),
      );
    },

    /**
     * Keeps what a request to the User's own AI holds beyond its line, for this pairing to read
     * with `read_request` (#3419).
     */
    keepRequest(request: Parameters<typeof requests.keep>[0]): AgentRequest {
      const kept = shownRequest(requests.keep(request));
      options.requested(kept);
      return kept;
    },

    /** The User asked this agent to check the Note: its marks land there while the ask stands (#3622). */
    askedToCheck: askedChecks.asked,

    /**
     * A check the User pressed, for IncarnaMind to start this agent with (ADR-0032): its server's
     * launch carries a grant admitted as the pairing, for that Note and the check's Tools alone,
     * held in memory only until `end`, which closes every connection opened with it. An agent asked
     * before to check the Note no longer may (./askedChecks).
     */
    checkGrant(pairingId: string, mindId: string): { launch: AgentLaunch; end(): Promise<void> } {
      askedChecks.withdraw(mindId);
      return grantFor(pairingId, { kind: "check", mindId, tools: CHECK_RUN_TOOLS });
    },

    /**
     * A request the User typed at a Note's foot, for IncarnaMind to start this agent with
     * (ADR-0034): its server's launch carries a grant that stands for the pairing, with its reach
     * and write switch and every Tool but a file by its path, held in memory only until `end`.
     */
    conversationGrant(
      pairingId: string,
      front: ConversationRun["front"],
      hears: ConversationHears = {},
    ): { launch: AgentLaunch; end(): Promise<void> } {
      return grantFor(pairingId, {
        kind: "conversation",
        tools: CONVERSATION_TOOLS,
        front,
        ...hears,
      });
    },

    /** The requests made about a Note, of the agents still connected, the newest first (#3419). */
    requestsFor(mindId: string): AgentRequest[] {
      return requests.forMind(mindId).map(shownRequest);
    },

    /** Local mode was turned on or off: pairings are paused or go on. */
    localModeChanged: changed,

    /** A model of IncarnaMind's own became ready, or none is now: each connection's Tool list follows (#3533). */
    modelChanged(ready: boolean): void {
      for (const open of connections.values()) {
        for (const connection of open) connection.modelChanged(ready);
      }
    },

    /** Tells the windows the settings changed, e.g. after a Skill was written. */
    announce: changed,

    /** Starts listening, if connecting agents was left on. */
    start: () => {
      try {
        forgetGone();
      } catch (error) {
        options.reportError(error);
      }
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
