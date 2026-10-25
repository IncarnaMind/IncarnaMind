/**
 * The official MCP Registry (https://registry.modelcontextprotocol.io), which
 * Settings › Connectors searches for community servers once the User types
 * (#148). Only the words they typed are sent, in the request's address,
 * after they allowed the "connector-registry" flow, and never in Local mode.
 * What comes back hasn't been reviewed: the page says so.
 */
import type {
  ConnectorRegistryCommand,
  ConnectorRegistrySearch,
  ConnectorRegistryServer,
  DataKind,
  ExternalService,
} from "../api";
import type { Consent } from "../consent";
import { ConsentDeclinedError, ConsentRevokedError, isRecord, LocalModeError } from "../errors";
import { createSendGate } from "../sendGate";

export const REGISTRY: ExternalService = {
  id: "https://registry.modelcontextprotocol.io",
  name: "MCP Registry",
};

/** What the "connector-registry" flow sends: the words typed in the Connectors search. */
export const REGISTRY_SENDS: readonly DataKind[] = ["connector-search"];

/** Fewer than this many letters search nothing. */
export const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;
const RESULTS = 20;
const TIMEOUT_MS = 15_000;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A remote server IncarnaMind can connect to: Streamable HTTP at a URL it can use as it is. */
function remoteUrl(remotes: unknown): string | null {
  if (!Array.isArray(remotes)) return null;
  for (const remote of remotes) {
    if (!isRecord(remote) || remote.type !== "streamable-http") continue;
    const url = text(remote.url);
    // A URL with {variables} or a required header needs setting up the page can't do.
    const needsHeader =
      Array.isArray(remote.headers) &&
      remote.headers.some((header) => isRecord(header) && header.isRequired === true);
    if (url.startsWith("https://") && !url.includes("{") && !needsHeader) return url;
  }
  return null;
}

/** How a local package runs: through npx or uvx, which fetch it the first time. */
function localCommand(packages: unknown): ConnectorRegistryCommand | null {
  if (!Array.isArray(packages)) return null;
  for (const entry of packages) {
    if (!isRecord(entry)) continue;
    const transport = isRecord(entry.transport) ? entry.transport.type : undefined;
    const identifier = text(entry.identifier);
    if (transport !== "stdio" || !identifier) continue;
    const version = text(entry.version);
    const pinned = version ? `${identifier}@${version}` : identifier;
    const runner =
      entry.registryType === "npm"
        ? { command: "npx", args: ["-y", pinned] }
        : entry.registryType === "pypi"
          ? { command: "uvx", args: [pinned] }
          : null;
    if (!runner) continue;
    const positional = Array.isArray(entry.packageArguments)
      ? entry.packageArguments.flatMap((argument) =>
          isRecord(argument) && argument.type === "positional" && text(argument.value)
            ? [text(argument.value)]
            : [],
        )
      : [];
    const env = Array.isArray(entry.environmentVariables)
      ? entry.environmentVariables.flatMap((variable) =>
          isRecord(variable) && text(variable.name) ? [text(variable.name)] : [],
        )
      : [];
    return { command: runner.command, args: [...runner.args, ...positional], env };
  }
  return null;
}

/** One server of the Registry's answer, or null for one that isn't active or has no name. */
function serverOf(item: unknown): ConnectorRegistryServer | null {
  if (!isRecord(item) || !isRecord(item.server)) return null;
  const meta = isRecord(item._meta)
    ? item._meta["io.modelcontextprotocol.registry/official"]
    : null;
  if (isRecord(meta) && meta.status !== undefined && meta.status !== "active") return null;
  const { server } = item;
  const id = text(server.name);
  if (!id) return null;
  const slash = id.lastIndexOf("/");
  const repository = isRecord(server.repository) ? text(server.repository.url) : "";
  const link = text(server.websiteUrl) || repository;
  return {
    id,
    name: text(server.title) || id.slice(slash + 1),
    publisher: slash > 0 ? id.slice(0, slash) : id,
    description: text(server.description),
    url: remoteUrl(server.remotes),
    command: localCommand(server.packages),
    link: link.startsWith("https://") ? link : null,
  };
}

/** The Registry's answer, read: each active server once, in its order. */
export function readRegistryAnswer(answer: unknown): ConnectorRegistryServer[] {
  if (!isRecord(answer) || !Array.isArray(answer.servers)) {
    throw new Error("The MCP Registry's answer has no list of servers.");
  }
  const servers: ConnectorRegistryServer[] = [];
  for (const item of answer.servers) {
    const server = serverOf(item);
    if (server && !servers.some((each) => each.id === server.id)) servers.push(server);
  }
  return servers;
}

export interface ConnectorRegistryOptions {
  /** The Registry's address; tests point it at a local stand-in. Consent is still the Registry's. */
  baseUrl: string;
  consent: Consent;
  /** Local mode is on: nothing is sent. */
  localOnly(): boolean;
}

export function createConnectorRegistry({ baseUrl, consent, localOnly }: ConnectorRegistryOptions) {
  const gate = createSendGate(consent, localOnly);
  return {
    /**
     * Searches the Registry for what the User typed, asking them first the
     * first time. Fewer than two letters search nothing.
     */
    async search(query: unknown, signal?: AbortSignal): Promise<ConnectorRegistrySearch> {
      const words = text(query).slice(0, MAX_QUERY_LENGTH);
      if (words.length < MIN_QUERY_LENGTH) return { outcome: "found", servers: [] };
      if (localOnly()) return { outcome: "failed", reason: "local-mode" };
      try {
        await consent.ensure("connector-registry", REGISTRY);
        gate.check("connector-registry", REGISTRY);
      } catch (error) {
        if (error instanceof ConsentDeclinedError || error instanceof ConsentRevokedError) {
          return { outcome: "failed", reason: "declined" };
        }
        if (error instanceof LocalModeError) return { outcome: "failed", reason: "local-mode" };
        throw error;
      }
      const url = new URL("/v0.1/servers", baseUrl);
      url.searchParams.set("search", words);
      url.searchParams.set("version", "latest");
      url.searchParams.set("limit", String(RESULTS));
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        console.error("The MCP Registry couldn't be reached.", error);
        return { outcome: "failed", reason: "unreachable" };
      }
      if (!response.ok) {
        console.error(`The MCP Registry answered ${response.status} to a search.`);
        return { outcome: "failed", reason: "service-error" };
      }
      try {
        return { outcome: "found", servers: readRegistryAnswer(await response.json()) };
      } catch (error) {
        console.error("The MCP Registry's answer couldn't be read.", error);
        return { outcome: "failed", reason: "service-error" };
      }
    },
  };
}
