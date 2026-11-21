/**
 * Get started's steps for a User whose own AI is connected (#3572). "Ask your AI for a document":
 * one press hands the AI a line that names their newest Document, as every other ask does. Its app
 * opens with the line typed where it has a link for that, and the line is copied only where it has
 * none. The core is the real one, so the line an app is opened with is the one the core builds;
 * the link it would open is recorded, and nothing of this computer opens. "See what needs a look"
 * is the User's own Check on the Note their AI wrote.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import {
  type AgentActivity,
  type AgentClientId,
  ALL_SHARED_ID,
  type GettingStarted,
} from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;

let real: Core | null = null;
const nothingWaits = async () => [];
const stillToCome = () => Promise.resolve(undefined);
/** What the core tells the windows of each call an agent made, as the test makes them. */
const calls: ((activity: AgentActivity) => void)[] = [];
const bridge = new Proxy(
  {},
  {
    get: (_each, name: string) => {
      if (name === "listApprovalRequests" || name === "listUserQuestions") return nothingWaits;
      if (name === "on")
        return (event: string, listener: (value: never) => void) => {
          if (event === "agents.activity")
            calls.push(listener as (activity: AgentActivity) => void);
          return real ? real.on(event as never, listener) : () => undefined;
        };
      const method: unknown = real && Reflect.get(real, name);
      return typeof method === "function" ? method.bind(real) : stillToCome;
    },
  },
);
Object.assign(view, { incarnamind: bridge, incarnamindFiles: bridge });

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
  IntersectionObserver: class {
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
const { useAgentAsked } = await import("../../src/renderer/src/askedAgent");
// The commands the card names their shortcuts of.
await import("../../src/renderer/src/commands/app");
const stepsPath = "../../src/renderer/src/components/FirstOpenSteps.tsx";
interface LookProps {
  note: { mindId: string; state: unknown } | null;
  testId: string | undefined;
  onCheck(): void;
  onOpen(): void;
}
const {
  FirstOpenSteps,
  AgentLook,
}: {
  FirstOpenSteps: ComponentType<{ mindId: string }>;
  AgentLook: ComponentType<LookProps>;
} = await import(stepsPath);

const LINE = (document: string) =>
  `Write a short summary of “${document}” as a new note in IncarnaMind.`;
const LINE_ZH = (document: string) => `在 IncarnaMind 里把文档“${document}”简要总结成一篇新笔记。`;

/** The Documents added and read, the second step the one that waits for the User's AI. */
const PROGRESS: GettingStarted = {
  started: true,
  citationChecked: false,
  mistakeSeen: false,
  indexed: true,
  askedOwn: false,
  askedReady: false,
  exported: false,
  hidden: false,
  seen: true,
  recorded: false,
  notesWritten: false,
  agentNoteSeen: false,
};

const links: string[] = [];
const typedIn = (link: string | undefined) =>
  new URL(link ?? "about:blank").searchParams.get("q") ?? "";

let unmount: (() => Promise<void>) | null = null;

interface Setup {
  language?: "en" | "zh-CN";
  /** The AIs are given one Folder holding only these Documents, not all of them. */
  share?: string[];
  /** Local mode pauses every agent. */
  localOnly?: boolean;
  /** What the step shows once it has been read; the line's Ask unless it lacks something. */
  ready?: string;
}

const pickDocuments = vi.fn();
const openSettings = vi.fn();

/**
 * The card of a User with these AIs connected, the one connected last first, and these Documents
 * added in this order, as the window shows it.
 */
async function card(
  clients: [string, AgentClientId][],
  documents: string[] = ["Harbour report 2025"],
  { language = "en", share, localOnly = false, ready = "first-open-agent-ask" }: Setup = {},
) {
  const dataDir = await createTempDataFolder();
  real = startCore(dataDir, {
    agents: {
      socketPath: agentSocketPath(dataDir),
      launcher: { command: process.execPath, args: ["not-started"] },
      version: "0.0.0-test",
      openLink: async (url: string) => {
        links.push(url);
      },
    },
  });
  if (language !== "en") await real.updateSettings({ user: { language } });
  await real.setAgentsEnabled(true);
  const shared = share && (await real.createLibraryGroup({ name: "Shared", description: "" }));
  for (const [name, client] of clients) {
    await real.connectAgent({
      name,
      client,
      folderIds: shared ? [shared.id] : [ALL_SHARED_ID],
    });
  }
  const sources = await createSourceFolder();
  for (const name of documents) {
    const [added] = await addAndProcess(real, [
      await writeSourceFile(
        sources,
        `${name}.md`,
        `# ${name}\n\nThe port handled 1.8 million tonnes.`,
      ),
    ]);
    if (shared && added && share?.includes(name))
      await real.assignDocumentGroup(added.id, shared.id);
  }
  if (localOnly) await real.setLocalOnly(true);
  useAppStore.setState({
    chatReadiness: { ready: false, reason: "no-provider" },
    minds: [],
    documents: await real.listDocuments(),
    settings: { language, user: {}, device: { gettingStarted: PROGRESS, work: [] } },
  } as never);
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(FirstOpenSteps, { mindId: "mind-1" })));
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  const part = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(part(ready)).not.toBeNull();
  });
  return { container, part };
}

