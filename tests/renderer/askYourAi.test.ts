/**
 * Ask your AI (#3373) for each kind of User: one whose own AI is connected and who set up no
 * model is never asked for one above a Note, the page stays bare, the assistant starts folded with
 * a pill that asks that AI, and the chat box offers it in place of the setup card; one with a
 * model, and one with neither, see what they saw before.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AgentActivity,
  type AgentPairing,
  type AskAgentInput,
  type AssistantPlace,
  type ChatReadiness,
  DEFAULT_ASSISTANT,
  type SearchScope,
  type WindowLayout,
} from "../../src/core/api";
import type { OwnAiPill } from "../../src/renderer/src/ownAiPanel";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;

const bridge = {
  agents: [] as AgentPairing[],
  asked: [] as AskAgentInput[],
  /** The agent's app took the link, as Claude Code's does. */
  opens: false,
  /** What the core tells the windows of each call an agent made. */
  calls: [] as ((activity: AgentActivity) => void)[],
  on: (event: string, listener: (activity: AgentActivity) => void) => {
    if (event === "agents.activity") bridge.calls.push(listener);
    return () => undefined;
  },
  listAgentsToAsk: async () => bridge.agents,
  listConversations: async () => [],
  askAgent: async (input: AskAgentInput) => {
    bridge.asked.push(input);
    return bridge.opens ? { kind: "opened" } : { kind: "copy", text: "The request" };
  },
  // The core keeps the assistant's place as the window asks.
  layout: null as WindowLayout | null,
  changeLayout: async (_window: string, change: { place: Partial<AssistantPlace> }) => {
    const layout = bridge.layout as WindowLayout;
    bridge.layout = { ...layout, assistant: { ...layout.assistant, ...change.place } };
    return bridge.layout;
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
const { askAgent, askedAbout } = await import("../../src/renderer/src/askYourAi");
const { composerKey } = await import("../../src/renderer/src/composer");
const { useFoldForOwnAi, useOwnAiPill } = await import("../../src/renderer/src/ownAiPanel");
const { useQuietAssistant } = await import("../../src/renderer/src/quietAssistant");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const noticePath = "../../src/renderer/src/components/providers/ChatReadinessNotice.tsx";
const { ChatReadinessNotice }: { ChatReadinessNotice: ComponentType<{ mindId: string }> } =
  await import(noticePath);
const checkNotReadyPath = "../../src/renderer/src/editor/CheckNotReady.tsx";
const {
  CheckNotReady,
}: {
  CheckNotReady: ComponentType<{
    mindId: string;
    readiness: Extract<ChatReadiness, { ready: false }>;
  }>;
} = await import(checkNotReadyPath);
const { setCheckProblem, useChecks } = await import("../../src/renderer/src/checks");
const { AskedCheckLine }: { AskedCheckLine: ComponentType<{ mindId: string }> } = await import(
  checkNotReadyPath
);
const { QUIET_AFTER_MS, useAgentAsked } = await import("../../src/renderer/src/askedAgent");

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

function user(
  readiness: ChatReadiness,
  agents: AgentPairing[],
  language = "en",
  assistant: AssistantPlace = DEFAULT_ASSISTANT,
) {
  bridge.agents = agents;
  bridge.layout = {
    groups: [
      {
        id: "group",
        tabs: [
          {
            id: "tab",
            item: { kind: "mind", mindId: MIND },
            preview: false,
            pinned: false,
            place: null,
            opened: 0,
          },
        ],
        activeTabId: "tab",
        width: 1,
      },
    ],
    focusedGroupId: "group",
    reopenable: 0,
    conversationId: null,
    assistant,
  } as WindowLayout;
  useAppStore.setState({
    chatReadiness: readiness,
    minds: [{ id: MIND, folderId: "folder-ferries" }],
    settings: { language, user: {}, device: { gettingStarted: {} } },
    layout: bridge.layout,
  } as never);
}

/** The window as the User finds it: folded or not, its rail (out of sight while quiet), and the pill. */
async function windowShown(): Promise<{ folded: boolean; rail: boolean; pill: OwnAiPill | null }> {
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  let pill: OwnAiPill | null = null;
  let quiet = false;
  const Probe = () => {
    useFoldForOwnAi();
    pill = useOwnAiPill();
    quiet = useQuietAssistant();
    return null;
  };
  await act(async () => root.render(createElement(Probe)));
  // The agents are read, then the fold is kept through the core.
  await act(async () => undefined);
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  const folded = useAppStore.getState().layout?.assistant.folded === true;
  return { folded, rail: folded && !quiet, pill };
}

let unmount: (() => Promise<void>) | null = null;
/** The line a Check that no model can run leaves in the Note's card. */
async function checkLine(readiness: Extract<ChatReadiness, { ready: false }>) {
  setCheckProblem(MIND, { kind: "not-ready", readiness });
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(CheckNotReady, { mindId: MIND, readiness })));
  // The agents are read from the core as the card shows.
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  return container as unknown as HTMLElement;
}

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
  bridge.opens = false;
  useAgentAsked.setState({ byKey: {} });
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
  // protects=a User with their own AI and no model is never asked for a model above a Note, while one with neither still is and one with a model sees nothing; fails_when=the agent User gets any line, or either other User's line changes
  test("with an agent and no model: none; with neither: Asking needs an AI model; with a model: none", async () => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code"), pairing("VS Code", "vscode")]);
    expect((await lineAbove()).textContent).toBe("");
    await unmount?.();
    user(MODEL, [pairing("Claude Code", "claude-code")]);
    expect((await lineAbove()).textContent).toBe("");
    await unmount?.();
    user(NO_MODEL, []);
    const line = await lineAbove();
    expect(line.textContent).toContain("Asking needs an AI model");
    expect(line.textContent).not.toContain("Claude Code");
  });
});

