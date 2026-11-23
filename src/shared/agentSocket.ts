/**
 * How an outside agent's shim reaches the running app (#351, #2049, ADR-0036):
 * the stdio command an agent starts connects to a local socket in the app,
 * completes a mutual HMAC-SHA256 challenge-response (v2) so the app proves it
 * holds the pairing key before the shim authenticates (never sending the key
 * on the wire), then carries MCP's own stdio framing both ways unchanged.
 * Older frozen shims (such as installed Claude Desktop .mcpb bundles) still
 * open with v1 (the pairing token on line 1), which the app keeps accepting
 * while marking the pairing out of date.
 *
 * Shared by the core and tests, so it imports nothing (pure data and framing).
 */

/** The environment variable that carries the pairing's token to the shim. */
export const AGENT_TOKEN_ENV = "INCARNAMIND_AGENT_TOKEN";

/** The environment variable that tells the shim where the app's socket is. */
export const AGENT_SOCKET_ENV = "INCARNAMIND_AGENT_SOCKET";

/** How a pairing's key shows wherever settings are shown rather than copied. */
export const HIDDEN_KEY = "•••••••";

/** The legacy opening-line version (token on line 1), kept for frozen installed shims. */
export const AGENT_HANDSHAKE_VERSION = 1;

/** The mutual HMAC challenge-response version (ADR-0036): the key never goes on the wire. */
export const AGENT_CHALLENGE_VERSION = 2;

/** The longest handshake line either side reads before closing the connection. */
export const AGENT_HANDSHAKE_MAX_BYTES = 16_384;

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROOF_HEX_RE = /^[0-9a-f]{64}$/;

/** The legacy shim opening line: the protocol's version and the pairing's token. */
export interface AgentHandshake {
  incarnamind: typeof AGENT_HANDSHAKE_VERSION;
  token: string;
}

/** What the app reads from the shim's first line: a v2 challenge nonce or a legacy v1 token. */
export type AgentOpening =
  | { version: typeof AGENT_HANDSHAKE_VERSION; token: string }
  | { version: typeof AGENT_CHALLENGE_VERSION; nonce: string };

/** Domain-separated HMAC input the app signs to prove it holds the pairing key. */
export const serverProofInput = (shimNonce: string, appNonce: string): string =>
  `incarnamind:v2:server:${shimNonce}:${appNonce}`;

/** Domain-separated HMAC input the shim signs after verifying the app's proof. */
export const clientProofInput = (appNonce: string, shimNonce: string): string =>
  `incarnamind:v2:client:${appNonce}:${shimNonce}`;

export function handshakeLine(token: string): string {
  const handshake: AgentHandshake = { incarnamind: AGENT_HANDSHAKE_VERSION, token };
  return `${JSON.stringify(handshake)}\n`;
}

export function challengeLine(nonce: string): string {
  return `${JSON.stringify({ incarnamind: AGENT_CHALLENGE_VERSION, nonce })}\n`;
}

export function serverChallengeLine(nonce: string, proofs: readonly string[]): string {
  return `${JSON.stringify({ incarnamind: AGENT_CHALLENGE_VERSION, nonce, proofs })}\n`;
}

export function clientProofLine(proof: string): string {
  return `${JSON.stringify({ incarnamind: AGENT_CHALLENGE_VERSION, proof })}\n`;
}

/** The token in a legacy v1 opening line, or null when the line isn't one. */
export function parseHandshake(line: string): string | null {
  const parsed = parseOpeningLine(line);
  return parsed?.version === AGENT_HANDSHAKE_VERSION ? parsed.token : null;
}

/** Parses line 1 from the shim: either a v2 challenge nonce or a legacy v1 token. */
export function parseOpeningLine(line: string): AgentOpening | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const { incarnamind, token, nonce } = value as Record<string, unknown>;
    if (
      incarnamind === AGENT_CHALLENGE_VERSION &&
      typeof nonce === "string" &&
      NONCE_RE.test(nonce)
    ) {
      return { version: AGENT_CHALLENGE_VERSION, nonce };
    }
    if (incarnamind === AGENT_HANDSHAKE_VERSION && typeof token === "string" && token !== "") {
      return { version: AGENT_HANDSHAKE_VERSION, token };
    }
    return null;
  } catch {
    return null;
  }
}

/** Parses line 2 from the app: its challenge nonce and its candidate server proofs. */
export function parseServerChallenge(line: string): { nonce: string; proofs: string[] } | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const { incarnamind, nonce, proofs } = value as Record<string, unknown>;
    if (
      incarnamind !== AGENT_CHALLENGE_VERSION ||
      typeof nonce !== "string" ||
      !NONCE_RE.test(nonce) ||
      !Array.isArray(proofs) ||
      !proofs.every(
        (entry): entry is string => typeof entry === "string" && PROOF_HEX_RE.test(entry),
      )
    ) {
      return null;
    }
    return { nonce, proofs };
  } catch {
    return null;
  }
}

/** Parses line 3 from the shim: its hex HMAC proof answering the app's nonce. */
export function parseClientProof(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const { incarnamind, proof } = value as Record<string, unknown>;
    return incarnamind === AGENT_CHALLENGE_VERSION &&
      typeof proof === "string" &&
      PROOF_HEX_RE.test(proof)
      ? proof
      : null;
  } catch {
    return null;
  }
}