beforeEach(() => {
  copied.length = 0;
  links.length = 0;
  useAgentAsked.setState({ byKey: {} });
  useNotices.setState({ confirmation: null });
  pickDocuments.mockClear();
  openSettings.mockClear();
  useAppStore.setState({ pickDocuments, openSettings } as never);
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("the step that asks the User's AI for a document", () => {
  // protects=one press opens an AI whose app has a link with exactly the card's line, naming the newest Document and asking for no check, copies nothing and says where to send it; fails_when=the press copies, opens another line, names another Document or the step still tells the User to paste
  test("opens the AI's app with the card's line, and copies nothing", async () => {
    const { container, part } = await card([["Claude Code", "claude-code"]]);
    expect(part("first-open-agent-ask")?.textContent).toBe("Ask Claude Code");
    expect(part("first-open-agent-line")?.textContent).toBe(LINE("Harbour report 2025"));
    expect(container.textContent).not.toContain("Paste this into");
    expect(part("first-open-agent-others")).toBeNull();
    await act(async () => part("first-open-agent-ask")?.click());
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(links[0]?.startsWith("claude-cli://open?q=")).toBe(true);
    expect(typedIn(links[0])).toBe(LINE("Harbour report 2025"));
    expect(typedIn(links[0])).not.toMatch(/check/i);
    expect(copied).toEqual([]);
    await vi.waitFor(() =>
      expect(useNotices.getState().confirmation).toMatchObject({
        message: "agents.ask.opened",
        params: { agent: "Claude Code" },
      }),
    );
  });

  // protects=after Ask the step says, in the words the Note's check line uses, that the AI was asked and the request is to be sent there, then that it is writing once that connection reads the Document, where before it looked the same for the 17 to 35 seconds until the Note came (#3587); fails_when=the step looks as before the press, says writing before the AI read the Document, or another AI's call moves it
  test.each([
    [
      "en",
      "Asked Claude Code: send the request there.",
      "Claude Code is writing the note.",
      "Ask again",
    ],
    ["zh-CN", "已交给 Claude Code：在那里发送请求即可。", "Claude Code 正在写笔记。", "再问一次"],
  ] as const)(
    "says the AI was asked, then that it is writing (%s)",
    async (language, asked, writing, again) => {
      const { part } = await card(
        [
          ["VS Code", "vscode"],
          ["Claude Code", "claude-code"],
        ],
        ["Harbour report 2025"],
        { language },
      );
      const { pairings } = await (real as Core).getAgents();
      const claude = pairings.find((each) => each.name === "Claude Code");
      const vscode = pairings.find((each) => each.name === "VS Code");
      const [document] = await (real as Core).listDocuments();
      await act(async () => part("first-open-agent-ask")?.click());
      await vi.waitFor(() => expect(links).toHaveLength(1));
      await vi.waitFor(() => expect(part("first-open-agent-asked")?.textContent).toBe(asked));
      expect(part("first-open-agent-asked")?.dataset.state).toBe("asked");
      expect(part("first-open-agent-ask")?.textContent).toBe(again);
      expect(part("first-open-agent-line")).toBeNull();
      const call = (pairingId: string, documentIds: string[]): AgentActivity => ({
        id: `call-${pairingId}`,
        pairingId,
        tool: "search",
        summary: "",
        outcome: "done",
        problem: null,
        count: 1,
        request: null,
        documentIds,
        effects: [],
        durationMs: 10,
        at: new Date(Date.now() + 1000).toISOString(),
      });
      await act(async () => {
        for (const heard of calls) heard(call(vscode?.id ?? "", [document?.id ?? ""]));
        for (const heard of calls) heard(call(claude?.id ?? "", ["another-document"]));
      });
      expect(part("first-open-agent-asked")?.dataset.state).toBe("asked");
      await act(async () => {
        for (const heard of calls) heard(call(claude?.id ?? "", [document?.id ?? ""]));
      });
      expect(part("first-open-agent-asked")?.textContent).toBe(writing);
      expect(part("first-open-agent-asked")?.dataset.state).toBe("working");
    },
  );

  // protects=the card names the newest Document the User added, not the first or every one; fails_when=an older Document is named
  test("names the newest of the User's Documents", async () => {
    const { part } = await card([["Claude Code", "claude-code"]], ["Older plan", "Newer plan"]);
    expect(part("first-open-agent-line")?.textContent).toBe(LINE("Newer plan"));
    await act(async () => part("first-open-agent-ask")?.click());
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(typedIn(links[0])).toBe(LINE("Newer plan"));
  });

  // protects=an AI with no link is handed the line to copy, and the notice says where to paste it; fails_when=nothing is copied, a link is opened or the notice says it opened
  test("copies the line for an AI whose app has no way to open with one", async () => {
    const { part } = await card([["VS Code", "vscode"]]);
    expect(part("first-open-agent-ask")?.textContent).toBe("Ask VS Code");
    await act(async () => part("first-open-agent-ask")?.click());
    await vi.waitFor(() => expect(copied).toEqual([LINE("Harbour report 2025")]));
    expect(links).toEqual([]);
    await vi.waitFor(() =>
      expect(useNotices.getState().confirmation).toMatchObject({
        message: "agents.ask.copied",
        params: { agent: "VS Code" },
      }),
    );
  });

  // protects=with several AIs connected the one connected last is asked and the others are one step away, as the Ask pill offers them; fails_when=the first AI isn't the one connected last, or the others have no way to be chosen
  test("with several AIs connected, asks the one connected last and offers the others", async () => {
    const { part } = await card([
      ["Claude Code", "claude-code"],
      ["VS Code", "vscode"],
    ]);
    expect(part("first-open-agent-ask")?.textContent).toBe("Ask VS Code");
    expect(part("first-open-agent-others")?.getAttribute("aria-label")).toBe("Ask another AI");
    await act(async () => part("first-open-agent-ask")?.click());
    await vi.waitFor(() => expect(copied).toEqual([LINE("Harbour report 2025")]));
    expect(links).toEqual([]);
  });

  // protects=the step's title press asks the same AI as its button, and the line is the card's in Chinese; fails_when=the title press does nothing, or Chinese gets the English line
  test("in Chinese, the title and the button ask with the Chinese line", async () => {
    const { container, part } = await card(
      [["Claude Code", "claude-code"]],
      ["Harbour report 2025"],
      {
        language: "zh-CN",
      },
    );
    expect(part("first-open-agent-ask")?.textContent).toBe(
      translate("zh-CN", "agents.ask.action", { agent: "Claude Code" }),
    );
    expect(part("first-open-agent-line")?.textContent).toBe(LINE_ZH("Harbour report 2025"));
    const title = container.querySelector(
      '[data-testid="first-open-step"][data-step="agentAsk"] [data-testid="first-open-step-do"]',
    ) as HTMLElement | null;
    expect(title).not.toBeNull();
    await act(async () => title?.click());
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(typedIn(links[0])).toBe(LINE_ZH("Harbour report 2025"));
    expect(copied).toEqual([]);
  });
});

describe("the step when there is nothing it can name (#3572)", () => {
  const LACKING = "first-open-agent-lacking";

  // protects=the step names the newest Document a connected AI can read, never one it can't, so a Document and an Ask always come together; fails_when=the newest Document is named though the AI reads only an older one, or the step has a line with no button
  test("names the newest Document the connected AI can read", async () => {
    const { part } = await card([["Claude Code", "claude-code"]], ["Older plan", "Newer plan"], {
      share: ["Older plan"],
    });
    expect(part("first-open-agent-line")?.textContent).toBe(LINE("Older plan"));
    await act(async () => part("first-open-agent-ask")?.click());
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(typedIn(links[0])).toBe(LINE("Older plan"));
  });

  // protects=with no Document the step says so in one sentence and offers the card's own Add files, in place of the chip; fails_when=an empty chip shows, or the control doesn't add files
  test("with no Document, one sentence and the card's own Add files", async () => {
    const { part } = await card([["Claude Code", "claude-code"]], [], { ready: LACKING });
    expect(part(LACKING)?.textContent).toBe(
      "No Documents yet. Add one, and your AI can write a note about it.",
    );
    expect(part("first-open-agent-line")).toBeNull();
    expect(part("first-open-agent-ask")).toBeNull();
    expect(part("first-open-agent-add")?.textContent).toBe("Add files…");
    await act(async () => part("first-open-agent-add")?.click());
    expect(pickDocuments).toHaveBeenCalledTimes(1);
    expect(links).toEqual([]);
  });

  // protects=with Documents but none shared with the connected AI the step says so and opens the agent settings, as the other not-shared lines do; fails_when=the chip shows with no button, or the way to the settings is missing
  test("with Documents none of which the AI can read, one sentence and the agent settings", async () => {
    const { part } = await card([["Claude Code", "claude-code"]], ["Only plan"], {
      share: [],
      ready: LACKING,
    });
    expect(part(LACKING)?.textContent).toBe(
      "No connected AI can read your Documents yet. Share them in its agent settings.",
    );
    expect(part("first-open-agent-line")).toBeNull();
    expect(part("first-open-agent-settings")?.textContent).toBe("Agent settings");
    await act(async () => part("first-open-agent-settings")?.click());
    expect(openSettings).toHaveBeenCalledWith("agents");
  });

  // protects=with every agent paused the step says to reconnect or resume, not to share; fails_when=Local mode is told to share Documents
  test("with the agents paused, it says to reconnect or resume their access", async () => {
    const { part } = await card([["Claude Code", "claude-code"]], ["Harbour report 2025"], {
      localOnly: true,
      ready: LACKING,
    });
    expect(part(LACKING)?.textContent).toBe("Reconnect your AI or resume its access in Settings.");
    expect(part("first-open-agent-settings")?.textContent).toBe("Agent settings");
  });

  // protects=the two sentences read in Chinese; fails_when=Chinese gets English words
  test("reads in Chinese too", async () => {
    const none = await card([["Claude Code", "claude-code"]], [], {
      language: "zh-CN",
      ready: LACKING,
    });
    expect(none.part(LACKING)?.textContent).toBe(
      "还没有文档。添加一份，你的 AI 就能为它写一篇笔记。",
    );
    expect(none.part("first-open-agent-add")?.textContent).toBe("添加文件…");
    await unmount?.();
    unmount = null;
    const unshared = await card([["Claude Code", "claude-code"]], ["Only plan"], {
      language: "zh-CN",
      share: [],
      ready: LACKING,
    });
    expect(unshared.part(LACKING)?.textContent).toBe(
      "已连接的 AI 都还读不了你的文档。请在智能体设置里共享给它们。",
    );
    expect(unshared.part("first-open-agent-settings")?.textContent).toBe("智能体设置");
  });
});

describe("the step that checks the Note the User's AI wrote", () => {
  const note = (kind: string, look: number) => ({ mindId: "note-1", state: { kind, look } });

  async function look(props: LookProps, language: "en" | "zh-CN" = "en") {
    useAppStore.setState({ settings: { language, user: {}, device: {} } } as never);
    const container = page.createElement("div", {});
    page.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AgentLook, props)));
    unmount = async () => {
      await act(() => root.unmount());
      container.remove();
    };
    return container as unknown as HTMLElement;
  }

  // protects=before a check the step offers Check on the Note, and says what shows once it is checked; pressing it runs the Note's own Check; fails_when=the step waits for the AI's marks with no way to start a check, or offers the Note instead of Check
  test("offers Check on the Note before it is checked", async () => {
    const checks: string[] = [];
    const container = await look({
      note: note("not-checked", 0),
      testId: "look",
      onCheck: () => checks.push("check"),
      onOpen: () => checks.push("open"),
    });
    expect(container.querySelector('[data-testid="look"]')?.textContent).toBe(
      "What needs a look shows here once the note is checked.",
    );
    expect(container.querySelector('[data-testid="look-open"]')).toBeNull();
    const check = container.querySelector('[data-testid="look-check"]') as HTMLElement;
    expect(check.textContent).toBe("Check");
    await act(async () => check.click());
    expect(checks).toEqual(["check"]);
  });

  // protects=the same step in Chinese; fails_when=Chinese gets English words
  test("reads in Chinese too", async () => {
    const container = await look(
      {
        note: note("not-checked", 0),
        testId: "look",
        onCheck: () => undefined,
        onOpen: () => undefined,
      },
      "zh-CN",
    );
    expect(container.querySelector('[data-testid="look"]')?.textContent).toBe(
      "笔记核对完后，需要留意的地方会显示在这里。",
    );
    expect(container.querySelector('[data-testid="look-check"]')?.textContent).toBe("核对");
  });

  // protects=once the Note is checked the step shows what the check found and offers the Note at its first mark, as before; fails_when=the result is lost or Check is offered again
  test("shows what the check found, and opens the Note", async () => {
    const opened: string[] = [];
    const container = await look({
      note: note("needs-look", 1),
      testId: "look",
      onCheck: () => opened.push("check"),
      onOpen: () => opened.push("open"),
    });
    expect(container.querySelector('[data-testid="look"]')?.textContent).toBe(
      "1 sentence needs a look.",
    );
    expect(container.querySelector('[data-testid="look-check"]')).toBeNull();
    await act(async () =>
      (container.querySelector('[data-testid="look-open"]') as HTMLElement).click(),
    );
    expect(opened).toEqual(["open"]);
  });
});