describe("the assistant and its pill", () => {
  const agents = [pairing("Claude Code", "claude-code"), pairing("VS Code", "vscode")];

  // protects=a User with only their own AI who never opened or folded the assistant finds it out of sight, no rail, with a pill that asks that AI about the Note; fails_when=it stays open, a rail shows, or no pill offers their AI
  test("with an agent and no model: folded out of sight for them, no rail, and the pill asks Claude Code", async () => {
    user(NO_MODEL, agents);
    const shown = await windowShown();
    expect(shown).toEqual({ folded: true, rail: false, pill: { mindId: MIND, agents } });
    expect(useAppStore.getState().layout?.assistant.foldedBy).toBe("agent");
  });

  // protects=once the User opens the assistant it stays open, and their own fold shows the rail as for everyone; fails_when=the app folds a panel the User opened, or hides the rail of their own fold
  test("their own open holds, and their own fold shows the rail", async () => {
    user(NO_MODEL, agents, "en", { ...DEFAULT_ASSISTANT, folded: false, foldedBy: "user" });
    expect(await windowShown()).toEqual({ folded: false, rail: false, pill: null });
    await unmount?.();
    user(NO_MODEL, agents, "en", { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "user" });
    expect(await windowShown()).toEqual({
      folded: true,
      rail: true,
      pill: { mindId: MIND, agents },
    });
  });

  // protects=a User with a model, or with neither, keeps the assistant as it was: open, or folded to its rail, with no agent's pill; fails_when=either is folded, loses the rail or gets the agent's pill
  test("with a model, or with neither: as before", async () => {
    user(MODEL, agents);
    expect(await windowShown()).toEqual({ folded: false, rail: false, pill: null });
    await unmount?.();
    user(NO_MODEL, []);
    expect(await windowShown()).toEqual({ folded: false, rail: false, pill: null });
    await unmount?.();
    user(MODEL, agents, "en", { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "user" });
    expect(await windowShown()).toEqual({ folded: true, rail: true, pill: null });
  });

  // protects=a fold made only for the User's own AI goes once they set up a model; fails_when=it stays folded for a User with a model who never folded it
  test("set up a model, and the fold made for their AI goes", async () => {
    user(MODEL, agents, "en", { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "agent" });
    expect(await windowShown()).toEqual({ folded: false, rail: false, pill: null });
  });
});

describe("asking an agent", () => {
  // protects=the action the card, the chat box and ⌘K run hands that agent the request and, where its app has no link, copies it and says where to paste it; fails_when=it asks another agent, changes what it was given, or copies silently
  test("copies the request for an agent with no link, and says where to paste it", async () => {
    user(NO_MODEL, [pairing("VS Code", "vscode")]);
    const ask = { kind: "question", text: "What did fuel cost in 2025?" } as const;
    expect(await askAgent(pairing("VS Code", "vscode"), MIND, ask)).toBe(true);
    expect(bridge.asked).toEqual([
      { pairingId: "pairing-VS Code", mindId: MIND, ask, onScreen: [], scope: null },
    ]);
    expect(copied).toEqual(["The request"]);
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "agents.ask.copied",
      params: { agent: "VS Code" },
    });
  });

  // protects=a request opened in the agent's own app says so in IncarnaMind's window too, so the User knows where to send it; fails_when=the press leaves this window as it was, or the line is copied over what the User had copied
  test("says the agent's app opened with the request typed, and copies nothing", async () => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code")]);
    bridge.opens = true;
    const ask = { kind: "note" } as const;
    expect(await askAgent(pairing("Claude Code", "claude-code"), MIND, ask)).toBe(true);
    expect(copied).toEqual([]);
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "agents.ask.opened",
      params: { agent: "Claude Code" },
    });
  });
});

