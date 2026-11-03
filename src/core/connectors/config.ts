/**
 * A Connector's configuration: checking what the User typed, and reading the
 * `mcpServers` JSON that Claude Desktop and Cursor keep theirs in:
 *
 *   { "mcpServers": {
 *       "github": { "command": "npx", "args": ["-y", "…"], "env": { "GITHUB_TOKEN": "…" } },
 *       "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } } }
 */
import type { ConnectorImportEntry } from "../api";
import { InvalidInputError, isRecord } from "../errors";
import { isLoopbackHost } from "../providers/kinds";

const MAX_NAME_LENGTH = 100;
const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGS = 200;
const MAX_URL_LENGTH = 2048;
const MAX_CLIENT_ID_LENGTH = 500;

/** What starts a local Connector. `env` holds secrets: it goes to the keychain, never the database. */
export interface LocalConnectorConfig {
  transport: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** An OAuth app the User registered with a service. The secret goes to the keychain. */
export interface ClientCredentials {
  clientId: string;
  clientSecret: string | null;
}

/** Remote input; header values and the OAuth secret are consumed into the device's secret store. */
export interface RemoteConnectorConfig {
  transport: "http";
  name: string;
  url: string;
  client: ClientCredentials | null;
  connection: "http" | "sse";
  headers: Record<string, string>;
}

export type ConnectorConfig = LocalConnectorConfig | RemoteConnectorConfig;

/**
 * A remote Connector's URL, checked: https, or http only to this computer,
 * since its sign-in's tokens travel with every request. The fragment is
 * dropped: an MCP endpoint (and an OAuth resource) never has one.
 */
export function parseRemoteUrl(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("A Connector's URL must be text.");
  const text = value.trim();
  if (!text) throw new InvalidInputError({ key: "error.connector.urlMissing" });
  if (text.length > MAX_URL_LENGTH)
    throw new InvalidInputError({ key: "error.connector.urlTooLong" });
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidInputError({ key: "error.connector.urlInvalid", values: { url: text } });
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new InvalidInputError({ key: "error.connector.urlInsecure" });
  }
  if (url.username || url.password) {
    throw new InvalidInputError({ key: "error.connector.urlCredentials" });
  }
  url.hash = "";
  return url.href;
}

/** The OAuth app the User entered, if any: a client ID, and a secret only if the service gave one. */
export function parseClient(value: unknown): ClientCredentials | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new InvalidInputError("A Connector's client must be an object.");
  if (typeof value.clientId !== "string")
    throw new InvalidInputError({ key: "error.connector.clientIdMissing" });
  const clientId = value.clientId.trim();
  if (!clientId) throw new InvalidInputError({ key: "error.connector.clientIdMissing" });
  if (clientId.length > MAX_CLIENT_ID_LENGTH || /\p{Cc}/u.test(clientId)) {
    throw new InvalidInputError({ key: "error.connector.clientIdInvalid" });
  }
  const rawSecret = value.clientSecret;
  if (rawSecret !== undefined && rawSecret !== null && typeof rawSecret !== "string") {
    throw new InvalidInputError("A client secret must be text.");
  }
  const clientSecret = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (clientSecret.includes("\0"))
    throw new InvalidInputError({ key: "error.connector.clientSecretInvalid" });
  return { clientId, clientSecret: clientSecret || null };
}

export function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length > 32) {
    throw new InvalidInputError({ key: "error.connector.headersInvalid" });
  }
  const names = new Set<string>();
  return Object.fromEntries(
    Object.entries(value).map(([name, raw]) => {
      const normalized = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name) ||
        names.has(normalized) ||
        /^(host|connection|content-length|content-type|accept|cookie|proxy-authorization|transfer-encoding|mcp-.*)$/i.test(
          name,
        ) ||
        typeof raw !== "string" ||
        !raw.trim() ||
        raw.length > 16_384 ||
        /[\r\n\0]/.test(raw)
      ) {
        throw new InvalidInputError({ key: "error.connector.headersInvalid" });
      }
      names.add(normalized);
      return [name, raw.trim()];
    }),
  );
}

function parseName(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("A Connector's name must be text.");
  const name = value.trim();
  if (!name) throw new InvalidInputError({ key: "error.connector.nameEmpty" });
  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidInputError({
      key: "error.connector.nameTooLong",
      values: { max: MAX_NAME_LENGTH },
    });
  }
  return name;
}

function parseCommand(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("A Connector's command must be text.");
  const command = value.trim();
  if (!command) throw new InvalidInputError({ key: "error.connector.commandMissing" });
  if (command.length > MAX_COMMAND_LENGTH || command.includes("\0")) {
    throw new InvalidInputError({ key: "error.connector.commandInvalid" });
  }
  return command;
}

function parseArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw new InvalidInputError("A Connector's arguments must be a list of text.");
  }
  return value.map((arg) => {
    // Configurations sometimes give numbers bare, e.g. a port.
    if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new InvalidInputError("A Connector's arguments must be a list of text.");
    }
    return arg;
  });
}

