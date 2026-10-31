/**
 * A local stand-in for GitHub and Copilot, for the Copilot route: the OAuth
 * device flow (which answers its pending and slow-down errors with 200, as
 * GitHub does), refresh with rotation, the editor profile's token exchange,
 * and Copilot's OpenAI-compatible chat API with its model list, on one HTTP
 * server on 127.0.0.1. No real account and no network.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, CopilotProfileId } from "../../src/core";
import type { CopilotProfile } from "../../src/core/providers/copilot/config";

export const ANSWER = "Hello from your Copilot plan.";
export const USER_CODE = "WDJB-MJHT";
export const EDITOR_HEADER = "test-editor/1";
/** The GitHub account the fake signs in. */
export const LOGIN = "priya-shah";
/** GitHub asks for five seconds between polls; the fake asks for a moment, so tests needn't wait. */
const POLL_SECONDS = 0.01;

/** The models Copilot lists for the token: one is hidden from pickers, one off by policy. */
export const LISTED_MODELS = [
  { id: "gpt-5.5", name: "GPT-5.5", capabilities: { type: "chat" } },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", capabilities: { type: "chat" } },
  {
    id: "gpt-5.5-mini",
    name: "GPT-5.5 mini",
    model_picker_enabled: false,
    capabilities: { type: "chat" },
  },
  {
    id: "gemini-3.6",
    name: "Gemini 3.6",
    policy: { state: "disabled" },
    capabilities: { type: "chat" },
  },
  { id: "text-embedding-4", name: "Embedding", capabilities: { type: "embeddings" } },
];

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
}

/** What the chat API says next, given the request: text, or calls to Tools. */
export interface ChatTurn {
  text?: string;
  calls?: { name: string; arguments: unknown }[];
}

/** What the fake chat API answers a good token with. */
export type ChatReply = {
  kind: "error";
  status: number;
  headers?: Record<string, string>;
  body: string;
};

