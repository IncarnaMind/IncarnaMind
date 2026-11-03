/**
 * A local stand-in for OpenAI, for the ChatGPT plan provider: Sign in with
 * ChatGPT's authorization server (dynamic registration, code exchange with
 * PKCE, refresh, revocation, signing keys) and the Responses API with its
 * model list, on one HTTP server on 127.0.0.1. No real account and no network.
 * The unit tests use it through `./chatgpt`; the smoke tests point a test
 * build at it (INCARNAMIND_TEST_CHATGPT), so it imports nothing from Vitest.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatGptPlanEndpoints } from "../../src/core";

export const SUBJECT = "user-0001";
export const EMAIL = "reader@example.com";
export const ANSWER = "Hello from your plan.";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const FULL_SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

/** The account's models, as `GET /v1/models` lists them. */
export const ACCOUNT_MODELS = [
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
  { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
  { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide" },
];

const KEY_ID = "test-key-1";

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

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT signed with RS256 by `key`. */
export function signJwt(claims: Record<string, unknown>, key: KeyObject, kid = KEY_ID): string {
  const signingInput = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part(claims)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

export interface IssuedTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface ApiRequest {
  path: string;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
}

/** What the fake Responses API answers with, when the token is good. */
export type ApiReply =
  | { kind: "answer"; text: string }
  /** A stream that starts, then fails with this error, as a usage limit can mid-answer. */
  | { kind: "fails-midway"; error: { code: string; message: string } }
  | { kind: "error"; status: number; body: unknown };

/** What the User does on OpenAI's page. */
export interface Approval {
  /** The account they sign in with. */
  subject?: string;
  email?: string;
  /** False: they don't allow IncarnaMind to use their plan. */
  allowPlan?: boolean;
}

/** Server-sent events of a streamed Responses API answer. */
function answerEvents(text: string, model: string): object[] {
  const response = { id: "resp_1", object: "response", created_at: 1_790_000_000, model };
  const words = text.split(/(?<= )/);
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    ...words.map((delta) => ({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      // The final event can come without the output items.
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [],
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 17,
        },
      },
    },
  ];
}

export interface FakeOpenAI {
  /** Point the core's `chatGptPlan` adapter here. */
  endpoints: ChatGptPlanEndpoints;
  /** Every authorization request the browser was sent to, as its query parameters. */
  authorizations: Record<string, string>[];
  /** Every request to the token endpoint, as its form fields. */
  tokenRequests: Record<string, string>[];
  /** Every request to the revocation endpoint, as its form fields. */
  revocations: Record<string, string>[];
  /** Every request that reached the Responses API or the model list. */
  apiRequests: ApiRequest[];
  /** Tokens handed out, oldest first. */
  issued: IssuedTokens[];
  /** Client IDs issued by dynamic registration, oldest first. */
  clients: string[];
  /** Access-token lifetime in seconds for the next tokens. */
  expiresIn: number;
  /** Milliseconds each refresh takes. */
  refreshDelayMs: number;
  /** When set, a code exchange is answered only once this settles. */
  holdCodeExchange: Promise<unknown> | null;
  /** When set, refreshes are refused with this status and body. */
  refreshRefusal: { status: number; body: unknown } | null;
  /** How the revocation endpoint answers. */
  revokeStatus: number;
  /** How the model list answers: its models, or an HTTP status. */
  modelList: typeof ACCOUNT_MODELS | number;
  /** When set, the model list is answered only once this settles. */
  holdModelList: Promise<unknown> | null;
  /** How the Responses API answers a request with a valid token. */
  reply: ApiReply;
  /** How it answers a request for one model, by its id, in place of `reply`. */
  replyFor: Record<string, ApiReply>;
  /** Changes the next ID token, to check that a bad one is refused. */
  tamperIdToken: ((claims: Record<string, unknown>) => Record<string, unknown>) | null;
  /** Signs the next ID token with a key OpenAI doesn't publish. */
  foreignSigner: boolean;
  /** Makes every access token issued so far invalid, as if the User disconnected the app. */
  revokeAccessTokens(): void;
  /** The responses requests only (not the model list). */
  responses(): ApiRequest[];
}

/** Responses requests apart from the reply's change-claim judge. */
export const answerResponses = (fake: FakeOpenAI): ApiRequest[] =>
  fake
    .responses()
    .filter(
      (request) =>
        typeof request.body.instructions !== "string" ||
        !request.body.instructions.startsWith(
          "You check an AI assistant's reply against IncarnaMind's record",
        ),
    );

/** What the User does on OpenAI's page, as the redirect back to the app says it. */
export type Decision = { approve: Approval } | "decline";

/** The fake with what only a browser or a test runner does with it. */
export interface FakeOpenAIServer extends FakeOpenAI {
  /**
   * Where OpenAI's page sends the browser once the User decided, for an
   * authorization request the app opened: the app's own callback, with a
   * code (and the client a first sign-in registered), or the refusal.
   */
  redirectFor(authorizeUrl: string, decision: Decision): URL;
  /** Stops the server. */
  close(): Promise<void>;
}

/** Starts the fake on a free port. Call `close` when done. */
export async function createFakeOpenAI(
  options: { now?: () => number } = {},
): Promise<FakeOpenAIServer> {
  const now = options.now ?? (() => Date.now());
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const jwk = publicKey.export({ format: "jwk" });

  interface PendingCode {
    challenge: string;
    redirectUri: string;
    clientId: string;
    nonce: string;
    subject: string;
    email: string;
    scope: string;
    resource: string;
  }
  const codes = new Map<string, PendingCode>();
  const validAccessTokens = new Set<string>();
  /** The newest refresh token of each client: refresh tokens rotate. */
  const refreshTokens = new Map<string, { token: string; subject: string; email: string }>();
  let codeCount = 0;

  const issue = (code: Pick<PendingCode, "clientId" | "subject" | "email" | "nonce">) => {
    const n = fake.issued.length + 1;
    const seconds = Math.floor(now() / 1000);
    let claims: Record<string, unknown> = {
      iss: origin,
      aud: code.clientId,
      sub: code.subject,
      email: code.email,
      nonce: code.nonce,
      iat: seconds,
      exp: seconds + 3600,
    };
    if (fake.tamperIdToken) {
      claims = fake.tamperIdToken(claims);
      fake.tamperIdToken = null;
    }
    const idToken = signJwt(claims, fake.foreignSigner ? foreign : privateKey);
    fake.foreignSigner = false;
    const tokens: IssuedTokens = {
      clientId: code.clientId,
      accessToken: `access-token-${n}-${"a".repeat(24)}`,
      refreshToken: `refresh-token-${n}-${"r".repeat(24)}`,
      idToken,
    };
    fake.issued.push(tokens);
    validAccessTokens.add(tokens.accessToken);
    refreshTokens.set(code.clientId, {
      token: tokens.refreshToken,
      subject: code.subject,
      email: code.email,
    });
    return tokens;
  };

  const tokenResponse = (tokens: IssuedTokens, scope: string) => ({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    id_token: tokens.idToken,
    token_type: "Bearer",
    expires_in: fake.expiresIn,
    scope,
  });

  const handleToken = async (request: IncomingMessage, response: ServerResponse) => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
    fake.tokenRequests.push(form);
    if (form.resource !== RESOURCE) {
      sendJson(response, 400, { error: "invalid_target" });
      return;
    }
    if (form.grant_type === "authorization_code") {
      await fake.holdCodeExchange;
      const pending = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      const challenge = createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      if (
        !pending ||
        pending.challenge !== challenge ||
        pending.redirectUri !== form.redirect_uri ||
        pending.clientId !== form.client_id
      ) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      sendJson(response, 200, tokenResponse(issue(pending), pending.scope));
      return;
    }
    if (form.grant_type === "refresh_token") {
      await new Promise((resolve) => setTimeout(resolve, fake.refreshDelayMs));
      if (fake.refreshRefusal) {
        sendJson(response, fake.refreshRefusal.status, fake.refreshRefusal.body);
        return;
      }
      const current = refreshTokens.get(form.client_id ?? "");
      if (!current || form.refresh_token !== current.token) {
        sendJson(response, 400, { error: "refresh_token_reused" });
        return;
      }
      const tokens = issue({
        clientId: form.client_id ?? "",
        subject: current.subject,
        email: current.email,
        nonce: "",
      });
      sendJson(response, 200, tokenResponse(tokens, FULL_SCOPE));
      return;
    }
    sendJson(response, 400, { error: "unsupported_grant_type" });
  };

  const handleRevoke = async (request: IncomingMessage, response: ServerResponse) => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
    fake.revocations.push(form);
    if (fake.revokeStatus !== 200) {
      sendJson(response, fake.revokeStatus, { error: "temporarily_unavailable" });
      return;
    }
    const current = refreshTokens.get(form.client_id ?? "");
    if (current?.token === form.token) refreshTokens.delete(form.client_id ?? "");
    response.writeHead(200).end();
  };

  const record = async (request: IncomingMessage, path: string) => {
    const text = request.method === "POST" ? await readBody(request) : "";
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    fake.apiRequests.push({ path, headers, body });
    const token = headers.authorization?.replace(/^Bearer /, "") ?? "";
    return { body, authorized: validAccessTokens.has(token) };
  };

  const handleModels = async (request: IncomingMessage, response: ServerResponse) => {
    const { authorized } = await record(request, "/v1/models");
    if (!authorized) {
      sendJson(response, 401, { error: { message: "Invalid token." } });
      return;
    }
    await fake.holdModelList;
    if (typeof fake.modelList === "number") {
      sendJson(response, fake.modelList, { error: { message: "Unavailable." } });
      return;
    }
    sendJson(response, 200, { models: fake.modelList });
  };

  const handleResponses = async (request: IncomingMessage, response: ServerResponse) => {
    const { body, authorized } = await record(request, "/v1/responses");
    if (!authorized) {
      sendJson(response, 401, {
        error: { code: "subscription_sharing_invalid_user", message: "Invalid token." },
      });
      return;
    }
    const reply = fake.replyFor[String(body.model)] ?? fake.reply;
    if (reply.kind === "error") {
      sendJson(response, reply.status, reply.body);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events =
      reply.kind === "answer"
        ? answerEvents(reply.text, String(body.model))
        : [
            ...answerEvents("Partly", String(body.model)).slice(0, 4),
            {
              type: "response.failed",
              response: { id: "resp_1", status: "failed", error: reply.error },
            },
          ];
    for (const event of events) {
      response.write(
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    response.end();
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const post = request.method === "POST";
    const handler =
      post && path === "/api/accounts/oauth/token"
        ? handleToken
        : post && path === "/api/accounts/oauth/revoke"
          ? handleRevoke
          : post && path === "/v1/responses"
            ? handleResponses
            : request.method === "GET" && path === "/v1/models"
              ? handleModels
              : request.method === "GET" && path === "/.well-known/jwks.json"
                ? async (_request: IncomingMessage, reply: ServerResponse) =>
                    sendJson(reply, 200, {
                      keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }],
                    })
                : null;
    if (!handler) {
      response.writeHead(404).end();
      return;
    }
    handler(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** What OpenAI's page does when the User approves: a code, and a client for a new registration. */
  const approve = (authorizeUrl: string, approval: Approval) => {
    const params = Object.fromEntries(new URL(authorizeUrl).searchParams);
    const subject = approval.subject ?? SUBJECT;
    let clientId = params.client_id ?? "";
    let issued: string | null = null;
    if (clientId === "dynamic_agent_client") {
      clientId = `oaiapp_test_${fake.clients.length + 1}`;
      fake.clients.push(clientId);
      issued = clientId;
    }
    codeCount += 1;
    const code = `code-${codeCount}`;
    const requested = (params.scope ?? "").split(" ");
    const scope = requested
      .filter((each) => approval.allowPlan !== false || each !== PLAN_SCOPE)
      .join(" ");
    codes.set(code, {
      challenge: params.code_challenge ?? "",
      redirectUri: params.redirect_uri ?? "",
      clientId,
      nonce: params.nonce ?? "",
      subject,
      email: approval.email ?? EMAIL,
      scope,
      resource: params.resource ?? "",
    });
    return { code, issued };
  };

  const fake: FakeOpenAIServer = {
    endpoints: {
      issuer: origin,
      authorizeUrl: `${origin}/api/accounts/authorize`,
      tokenUrl: `${origin}/api/accounts/oauth/token`,
      revokeUrl: `${origin}/api/accounts/oauth/revoke`,
      jwksUrl: `${origin}/.well-known/jwks.json`,
      signInTimeoutMs: 10_000,
      apiBaseUrl: `${origin}/v1`,
    },
    authorizations: [],
    tokenRequests: [],
    revocations: [],
    apiRequests: [],
    issued: [],
    clients: [],
    expiresIn: 3600,
    refreshDelayMs: 0,
    holdCodeExchange: null,
    refreshRefusal: null,
    revokeStatus: 200,
    modelList: ACCOUNT_MODELS,
    holdModelList: null,
    reply: { kind: "answer", text: ANSWER },
    replyFor: {},
    tamperIdToken: null,
    foreignSigner: false,
    revokeAccessTokens: () => validAccessTokens.clear(),
    responses: () => fake.apiRequests.filter((each) => each.path === "/v1/responses"),
    redirectFor(authorizeUrl, decision) {
      const params = new URL(authorizeUrl).searchParams;
      const redirect = new URL(params.get("redirect_uri") ?? "");
      redirect.searchParams.set("state", params.get("state") ?? "");
      if (decision === "decline") {
        redirect.searchParams.set("error", "access_denied");
        redirect.searchParams.set("error_description", "The User declined.");
        return redirect;
      }
      const { code, issued } = approve(authorizeUrl, decision.approve);
      redirect.searchParams.set("code", code);
      if (issued) redirect.searchParams.set("client_id", issued);
      return redirect;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return fake;
}

/**
 * The User signing in on OpenAI's page the app opened, approving as
 * `approval` says, and the browser following the redirect back to the app.
 * Resolves with the page the app's callback showed.
 */
export async function signInAt(
  fake: FakeOpenAIServer,
  authorizeUrl: string,
  approval: Approval = {},
): Promise<{ status: number; html: string }> {
  const response = await fetch(fake.redirectFor(authorizeUrl, { approve: approval }));
  return { status: response.status, html: await response.text() };
}
