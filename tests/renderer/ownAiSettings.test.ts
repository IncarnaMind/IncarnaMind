/**
 * With only the User's own AI connected and no model set up in IncarnaMind (#3537): Settings lists
 * no Connectors and no Skills, and AI leads with Your AI, a model being one quiet row (#3645); with
 * a model set up nothing is held back. A Connector that is on keeps its page, the one place that
 * disconnects it.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentClient, AgentPairing, AgentSettings, ChatReadiness } from "../../src/core/api";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;

const bridge = {
  on: () => () => undefined,
  getAgents: async () => ({ pairings: [] as AgentPairing[] }),
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
vi.stubGlobal("navigator", { userAgent: "node" });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
const { commands, offered } = await import("../../src/renderer/src/commands/registry");
await import("../../src/renderer/src/commands/app");
const { noModelSetUp } = await import("../../src/renderer/src/noModelSetUp");
const { pagesOffered, settingsPages } = await import("../../src/renderer/src/settingsPages");
const { useSettingsPagesOffered } = await import("../../src/renderer/src/settingsOffered");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const settingsPath = "../../src/renderer/src/components/SettingsDialog.tsx";
const { SettingsDialog }: { SettingsDialog: ComponentType } = await import(settingsPath);
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
const {
  useAgentsRead,
}: {
  useAgentsRead(): { settings: AgentSettings | null; failed: boolean; retry(): void };
} = await import(yourAiPath);
const useModelPath = "../../src/renderer/src/components/ai/UseModelRow.tsx";
const { UseModelRow }: { UseModelRow: ComponentType } = await import(useModelPath);
const menuPath = "../../src/renderer/src/components/AddDocumentsMenu.tsx";
const { AddDocumentsMenu }: { AddDocumentsMenu: ComponentType } = await import(menuPath);

const NO_MODEL: ChatReadiness = { ready: false, reason: "no-provider" };
const MODEL = {
  ready: true,
  provider: { id: "anthropic", kind: "anthropic" },
  modelId: "claude-haiku-5-5",
  consent: "not-required",
} as unknown as ChatReadiness;
const HELD_BACK = ["connectors", "skills"] as const;
const ALL = [...settingsPages];

const user = (readiness: ChatReadiness | null, connectorsOn = false, language = "en") =>
  useAppStore.setState({
    chatReadiness: readiness,
    connectorsOn,
    settings: { language, user: {}, device: {} },
  } as never);

let unmount: (() => Promise<void>) | null = null;
async function shown(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  return container as unknown as HTMLElement;
}
const testIds = (container: HTMLElement, prefix: string) =>
  [...container.querySelectorAll(`[data-testid^="${prefix}"]`)].map((each) =>
    (each.getAttribute("data-testid") ?? "").slice(prefix.length),
  );
const nav = (container: HTMLElement) =>
  testIds(container, "settings-nav-").filter((each) => each !== "");

beforeEach(() => {
  useAppStore.setState({ settingsOpen: false, settingsPage: "general", settingsAt: null });
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("the one notion of no model set up", () => {
  test("is the readiness saying there is no provider, and nothing else", () => {
    expect(noModelSetUp(NO_MODEL)).toBe(true);
    expect(noModelSetUp(MODEL)).toBe(false);
    // Not known yet: nothing is held back before it is.
    expect(noModelSetUp(null)).toBe(false);
    // A model that is set up but can't answer now is still set up.
    for (const reason of [
      "missing-api-key",
      "api-key-unreadable",
      "consent-declined",
      "sign-in-required",
      "local-mode",
    ] as const) {
      const readiness = { ready: false, reason } as unknown as ChatReadiness;
      expect(noModelSetUp(readiness), reason).toBe(false);
    }
  });
});

describe("which Settings pages are listed", () => {
  test("with no model, no Connectors and no Skills; every other page stays", () => {
    expect(pagesOffered({ noModel: true, connectorsOn: false })).toEqual([
      "general",
      "ai",
      "meetings",
      "privacy",
    ]);
  });

  test("with a model, every page, as before", () => {
    expect(pagesOffered({ noModel: false, connectorsOn: false })).toEqual(ALL);
    expect(pagesOffered({ noModel: false, connectorsOn: true })).toEqual(ALL);
  });

  test("a Connector that is on keeps its page, with no model, and Skills still go", () => {
    expect(pagesOffered({ noModel: true, connectorsOn: true })).toEqual([
      "general",
      "ai",
      "meetings",
      "connectors",
      "privacy",
    ]);
  });

  test("follows the model as it is removed and set up again, and the Connectors as they come and go", async () => {
    let listed: readonly string[] = [];
    const Probe = () => {
      listed = useSettingsPagesOffered();
      return null;
    };
    user(MODEL);
    await shown(createElement(Probe));
    expect(listed).toEqual(ALL);
    await act(async () => user(NO_MODEL));
    expect(listed).not.toContain("connectors");
    expect(listed).not.toContain("skills");
    await act(async () => user(NO_MODEL, true));
    expect(listed).toContain("connectors");
    expect(listed).not.toContain("skills");
    await act(async () => user(NO_MODEL, false));
    expect(listed).not.toContain("connectors");
    await act(async () => user(MODEL));
    expect(listed).toEqual(ALL);
  });

  test("the dialog's list is the same, in English and Chinese", async () => {
    for (const language of ["en", "zh-CN"]) {
      user(NO_MODEL, false, language);
      const container = await shown(createElement(SettingsDialog));
      expect(nav(container), language).toEqual(["general", "ai", "meetings", "privacy"]);
      await act(async () => user(MODEL, false, language));
      expect(nav(container), language).toEqual(ALL);
      await unmount?.();
      unmount = null;
    }
  });
});

describe("every route to a page that is held back", () => {
  test("a link to one by name lands on AI, which exists; with a model it lands where it says", () => {
    for (const held of HELD_BACK) {
      user(NO_MODEL);
      useAppStore.getState().openSettings(held);
      expect(useAppStore.getState().settingsPage, held).toBe("ai");
      useAppStore.getState().showSettingsPage(held);
      expect(useAppStore.getState().settingsPage, held).toBe("ai");
      user(MODEL);
      useAppStore.getState().openSettings(held);
      expect(useAppStore.getState().settingsPage, held).toBe(held);
    }
    user(NO_MODEL, true);
    useAppStore.getState().openSettings("connectors");
    expect(useAppStore.getState().settingsPage).toBe("connectors");
    useAppStore.getState().openSettings("skills");
    expect(useAppStore.getState().settingsPage).toBe("ai");
  });

  test("the page the User is on stays in the dialog's list until they leave it", async () => {
    user(MODEL);
    // Not opened: a dialog shown as a modal needs a browser.
    useAppStore.setState({ settingsPage: "skills" });
    const container = await shown(createElement(SettingsDialog));
    expect(nav(container)).toEqual(ALL);
    // The last model is removed on Skills: Skills is where they are, so it stays for now.
    await act(async () => user(NO_MODEL));
    expect(nav(container)).toEqual(["general", "ai", "meetings", "skills", "privacy"]);
    // They go to AI: it is gone from the list.
    await act(async () => useAppStore.getState().showSettingsPage("ai"));
    expect(nav(container)).toEqual(["general", "ai", "meetings", "privacy"]);
    // Nothing brings them back to a page that is held back.
    await act(async () => useAppStore.getState().showSettingsPage("skills"));
    expect(useAppStore.getState().settingsPage).toBe("ai");
  });

  test("the last Connector switched off on its own page leaves it listed until they go", async () => {
    user(NO_MODEL, true);
    useAppStore.setState({ settingsPage: "connectors" });
    const container = await shown(createElement(SettingsDialog));
    expect(nav(container)).toContain("connectors");
    await act(async () => user(NO_MODEL, false));
    expect(nav(container)).toContain("connectors");
    await act(async () => useAppStore.getState().showSettingsPage("privacy"));
    expect(nav(container)).not.toContain("connectors");
  });

  test("⌘K offers each page only while it is listed", () => {
    const context = { selection: [], focus: null, surface: "mind" } as const;
    const command = (page: string) => {
      const found = commands.get(`settings.${page}`);
      if (!found) throw new Error(`There is no command for Settings › ${page}.`);
      return found;
    };
    user(NO_MODEL);
    for (const held of HELD_BACK) expect(offered(command(held), context), held).toBe(false);
    for (const kept of ["ai", "meetings", "privacy"]) {
      expect(offered(command(kept), context), kept).toBe(true);
    }
    user(NO_MODEL, true);
    expect(offered(command("connectors"), context)).toBe(true);
    expect(offered(command("skills"), context)).toBe(false);
    user(MODEL);
    for (const held of HELD_BACK) expect(offered(command(held), context), held).toBe(true);
  });

  test("the Library's Connect an app is offered only while Connectors is listed", async () => {
    user(NO_MODEL);
    const container = await shown(createElement(AddDocumentsMenu));
    const connect = () => container.querySelector('[data-testid="library-connect-app"]');
    expect(connect()).toBeNull();
    await act(async () => user(NO_MODEL, true));
    expect(connect()).not.toBeNull();
    await act(async () => user(NO_MODEL, false));
    expect(connect()).toBeNull();
    await act(async () => user(MODEL));
    expect(connect()).not.toBeNull();
  });
});

const client = (id: string, name: string, installed = false): AgentClient =>
  ({ id, name, otherNames: [], chat: false, installed, setup: "file", skillPath: null }) as never;
const CLIENTS = [
  client("claude-code", "Claude Code", true),
  client("codex", "ChatGPT app and Codex"),
  client("cursor", "Cursor"),
  client("other", ""),
];
const CLAUDE_CODE: AgentPairing = {
  id: "pairing-1",
  name: "Claude Code",
  folderIds: ["all"],
  client: "claude-code",
  propose: true,
  lastUsedAt: null,
  createdAt: "2026-11-22T00:00:00.000Z",
} as never;
const agents = (
  pairings: AgentPairing[],
  enabled = true,
  shimsOutOfDate: string[] = [],
): AgentSettings =>
  ({
    enabled,
    paused: null,
    pairings,
    skills: [],
    skillsOutOfDate: [],
    awaitingInstall: [],
    shimsOutOfDate,
  }) as never;

describe("Settings › AI leads with Your AI (#3645)", () => {
  const retry = vi.fn();
  const yourAi = async (
    settings: AgentSettings,
    readiness: ChatReadiness = NO_MODEL,
    language = "en",
    failed = false,
    listFailed = false,
  ) => {
    user(readiness, false, language);
    const container = await shown(
      createElement(YourAiSection, {
        settings: failed ? null : settings,
        failed,
        clients: listFailed ? [] : CLIENTS,
        clientsFailed: listFailed,
        // As the page's read says: connecting off with an agent connected.
        switchShown: !settings.enabled && settings.pairings.length > 0,
        setSettings: () => undefined,
        retry,
      }),
    );
    const part = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    const listed = () =>
      [...container.querySelectorAll('[data-testid="agent-client"]')].map((each) =>
        each.getAttribute("data-client"),
      );
    return { container, part, listed };
  };

  test("nothing set up: its line and the agents to connect, open, with no switch", async () => {
    const { part, listed } = await yourAi(agents([], false));
    expect(part("ai-lede")?.textContent).toBe("Let the AI tool you use read your Documents.");
    expect(listed()).toEqual(["claude-code", "codex", "cursor", "other"]);
    expect(part("agents-enabled")).toBeNull();
    expect(part("agents-connect-another")).toBeNull();
  });

  test("one connected: its row and Connect another agent…, which lists the rest but not it", async () => {
    const { part, listed } = await yourAi(agents([CLAUDE_CODE]));
    expect(part("ai-lede")).toBeNull();
    expect(part("agent-pairing")?.getAttribute("data-name")).toBe("Claude Code");
    expect(part("agents-enabled")).toBeNull();
    expect(listed()).toEqual([]);
    const another = part("agents-connect-another");
    expect(another?.textContent).toBe("Connect another agent…");
    await act(async () => (another as unknown as { click(): void }).click());
    expect(listed()).not.toContain("claude-code");
    expect(listed()).toContain("other");
    expect(part("agents-connect-another")).toBeNull();
  });

  test("a model only: its line and Connect an agent…, folded", async () => {
    const { part, listed } = await yourAi(agents([]), MODEL);
    expect(part("ai-lede")).not.toBeNull();
    expect(listed()).toEqual([]);
    expect(part("agents-connect-another")?.textContent).toBe("Connect an agent…");
  });

  test("connecting turned off: the switch shows, off, beside the agent it holds back", async () => {
    const { part, container } = await yourAi(agents([CLAUDE_CODE], false));
    const toggle = part("agents-enabled") as unknown as { checked: boolean } | null;
    expect(toggle?.checked).toBe(false);
    expect(container.textContent).toContain("Off: no agent can reach your Documents.");
    expect(part("agent-pairing")).not.toBeNull();
  });

  test("agents that can't be read: one line with Try again, and nothing else of Your AI", async () => {
    const { part, listed } = await yourAi(agents([]), NO_MODEL, "en", true);
    expect(part("agents-read-failed")?.textContent).toContain(
      "Couldn’t read your AI’s connections",
    );
    expect(listed()).toEqual([]);
    const again = part("agents-read-failed")?.querySelector("button");
    await act(async () => (again as unknown as { click(): void }).click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("agents to connect that can't be listed: one line with Try again where the list goes", async () => {
    retry.mockClear();
    const { part, listed } = await yourAi(agents([]), NO_MODEL, "en", false, true);
    expect(part("agents-list-failed")?.textContent).toContain(
      "Couldn’t list the agents to connect",
    );
    expect(listed()).toEqual([]);
    const again = part("agents-list-failed")?.querySelector("button");
    await act(async () => (again as unknown as { click(): void }).click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("a failed read stays said while Try again waits, so the page keeps showing, and goes once one succeeds", async () => {
    let answer: (settings: AgentSettings) => void = () => undefined;
    const reads = [
      () => Promise.reject(new Error("The agents' settings couldn't be read.")),
      () =>
        new Promise<AgentSettings>((resolve) => {
          answer = resolve;
        }),
    ];
    const original = bridge.getAgents;
    Object.assign(bridge, { getAgents: () => (reads.shift() ?? reads[0])?.() });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let read = { settings: null, failed: false, retry: () => undefined } as ReturnType<
        typeof useAgentsRead
      >;
      const Probe = () => {
        read = useAgentsRead();
        return null;
      };
      await shown(createElement(Probe));
      expect(read.failed).toBe(true);
      await act(async () => read.retry());
      expect(read.failed).toBe(true);
      await act(async () => answer(agents([CLAUDE_CODE])));
      expect(read.failed).toBe(false);
      expect(read.settings?.pairings).toHaveLength(1);
    } finally {
      Object.assign(bridge, { getAgents: original });
      error.mockRestore();
    }
  });

  test("in Chinese, in Chinese words", async () => {
    const none = await yourAi(agents([]), NO_MODEL, "zh-CN");
    expect(none.part("ai-lede")?.textContent).toBe("让你常用的 AI 工具读取你的文档。");
    await unmount?.();
    unmount = null;
    const one = await yourAi(agents([CLAUDE_CODE]), NO_MODEL, "zh-CN");
    expect(one.part("agents-connect-another")?.textContent).toBe("连接其他智能体…");
  });

  test("a pairing that last connected with a legacy v1 shim says so, with reinstall for bundle clients", async () => {
    const clear = async () => {
      await unmount?.();
      unmount = null;
    };
    const claudeDesktop: AgentPairing = {
      ...CLAUDE_CODE,
      id: "p-bundle",
      name: "Claude Desktop",
      client: "claude-desktop",
    } as never;
    const { part } = await yourAi(agents([CLAUDE_CODE], true, [CLAUDE_CODE.id]));
    expect(part("agent-pairing-shim-old")?.textContent).toContain(
      "Using an older connection helper",
    );
    expect(part("agent-shim-reinstall")).toBeNull();
    await clear();

    const bundle = await yourAi(agents([claudeDesktop], true, [claudeDesktop.id]));
    expect(bundle.part("agent-pairing-shim-old")?.textContent).toContain(
      "Using an older connection helper",
    );
    expect(bundle.part("agent-shim-reinstall")?.textContent).toBe(
      "Open the install in Claude again",
    );
    await clear();

    const zh = await yourAi(agents([claudeDesktop], true, [claudeDesktop.id]), NO_MODEL, "zh-CN");
    expect(zh.part("agent-pairing-shim-old")?.textContent).toContain("正在使用旧版连接程序");
    expect(zh.part("agent-shim-reinstall")?.textContent).toBe("在 Claude 中重新打开安装");
  });

  test("a model in IncarnaMind, with none set up, is one quiet row that says it is optional", async () => {
    for (const [language, words] of [
      ["en", ["Use a model in IncarnaMind…", "Optional: the assistant"]],
      ["zh-CN", ["在 IncarnaMind 里用一个模型…", "可选：助手、自动整理、会后笔记"]],
    ] as const) {
      user(NO_MODEL, false, language);
      const container = await shown(createElement(UseModelRow));
      const row = container.querySelector('[data-testid="ai-use-model-open"]');
      for (const word of words) expect(row?.textContent, language).toContain(word);
      await unmount?.();
      unmount = null;
    }
  });
});
