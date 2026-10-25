/**
 * Connectors (CONTEXT.md): external services the User has connected, through
 * which Answers can look things up. Each is an MCP server, spoken to with the
 * official MCP SDK:
 * - local ones run as programs on this computer, over their standard input
 *   and output;
 * - remote ones are reached by URL over Streamable HTTP, and sign in through
 *   the User's browser when the server requires it (./remote, ./auth).
 *
 * - Storage: one row per Connector, sync-ready and without secrets. A local
 *   one's environment values (usually API keys) are one keychain secret; a
 *   remote one's tokens and OAuth registration are two more.
 * - Lifecycle: enabled Connectors start when the core starts, or on first use
 *   if they haven't yet. A process that stops, or a server that can't be
 *   reached, is tried again, waiting longer after each failure. A remote one
 *   whose sign-in is missing or expired waits for the User instead. Turning
 *   one off, deleting it, or closing the core stops it.
 * - Answers: the Tools of each ready Connector, local or remote, namespaced by
 *   Connector. Each call sends data to its Connector's service and may change
 *   something there, unless the Connector marks the Tool read-only (its
 *   Effects, `connectorToolEffects`): Answers ask the User before a call that
 *   may change something (see ../approvals). Every call checks consent for
 *   the "connectors" flow first: even a server on this computer can reach
 *   the internet.
 * - Local mode: a remote Connector whose server isn't on this computer
 *   (`serviceForUrl`) isn't connected to, nor offered to Answers, while
 *   "Keep everything on this computer" is on; it is "paused". Local programs
 *   and servers at a loopback address keep working. One at a loopback
 *   address whose sign-in server isn't (the MCP server names it) neither
 *   renews nor starts a sign-in while it is on: it waits for a sign-in, "held
 *   back", with its tokens kept for when it is off.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Browser, ProcessLauncher } from "../adapters";
import type {
  Connector,
  ConnectorDirectoryEntry,
  ConnectorError,
  ConnectorImportEntry,
  ConnectorImportResult,
  ConnectorSignInError,
  ConnectorSignInResult,
  ConnectorState,
  ConnectorTool,
  Effect,
  ExternalService,
} from "../api";
import type { Consent } from "../consent";
import {
  ConsentDeclinedError,
  ConsentRevokedError,
  InvalidInputError,
  isRecord,
  LocalModeError,
  NotFoundError,
  SecretStorageError,
} from "../errors";
import { DEFAULT_SIGN_IN_TIMEOUT_MS, type OAuthPage } from "../oauth";
import { serviceForUrl } from "../providers/service";
import type { Secrets } from "../secrets";
import { createSendGate } from "../sendGate";
import type { Database } from "../storage";
import type { Tool } from "../tools";
import {
  type ConnectorAuth,
  causedBy,
  clientSecret,
  createConnectorAuth,
  HeldBackError,
  manualClientRecord,
} from "./auth";
import { type ConnectorConfig, parseAddInput, parseClient, readMcpServers } from "./config";
import { startError, stoppedError } from "./errors";
import {
  needsSignIn,
  remoteError,
  remoteService,
  remoteTransport,
  signInError,
  signInRemote,
} from "./remote";
import type { ChildProcessTransport } from "./transport";

/** What the "connectors" flow sends to each Connector. */
const CONNECTORS_FLOW_SENDS = ["tool-arguments"] as const;

export interface ConnectorTiming {
  /** How long a Connector may take to start and answer MCP's handshake: `npx -y` may download its package first. */
  connectTimeoutMs: number;
  /** How long one Tool call may take, without progress. */
  callTimeoutMs: number;
  /** How long an Answer waits for Connectors that are still connecting before going on without them. */
  readyWaitMs: number;
  /** The waits before each restart after a failure; the last one repeats. */
  restartDelaysMs: readonly number[];
  /** Failures in a row before IncarnaMind stops restarting a Connector by itself. */
  maxRestarts: number;
  /** A Connector that stayed up this long has its failure count reset. */
  stableMs: number;
  /** How long the User has to finish a remote Connector's sign-in in the browser. */
  signInTimeoutMs: number;
}

const CONNECTOR_TIMING: ConnectorTiming = {
  connectTimeoutMs: 60_000,
  callTimeoutMs: 120_000,
  readyWaitMs: 10_000,
  restartDelaysMs: [1_000, 2_000, 4_000, 8_000, 16_000],
  maxRestarts: 5,
  stableMs: 60_000,
  signInTimeoutMs: DEFAULT_SIGN_IN_TIMEOUT_MS,
};

/** The most of a Tool's result an Answer passes to the model. */
const MAX_RESULT_CHARS = 20_000;
/** The most of a Tool's description the model is given. */
const MAX_DESCRIPTION_CHARS = 1_000;
/** What providers accept as a Tool's name. */
const MAX_TOOL_NAME_LENGTH = 64;
const CLIENT_INFO = { name: "IncarnaMind", version: "1.0.0" };