describe("a sentence the User asked their AI to fix (#3419)", () => {
  const request = (readAt: string | null, checkId = "check-1") => ({
    id: "request-1",
    pairingId: "pairing-Claude Code",
    mindId: MIND,
    sentences: [{ sentence: "Gross margin held at 40.3% in Q3.", checkId }],
    createdAt: "2026-11-19T10:00:00.000Z",
    readAt,
  });
  const agents = [pairing("Claude Code", "claude-code")];
  const sentence = "Gross margin held at 40.3% in Q3.";

  // protects=the card says the request waits for that agent until it reads it, and stops saying so once the sentence is edited or checked again or the agent can't read the Note; fails_when=a line names another agent, outlives an edit or a new check, or says read before it was
  test("waits for the agent, says when it read it, and goes with an edit or a new check", () => {
    expect(askedAbout([request(null)], agents, "check-1", sentence)).toEqual({
      agent: "Claude Code",
      read: false,
    });
    expect(askedAbout([request("2026-11-19T10:01:00.000Z")], agents, "check-1", sentence)).toEqual({
      agent: "Claude Code",
      read: true,
    });
    expect(askedAbout([request(null)], agents, "check-2", sentence)).toBeNull();
    expect(
      askedAbout([request(null)], agents, "check-1", "Gross margin was 38.1% in Q3."),
    ).toBeNull();
    expect(askedAbout([request(null)], [], "check-1", sentence)).toBeNull();
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

describe("a Question asked of the User's own AI with a Document open (#3533)", () => {
  const withDocumentsOpen = (...documentIds: string[]) => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code")]);
    const layout = bridge.layout as WindowLayout;
    const [note] = layout.groups;
    if (!note) throw new Error("No group.");
    const tab = (documentId: string) => ({
      id: `tab-${documentId}`,
      item: { kind: "document", documentId },
      preview: false,
      pinned: false,
      place: null,
      opened: 0,
    });
    const groups = [
      note,
      ...documentIds.map((documentId) => ({
        id: `group-${documentId}`,
        tabs: [tab(documentId)],
        activeTabId: `tab-${documentId}`,
        width: 1,
      })),
    ];
    useAppStore.setState({ layout: { ...layout, groups } } as never);
  };
  const scope: SearchScope = { folderIds: ["folder-ferries"], tagIds: [], documentIds: [] };
  const question = { kind: "question", text: "Summarise this document" } as const;

  // protects=a question goes to the agent with the Documents open on screen and the chat box's scope, as the assistant is given them; fails_when=either is left out, or another kind of ask carries them
  test("goes with the Documents open on screen and the scope, and no other ask does", async () => {
    withDocumentsOpen("doc-summary", "doc-tariffs");
    const claude = pairing("Claude Code", "claude-code");
    expect(await askAgent(claude, MIND, question, scope)).toBe(true);
    expect(bridge.asked.at(-1)).toEqual({
      pairingId: claude.id,
      mindId: MIND,
      ask: question,
      onScreen: ["doc-summary", "doc-tariffs"],
      scope,
    });
    expect(await askAgent(claude, MIND, { kind: "note" })).toBe(true);
    expect(await askAgent(claude, MIND, { kind: "check" })).toBe(true);
    for (const each of bridge.asked.slice(-2)) {
      expect(each).not.toHaveProperty("onScreen");
      expect(each).not.toHaveProperty("scope");
    }
  });

  // protects=with nothing open and no scope the question carries none; fails_when=a Document that isn't open is sent
  test("with nothing open it carries no Document", async () => {
    user(NO_MODEL, [pairing("Claude Code", "claude-code")]);
    await askAgent(pairing("Claude Code", "claude-code"), MIND, question);
    expect(bridge.asked.at(-1)).toMatchObject({ onScreen: [], scope: null });
  });
});

describe("a Check that no model can run, for each kind of User (#3533)", () => {
  const claude = pairing("Claude Code", "claude-code");
  const problemKind = () => useChecks.getState().problems[MIND]?.kind;

  // protects=with no model and an agent that can read the Note, the Check's line offers to ask that agent, as "Ask {agent}" is worded elsewhere, with the others behind the arrow, and pressing it asks for a check and clears the line; fails_when=the line is about asking, offers no agent, or the press asks another kind of thing
  test("with no model and an agent: Ask {agent} asks it to check the Note", async () => {
    user(NO_MODEL, [claude, pairing("VS Code", "vscode")]);
    const line = await checkLine(NO_MODEL as never);
    expect(line.textContent).toContain("Ask Claude Code");
    expect(line.textContent).toContain("Set up a model");
    expect(line.textContent).not.toContain("Asking needs an AI model");
    expect(line.querySelector('[data-testid="checks-ask-agent-others"]')).not.toBeNull();
    const ask = line.querySelector('[data-testid="checks-ask-agent-ask"]') as HTMLElement;
    await act(async () => ask.click());
    expect(bridge.asked).toEqual([{ pairingId: claude.id, mindId: MIND, ask: { kind: "check" } }]);
    expect(problemKind()).toBeUndefined();
  });

  // protects=with neither a model nor an agent the line says what a check needs, in words about checking, with the way to set a model up; fails_when=it says asking, or offers no way on
  test("with no model and no agent: a line about checking, with the way to set a model up", async () => {
    user(NO_MODEL, []);
    const line = await checkLine(NO_MODEL as never);
    expect(line.textContent).toContain("Checking needs an AI model");
    expect(line.textContent).toContain("Set up");
    expect(line.textContent).not.toContain("Asking");
    expect(line.querySelector('[data-testid="checks-ask-agent"]')).toBeNull();
  });

  // protects=the same line in Chinese; fails_when=Chinese gets English words
  test("says it in Chinese when the interface is", async () => {
    user(NO_MODEL, [claude], "zh-CN");
    expect((await checkLine(NO_MODEL as never)).textContent).toContain("Claude Code");
    await unmount?.();
    user(NO_MODEL, [], "zh-CN");
    expect((await checkLine(NO_MODEL as never)).textContent).toContain("核对需要 AI 模型");
  });

  // protects=a model that is set up but can't be used (its key is gone) keeps its own explanation and no agent is offered; fails_when=the agent is offered for a problem the User fixes in Settings
  test("with a model that can't be used: its own explanation, as before", async () => {
    const missingKey = {
      ready: false,
      reason: "missing-api-key",
      provider: { id: "anthropic", kind: "anthropic" },
      modelId: "claude-haiku-5-5",
    } as unknown as Extract<ChatReadiness, { ready: false }>;
    user(missingKey, [claude]);
    const line = await checkLine(missingKey);
    expect(line.querySelector('[data-testid="checks-ask-agent"]')).toBeNull();
    expect(line.textContent).not.toContain("Ask Claude Code");
    expect(line.textContent).toContain("Set up");
  });
});

describe("a Check handed to the User's own AI says how it goes, until its marks land (#3587)", () => {
  const codex = pairing("Codex", "codex");
  const claude = pairing("Claude Code", "claude-code");
  let calls = 0;
  /** A call `agent` made, as the core tells the windows once it has recorded it. */
  const called = async (
    agent: AgentPairing,
    tool: AgentActivity["tool"],
    { mindId, documentIds = [] }: { mindId?: string; documentIds?: string[] } = {},
  ) => {
    calls += 1;
    const activity: AgentActivity = {
      id: `call-${calls}`,
      pairingId: agent.id,
      tool,
      summary: "",
      outcome: "done",
      problem: null,
      count: null,
      request: null,
      documentIds,
      effects: mindId ? [{ action: "read", scope: { kind: "mind", mindId } }] : [],
      durationMs: 10,
      at: new Date(Date.now() + 1000).toISOString(),
    };
    await act(async () => {
      for (const listener of bridge.calls) listener(activity);
    });
  };

  async function askedLine() {
    const container = page.createElement("div", {});
    page.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AskedCheckLine, { mindId: MIND })));
    await act(async () => undefined);
    unmount = async () => {
      await act(() => root.unmount());
      container.remove();
    };
    const part = (testId: string) =>
      container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    return { container: container as unknown as HTMLElement, part };
  }

  // protects=from the press until the marks land the Note says in plain words that the AI was asked and the request is to be sent there, then that it is checking once that connection calls a Tool about the Note (read_request is not needed), and nothing once its report lands; a call about something else, or another AI's, changes nothing; fails_when=the line stays silent, says checking before the AI picked the Note up, or stays after the marks land
  test.each([
    [
      "en",
      [
        "Asked Codex: send the request there.",
        "Checking this note in Codex.",
        "Ask again",
        "Ask another AI",
        "Set up a model",
      ],
    ],
    [
      "zh-CN",
      [
        "已交给 Codex：在那里发送请求即可。",
        "Codex 正在核对这篇笔记。",
        "再问一次",
        "交给其他智能体",
        "设置 AI 模型",
      ],
    ],
  ] as const)("asked, checking, then its result (%s)", async (language, words) => {
    const [asked, checking, again, others, setUp] = words;
    user(NO_MODEL, [claude, codex], language);
    bridge.opens = true;
    expect(await askAgent(codex, MIND, { kind: "check" })).toBe(true);
    const { container, part } = await askedLine();
    expect(part("checks-asked")?.textContent).toBe(asked);
    expect(part("checks-asked")?.dataset.state).toBe("asked");
    expect(part("checks-asked-line-ask")?.textContent).toBe(again);
    expect(part("checks-asked-set-up")?.textContent).toBe(setUp);
    expect(part("checks-asked-line-others")?.getAttribute("aria-label")).toBe(others);

    await called(claude, "check_mind_yourself", { mindId: MIND });
    await called(codex, "list_minds");
    await called(codex, "check_mind_yourself", { mindId: "another-note" });
    expect(part("checks-asked")?.textContent).toBe(asked);
    await called(codex, "check_mind_yourself", { mindId: MIND });
    expect(part("checks-asked")?.textContent).toBe(checking);
    expect(part("checks-asked")?.dataset.state).toBe("working");
    // Once it has the Note, its searches between say it is still at work.
    await called(codex, "search", { documentIds: ["harbour-report"] });
    expect(part("checks-asked")?.dataset.state).toBe("working");

    await called(codex, "report_check", { mindId: MIND });
    expect(part("checks-asked")).toBeNull();
    expect(container.textContent).toBe("");
  });

  // protects=an AI that never picks the request up leaves no line that waits for ever: after a few minutes the line says nothing came and how to ask again, and Ask again asks the same AI once more; a call that comes after all makes it checking; fails_when=the line keeps saying asked or checking with nothing heard, or Ask again asks another AI
  test("an AI that never picks it up: the line says so, and how to ask again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      user(NO_MODEL, [codex]);
      expect(await askAgent(codex, MIND, { kind: "check" })).toBe(true);
      const { part } = await askedLine();
      expect(part("checks-asked")?.textContent).toBe(
        "Copied for Codex: paste the request there and send it.",
      );
      await act(async () => vi.advanceTimersByTime(QUIET_AFTER_MS - 1000));
      expect(part("checks-asked")?.dataset.state).toBe("asked");
      await act(async () => vi.advanceTimersByTime(1000));
      expect(part("checks-asked")?.textContent).toBe(
        "Nothing from Codex yet. Send the request, or ask again.",
      );
      expect(part("checks-asked")?.dataset.state).toBe("quiet");

      await called(codex, "read_request", { mindId: MIND });
      expect(part("checks-asked")?.dataset.state).toBe("working");
      await act(async () => vi.advanceTimersByTime(QUIET_AFTER_MS));
      expect(part("checks-asked")?.dataset.state).toBe("quiet");

      bridge.asked = [];
      await act(async () => part("checks-asked-line-ask")?.click());
      await act(async () => undefined);
      expect(bridge.asked).toEqual([{ pairingId: codex.id, mindId: MIND, ask: { kind: "check" } }]);
      expect(part("checks-asked")?.dataset.state).toBe("asked");
    } finally {
      vi.useRealTimers();
    }
  });

  // protects=the Chinese words for an AI that never came; fails_when=Chinese gets English words
  test("says it in Chinese too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      user(NO_MODEL, [codex], "zh-CN");
      expect(await askAgent(codex, MIND, { kind: "check" })).toBe(true);
      const { part } = await askedLine();
      expect(part("checks-asked")?.textContent).toBe("已为 Codex 复制：粘贴到那里并发送请求。");
      await act(async () => vi.advanceTimersByTime(QUIET_AFTER_MS));
      expect(part("checks-asked")?.textContent).toBe("Codex 还没有动静。请发送请求，或再问一次。");
    } finally {
      vi.useRealTimers();
    }
  });
});
