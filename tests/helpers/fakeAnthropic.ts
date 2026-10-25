/**
 * A local stand-in for Anthropic, for the Claude account route: an OAuth
 * authorization server (code exchange with PKCE and the state, refresh with
 * rotation) and the Messages API, on one HTTP server on 127.0.0.1. No real
 * account and no network. The unit tests stop it when each test finishes; the
 * smoke tests point a test build at it (INCARNAMIND_TEST_CLAUDE), so it imports
 * nothing from Vitest.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "../../src/core";
import { isRecord } from "../../src/core/errors";
import type { AnthropicOAuthConfig } from "../../src/core/providers/claudeAccount/config";

export const ANSWER = "Hello from your Claude plan.";
export const SYSTEM_BLOCK = "A system block the test profile adds.";
export const BETA_FLAG = "test-profile-2026-10-14";

export interface RecordedRequest {
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
}

/** What the fake Messages API answers a good token with. */
export type MessagesReply =
  | { kind: "answer" }
  | { kind: "error"; status: number; headers?: Record<string, string>; body: string };

interface PendingCode {
  challenge: string;
  redirectUri: string;
  state: string;
  clientId: string;
}

export interface FakeAnthropic {
  readonly origin: string;
  /** A client profile pointing at the fake; `redirect` says how the browser comes back. */
  profile(redirect: "page" | "loopback"): AnthropicOAuthConfig;
  /** Every token request, as JSON bodies. */
  tokenRequests: Record<string, unknown>[];
  /** Every Messages API request. */
  messages: RecordedRequest[];
  /** Tokens issued so far, the latest last. */
  issued: { accessToken: string; refreshToken: string }[];
  /** How long issued access tokens last, in seconds. */
  expiresIn: number;
  /** Set to refuse refreshes with this OAuth error. */
  refuseRefresh: string | null;
  /** The next replies of the Messages API, then answers. */
  replies: MessagesReply[];
  /** What an answer says. */
  answer: string;
  /** Refresh tokens revoked at sign-out, in order. */
  revoked: string[];
  /** A refresh is answered only once this resolves. */
  holdRefresh: Promise<void> | null;
  /** The token endpoint and the Messages API answer with a redirect to `/elsewhere`. */
  redirects: boolean;
  /** Requests that reached `/elsewhere`. */
  redirected: string[];
  /** Hands out a code for an authorization request, as Anthropic's page does once the User approves. */
  approve(authorizeUrl: string): { code: string; state: string; redirectUri: string };
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const CLIENT_ID = "test-client";

export async function createFakeAnthropic(): Promise<FakeAnthropic> {
  const codes = new Map<string, PendingCode>();
  const live = new Set<string>();
  let refreshable: string | null = null;
  let codeCount = 0;
  let origin = "";

  const issue = (fake: FakeAnthropic) => {
    const n = fake.issued.length + 1;
    const tokens = { accessToken: `access-${n}`, refreshToken: `refresh-${n}` };
    fake.issued.push(tokens);
    live.add(tokens.accessToken);
    refreshable = tokens.refreshToken;
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: fake.expiresIn,
      token_type: "Bearer",
      account: { uuid: "account-1", email_address: "reader@example.test" },
      organization: { uuid: "organization-1", name: "Reader's Organization" },
    };
  };

  const token = async (
    fake: FakeAnthropic,
    body: Record<string, unknown>,
    response: ServerResponse,
  ) => {
    fake.tokenRequests.push(body);
    if (body.grant_type === "authorization_code") {
      const pending = codes.get(String(body.code));
      codes.delete(String(body.code));
      const valid =
        pending &&
        body.client_id === pending.clientId &&
        body.redirect_uri === pending.redirectUri &&
        body.state === pending.state &&
        typeof body.code_verifier === "string" &&
        s256(body.code_verifier) === pending.challenge;
      if (!valid) return sendJson(response, 400, { error: "invalid_grant" });
      return sendJson(response, 200, issue(fake));
    }
    if (body.grant_type === "refresh_token") {
      await fake.holdRefresh;
      if (fake.refuseRefresh) return sendJson(response, 400, { error: fake.refuseRefresh });
      if (body.client_id !== CLIENT_ID || body.refresh_token !== refreshable) {
        return sendJson(response, 400, { error: "invalid_grant" });
      }
      return sendJson(response, 200, issue(fake));
    }
    return sendJson(response, 400, { error: "unsupported_grant_type" });
  };

