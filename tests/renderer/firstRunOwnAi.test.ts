/**
 * The first run's Your AI step leads with the AI the User already has (#3537): a model in
 * IncarnaMind is one quiet line, which opens in place, and is open while one works. It adds no
 * step and takes nothing away: the key field and every other way are behind that line.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentClient, AgentPairing, ChatReadiness } from "../../src/core/api";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;
if (!("scrollIntoView" in view.HTMLElement.prototype)) {
  Object.assign(view.HTMLElement.prototype, {
    scrollIntoView: () => undefined,
    showModal() {
      (this as unknown as { open: boolean }).open = true;
    },
    close() {
      (this as unknown as { open: boolean }).open = false;
    },
  });
}

const client = (
  id: AgentClient["id"],
  name: string,
  { installed = id === "claude-code", setup = "file" }: Partial<AgentClient> = {},
): AgentClient =>
  ({
    id,
    name,
    otherNames: [],
    chat: false,
    installed,
    setup,
    skillPath: null,
  }) as unknown as AgentClient;
const bridge = {
  clients: [client("claude-code", "Claude Code"), client("other", "")],
  pairings: [] as AgentPairing[],
  enabled: false,
  on: () => () => undefined,
  listAgentClients: async () => bridge.clients,
  listLibraryGroups: async () => [],
  getSecretStorageStatus: async () => ({ status: "ok" }),
  previewAgentSetup: async () => null,
  getAgents: async () => ({ enabled: bridge.enabled, pairings: bridge.pairings }),
  setAgentsEnabled: async (enabled: boolean) => {
    bridge.enabled = enabled;
  },
  setUpAgent: async () => {
    throw new Error("Unexpected setUpAgent");
  },
  listChatProviders: async () => [],
  listApprovalRequests: async () => [],
  listUserQuestions: async () => [],
};
const methods = new Proxy(bridge, {
  get: (each, name) =>
    name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
});
Object.assign(view, { incarnamind: methods, incarnamindFiles: methods });
const globals: Record<string, unknown> = {
  document: page,
  window: view,
  HTMLElement: view.HTMLElement,
  Element: view.Element,
  Event: view.Event,
  Node: view.Node,
  MutationObserver: view.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
vi.stubGlobal("navigator", { userAgent: "node" });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
const stepPath = "../../src/renderer/src/components/firstRun/AiStep.tsx";
const { AiStep }: { AiStep: ComponentType<{ place: unknown }> } = await import(stepPath);
const dialogPath = "../../src/renderer/src/components/agents/ConnectManyDialog.tsx";
const { ConnectManyDialog }: { ConnectManyDialog: ComponentType<Record<string, unknown>> } =
  await import(dialogPath);
const { translate } = await import("../../src/shared/i18n");

const NO_MODEL: ChatReadiness = { ready: false, reason: "no-provider" };
const MODEL = {
  ready: true,
  provider: { id: "anthropic", kind: "anthropic" },
  modelId: "claude-haiku-5-5",
  consent: "not-required",
} as unknown as ChatReadiness;
const PLACE = { steps: [], at: 1, next: () => undefined, back: () => undefined };

let unmount: (() => Promise<void>) | null = null;
async function step(readiness: ChatReadiness, language = "en") {
  useAppStore.setState({
    chatReadiness: readiness,
    embedding: { localOnly: false },
    settings: { language, user: {}, device: {} },
  } as never);
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AiStep, { place: PLACE })));
  await act(async () => undefined);
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  return container as unknown as HTMLElement;
}
const has = (container: HTMLElement, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) !== null;

beforeEach(() => {
  bridge.clients = [client("claude-code", "Claude Code"), client("other", "")];
  bridge.pairings = [];
  bridge.enabled = false;
  bridge.setAgentsEnabled = async (enabled: boolean) => {
    bridge.enabled = enabled;
  };
  bridge.setUpAgent = async () => {
    throw new Error("Unexpected setUpAgent");
  };
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("the setup's Your AI step", () => {
  test("with no model: the AI they have leads, and a model in IncarnaMind is one quiet line, closed", async () => {
    const container = await step(NO_MODEL);
    const headings = [...container.querySelectorAll("h2")].map((each) => each.textContent);
    expect(headings).toEqual(["Use the AI you already have"]);
    const line = container.querySelector('[data-testid="setup-in-app-open"]');
    expect(line?.textContent).toBe("Use a model in IncarnaMind");
    for (const behind of ["setup-key", "setup-way-chatgpt", "setup-way-more", "setup-way-local"]) {
      expect(has(container, behind), behind).toBe(false);
    }
    // The agents are all there to choose from.
    expect(container.querySelectorAll('[data-testid="setup-agent"]').length).toBeGreaterThan(0);
  });

  test("pressing the line opens the key field and the other ways in place, and the line goes", async () => {
    const container = await step(NO_MODEL);
    const line = container.querySelector('[data-testid="setup-in-app-open"]') as HTMLElement;
    await act(async () => line.click());
    expect(has(container, "setup-in-app-open")).toBe(false);
    const headings = [...container.querySelectorAll("h2")].map((each) => each.textContent);
    expect(headings).toEqual(["Use the AI you already have", "Use a model in IncarnaMind"]);
    for (const way of ["setup-key", "setup-way-more", "setup-way-local"]) {
      expect(has(container, way), way).toBe(true);
    }
    // Still the one step: its own foot, nothing added.
    expect(has(container, "setup-next")).toBe(true);
    expect(has(container, "setup-skip")).toBe(true);
  });

  test("with a model working it is open, as it was: the model and what it sends are shown", async () => {
    const container = await step(MODEL);
    expect(has(container, "setup-in-app-open")).toBe(false);
    expect(has(container, "setup-key")).toBe(true);
    expect(has(container, "setup-ai-works")).toBe(true);
  });

  test("with their own AI connected and no model, it is the same: the line, closed, and Continue open", async () => {
    bridge.pairings = [
      {
        id: "p1",
        name: "Claude Code",
        folderIds: [],
        client: "claude-code",
        propose: true,
        lastUsedAt: null,
        createdAt: "2026-11-21T10:00:00.000Z",
      },
    ];
    const container = await step(NO_MODEL);
    expect(has(container, "setup-agent-connected")).toBe(true);
    expect(has(container, "setup-in-app-open")).toBe(true);
    expect(has(container, "setup-key")).toBe(false);
    expect(
      (container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("the line reads in Chinese too", async () => {
    const container = await step(NO_MODEL, "zh-CN");
    expect(container.querySelector('[data-testid="setup-in-app-open"]')?.textContent).toBe(
      "在 IncarnaMind 里用一个模型",
    );
  });

  test("with two found apps: Details holds the consent text, and failing every app keeps the tiles open (#3644)", async () => {
    bridge.clients = [
      client("claude-code", "Claude Code", { installed: true, setup: "file" }),
      client("codex", "ChatGPT app and Codex", { installed: true, setup: "file" }),
      client("other", "", { installed: false, setup: "manual" }),
    ];
    bridge.setUpAgent = async () => {
      throw new Error("Permission denied.");
    };

    const container = await step(NO_MODEL);
    const consent = container.querySelector('[data-testid="connect-many-consent-body"]');
    expect(consent?.textContent).toBe(translate("en", "agents.connectAll.body"));

    const allow = container.querySelector(
      '[data-testid="setup-agent-allow-all"]',
    ) as HTMLButtonElement;
    expect(allow).not.toBeNull();
    await act(async () => {
      allow.click();
    });
    await act(async () => undefined);

    expect(has(container, "connect-many-result")).toBe(true);
    expect(container.querySelectorAll('[data-testid="connect-many-retry"]').length).toBe(2);
    // No dead-end: the tiles stay visible when nothing connected.
    expect(container.querySelectorAll('[data-testid="setup-agent"]').length).toBeGreaterThan(0);
    expect(bridge.enabled).toBe(false);
  });

  test("when turning connecting agents on fails, the many-app sheet stays open with the error (#3644)", async () => {
    bridge.clients = [
      client("claude-code", "Claude Code", { installed: true, setup: "file" }),
      client("codex", "ChatGPT app and Codex", { installed: true, setup: "file" }),
      client("other", "", { installed: false, setup: "manual" }),
    ];
    bridge.setAgentsEnabled = async () => {
      throw new Error("Settings are read-only.");
    };

    const container = await step(NO_MODEL);
    const allow = container.querySelector(
      '[data-testid="setup-agent-allow-all"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allow.click();
    });
    await act(async () => undefined);

    expect(has(container, "setup-agent-allow-all")).toBe(true);
    const alertText = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alertText).toBe(translate("en", "agents.setup.failed"));
    expect(alertText).not.toContain("Settings are read-only.");
  });

  test("ConnectManyDialog blocks Cancel, Esc and close while setup is running (#3644)", async () => {
    const onClose = vi.fn();
    const found = [
      client("claude-code", "Claude Code", { installed: true, setup: "file" }),
      client("codex", "ChatGPT app and Codex", { installed: true, setup: "file" }),
    ];
    const container = page.createElement("div", {});
    page.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(ConnectManyDialog, {
          open: true,
          clients: found,
          busy: true,
          problem: null,
          outcomes: null,
          undone: new Set(),
          onAllow: () => undefined,
          onUndo: async () => undefined,
          onRetry: async () => undefined,
          onClose,
        }),
      ),
    );
    unmount = async () => {
      await act(() => root.unmount());
      container.remove();
    };
    const cancelButton = container.querySelector(
      '[data-testid="connect-many-cancel"]',
    ) as HTMLButtonElement;
    const allowButton = container.querySelector(
      '[data-testid="connect-many-allow"]',
    ) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(true);
    expect(allowButton.disabled).toBe(true);
    const dialog = container.querySelector('[data-testid="connect-many-dialog"]') as HTMLElement;
    const cancelEvent = new view.Event("cancel", { cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(cancelEvent);
      dialog.dispatchEvent(new view.Event("close"));
    });
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
