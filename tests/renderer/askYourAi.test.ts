/**
 * Ask your AI (#3373) for each kind of User: one whose own AI is connected and who set up no
 * model gets a way to ask that AI where IncarnaMind would have asked for a model, above a Note
 * and in the chat box; one with a model, and one with neither, see what they saw before.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentAsk, AgentPairing, ChatReadiness } from "../../src/core/api";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;

const bridge = {
  agents: [] as AgentPairing[],
  asked: [] as { pairingId: string; mindId: string | null; ask: AgentAsk }[],
  on: () => () => undefined,
  listAgentsToAsk: async () => bridge.agents,
  askAgent: async (input: { pairingId: string; mindId: string | null; ask: AgentAsk }) => {
    bridge.asked.push(input);
    return { kind: "copy", text: "The request" };
  },
  askInConversation: async () => ({
    asked: false,
    reason: "not-ready",
    readiness: { ready: false, reason: "no-provider" },
  }),
};
const methods = new Proxy(bridge, {
  get: (each, name) =>
    name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
});
Object.assign(view, { incarnamind: methods, incarnamindFiles: methods });
const copied: string[] = [];
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
vi.stubGlobal("navigator", {
  userAgent: "node",
  clipboard: {
    writeText: async (text: string) => {
      copied.push(text);
    },
  },
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
const { useNotices } = await import("../../src/renderer/src/notices");
const { useAnswers } = await import("../../src/renderer/src/answers");
const { useModelSetup } = await import("../../src/renderer/src/modelSetup");
const { askInAssistant } = await import("../../src/renderer/src/conversations");
const { composerKey } = await import("../../src/renderer/src/composer");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const noticePath = "../../src/renderer/src/components/providers/ChatReadinessNotice.tsx";
const { ChatReadinessNotice }: { ChatReadinessNotice: ComponentType<{ mindId: string }> } =
  await import(noticePath);

const MIND = "mind-ferries";
const pairing = (name: string, client: string | null): AgentPairing => ({
  id: `pairing-${name}`,
  name,
  folderIds: ["folder-ferries"],
  client,
  propose: true,
  lastUsedAt: null,
  createdAt: "2026-11-19T10:00:00.000Z",
});
const NO_MODEL: ChatReadiness = { ready: false, reason: "no-provider" };
const MODEL = {
  ready: true,
  provider: { id: "anthropic", kind: "anthropic" },
  modelId: "claude-haiku-5-5",
  consent: "not-required",
} as unknown as ChatReadiness;

function user(readiness: ChatReadiness, agents: AgentPairing[], language = "en") {
  bridge.agents = agents;
  useAppStore.setState({
    chatReadiness: readiness,
    minds: [{ id: MIND, folderId: "folder-ferries" }],
    settings: { language, user: {} },
  } as never);
}

let unmount: (() => Promise<void>) | null = null;
async function lineAbove(): Promise<HTMLElement> {
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ChatReadinessNotice, { mindId: MIND })));
  // The agents are read from the core as the Note shows.
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  return container as unknown as HTMLElement;
}

beforeEach(() => {
  bridge.asked = [];
  copied.length = 0;
  useNotices.setState({ confirmation: null });
  useModelSetup.setState({ waiting: null, wanted: false, ready: false });
  useAnswers.setState({ blocked: {} } as never);
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("the line above a Note", () => {
  // protects=a User with their own AI and no model is offered that AI about the Note, a model still one step away, and no nag; fails_when=the nag shows, or the agent's line has no way to set up a model
  test("with an agent and no model: Ask {agent} about this note, then Set up a model", async () => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code"), pairing("VS Code", "vscode")]);
    const line = await lineAbove();
    expect(line.textContent).toContain("Ask Claude Code about this note");
    expect(line.textContent).toContain("Set up a model");
    expect(line.textContent).not.toContain("Asking needs an AI model");
    expect(line.querySelector('[data-testid="ask-agent-note-others"]')).not.toBeNull();
  });

  test("in Chinese", async () => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code")], "zh-CN");
    const line = await lineAbove();
    expect(line.textContent).toContain("就这篇笔记问 Claude Code");
    expect(line.textContent).toContain("设置 AI 模型");
    expect(line.querySelector('[data-testid="ask-agent-note-others"]')).toBeNull();
  });

  // protects=a User with a model, or with neither, sees what they saw before; fails_when=either gets the agent's line
  test("with a model: nothing; with neither: Asking needs an AI model", async () => {
    user(MODEL, [pairing("Claude Code", "claude-code")]);
    expect((await lineAbove()).textContent).toBe("");
    await unmount?.();
    user(NO_MODEL, []);
    const line = await lineAbove();
    expect(line.textContent).toContain("Asking needs an AI model");
    expect(line.textContent).not.toContain("Claude Code");
  });

  // protects=pressing Ask hands the agent the Note by name only and, where its app has no link, copies the request and says where to paste it; fails_when=it asks another agent, carries anything but the Note, or copies silently
  test("Ask copies the request for an agent with no link, and says where to paste it", async () => {
    user(NO_MODEL, [pairing("VS Code", "vscode")]);
    const line = await lineAbove();
    const ask = line.querySelector<HTMLButtonElement>('[data-testid="ask-agent-note-ask"]');
    await act(async () => ask?.click());
    expect(bridge.asked).toEqual([
      { pairingId: "pairing-VS Code", mindId: MIND, ask: { kind: "note" } },
    ]);
    expect(copied).toEqual(["The request"]);
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "agents.ask.copied",
      params: { agent: "VS Code" },
    });
  });
});

describe("a Question in the chat box with no model", () => {
  const input = { mindId: MIND, text: "What did fuel cost in 2025?" };

  // protects=with the User's own AI connected the chat box offers it instead of the setup card, the words kept; with none, the setup card waits as before; fails_when=an agent User gets the setup card, or a User with no agent loses it
  test("offers the User's own AI where one is connected, else the setup card", async () => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code")]);
    await lineAbove();
    expect(await askInAssistant(input)).toBe(false);
    expect(useAnswers.getState().blocked[composerKey(MIND)]).toMatchObject({
      kind: "not-ready",
    });
    expect(useModelSetup.getState().waiting).toBeNull();
    await unmount?.();

    user(NO_MODEL, []);
    await lineAbove();
    expect(await askInAssistant(input)).toBe(true);
    expect(useModelSetup.getState().waiting?.text).toBe(input.text);
  });
});
