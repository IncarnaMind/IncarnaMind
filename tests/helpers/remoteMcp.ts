/**
 * A local stand-in for a remote Connector's service, with no network and no
 * real accounts: an OAuth 2.1 authorization server (metadata, dynamic client
 * registration, the code exchange with PKCE, refresh tokens that rotate) and
 * an MCP server over Streamable HTTP that requires its tokens, each on its
 * own port on 127.0.0.1, so they are two origins as they would be for real.
 * Plus a fake browser that plays the User on the sign-in page.
 *
 * It uses no test framework, so the core tests (Vitest) and the smoke tests
 * (Playwright) can both start it. Call `close()` when done.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Browser } from "../../src/core";

/** The client ID of an OAuth app "the User registered" with the service by hand. */
export const MANUAL_CLIENT_ID = "users-own-app";
export const MANUAL_CLIENT_SECRET = "users-own-secret-0123456789";
export const SCOPE = "wiki.read";

export interface Registration {
  clientId: string;
  /** What IncarnaMind sent to the registration endpoint. */
  metadata: Record<string, unknown>;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  resource: string;
}

/** A call that reached the MCP server's Tool, with the token it carried. */
export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  token: string | null;
}

export interface FakeRemote {
  /** The MCP endpoint, as the User would enter it. */
  url: string;
  /** The MCP server's origin, which consent is recorded for. */
  mcpOrigin: string;
  /** The authorization server's issuer. */
  issuer: string;
  /** The resource indicator the protected-resource metadata gives. */
  resource: string;

  /** The MCP server answers without any token. */
  open: boolean;
  /** The authorization server offers dynamic client registration. */
  dynamicRegistration: boolean;
  /** The authorization server adds `iss` to its answers and says so in its metadata (RFC 9207). */
  issParameter: boolean;
  /** When set, the `iss` the browser brings back instead of the real one: a mix-up. */
  forgedIss: string | null;
  /** When set, the issuer the metadata names instead of the real one. */
  metadataIssuer: string | null;
  /** When set, the authorization server the MCP server's metadata names instead of its own, with its endpoints there: an address a test forwards here. */
  authorizationServer: string | null;
  /** Access-token lifetime in seconds for the next tokens. */
  expiresIn: number;
  /** Milliseconds each refresh takes. */
  refreshDelayMs: number;
  /** When set, refreshes are refused with this status and body. */
  refreshRefusal: { status: number; body: unknown } | null;

  /** Every request to each endpoint, by path, in order. */
  requests: { method: string; path: string; authorization: string | null }[];
  registrations: Registration[];
  /** The query of every authorization request the browser opened. */
  authorizeRequests: Record<string, string>[];
  /** Every request to the token endpoint, as its form fields. */
  tokenRequests: Record<string, string>[];
  issued: IssuedTokens[];
  toolCalls: ToolCall[];