  const messages = (
    fake: FakeAnthropic,
    request: IncomingMessage,
    body: Record<string, unknown>,
    response: ServerResponse,
  ) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(",") : value,
      ]),
    );
    fake.messages.push({ headers, body });
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const keyed = request.headers["x-api-key"] !== undefined;
    if (!keyed && (!bearer || !live.has(bearer))) {
      return sendJson(response, 401, {
        type: "error",
        error: { type: "authentication_error", message: "Invalid bearer token" },
      });
    }
    const reply = fake.replies.shift() ?? { kind: "answer" };
    if (reply.kind === "error") {
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(reply.body);
      return;
    }
    const model = String(body.model);
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events: [string, object][] = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 12, output_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: fake.answer },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 6 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      for (const [event, data] of events) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      response.end();
      return;
    }
    return sendJson(response, 200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: fake.answer }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 6 },
    });
  };

  const fake: FakeAnthropic = {
    get origin() {
      return origin;
    },
    tokenRequests: [],
    messages: [],
    issued: [],
    expiresIn: 3600,
    refuseRefresh: null,
    replies: [],
    answer: ANSWER,
    revoked: [],
    holdRefresh: null,
    redirects: false,
    redirected: [],
    profile: (redirect) => ({
      experimental: true,
      clientId: CLIENT_ID,
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/v1/oauth/token`,
      scopes: ["user:profile", "user:inference"],
      authorizeParams: { code: "true" },
      redirect:
        redirect === "page"
          ? { kind: "page", uri: `${origin}/oauth/code/callback` }
          : { kind: "loopback", port: 0, path: "/callback" },
      tokenRequest: { format: "json", stateInExchange: true },
      stateBytes: 32,
      apiBaseUrl: `${origin}/v1`,
      request: { systemBlocks: [SYSTEM_BLOCK], headers: { "anthropic-beta": BETA_FLAG } },
    }),
    approve(authorizeUrl) {
      const params = new URL(authorizeUrl).searchParams;
      codeCount += 1;
      const code = `code-${codeCount}`;
      const pending = {
        challenge: params.get("code_challenge") ?? "",
        redirectUri: params.get("redirect_uri") ?? "",
        state: params.get("state") ?? "",
        clientId: params.get("client_id") ?? "",
      };
      codes.set(code, pending);
      return { code, state: pending.state, redirectUri: pending.redirectUri };
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    readBody(request)
      .then((raw) => {
        const isJson = (request.headers["content-type"] ?? "").includes("application/json");
        const parsed: unknown = raw && isJson ? JSON.parse(raw) : {};
        const body = isRecord(parsed) ? parsed : {};
        if (path === "/elsewhere") {
          fake.redirected.push(raw);
          return sendJson(response, 200, {});
        }
        if (fake.redirects && (path === "/v1/oauth/token" || path === "/v1/messages")) {
          response.writeHead(307, { location: `${origin}/elsewhere` }).end();
          return;
        }
        if (request.method === "POST" && path === "/v1/oauth/revoke") {
          fake.revoked.push(new URLSearchParams(raw).get("token") ?? "");
          return sendJson(response, 200, {});
        }
        if (request.method === "POST" && path === "/v1/oauth/token") {
          if (!isJson) return sendJson(response, 415, { error: "invalid_request" });
          return token(fake, body, response);
        }
        if (request.method === "POST" && path === "/v1/messages") {
          return messages(fake, request, body, response);
        }
        response.writeHead(404).end();
      })
      .catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

export interface FakeClaudeBrowser extends Browser {
  opened: string[];
  /**
   * What the User does on Anthropic's page: "approve" signs in (with a
   * loopback redirect, the browser comes back at once), "decline" refuses,
   * "wait" leaves the page open for the test to finish.
   */
  behaviour: "approve" | "decline" | "wait";
  /** What the page showed for the latest approval: its code and its address. */
  shown: { code: string; address: string } | null;
  /** Each loopback redirect's status, once the browser came back. */
  visits: Promise<number>[];
}

export function createFakeClaudeBrowser(fake: FakeAnthropic): FakeClaudeBrowser {
  const browser: FakeClaudeBrowser = {
    opened: [],
    behaviour: "approve",
    shown: null,
    visits: [],
    async open(url) {
      browser.opened.push(url);
      const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      const back = new URL(redirectUri);
      if (browser.behaviour === "decline") {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("state", new URL(url).searchParams.get("state") ?? "");
      } else {
        const { code, state } = fake.approve(url);
        back.searchParams.set("code", code);
        back.searchParams.set("state", state);
        browser.shown = { code: `${code}#${state}`, address: back.href };
      }
      // Anthropic's own page shows the code: only a loopback redirect comes back by itself.
      if (browser.behaviour === "wait" || back.origin === fake.origin) return;
      browser.visits.push(
        new Promise((resolve) => setTimeout(resolve, 5)).then(async () => {
          const response = await fetch(back);
          await response.text();
          return response.status;
        }),
      );
    },
  };
  return browser;
}
