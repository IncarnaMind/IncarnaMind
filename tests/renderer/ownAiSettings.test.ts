/**
 * With only the User's own AI connected and no model set up in IncarnaMind (#3537): Settings lists
 * no Connectors and no Skills, and AI says which AI of theirs is connected; with a model set up
 * nothing differs. A Connector that is on keeps its page, the one place that disconnects it.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentPairing, ChatReadiness } from "../../src/core/api";

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
const noAiPath = "../../src/renderer/src/components/firstRun/NoAiYet.tsx";
const { NoAiYet }: { NoAiYet: ComponentType<{ agents: readonly string[]; onAdd(): void }> } =
  await import(noAiPath);
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
      "agents",
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
      "agents",
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
      expect(nav(container), language).toEqual(["general", "ai", "meetings", "agents", "privacy"]);
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
    expect(nav(container)).toEqual(["general", "ai", "meetings", "skills", "agents", "privacy"]);
    // They go to AI: it is gone from the list.
    await act(async () => useAppStore.getState().showSettingsPage("ai"));
    expect(nav(container)).toEqual(["general", "ai", "meetings", "agents", "privacy"]);
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
    for (const kept of ["ai", "meetings", "agents", "privacy"]) {
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

describe("Settings › AI says whose AI is connected", () => {
  const card = async (agents: readonly string[], language = "en") => {
    user(NO_MODEL, false, language);
    const container = await shown(createElement(NoAiYet, { agents, onAdd: () => undefined }));
    const section = container.querySelector('[data-testid="ai-none"]');
    return {
      text: section?.textContent ?? "",
      addIsPrimary: (
        container.querySelector('[data-testid="ai-none-add"]')?.className ?? ""
      ).includes("bg-ink"),
    };
  };

  test("with one AI connected: its name first, a model as optional, and no primary button for it", async () => {
    const own = await card(["Claude Code"]);
    expect(own.text).toContain("Your AI: Claude Code");
    expect(own.text).toContain("A model in IncarnaMind is optional.");
    expect(own.text).not.toContain("No AI yet");
    expect(own.addIsPrimary).toBe(false);
  });

  test("with two, both are named, and in Chinese the words are Chinese", async () => {
    expect((await card(["Claude Code", "Cursor"])).text).toContain(
      "Your AI: Claude Code and Cursor",
    );
    await unmount?.();
    unmount = null;
    const chinese = await card(["Claude Code"], "zh-CN");
    expect(chinese.text).toContain("你的 AI：Claude Code");
    expect(chinese.text).toContain("在 IncarnaMind 里设置模型是可选的");
  });

  test("with none connected it is as it was: No AI yet, and adding a key is the primary button", async () => {
    const none = await card([]);
    expect(none.text).toContain("No AI yet");
    expect(none.text).toContain("Add a key, sign in to a plan, or use a model on this computer.");
    expect(none.text).not.toContain("optional");
    expect(none.addIsPrimary).toBe(true);
  });
});