interface ConnectorRow {
  id: string;
  name: string;
  transport: string;
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * The `config` column, without secrets: for "stdio" only the names of the
 * environment variables; for "http" the URL, and the client ID of the OAuth
 * app the User entered (its secret, if any, is in the keychain).
 */
type StoredConfig =
  | { transport: "stdio"; command: string; args: string[]; env: string[] }
  | { transport: "http"; url: string; clientId: string | null };

interface ToolInfo extends ConnectorTool {
  inputSchema: Record<string, unknown>;
}

/** How to end a connection: gracefully, or at once when the app quits. */
interface Session {
  close(): Promise<void>;
  kill(): void;
}

/** A Connector's process or connection, kept in memory. */
interface Runtime {
  /** Counts starts and stops: work from an earlier one sees it is stale and gives up. */
  generation: number;
  state: Exclude<ConnectorState, "off" | "signing-in">;
  error: ConnectorError | null;
  tools: ToolInfo[] | null;
  session: Session | null;
  /** Set while "ready". */
  client: Client | null;
  connectedAt: number;
  /** Settles when the start under way has connected or failed. */
  starting: Promise<void> | null;
  /** Failures in a row, for the wait before the next restart. */
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Remote: a browser sign-in waiting for the User. */
  signingIn: { controller: AbortController; done: Promise<unknown> } | null;
  /** Remote: why the last sign-in didn't work. */
  signInError: ConnectorSignInError | null;
  /** Remote: Local mode kept its sign-in from renewing or starting, as its server isn't on this computer (see `RemoteConnectorSignIn.heldBack`). */
  heldBack: boolean;
}

class MissingSecretsError extends Error {
  override name = "MissingSecretsError";
}

export interface ConnectorsOptions {
  db: Database;
  now: () => string;
  /** Milliseconds since the epoch, for when sign-ins expire. */
  clock: () => number;
  secrets: Secrets;
  processes: ProcessLauncher;
  browser: Browser;
  consent: Consent;
  /** Whether "Keep everything on this computer" is on. */
  localOnly(): boolean;
  /** The browser tab's pages after a remote Connector's sign-in, in the User's language. */
  signInPages(name: string): { success: OAuthPage; failure: OAuthPage };
  /** Something changed: the list, as `list()` returns it. */
  onChange(connectors: Connector[]): void;
  /** A Connector was added, deleted, or turned on or off. */
  onEnabledChange(): void;
  reportError(error: unknown): void;
  timing?: Partial<ConnectorTiming>;
}

const COLUMNS = "id, name, transport, config, enabled, created_at, updated_at";
const envSecret = (connectorId: string) => `connector:${connectorId}:env`;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function storedConfig(row: ConnectorRow): StoredConfig {
  const texts = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  try {
    const parsed: unknown = JSON.parse(row.config);
    if (row.transport === "http") {
      if (isRecord(parsed) && typeof parsed.url === "string") {
        const clientId = typeof parsed.clientId === "string" ? parsed.clientId : null;
        return { transport: "http", url: parsed.url, clientId };
      }
      // Unreadable: a URL that can't connect.
      return { transport: "http", url: "", clientId: null };
    }
    if (isRecord(parsed) && typeof parsed.command === "string") {
      return {
        transport: "stdio",
        command: parsed.command,
        args: texts(parsed.args),
        env: texts(parsed.env),
      };
    }
  } catch {
    // Unreadable: treated as a Connector with no command, which fails to start.
  }
  return { transport: "stdio", command: "", args: [], env: [] };
}

/** Where the "connectors" flow sends a Connector's Tool arguments. */
function serviceOf(row: ConnectorRow): ExternalService {
  const config = storedConfig(row);
  if (config.transport === "http") {
    try {
      return remoteService(config.url);
    } catch {
      // An unreadable URL: the Connector can't connect, so nothing is sent anyway.
    }
  }
  return { id: `connector:${row.id}`, name: row.name };
}

/**
 * What a call of a Connector's Tool can do: send its arguments to the
 * Connector's `service`, and change something there. The Connector marking
 * the Tool read-only (MCP's `readOnlyHint`) narrows that to reading. It is a
 * hint IncarnaMind can't check, so it never widens anything.
 */
export function connectorToolEffects(service: ExternalService, readOnly: boolean): Effect[] {
  const scope = { kind: "service", serviceId: service.id, name: service.name } as const;
  return [
    { action: readOnly ? "read" : "write", scope },
    { action: "network", scope },
  ];
}

function toToolInfo(tool: McpTool): ToolInfo {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title ?? null,
    description: tool.description ?? "",
    readOnly: tool.annotations?.readOnlyHint === true,
    inputSchema: tool.inputSchema,
  };
}

/** Lowercase letters, digits and "_", for a Tool name the model calls: "Linear (work)" → "linear_work". */
function slug(text: string, fallback: string): string {
  const cleaned = text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .toLowerCase();
  return cleaned || fallback;
}