/** A name a variable can have in every shell: no "=", spaces or control characters. */
const ENV_NAME = /^[^=\s\p{Cc}]+$/u;

function parseEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new InvalidInputError("A Connector's environment must map names to values.");
  }
  const env: Record<string, string> = {};
  for (const [rawName, raw] of Object.entries(value)) {
    const name = rawName.trim();
    if (!ENV_NAME.test(name)) {
      throw new InvalidInputError({
        key: "error.connector.envNameInvalid",
        values: { name: rawName },
      });
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new InvalidInputError(`The value of ${name} must be text.`);
    }
    const text = String(raw);
    if (text.includes("\0"))
      throw new InvalidInputError({ key: "error.connector.envValueInvalid", values: { name } });
    env[name] = text;
  }
  return env;
}

/** A local Connector by its command, or a remote one by its `url`. */
export function parseAddInput(input: unknown): ConnectorConfig {
  if (!isRecord(input)) throw new InvalidInputError("addConnector expects an object.");
  if (input.url !== undefined) {
    if (input.command !== undefined) {
      throw new InvalidInputError("A Connector has either a command or a URL, not both.");
    }
    const headers = parseHeaders(input.headers);
    const client = parseClient(input.client);
    if (client && Object.keys(headers).length > 0) {
      throw new InvalidInputError({ key: "error.connector.authChoice" });
    }
    return {
      transport: "http",
      name: parseName(input.name),
      url: parseRemoteUrl(input.url),
      client,
      connection: input.connection === "sse" ? "sse" : "http",
      headers,
    };
  }
  return {
    transport: "stdio",
    name: parseName(input.name),
    command: parseCommand(input.command),
    args: parseArgs(input.args),
    env: parseEnv(input.env),
  };
}

/** A server of an `mcpServers` configuration, and its configuration when it can be added. */
export interface ImportCandidate {
  entry: ConnectorImportEntry;
  config: ConnectorConfig | null;
}

/** Streamable HTTP, as Cursor, VS Code and Claude Code name it. A URL without a type may be either. */
const STREAMABLE_HTTP_TYPES = new Set(["http", "streamable-http", "streamablehttp"]);

const looksLikeServer = (value: unknown) =>
  isRecord(value) && (typeof value.command === "string" || typeof value.url === "string");

function remoteCandidate(name: string, value: Record<string, unknown>): ImportCandidate {
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const base = { name, command: null, args: [], env: [], ...(url ? { url } : {}) };
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (type !== "" && type !== "sse" && !STREAMABLE_HTTP_TYPES.has(type)) {
    return { entry: { ...base, action: "remote" }, config: null };
  }
  try {
    const parsed = parseRemoteUrl(url);
    const headers = parseHeaders(value.headers);
    const connection = type === "sse" ? "sse" : "http";
    return {
      entry: { ...base, url: parsed, headers: Object.keys(headers), connection, action: "add" },
      config: { transport: "http", name, url: parsed, client: null, headers, connection },
    };
  } catch {
    return { entry: { ...base, action: "invalid" }, config: null };
  }
}

/** The object that maps server names to servers, wherever the configuration keeps it. */
function serversOf(parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed)) return null;
  if (isRecord(parsed.mcpServers)) return parsed.mcpServers;
  // VS Code's mcp.json.
  if (isRecord(parsed.servers)) return parsed.servers;
  // Just the servers, pasted without the "mcpServers" around them.
  const values = Object.values(parsed);
  return values.length > 0 && values.every(looksLikeServer) ? parsed : null;
}

function candidate(key: string, value: unknown): ImportCandidate {
  const name = key.trim();
  const base = { name, command: null, args: [], env: [] };
  if (!name || name.length > MAX_NAME_LENGTH || !isRecord(value)) {
    return { entry: { ...base, action: "invalid" }, config: null };
  }
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (typeof value.url === "string" || type === "sse" || STREAMABLE_HTTP_TYPES.has(type)) {
    return remoteCandidate(name, value);
  }
  try {
    const config: LocalConnectorConfig = {
      transport: "stdio",
      name,
      command: parseCommand(value.command),
      args: parseArgs(value.args),
      env: parseEnv(value.env),
    };
    const entry: ConnectorImportEntry = {
      name,
      command: config.command,
      args: config.args,
      env: Object.keys(config.env),
      action: "add",
    };
    return { entry, config };
  } catch {
    const command = typeof value.command === "string" ? value.command : null;
    return { entry: { ...base, command, action: "invalid" }, config: null };
  }
}

/**
 * Every server in an `mcpServers` configuration, in its order, marked "add"
 * unless it is a remote server IncarnaMind can't connect to, or invalid.
 * Whether a name is taken is for the caller.
 */
export function readMcpServers(json: unknown): ImportCandidate[] {
  if (typeof json !== "string") throw new InvalidInputError("The configuration must be text.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidInputError({ key: "error.connector.jsonInvalid" });
  }
  const servers = serversOf(parsed);
  if (!servers || Object.keys(servers).length === 0) {
    throw new InvalidInputError({ key: "error.connector.noServers" });
  }
  return Object.entries(servers).map(([key, value]) => candidate(key, value));
}
