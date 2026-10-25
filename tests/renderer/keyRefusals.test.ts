import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatProvider, CoreBridge } from "../../src/core/api";

const calls = vi.hoisted(() => ({
  providers: vi.fn<CoreBridge["listChatProviders"]>(),
  settings: vi.fn(), error: vi.fn(), open: vi.fn(),
}));
vi.mock("../../src/renderer/src/core", () => ({ core: { listChatProviders: calls.providers } }));
vi.mock("../../src/renderer/src/store", () => ({ useAppStore: { getState: () => ({ openSettings: calls.settings, reportError: calls.error }) } }));
import { useKeyRefusals } from "../../src/renderer/src/keyRefusals";

const provider: ChatProvider = {
  id: "provider", kind: "openai", catalogId: "openai", endpoint: "global",
  baseUrl: null, hasApiKey: true, service: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { open: calls.open });
  calls.providers.mockResolvedValue([provider]);
  useKeyRefusals.setState({ showing: null, savedAt: {}, billingOpenedAt: {} });
});

describe("a key problem's next action", () => {
  test("credit recovery opens the same provider's key form with its credit reason", async () => {
    await useKeyRefusals.getState().check(provider.id, "model", "2026-10-12T09:00:00.000Z", "out-of-credit");
    expect(useKeyRefusals.getState().showing).toEqual({
      catalogId: "openai", endpoint: "global", modelId: "model", at: "2026-10-12T09:00:00.000Z", kind: "out-of-credit",
    });
    expect(calls.settings).toHaveBeenCalledWith("models");
    expect(calls.open).not.toHaveBeenCalled();
  });

  test("an authentication failure keeps its existing reason; a missing provider still opens Models", async () => {
    await useKeyRefusals.getState().check(provider.id, "model", null);
    expect(useKeyRefusals.getState().showing?.kind).toBe("auth");
    useKeyRefusals.getState().done();
    await useKeyRefusals.getState().check("gone", "model", null, "out-of-credit");
    expect(useKeyRefusals.getState().showing).toBeNull();
    expect(calls.settings).toHaveBeenCalledTimes(2);
  });

  test("opening billing is remembered only for that provider, so the failed Answer can offer retry", () => {
    useKeyRefusals.getState().openBilling(provider.id, "https://example.test/billing");
    expect(calls.open).toHaveBeenCalledWith("https://example.test/billing", "_blank", "noreferrer");
    expect(Object.keys(useKeyRefusals.getState().billingOpenedAt)).toEqual([provider.id]);
    expect(Number.isNaN(Date.parse(useKeyRefusals.getState().billingOpenedAt[provider.id] ?? ""))).toBe(false);
  });

  test("a provider-list failure is reported and leaves Models usable", async () => {
    const error = new Error("Providers are unavailable.");
    calls.providers.mockRejectedValueOnce(error);
    await useKeyRefusals.getState().check(provider.id, "model", null, "out-of-credit");
    expect(calls.error).toHaveBeenCalledWith(error);
    expect(calls.settings).toHaveBeenCalledWith("models");
  });
});