  /** Makes every access token issued so far invalid, as if they expired early or were revoked. */
  revokeAccessTokens(): void;
  /**
   * What the sign-in page does when the User approves: checks the request as
   * a real server would and returns where it redirects the browser, with a
   * code bound to the request.
   */
  approve(authorizeUrl: string): string;
  /** Where the sign-in page redirects the browser when the User declines. */
  decline(authorizeUrl: string): string;
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const isLoopbackRedirect = (uri: string) => {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const stop = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

/** The service's wiki: `search_wiki` only reads (it says so), `edit_wiki` changes things. */
function wikiServer(fake: FakeRemote, token: string | null) {
  const server = new McpServer({ name: "wiki", version: "1.0.0" }, { capabilities: { tools: {} } });
  const query = {
    type: "object",
    properties: { query: { type: "string", description: "What to look for." } },
    required: ["query"],
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_wiki",
        description: "Searches the team wiki.",
        inputSchema: query,
        annotations: { readOnlyHint: true },
      },
      {
        name: "edit_wiki",
        description: "Edits a wiki page.",
        inputSchema: query,
        annotations: { readOnlyHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    fake.toolCalls.push({ tool: name, arguments: args, token });
    return {
      content: [{ type: "text", text: `Wiki results for "${String(args.query)}": Tide tables.` }],
    };
  });
  return server;
}

/** Starts the fake service: an authorization server and an MCP server, each on a free port. */
export async function startFakeRemote(): Promise<FakeRemote> {
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; resource: string }
  >();
  const validAccessTokens = new Set<string>();
  let codeCount = 0;

  const authServer = createServer();
  const mcpServer = createServer();
  const issuer = await listen(authServer);
  const mcpOrigin = await listen(mcpServer);
  const url = `${mcpOrigin}/mcp`;

  const known = (clientId: string) =>
    clientId === MANUAL_CLIENT_ID || fake.registrations.some((each) => each.clientId === clientId);

  const issue = (clientId: string, resource: string): IssuedTokens => {
    const n = fake.issued.length + 1;
    const tokens = {
      accessToken: `access-token-${n}-${"a".repeat(24)}`,
      refreshToken: `refresh-token-${n}-${"r".repeat(24)}`,
      clientId,
      resource,
    };
    fake.issued.push(tokens);
    validAccessTokens.add(tokens.accessToken);
    return tokens;
  };

  const tokenResponse = (tokens: IssuedTokens) => ({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: fake.expiresIn,
    scope: SCOPE,
  });

  /** The client's credentials, from a form or Basic authentication. */
  const credentials = (request: IncomingMessage, form: Record<string, string>) => {
    const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (basic) {
      const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
      return { clientId: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
    }
    return { clientId: form.client_id ?? "", secret: form.client_secret ?? null };
  };

  const handleToken = async (request: IncomingMessage, response: ServerResponse) => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
    fake.tokenRequests.push(form);
    const { clientId, secret } = credentials(request, form);
    if (!known(clientId) || (clientId === MANUAL_CLIENT_ID && secret !== MANUAL_CLIENT_SECRET)) {
      sendJson(response, 401, { error: "invalid_client" });
      return;
    }
    if (form.grant_type === "authorization_code") {
      const pending = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      const challenge = createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      if (
        !pending ||
        pending.challenge !== challenge ||
        pending.redirectUri !== form.redirect_uri ||
        pending.clientId !== clientId ||
        pending.resource !== form.resource
      ) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      sendJson(response, 200, tokenResponse(issue(clientId, fake.resource)));
      return;
    }
    if (form.grant_type === "refresh_token") {
      await new Promise((resolve) => setTimeout(resolve, fake.refreshDelayMs));
      if (fake.refreshRefusal) {
        sendJson(response, fake.refreshRefusal.status, fake.refreshRefusal.body);
        return;
      }
      // Refresh tokens rotate: only the newest one works.
      const latest = fake.issued.at(-1);
      if (
        !latest ||
        form.refresh_token !== latest.refreshToken ||
        form.resource !== fake.resource
      ) {
        sendJson(response, 400, { error: "invalid_grant", error_description: "Unknown token." });
        return;
      }
      sendJson(response, 200, tokenResponse(issue(clientId, fake.resource)));
      return;
    }
    sendJson(response, 400, { error: "unsupported_grant_type" });
  };

  const handleRegister = async (request: IncomingMessage, response: ServerResponse) => {
    const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
    const redirects = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
    if (redirects.length === 0 || !redirects.every((uri) => isLoopbackRedirect(String(uri)))) {
      sendJson(response, 400, { error: "invalid_redirect_uri" });
      return;
    }
    const clientId = `registered-client-${fake.registrations.length + 1}`;
    fake.registrations.push({ clientId, metadata });
    sendJson(response, 201, {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  };

  authServer.on("request", (request, response) => {
    const path = new URL(request.url ?? "/", issuer).pathname;
    fake.requests.push({
      method: request.method ?? "",
      path: `auth:${path}`,
      authorization: request.headers.authorization ?? null,
    });
    const run = async () => {
      if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
        const base = fake.authorizationServer ?? issuer;
        sendJson(response, 200, {
          issuer: fake.metadataIssuer ?? base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(fake.dynamicRegistration ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          scopes_supported: [SCOPE],
          authorization_response_iss_parameter_supported: fake.issParameter,
        });
      } else if (request.method === "POST" && path === "/token") {
        await handleToken(request, response);
      } else if (request.method === "POST" && path === "/register" && fake.dynamicRegistration) {
        await handleRegister(request, response);
      } else {
        response.writeHead(404).end();
      }
    };
    run().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });

  mcpServer.on("request", (request, response) => {
    const path = new URL(request.url ?? "/", mcpOrigin).pathname;
    const authorization = request.headers.authorization ?? null;
    fake.requests.push({ method: request.method ?? "", path: `mcp:${path}`, authorization });
    const run = async () => {
      if (request.method === "GET" && path === "/.well-known/oauth-protected-resource/mcp") {
        sendJson(response, 200, {
          resource: fake.resource,
          authorization_servers: [fake.authorizationServer ?? issuer],
          scopes_supported: [SCOPE],
          bearer_methods_supported: ["header"],
        });
        return;
      }
      if (path !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? null;
      if (!fake.open && !(token && validAccessTokens.has(token))) {
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`,
        });
        response.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return;
      }
      // Stateless: a server and transport for each request, answering in JSON.
      const server = wikiServer(fake, token);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    };
    run().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    });
  });

  const redirectFor = (authorizeUrl: string, params: Record<string, string>) => {
    const query = new URL(authorizeUrl).searchParams;
    const redirect = new URL(query.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", query.get("state") ?? "");
    for (const [name, value] of Object.entries(params)) redirect.searchParams.set(name, value);
    if (fake.issParameter || fake.forgedIss) {
      redirect.searchParams.set("iss", fake.forgedIss ?? fake.authorizationServer ?? issuer);
    }
    return redirect.href;
  };

  const fake: FakeRemote = {
    url,
    mcpOrigin,
    issuer,
    resource: url,
    open: false,
    dynamicRegistration: true,
    issParameter: true,
    forgedIss: null,
    metadataIssuer: null,
    authorizationServer: null,
    expiresIn: 3600,
    refreshDelayMs: 0,
    refreshRefusal: null,
    requests: [],
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    issued: [],
    toolCalls: [],
    revokeAccessTokens: () => validAccessTokens.clear(),

    approve(authorizeUrl) {
      const query = new URL(authorizeUrl).searchParams;
      fake.authorizeRequests.push(Object.fromEntries(query));
      const clientId = query.get("client_id") ?? "";
      const redirectUri = query.get("redirect_uri") ?? "";
      const registered = fake.registrations.find((each) => each.clientId === clientId);
      // A registered client may only come back to a redirect URI it registered.
      const allowed = registered
        ? (registered.metadata.redirect_uris as string[]).includes(redirectUri)
        : clientId === MANUAL_CLIENT_ID && isLoopbackRedirect(redirectUri);
      if (
        !allowed ||
        query.get("response_type") !== "code" ||
        query.get("code_challenge_method") !== "S256" ||
        !query.get("code_challenge") ||
        query.get("resource") !== fake.resource
      ) {
        throw new Error(`The fake authorization server refused the request: ${authorizeUrl}`);
      }
      codeCount += 1;
      const code = `code-${codeCount}`;
      codes.set(code, {
        challenge: query.get("code_challenge") ?? "",
        redirectUri,
        clientId,
        resource: query.get("resource") ?? "",
      });
      return redirectFor(authorizeUrl, { code });
    },

    decline(authorizeUrl) {
      fake.authorizeRequests.push(Object.fromEntries(new URL(authorizeUrl).searchParams));
      return redirectFor(authorizeUrl, {
        error: "access_denied",
        error_description: "The User declined.",
      });
    },

    close: async () => {
      await Promise.all([stop(authServer), stop(mcpServer)]);
    },
  };
  return fake;
}

export interface BrowserVisit {
  /** The URL the browser went to: where the sign-in page redirected it. */
  url: string;
  status: number;
  html: string;
}

export interface FakeBrowser extends Browser {
  /** Every URL the app opened. */
  opened: string[];
  /** The page the loopback redirect showed for each visit, once it arrives. */
  visits: Promise<BrowserVisit>[];
  /**
   * What the User does on the sign-in page: "approve" signs in, "decline"
   * refuses, "ignore" walks away. With `forgedStateFirst`, something else
   * first sends the redirect a code with a state of its own.
   */
  behaviour: "approve" | "decline" | "ignore";
  forgedStateFirst: boolean;
}

const visit = async (url: string): Promise<BrowserVisit> => {
  const response = await fetch(url);
  return { url, status: response.status, html: await response.text() };
};

/** A browser in which the User signs in to the fake service, redirecting back like a real one. */
export function createFakeBrowser(fake: FakeRemote): FakeBrowser {
  const browser: FakeBrowser = {
    opened: [],
    visits: [],
    behaviour: "approve",
    forgedStateFirst: false,
    async open(url) {
      browser.opened.push(url);
      if (browser.behaviour === "ignore") return;
      const redirect = browser.behaviour === "approve" ? fake.approve(url) : fake.decline(url);
      const forged = new URL(redirect);
      forged.searchParams.set("state", "forged-state");
      forged.searchParams.set("code", "stolen-code");
      // Like a real browser, the redirect happens after `open` returns.
      const later = new Promise((resolve) => setTimeout(resolve, 5));
      if (browser.forgedStateFirst) {
        const first = later.then(() => visit(forged.href));
        browser.visits.push(first);
        browser.visits.push(first.then(() => visit(redirect)));
      } else {
        browser.visits.push(later.then(() => visit(redirect)));
      }
    },
  };
  return browser;
}