/** What a Tool call returned, as text for the model. */
function resultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    switch (item.type) {
      case "text":
        if (typeof item.text === "string") parts.push(item.text);
        break;
      case "resource": {
        const resource = isRecord(item.resource) ? item.resource : {};
        if (typeof resource.text === "string") parts.push(resource.text);
        else parts.push(`[A file, ${String(resource.uri ?? "")}, which IncarnaMind can't read.]`);
        break;
      }
      case "resource_link":
        parts.push(`[A link: ${String(item.name ?? "")} ${String(item.uri ?? "")}]`);
        break;
      case "image":
      case "audio":
        parts.push(
          `[An ${item.type === "image" ? "image" : "audio clip"}, which IncarnaMind can't pass on.]`,
        );
        break;
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  // Older servers give `toolResult` instead of content.
  if (parts.length === 0 && result.toolResult !== undefined) {
    parts.push(JSON.stringify(result.toolResult));
  }
  const text = parts.join("\n\n").trim();
  if (!text) return "(The Tool returned nothing.)";
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n[The rest was cut: the result was too long.]`
    : text;
}

/** Waits for `promise`, unless `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function awayFromHere(row: ConnectorRow): boolean {
  const config = storedConfig(row);
  if (config.transport !== "http") return false;
  try {
    return serviceForUrl(config.url) !== null;
  } catch {
    // An unreadable URL can't connect, so nothing is sent.
    return false;
  }
}

export function createConnectors(options: ConnectorsOptions) {
  const { db, now, secrets, processes, consent } = options;
  const gate = createSendGate(consent, options.localOnly);
  const timing: ConnectorTiming = { ...CONNECTOR_TIMING, ...options.timing };
  const runtimes = new Map<string, Runtime>();
  const auths = new Map<string, ConnectorAuth>();
  let closed = false;

  const paused = (row: ConnectorRow) => options.localOnly() && awayFromHere(row);

  /** Local mode is on and `url` isn't on this computer: no request goes there. */
  const awayInLocalMode = (url: string) => {
    if (!options.localOnly()) return false;
    try {
      return serviceForUrl(url) !== null;
    } catch {
      return false;
    }
  };

  const liveRows = () =>
    db.all<ConnectorRow>(
      `SELECT ${COLUMNS} FROM connectors WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, created_at`,
    );
  const rowById = (id: string) =>
    db.get<ConnectorRow>(`SELECT ${COLUMNS} FROM connectors WHERE id = ? AND deleted_at IS NULL`, [
      id,
    ]);
  const requireRow = (id: unknown): ConnectorRow => {
    if (typeof id !== "string" || id === "") {
      throw new InvalidInputError("A Connector id must be a non-empty string.");
    }
    const row = rowById(id);
    if (!row) throw new NotFoundError({ key: "error.connector.notFound" });
    return row;
  };
  const requireRemote = (id: unknown) => {
    const row = requireRow(id);
    const config = storedConfig(row);
    if (config.transport !== "http") {
      throw new InvalidInputError("Only remote Connectors sign in.");
    }
    return { row, config };
  };

  const changed = () => {
    if (!closed) options.onChange(list());
  };

  /** A remote Connector's sign-in, kept for as long as the Connector exists. */
  const authOf = (id: string, url: string): ConnectorAuth => {
    let found = auths.get(id);
    if (!found) {
      found = createConnectorAuth({
        connectorId: id,
        url,
        secrets,
        now: options.clock,
        manualClientId: () => {
          const row = rowById(id);
          const config = row ? storedConfig(row) : null;
          return config?.transport === "http" ? config.clientId : null;
        },
        onChange: changed,
        heldBack: awayInLocalMode,
      });
      auths.set(id, found);
    }
    return found;
  };

  const toConnector = (row: ConnectorRow): Connector => {
    const config = storedConfig(row);
    const enabled = row.enabled === 1;
    const runtime = runtimes.get(row.id);
    const common = {
      id: row.id,
      name: row.name,
      enabled,
      state: !enabled
        ? ("off" as const)
        : paused(row)
          ? ("paused" as const)
          : runtime?.signingIn
            ? ("signing-in" as const)
            : (runtime?.state ?? "connecting"),
      error: enabled && !runtime?.signingIn && !paused(row) ? (runtime?.error ?? null) : null,
      tools:
        enabled && runtime?.tools
          ? runtime.tools.map(({ name, title, description, readOnly }) => ({
              name,
              title,
              description,
              readOnly,
            }))
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (config.transport === "http") {
      return {
        ...common,
        transport: "http",
        url: config.url,
        clientId: config.clientId,
        signIn: {
          ...(auths.get(row.id)?.status() ?? { signedIn: false, expired: false }),
          heldBack: options.localOnly() && runtime?.heldBack === true,
          error: runtime?.signInError ?? null,
        },
      };
    }
    return {
      ...common,
      transport: "stdio",
      command: config.command,
      args: config.args,
      env: config.env,
    };
  };

  const list = () => liveRows().map(toConnector);

  consent.registry.register({
    id: "connectors",
    sends: CONNECTORS_FLOW_SENDS,
    async services() {
      const services = new Map<string, ExternalService>();
      for (const row of liveRows()) {
        if (row.enabled !== 1) continue;
        const service = serviceOf(row);
        if (!services.has(service.id)) services.set(service.id, service);
      }
      return [...services.values()];
    },
    onThisComputer: (serviceId) =>
      liveRows().some((row) => serviceOf(row).id === serviceId && !awayFromHere(row)),
  });

  const runtimeOf = (id: string): Runtime => {
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = {
        generation: 0,
        state: "connecting",
        error: null,
        tools: null,
        session: null,
        client: null,
        connectedAt: 0,
        starting: null,
        failures: 0,
        retryTimer: null,
        signingIn: null,
        signInError: null,
        heldBack: false,
      };
      runtimes.set(id, runtime);
    }
    return runtime;
  };

  const clearRetry = (runtime: Runtime) => {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
  };

  /** Ends the current process or connection, gracefully unless `now`. Its callbacks see a new generation and stand down. */
  const stopProcess = (runtime: Runtime, { now = false } = {}) => {
    runtime.generation++;
    clearRetry(runtime);
    runtime.starting = null;
    const session = runtime.session;
    runtime.session = null;
    runtime.client = null;
    if (!session) return;
    if (now) session.kill();
    else session.close().catch(options.reportError);
  };

  /** Stops waiting for a browser sign-in, and waits until it has ended. */
  const cancelSignIn = async (runtime: Runtime | undefined) => {
    const signing = runtime?.signingIn;
    if (!signing) return;
    signing.controller.abort();
    await signing.done.catch(() => undefined);
  };

  const readEnv = async (id: string, names: readonly string[]) => {
    if (names.length === 0) return {};
    const raw = await secrets.tryGet(envSecret(id));
    let env: unknown;
    try {
      env = raw === null ? null : JSON.parse(raw);
    } catch {
      env = null;
    }
    if (!isRecord(env) || names.some((name) => typeof env[name] !== "string")) {
      throw new MissingSecretsError("The Connector's environment can't be read on this device.");
    }
    return env as Record<string, string>;
  };

  /** Records a failure; failures that may pass are retried, waiting longer each time. */
  const fail = (id: string, runtime: Runtime, error: ConnectorError) => {
    runtime.failures++;
    const retryable = error.kind !== "missing-command" && error.kind !== "missing-secrets";
    const retrying = retryable && runtime.failures <= timing.maxRestarts;
    runtime.state = "error";
    runtime.error = { ...error, retrying };
    runtime.tools = null;
    if (retrying) {
      const delays = timing.restartDelaysMs;
      const wait = delays[Math.min(runtime.failures - 1, delays.length - 1)] ?? 1_000;
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = null;
        if (!closed && rowById(id)?.enabled === 1) start(id);
      }, wait);
      runtime.retryTimer.unref?.();
    }
    changed();
  };

  /** A remote Connector's server wants a sign-in IncarnaMind doesn't have: it waits for the User. */
  const waitForSignIn = (runtime: Runtime, heldBack = false) => {
    stopProcess(runtime);
    runtime.state = "needs-sign-in";
    runtime.error = null;
    runtime.tools = null;
    runtime.failures = 0;
    runtime.heldBack = heldBack;
    changed();
  };

  /** The process of a ready Connector ended without being asked to, or its server can't be reached. */
  const lost = (id: string, runtime: Runtime, generation: number, error: () => ConnectorError) => {
    if (closed || runtime.generation !== generation) return;
    // Anything else this connection does from now on stands down, including its closing.
    runtime.generation++;
    const session = runtime.session;
    runtime.session = null;
    runtime.client = null;
    session?.kill();
    if (Date.now() - runtime.connectedAt >= timing.stableMs) runtime.failures = 0;
    fail(id, runtime, error());
  };

  /**
   * MCP's handshake over a transport that is ready to start, then the Tools.
   * `onLost` hears when a connection that was ready closes by itself.
   */
  async function handshake(
    runtime: Runtime,
    generation: number,
    transport: Transport,
    onLost: () => void,
  ): Promise<{ client: Client; tools: ToolInfo[]; ready(): void }> {
    const current = () => !closed && runtime.generation === generation;
    let ready = false;
    const { Client } = await import("./sdk");
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error || !tools || !ready || !current()) return;
            runtime.tools = tools.map(toToolInfo);
            changed();
          },
        },
      },
    });
    // Lines that aren't MCP, e.g. a server logging to its standard output, are skipped.
    client.onerror = () => undefined;
    client.onclose = () => {
      if (ready) onLost();
    };
    await client.connect(transport, { timeout: timing.connectTimeoutMs });
    const tools: ToolInfo[] = [];
    if (client.getServerCapabilities()?.tools) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: timing.connectTimeoutMs,
        });
        tools.push(...page.tools.map(toToolInfo));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 1_000);
    }
    return {
      client,
      tools,
      ready: () => {
        ready = true;
      },
    };
  }

  /** The connection is up: Answers can use its Tools. */
  const becameReady = (runtime: Runtime, client: Client, tools: ToolInfo[]) => {
    runtime.client = client;
    runtime.connectedAt = Date.now();
    runtime.state = "ready";
    runtime.error = null;
    runtime.tools = tools;
    changed();
  };

  async function connectLocal(
    id: string,
    config: Extract<StoredConfig, { transport: "stdio" }>,
    runtime: Runtime,
    generation: number,
  ): Promise<void> {
    const current = () => !closed && runtime.generation === generation;
    const { command, args, env: envNames } = config;
    let transport: ChildProcessTransport | null = null;
    try {
      const env = await readEnv(id, envNames);
      // Loaded before the process starts, so its output is read from the first line.
      const { ChildProcessTransport } = await import("./sdk");
      if (!current()) return;
      const child = await processes.spawn(command, args, { env });
      transport = new ChildProcessTransport(child);
      if (!current()) {
        transport.kill();
        return;
      }
      const process = transport;
      runtime.session = { close: () => process.close(), kill: () => process.kill() };
      const { client, tools, ready } = await handshake(runtime, generation, transport, () =>
        lost(id, runtime, generation, () =>
          stoppedError(command, process.exit, process.stderrTail, process.error),
        ),
      );
      if (!current()) {
        transport.close().catch(options.reportError);
        return;
      }
      ready();
      becameReady(runtime, client, tools);
    } catch (error) {
      let ended: Parameters<typeof startError>[2] = null;
      if (transport) {
        // A moment for the process to say how it ended, e.g. its exit code.
        await Promise.race([
          transport.ended,
          new Promise((resolve) => setTimeout(resolve, 250).unref()),
        ]);
        ended = {
          exit: transport.exit,
          stderr: transport.stderrTail,
          processError: transport.error,
        };
        transport.kill();
      }
      if (!current()) return;
      runtime.session = null;
      runtime.client = null;
      fail(
        id,
        runtime,
        error instanceof MissingSecretsError
          ? {
              kind: "missing-secrets",
              command: null,
              install: null,
              message: error.message,
              retrying: false,
            }
          : startError(command, error, ended),
      );
    }
  }

  async function connectRemote(
    id: string,
    url: string,
    runtime: Runtime,
    generation: number,
  ): Promise<void> {
    const current = () => !closed && runtime.generation === generation;
    const auth = authOf(id, url);
    const held = auth.heldBackCount();
    let transport: StreamableHTTPClientTransport | null = null;
    try {
      await auth.load();
      // An access token that has expired is renewed first, rather than sent to be refused.
      await auth.refreshIfStale();
      if (!current()) return;
      const connection = await remoteTransport(url, auth);
      if (!current()) return;
      transport = connection;
      runtime.session = { close: () => connection.close(), kill: () => void connection.close() };
      const { client, tools, ready } = await handshake(runtime, generation, connection, () =>
        lost(id, runtime, generation, () => ({
          kind: "stopped",
          command: null,
          install: null,
          message: "The connection closed.",
          retrying: false,
        })),
      );
      if (!current()) {
        connection.close().catch(options.reportError);
        return;
      }
      ready();
      becameReady(runtime, client, tools);
    } catch (error) {
      transport?.close().catch(() => undefined);
      if (!current()) return;
      runtime.session = null;
      runtime.client = null;
      if (causedBy(error, HeldBackError) || auth.heldBackCount() > held) {
        waitForSignIn(runtime, true);
      } else if (needsSignIn(error)) waitForSignIn(runtime);
      else fail(id, runtime, remoteError(error));
    }
  }

  async function connect(id: string, runtime: Runtime, generation: number): Promise<void> {
    const row = rowById(id);
    if (row?.enabled !== 1) return;
    const config = storedConfig(row);
    if (config.transport === "http") await connectRemote(id, config.url, runtime, generation);
    else await connectLocal(id, config, runtime, generation);
  }

  /** Starts a Connector, stopping its process (or connection) first if one runs. */
  function start(id: string): void {
    const runtime = runtimeOf(id);
    stopProcess(runtime);
    const generation = runtime.generation;
    runtime.state = "connecting";
    runtime.error = null;
    runtime.tools = null;
    runtime.heldBack = false;
    changed();
    const row = rowById(id);
    if (row && paused(row)) return;
    runtime.starting = connect(id, runtime, generation)
      .catch(options.reportError)
      .finally(() => {
        if (runtime.generation === generation) runtime.starting = null;
      });
  }

  /** Turned off or deleted: the process stops, a sign-in waiting is cancelled, and the failure count is forgotten. */
  const stop = (id: string) => {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    runtime.signingIn?.controller.abort();
    stopProcess(runtime);
    runtime.state = "connecting";
    runtime.error = null;
    runtime.tools = null;
    runtime.failures = 0;
  };

  const assertNameFree = (name: string) => {
    if (liveRows().some((row) => sameName(row.name, name))) {
      throw new InvalidInputError({ key: "error.connector.nameTaken", values: { name } });
    }
  };

  /** Stores a new Connector, its secrets in the keychain first: if that is refused, nothing is added. */
  const insert = async (config: ConnectorConfig): Promise<string> => {
    assertNameFree(config.name);
    const id = randomUUID();
    let secretName: string | null = null;
    let stored: StoredConfig;
    if (config.transport === "http") {
      const secret = config.client?.clientSecret ?? null;
      if (secret) {
        secretName = clientSecret(id);
        await secrets.set(secretName, manualClientRecord(secret));
      }
      stored = { transport: "http", url: config.url, clientId: config.client?.clientId ?? null };
    } else {
      const envNames = Object.keys(config.env);
      if (envNames.length > 0) {
        secretName = envSecret(id);
        await secrets.set(secretName, JSON.stringify(config.env));
      }
      stored = {
        transport: "stdio",
        command: config.command,
        args: config.args,
        env: envNames,
      };
    }
    const { transport, ...columns } = stored;
    const at = now();
    try {
      assertNameFree(config.name);
      db.run(
        `INSERT INTO connectors (id, name, transport, config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [id, config.name, transport, JSON.stringify(columns), at, at],
      );
    } catch (error) {
      if (secretName) await secrets.delete(secretName).catch(options.reportError);
      throw error;
    }
    // Connecting it, where the form says what goes to it, allows its Tool calls (ADR-0022).
    consent.choose(["connectors"], serviceOf(requireRow(id)));
    return id;
  };

  const previewImport = (json: unknown) => {
    const candidates = readMcpServers(json);
    const taken = new Set(liveRows().map((row) => row.name.toLowerCase()));
    for (const { entry } of candidates) {
      if (entry.action !== "add") continue;
      const key = entry.name.toLowerCase();
      if (taken.has(key)) entry.action = "exists";
      else taken.add(key);
    }
    return candidates;
  };

  /** Each enabled Connector that hasn't been started (or whose start is long over) starts. */
  const startIdle = (rows: readonly ConnectorRow[]) => {
    for (const row of rows) {
      const runtime = runtimes.get(row.id);
      const idle =
        !runtime ||
        (runtime.state === "connecting" &&
          !runtime.starting &&
          !runtime.retryTimer &&
          !runtime.signingIn);
      if (idle) start(row.id);
    }
  };

  const heldBackMessage =
    "Everything stays on this computer, and this Connector's sign-in is with a server that isn't on it, so the sign-in isn't renewed or started.";

  /**
   * A connected remote Connector whose access token needs renewing, while Local
   * mode is on and its sign-in is with a server elsewhere: held back, its Tools
   * left out, instead of offered and then refused.
   */
  const holdBackIfStale = async (row: ConnectorRow) => {
    const config = storedConfig(row);
    const runtime = runtimes.get(row.id);
    if (config.transport !== "http" || runtime?.state !== "ready") return;
    const generation = runtime.generation;
    try {
      await authOf(row.id, config.url).refreshIfStale();
    } catch (error) {
      if (causedBy(error, HeldBackError) && runtime.generation === generation) {
        waitForSignIn(runtime, true);
      }
    }
  };

  /** Why a call through a remote Connector failed: it may now need a sign-in, or its server may be gone. */
  const remoteCallFailed = (
    row: ConnectorRow,
    runtime: Runtime,
    generation: number,
    error: unknown,
    heldBack: boolean,
  ) => {
    if (closed || runtime.generation !== generation) return;
    if (heldBack || causedBy(error, HeldBackError)) {
      waitForSignIn(runtime, true);
      throw new Error(
        `The Connector "${row.name}" can't renew its sign-in while everything stays on this computer, so it can't be used now. Go on without it.`,
      );
    }
    if (needsSignIn(error)) {
      waitForSignIn(runtime);
      throw new Error(
        `The User needs to sign in to the Connector "${row.name}" again (in Settings → Connectors), so it can't be used now. Go on without it.`,
      );
    }
    const reason = remoteError(error);
    if (reason.kind === "unreachable") lost(row.id, runtime, generation, () => reason);
  };

  /** A Connector's Tool, as an Answer offers it to the model. */
  const answerTool = (row: ConnectorRow, tool: ToolInfo, name: string): Tool => {
    const service = serviceOf(row);
    const config = storedConfig(row);
    const description = tool.description || tool.title || tool.name;
    return {
      name,
      description: `From the User's Connector "${row.name}". ${description}`.slice(
        0,
        MAX_DESCRIPTION_CHARS,
      ),
      inputSchema: tool.inputSchema,
      provider: { kind: "connector", id: row.id, name: row.name },
      providerTool: tool.name,
      title: tool.title,
      effects: () => connectorToolEffects(service, tool.readOnly),
      // Its reply comes from the Connector's service, not from the User.
      untrustedResult: true,
      async call(input, { signal }) {
        if (paused(row)) {
          throw new Error(
            `The Connector "${row.name}" isn't used while everything stays on this computer, so ${tool.name} wasn't called. Go on without it.`,
          );
        }
        const refusal = (error: unknown) => {
          if (error instanceof ConsentDeclinedError || error instanceof ConsentRevokedError) {
            return new Error(
              `The User didn't allow sending data to the Connector "${row.name}", so ${tool.name} wasn't called. Go on without it.`,
            );
          }
          if (error instanceof LocalModeError) {
            return new Error(
              `The Connector "${row.name}" isn't used while everything stays on this computer, so ${tool.name} wasn't called. Go on without it.`,
            );
          }
          return error;
        };
        try {
          await untilAborted(consent.ensure("connectors", service), signal);
        } catch (error) {
          throw refusal(error);
        }
        const runtime = runtimes.get(row.id);
        const client = runtime?.client;
        if (!runtime || !client) {
          throw new Error(`The Connector "${row.name}" isn't connected right now.`);
        }
        const generation = runtime.generation;
        const auth = config.transport === "http" ? authOf(row.id, config.url) : null;
        const held = auth?.heldBackCount() ?? 0;
        let result: Awaited<ReturnType<Client["callTool"]>>;
        try {
          await auth?.refreshIfStale();
        } catch (error) {
          if (auth) remoteCallFailed(row, runtime, generation, error, auth.heldBackCount() > held);
          throw error;
        }
        // After the sign-in's refresh, which can wait on its server: the call is what sends.
        try {
          gate.check("connectors", service);
        } catch (error) {
          throw refusal(error);
        }
        try {
          result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
            signal,
            timeout: timing.callTimeoutMs,
            resetTimeoutOnProgress: true,
          });
        } catch (error) {
          if (auth) remoteCallFailed(row, runtime, generation, error, auth.heldBackCount() > held);
          throw error;
        }
        const text = resultText(result);
        if (result.isError === true) throw new Error(text);
        return text;
      },
    };
  };

  const added = async (config: ConnectorConfig): Promise<Connector> => {
    const id = await insert(config);
    start(id);
    options.onEnabledChange();
    return toConnector(requireRow(id));
  };

  function setEnabled(id: unknown, enabled: unknown): Connector {
    const row = requireRow(id);
    if (typeof enabled !== "boolean") throw new InvalidInputError("enabled must be true or false.");
    if ((row.enabled === 1) !== enabled) {
      db.run("UPDATE connectors SET enabled = ?, updated_at = ? WHERE id = ?", [
        enabled ? 1 : 0,
        now(),
        row.id,
      ]);
    }
    if (enabled) {
      const runtime = runtimes.get(row.id);
      if (!runtime?.client && !runtime?.starting && !runtime?.signingIn) start(row.id);
    } else {
      stop(row.id);
    }
    changed();
    options.onEnabledChange();
    return toConnector(requireRow(row.id));
  }

  return {
    list,

    add: async (input: unknown): Promise<Connector> => added(parseAddInput(input)),

    /**
     * Adds a directory entry as a remote Connector at its URL, named as the
     * service; a Connector already at that URL is the entry, turned on.
     */
    async addFromDirectory(entry: ConnectorDirectoryEntry, client: unknown): Promise<Connector> {
      const existing = liveRows().find((row) => {
        const config = storedConfig(row);
        return config.transport === "http" && config.url === entry.url;
      });
      if (existing) return setEnabled(existing.id, true);
      return added(parseAddInput({ name: entry.name, url: entry.url, client }));
    },

    /**
     * Changes a local Connector's name, command and arguments, and its
     * environment when one is given (none keeps the saved values), then starts
     * it again with them. Its Tools' approvals and its data-flow decision stay:
     * they belong to the Connector, not to its command.
     */
    async edit(id: unknown, input: unknown): Promise<Connector> {
      const row = requireRow(id);
      const current = storedConfig(row);
      const config = parseAddInput(input);
      if (current.transport !== "stdio" || config.transport !== "stdio") {
        throw new InvalidInputError("Only a local Connector's command can be changed.");
      }
      if (liveRows().some((other) => other.id !== row.id && sameName(other.name, config.name))) {
        throw new InvalidInputError({
          key: "error.connector.nameTaken",
          values: { name: config.name },
        });
      }
      const envNames = Object.keys(config.env);
      if (envNames.length > 0) await secrets.set(envSecret(row.id), JSON.stringify(config.env));
      const stored = {
        command: config.command,
        args: config.args,
        env: envNames.length > 0 ? envNames : current.env,
      };
      db.run("UPDATE connectors SET name = ?, config = ?, updated_at = ? WHERE id = ?", [
        config.name,
        JSON.stringify(stored),
        now(),
        row.id,
      ]);
      stop(row.id);
      if (row.enabled === 1) start(row.id);
      changed();
      options.onEnabledChange();
      return toConnector(requireRow(row.id));
    },

    setEnabled,

    async restart(id: unknown): Promise<Connector> {
      const row = requireRow(id);
      if (row.enabled !== 1) throw new InvalidInputError({ key: "error.connector.off" });
      const runtime = runtimeOf(row.id);
      await cancelSignIn(runtime);
      runtime.failures = 0;
      start(row.id);
      return toConnector(requireRow(row.id));
    },

    async delete(id: unknown): Promise<void> {
      const row = requireRow(id);
      const service = serviceOf(row);
      const config = storedConfig(row);
      const runtime = runtimes.get(row.id);
      stop(row.id);
      await cancelSignIn(runtime);
      runtimes.delete(row.id);
      const at = now();
      db.run("UPDATE connectors SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, row.id]);
      // Added again later, it is a new Connector: it asks again. A server another Connector still uses keeps its decision.
      if (!liveRows().some((other) => serviceOf(other).id === service.id)) {
        consent.revoke("connectors", service.id);
      }
      if (config.transport === "http") {
        await authOf(row.id, config.url).deleteAll().catch(options.reportError);
        auths.delete(row.id);
      } else {
        await secrets.delete(envSecret(row.id)).catch(options.reportError);
      }
      changed();
      options.onEnabledChange();
    },

    /**
     * Signs in to a remote Connector in the browser and waits for the User.
     * Starting again cancels a sign-in still waiting.
     */
    async signIn(id: unknown): Promise<ConnectorSignInResult> {
      const { row, config } = requireRemote(id);
      if (row.enabled !== 1) throw new InvalidInputError({ key: "error.connector.off" });
      if (paused(row)) throw new InvalidInputError({ key: "error.connector.localMode" });
      const storage = secrets.status();
      const runtime = runtimeOf(row.id);
      if (options.localOnly() && runtime.heldBack) {
        return { ok: false, error: { kind: "held-back", message: heldBackMessage } };
      }
      // Check before the User signs in, not after: the tokens would have nowhere to go. The
      // Connector says so under its row, or the click would seem to do nothing.
      if (!storage.canSave) {
        const error = new SecretStorageError(storage.protection);
        runtime.signInError = { kind: "secret-storage", message: error.message };
        changed();
        return { ok: false, error: runtime.signInError };
      }
      await cancelSignIn(runtime);
      if (closed || rowById(row.id)?.enabled !== 1) {
        return { ok: false, error: { kind: "cancelled", message: "The sign-in was cancelled." } };
      }
      // Nothing in the background competes with the sign-in for the server.
      stopProcess(runtime);
      runtime.state = "connecting";
      runtime.error = null;
      runtime.tools = null;
      runtime.signInError = null;
      const controller = new AbortController();
      const auth = authOf(row.id, config.url);
      const held = auth.heldBackCount();
      const done = signInRemote({
        url: config.url,
        auth,
        browser: options.browser,
        pages: options.signInPages(row.name),
        timeoutMs: timing.signInTimeoutMs,
        requestTimeoutMs: timing.connectTimeoutMs,
        signal: controller.signal,
        clientInfo: CLIENT_INFO,
      });
      runtime.signingIn = { controller, done };
      changed();
      let failure: ConnectorSignInError | null = null;
      try {
        await done;
      } catch (error) {
        failure =
          auth.heldBackCount() > held
            ? { kind: "held-back", message: heldBackMessage }
            : signInError(error);
      } finally {
        if (runtime.signingIn?.controller === controller) runtime.signingIn = null;
      }
      // Cancelled by a newer sign-in, by turning the Connector off or deleting it, or by quitting.
      if (closed || runtime.signingIn || runtimes.get(row.id) !== runtime) {
        return { ok: false, error: failure ?? { kind: "cancelled", message: "Cancelled." } };
      }
      // Neither is what Local mode held back: the Connector says that itself.
      runtime.signInError =
        failure?.kind === "cancelled" || failure?.kind === "held-back" ? null : failure;
      if (rowById(row.id)?.enabled === 1) {
        // Connect with the new tokens; without them, it ends up waiting for a sign-in again.
        start(row.id);
        await runtime.starting;
      } else {
        changed();
      }
      if (failure) return { ok: false, error: failure };
      return { ok: true, connector: toConnector(requireRow(row.id)) };
    },

    async cancelSignIn(id: unknown): Promise<void> {
      const row = requireRow(id);
      await cancelSignIn(runtimes.get(row.id));
    },

    /** Deletes a remote Connector's tokens and disconnects it: it waits for a sign-in. */
    async signOut(id: unknown): Promise<Connector> {
      const { row, config } = requireRemote(id);
      const runtime = runtimeOf(row.id);
      await cancelSignIn(runtime);
      await authOf(row.id, config.url).signOut();
      runtime.signInError = null;
      if (rowById(row.id)?.enabled === 1) waitForSignIn(runtime);
      else changed();
      return toConnector(requireRow(row.id));
    },

    /** Sets (or, with null, clears) the OAuth app a remote Connector signs in with. Signs out first. */
    async setClient(id: unknown, input: unknown): Promise<Connector> {
      const { row, config } = requireRemote(id);
      const client = parseClient(input);
      if (client?.clientSecret) {
        const { canSave, protection } = secrets.status();
        if (!canSave) throw new SecretStorageError(protection);
      }
      const runtime = runtimeOf(row.id);
      await cancelSignIn(runtime);
      db.run("UPDATE connectors SET config = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify({ url: config.url, clientId: client?.clientId ?? null }),
        now(),
        row.id,
      ]);
      await authOf(row.id, config.url).setManualSecret(client?.clientSecret ?? null);
      runtime.signInError = null;
      if (rowById(row.id)?.enabled === 1) waitForSignIn(runtime);
      else changed();
      return toConnector(requireRow(row.id));
    },

    previewImport: (json: unknown): ConnectorImportEntry[] =>
      previewImport(json).map((candidate) => candidate.entry),

    async import(json: unknown): Promise<ConnectorImportResult> {
      const candidates = previewImport(json);
      const adding = candidates.filter((each) => each.entry.action === "add");
      // Every environment goes to the keychain: check it can take them before adding any.
      const hasSecrets = (config: ConnectorConfig | null) =>
        config?.transport === "stdio" && Object.keys(config.env).length > 0;
      if (adding.some((each) => hasSecrets(each.config))) {
        const { canSave, protection } = secrets.status();
        if (!canSave) throw new SecretStorageError(protection);
      }
      const ids: string[] = [];
      for (const { config } of adding) if (config) ids.push(await insert(config));
      for (const id of ids) start(id);
      if (ids.length > 0) options.onEnabledChange();
      return {
        added: ids.map((id) => toConnector(requireRow(id))),
        skipped: candidates.filter((each) => each.entry.action !== "add").map((each) => each.entry),
      };
    },

    /** Whether any Connector is on: Answers may then send Tool results to the chat model. */
    anyEnabled: () => liveRows().some((row) => row.enabled === 1 && !paused(row)),

    /** "Keep everything on this computer" was turned on or off: remote Connectors disconnect, or connect again. */
    localModeChanged(): void {
      for (const row of liveRows()) {
        if (row.enabled !== 1) continue;
        const away = awayFromHere(row);
        if (!away && !runtimes.get(row.id)?.heldBack) continue;
        if (!options.localOnly()) start(row.id);
        else if (away) stop(row.id);
      }
      changed();
      options.onEnabledChange();
    },

    /** Starts every enabled Connector, e.g. when the app starts, and reads every remote one's sign-in. */
    startAll(): void {
      const rows = liveRows();
      for (const row of rows) {
        const config = storedConfig(row);
        if (config.transport === "http") {
          authOf(row.id, config.url).load().then(changed, options.reportError);
        }
      }
      startIdle(rows.filter((row) => row.enabled === 1));
    },

    /**
     * The Connectors as a Tool provider (see ../tools): the Tools of every
     * enabled Connector that is ready, for one Answer. Connectors not yet
     * started start now; those still connecting are waited for, a little.
     */
    async tools(signal: AbortSignal): Promise<Tool[]> {
      const rows = liveRows().filter((row) => row.enabled === 1 && !paused(row));
      if (rows.length === 0) return [];
      startIdle(rows);
      if (options.localOnly()) await Promise.all(rows.map(holdBackIfStale));
      const starting = rows.flatMap((row) => runtimes.get(row.id)?.starting ?? []);
      if (starting.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await untilAborted(
          Promise.race([
            Promise.allSettled(starting),
            new Promise((resolve) => {
              timer = setTimeout(resolve, timing.readyWaitMs);
            }),
          ]),
          signal,
        ).finally(() => clearTimeout(timer));
      }
      const tools: Tool[] = [];
      const names = new Set<string>();
      const unique = (name: string) => {
        let candidate = name.slice(0, MAX_TOOL_NAME_LENGTH);
        for (let n = 2; names.has(candidate); n++) {
          const suffix = `_${n}`;
          candidate = `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
        }
        names.add(candidate);
        return candidate;
      };
      const prefixes = new Set<string>();
      for (const row of rows) {
        const runtime = runtimes.get(row.id);
        if (runtime?.state !== "ready" || !runtime.tools) continue;
        // Two Connectors whose names give the same prefix: the second gets a number.
        let prefix = slug(row.name, "connector").slice(0, 24);
        for (let n = 2; prefixes.has(prefix); n++)
          prefix = `${slug(row.name, "connector").slice(0, 21)}_${n}`;
        prefixes.add(prefix);
        for (const tool of runtime.tools) {
          tools.push(answerTool(row, tool, unique(`${prefix}__${slug(tool.name, "tool")}`)));
        }
      }
      return tools;
    },

    /**
     * Where connecting to remote Connectors that are on, and signing in to
     * them, goes: each one's server, and the authorization server it named.
     * Nothing of the User's content goes there this way (Tool calls are the
     * "connectors" data flow).
     */
    remoteTraffic(): ExternalService[] {
      const services = new Map<string, ExternalService>();
      const add = (url: string) => {
        try {
          const service = remoteService(url);
          if (!services.has(service.id)) services.set(service.id, service);
        } catch {
          // An unreadable URL goes nowhere.
        }
      };
      for (const row of liveRows()) {
        const config = storedConfig(row);
        if (row.enabled !== 1 || config.transport !== "http" || paused(row)) continue;
        add(config.url);
        const authorizationServer = auths.get(row.id)?.authorizationServer();
        if (authorizationServer && !awayInLocalMode(authorizationServer)) add(authorizationServer);
      }
      return [...services.values()];
    },

    /**
     * The Connectors that are on but wait for the User to sign in, so an
     * Answer can say why it couldn't use them.
     */
    needingSignIn(): { id: string; name: string }[] {
      return liveRows()
        .filter((row) => {
          const runtime = runtimes.get(row.id);
          return (
            row.enabled === 1 &&
            !paused(row) &&
            runtime !== undefined &&
            (runtime.signingIn !== null || runtime.state === "needs-sign-in")
          );
        })
        .map((row) => ({ id: row.id, name: row.name }));
    },

    /** Stops every Connector at once, e.g. when the app quits. */
    close(): void {
      if (closed) return;
      closed = true;
      for (const runtime of runtimes.values()) {
        runtime.signingIn?.controller.abort();
        stopProcess(runtime, { now: true });
      }
      runtimes.clear();
    },
  };
}
