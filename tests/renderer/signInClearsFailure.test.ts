import { beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Settings › Models shows the default model's last failure until something fixes it. Signing in
 * again fixes a sign-in that ended, so each plan's sign-in clears the line, whichever place the
 * User signs in from; a sign-in that fails leaves it.
 */

const bridge = vi.hoisted(() => ({
  providers: [] as { id: string; kind: string }[],
  signInFails: false,
}));

const signedIn = { account: { state: "signed-in" }, models: [{ id: "plan-model" }], profiles: [] };
const refused = { ok: false, error: { kind: "failed", message: "Refused." } };

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    listChatProviders: async () => bridge.providers,
    saveChatProvider: async (input: { kind: string }) => ({ id: `new-${input.kind}`, ...input }),
    getChatGptPlan: async () => ({ ...signedIn, account: { state: "expired" } }),
    signInToChatGpt: async () =>
      bridge.signInFails ? refused : { ok: true, firstTime: false, status: signedIn },
    getClaudeAccount: async () => ({ ...signedIn, account: { state: "expired" } }),
    signInToClaude: async () => (bridge.signInFails ? refused : { ok: true, status: signedIn }),
    getCopilot: async () => signedIn,
    signInToCopilot: async () => (bridge.signInFails ? refused : { ok: true, status: signedIn }),
  },
}));

const { clearModelFailure, useModelHealth } = await import("../../src/renderer/src/modelHealth");
const { continueWithChatGpt } = await import("../../src/renderer/src/chatGptSignIn");
const { signInWithClaude } = await import("../../src/renderer/src/claudeSignIn");
const { signInWithCopilot } = await import("../../src/renderer/src/copilotSignIn");

const PLANS = [
  { name: "ChatGPT", kind: "chatgpt", signIn: () => continueWithChatGpt({ keepDefault: true }) },
  { name: "Claude", kind: "claude-account", signIn: () => signInWithClaude({ keepDefault: true }) },
  { name: "Copilot", kind: "copilot", signIn: () => signInWithCopilot({ keepDefault: true }) },
] as const;

const failure = (modelId: string) => ({
  modelId,
  error: { kind: "not-signed-in" as const, message: "Signed out." },
  at: "2026-10-22T08:00:00.000Z",
});

beforeEach(() => {
  bridge.providers = PLANS.map(({ kind }) => ({ id: `${kind}-provider`, kind }));
  bridge.signInFails = false;
  clearModelFailure("anthropic-provider");
  for (const { kind } of PLANS) clearModelFailure(`${kind}-provider`);
});

describe.each(PLANS)("signing in again to $name", ({ kind, signIn }) => {
  const planId = `${kind}-provider`;

  test("clears the plan's failure and leaves another provider's", async () => {
    useModelHealth.setState({
      failures: { [planId]: failure("plan-model"), "anthropic-provider": failure("claude") },
    });

    await signIn();

    expect(Object.keys(useModelHealth.getState().failures)).toEqual(["anthropic-provider"]);
  });

  test("keeps the failure when the sign-in fails", async () => {
    bridge.signInFails = true;
    useModelHealth.setState({ failures: { [planId]: failure("plan-model") } });

    await signIn();

    expect(Object.keys(useModelHealth.getState().failures)).toEqual([planId]);
  });
});
