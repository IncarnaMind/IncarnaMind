/**
 * Connecting every AI found on this computer at once, from Settings › AI (#3644): the sheet's
 * consent is in its Details, a run where every app fails leaves the sheet and the agents to
 * connect in place, turning connecting on failing says so in plain words, and while it runs the
 * sheet can't be closed.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentClient, AgentPairing, AgentSettings, ChatReadiness } from "../../src/core/api";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;
Object.assign(view.HTMLElement.prototype, {
  scrollIntoView: () => undefined,
  showModal() {
    (this as unknown as { open: boolean }).open = true;
  },
  close() {
    (this as unknown as { open: boolean }).open = false;
  },
});

const client = (
  id: AgentClient["id"],
  name: string,
  { installed = false, setup = "file" }: Partial<AgentClient> = {},
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
const FOUND = [
  client("claude-code", "Claude Code", { installed: true }),
  client("codex", "ChatGPT", { installed: true }),
  client("other", "", { setup: "manual" }),
];
const bridge = {
  enabled: false,
  on: () => () => undefined,
  listAgentClients: async () => FOUND,
  listLibraryGroups: async () => [],
  getSecretStorageStatus: async () => ({ status: "ok" }),
  previewAgentSetup: async () => null,
  getAgents: async () => ({ enabled: bridge.enabled, pairings: [] as AgentPairing[] }),
  setAgentsEnabled: async (enabled: boolean) => {
    bridge.enabled = enabled;
  },
  setUpAgent: async (): Promise<never> => {
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
const { translate } = await import("../../src/shared/i18n");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const yourAiPath = "../../src/renderer/src/components/agents/YourAiSection.tsx";
const {
  YourAiSection,
}: {
  YourAiSection: ComponentType<{
    settings: AgentSettings | null;
    failed: boolean;
    clients: readonly AgentClient[] | null;
    clientsFailed: boolean;
    switchShown: boolean;
    setSettings(settings: AgentSettings): void;
    retry(): void;
  }>;
} = await import(yourAiPath);
const dialogPath = "../../src/renderer/src/components/agents/ConnectManyDialog.tsx";
const { ConnectManyDialog }: { ConnectManyDialog: ComponentType<Record<string, unknown>> } =
  await import(dialogPath);

const NO_MODEL: ChatReadiness = { ready: false, reason: "no-provider" };
const NOTHING_CONNECTED = {
  enabled: false,
  paused: null,
  pairings: [],
  skills: [],
  skillsOutOfDate: [],
  awaitingInstall: [],
  shimsOutOfDate: [],
} as unknown as AgentSettings;

let unmount: (() => Promise<void>) | null = null;
async function shown(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => undefined);
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  return container as unknown as HTMLElement;
}

/** Settings › AI's Your AI with two agents found here, nothing connected, and its sheet opened. */
async function connectAll(): Promise<HTMLElement> {
  useAppStore.setState({
    chatReadiness: NO_MODEL,
    embedding: { localOnly: false },
    settings: { language: "en", user: {}, device: {} },
  } as never);
  const container = await shown(
    createElement(YourAiSection, {
      settings: NOTHING_CONNECTED,
      failed: false,
      clients: FOUND,
      clientsFailed: false,
      switchShown: false,
      setSettings: () => undefined,
      retry: () => undefined,
    }),
  );
  const open = container.querySelector('[data-testid="agents-connect-all"]') as HTMLButtonElement;
  expect(open).not.toBeNull();
  await act(async () => open.click());
  await act(async () => undefined);
  return container;
}

async function allow(container: HTMLElement) {
  const allowButton = container.querySelector(
    '[data-testid="connect-many-allow"]',
  ) as HTMLButtonElement;
  expect(allowButton).not.toBeNull();
  await act(async () => allowButton.click());
  await act(async () => undefined);
  await act(async () => undefined);
}

const count = (container: HTMLElement, testId: string) =>
  container.querySelectorAll(`[data-testid="${testId}"]`).length;

beforeEach(() => {
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

describe("connecting every agent found here at once (#3644)", () => {
  test("Details holds the consent text, and failing every app keeps the sheet and the agents to connect in place", async () => {
    bridge.setUpAgent = async () => {
      throw new Error("Permission denied.");
    };
    const container = await connectAll();
    const consent = container.querySelector('[data-testid="connect-many-consent-body"]');
    expect(consent?.textContent).toBe(translate("en", "agents.connectAll.body"));

    await allow(container);

    expect(count(container, "connect-many-result")).toBe(1);
    expect(count(container, "connect-many-retry")).toBe(2);
    // No dead end: nothing connected, so the agents to connect stay where they were.
    expect(count(container, "agents-connect-all")).toBe(1);
    expect(count(container, "agent-client")).toBeGreaterThan(0);
    expect(bridge.enabled).toBe(false);
  });

  test("when turning connecting agents on fails, the sheet stays open with the error in plain words", async () => {
    bridge.setAgentsEnabled = async () => {
      throw new Error("Settings are read-only.");
    };
    const container = await connectAll();

    await allow(container);

    expect(count(container, "connect-many-allow")).toBe(1);
    const alertText = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alertText).toBe(translate("en", "agents.setup.failed"));
    expect(alertText).not.toContain("Settings are read-only.");
  });

  test("the sheet blocks Cancel, Esc and close while setup is running", async () => {
    const onClose = vi.fn();
    const container = await shown(
      createElement(ConnectManyDialog, {
        open: true,
        clients: FOUND.slice(0, 2),
        busy: true,
        problem: null,
        outcomes: null,
        undone: new Set(),
        onAllow: () => undefined,
        onUndo: async () => undefined,
        onRetry: async () => undefined,
        onClose,
      }),
    );
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