export interface FakeGitHub {
  readonly origin: string;
  profile(id: CopilotProfileId): CopilotProfile;
  /** Every request, in order. */
  requests: RecordedRequest[];
  /** Tokens GitHub issued, the latest last. */
  issued: { accessToken: string; refreshToken: string | null }[];
  /** Copilot tokens the exchange handed out, the latest last. */
  exchanged: string[];
  /** Issue tokens that expire, with a refresh token (an app with expiring tokens). */
  expiring: boolean;
  /** The next poll answers `slow_down` once. */
  slowDown: boolean;
  /** Refuse refreshes with this OAuth error (in a 200, as GitHub does). */
  refuseRefresh: string | null;
  /** The exchange answers this status instead of a Copilot token, e.g. 404 for no Copilot plan. */
  exchangeStatus: number | null;
  /** The token exchange drops the connection, as offline. */
  exchangeOffline: boolean;
  /** The token exchange answers with GitHub's own error for an account without Copilot. */
  exchangeNoCopilot: boolean;
  /** The token exchange answers that an organization's policy blocks the app. */
  exchangePolicy: boolean;
  /** What the token exchange says of the plan. */
  sku: string;
  /** The account's name isn't given: GitHub answers this status instead. */
  userStatus: number | null;
  /** What Copilot's model list holds. */
  listedModels: unknown[];
  /** The token exchange answers only once this resolves. */
  holdExchange: Promise<void> | null;
  /** The next replies of the chat API, then answers. */
  replies: ChatReply[];
  /** What the chat API says to each request after `replies`; `ANSWER` without one. */
  script: ((body: Record<string, unknown>) => ChatTurn) | null;
  /** The User approves the code on GitHub's page. */
  approve(): void;
  /** The User declines on GitHub's page. */
  deny(): void;
  /** The code expires before the User approves. */
  expire(): void;
  /** Tokens GitHub no longer takes, as when the User revokes the app. */
  revoke(): void;
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

/** Starts the fake on a free port. Call `close` when done. */
export async function createFakeGitHub(): Promise<FakeGitHub> {
  let origin = "";
  let deviceState: "pending" | "approved" | "denied" | "expired" = "pending";
  const live = new Set<string>();
  let refreshable: string | null = null;
  let deviceCount = 0;

  const issue = (fake: FakeGitHub) => {
    const n = fake.issued.length + 1;
    const tokens = {
      accessToken: `github-access-${n}`,
      refreshToken: fake.expiring ? `github-refresh-${n}` : null,
    };
    fake.issued.push(tokens);
    live.add(tokens.accessToken);
    refreshable = tokens.refreshToken;
    return {
      access_token: tokens.accessToken,
      token_type: "bearer",
      scope: "read:user",
      ...(fake.expiring && {
        expires_in: 28_800,
        refresh_token: tokens.refreshToken,
        refresh_token_expires_in: 15_897_600,
      }),
    };
  };

  const fake: FakeGitHub = {
    get origin() {
      return origin;
    },
    profile: (id) => ({
      clientId: id === "own" ? "test-own-app" : "test-editor-app",
      deviceCodeUrl: `${origin}/login/device/code`,
      tokenUrl: `${origin}/login/oauth/access_token`,
      scopes: ["read:user"],
      format: "json",
      apiBaseUrl: origin,
      accountUrl: `${origin}/user`,
      ...(id === "editor" && {
        experimental: true,
        signInHeaders: { "Editor-Version": EDITOR_HEADER },
        requestHeaders: { "Editor-Version": EDITOR_HEADER },
        tokenExchange: {
          url: `${origin}/copilot_internal/v2/token`,
          headers: { "Editor-Version": EDITOR_HEADER },
        },
      }),
    }),
    requests: [],
    issued: [],
    exchanged: [],
    expiring: false,
    slowDown: false,
    refuseRefresh: null,
    exchangeStatus: null,
    exchangeOffline: false,
    exchangeNoCopilot: false,
    exchangePolicy: false,
    sku: "plus_monthly_subscriber_quota",
    userStatus: null,
    listedModels: LISTED_MODELS,
    holdExchange: null,
    replies: [],
    script: null,
    approve: () => {
      deviceState = "approved";
    },
    deny: () => {
      deviceState = "denied";
    },
    expire: () => {
      deviceState = "expired";
    },
    revoke: () => live.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const token = (body: Record<string, unknown>, response: ServerResponse) => {
    if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      if (fake.slowDown) {
        fake.slowDown = false;
        return sendJson(response, 200, { error: "slow_down", interval: POLL_SECONDS });
      }
      if (deviceState === "pending")
        return sendJson(response, 200, { error: "authorization_pending" });
      if (deviceState === "denied") return sendJson(response, 200, { error: "access_denied" });
      if (deviceState === "expired") return sendJson(response, 200, { error: "expired_token" });
      deviceState = "pending";
      return sendJson(response, 200, issue(fake));
    }
    if (body.grant_type === "refresh_token") {
      if (fake.refuseRefresh || body.refresh_token !== refreshable || "client_secret" in body) {
        return sendJson(response, 200, { error: fake.refuseRefresh ?? "bad_refresh_token" });
      }
      return sendJson(response, 200, issue(fake));
    }
    return sendJson(response, 200, { error: "unsupported_grant_type" });
  };

  const bearer = (request: IncomingMessage) =>
    /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";

  const chat = (
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (!live.has(bearer(request))) {
      return sendJson(response, 401, { error: { message: "Bad credentials" } });
    }
    const reply = fake.replies.shift();
    if (reply) {
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(reply.body);
      return;
    }
    const model = String(body.model);
    const turn = fake.script?.(body) ?? { text: ANSWER };
    const toolCalls = turn.calls?.map((call, index) => ({
      index,
      id: `call-${index + 1}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    const finish = toolCalls ? "tool_calls" : "stop";
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1_790_000_000,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(
        chunk(
          {
            role: "assistant",
            content: turn.text ?? null,
            ...(toolCalls && { tool_calls: toolCalls }),
          },
          null,
        ),
      );
      response.write(chunk({}, finish));
      response.end("data: [DONE]\n\n");
      return;
    }
    return sendJson(response, 200, {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1_790_000_000,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.text ?? null,
            ...(toolCalls && { tool_calls: toolCalls }),
          },
          finish_reason: finish,
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    });
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    readBody(request)
      .then(async (raw) => {
        const isJson = (request.headers["content-type"] ?? "").includes("application/json");
        const body: Record<string, unknown> = raw
          ? isJson
            ? JSON.parse(raw)
            : Object.fromEntries(new URLSearchParams(raw))
          : {};
        const headers = Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(",") : value,
          ]),
        );
        fake.requests.push({ path, headers, body });
        if (request.method === "POST" && path === "/login/device/code") {
          deviceCount += 1;
          deviceState = "pending";
          return sendJson(response, 200, {
            device_code: `device-${deviceCount}`,
            user_code: USER_CODE,
            verification_uri: `${origin}/login/device`,
            expires_in: 900,
            interval: POLL_SECONDS,
          });
        }
        if (request.method === "POST" && path === "/login/oauth/access_token") {
          return token(body, response);
        }
        if (request.method === "GET" && path === "/copilot_internal/v2/token") {
          if (!live.has(bearer(request)))
            return sendJson(response, 401, { message: "Bad credentials" });
          await fake.holdExchange;
          if (fake.exchangeOffline) return response.socket?.destroy();
          if (fake.exchangeNoCopilot) {
            return sendJson(response, 403, {
              message: "Resource not accessible by integration",
              error_details: {
                notification_id: "no_copilot_access",
                message:
                  "No access to GitHub Copilot found. You are currently logged in as tester.",
              },
            });
          }
          if (fake.exchangePolicy) {
            return sendJson(response, 403, {
              message: "Copilot is disabled for this app by your organization's policy.",
            });
          }
          if (fake.exchangeStatus) {
            const status = fake.exchangeStatus;
            const message =
              status === 403
                ? "Resource not accessible by integration"
                : status === 404
                  ? "Not Found"
                  : "Server Error";
            return sendJson(response, status, { message });
          }
          const session = `copilot-session-${fake.exchanged.length + 1}`;
          fake.exchanged.push(session);
          live.add(session);
          return sendJson(response, 200, {
            token: session,
            expires_at: Math.floor(Date.parse("2026-10-06T09:25:00.000Z") / 1000),
            sku: fake.sku,
          });
        }
        if (request.method === "GET" && path === "/user") {
          if (!live.has(bearer(request)))
            return sendJson(response, 401, { message: "Bad credentials" });
          if (fake.userStatus) return sendJson(response, fake.userStatus, { message: "Error" });
          return sendJson(response, 200, { login: LOGIN, id: 1 });
        }
        if (request.method === "GET" && path === "/models") {
          if (!live.has(bearer(request)))
            return sendJson(response, 401, { message: "Bad credentials" });
          return sendJson(response, 200, { data: fake.listedModels, object: "list" });
        }
        if (request.method === "POST" && path === "/chat/completions") {
          return chat(body, request, response);
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

/** A browser that records what the app opens; the test plays the User on GitHub's page. */
export function createRecordingBrowser(): Browser & { opened: string[] } {
  const browser = {
    opened: [] as string[],
    async open(url: string) {
      browser.opened.push(url);
    },
  };
  return browser;
}
