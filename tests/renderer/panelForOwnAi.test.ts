/**
 * With no model set up and the User's own AI connected (#3612), the assistant panel is never
 * shown: nothing offers it, and every way that opened it either hands the request to that AI or
 * isn't offered. A User with a model, and one with neither a model nor an AI, keep what they had.
 * One who disconnected their AI keeps the panel out of sight, and the Note's foot says what asking
 * needs (#3764). Each test is a row of the pull request's case table.
 */
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type AgentActivity,
  type AgentPairing,
  type AskAgentInput,
  type AssistantPlace,
  type ChatReadiness,
  DEFAULT_ASSISTANT,
  type TabItem,
  type WindowLayout,
} from "../../src/core/api";

const page = new DOMParser().parseFromString(
  "<html><head></head><body></body></html>",
  "text/html",
);
Object.defineProperty(page, "styleSheets", { value: [] });
Object.defineProperty(page, "implementation", { value: { createHTMLDocument: () => page } });
const view = page.defaultView;

const MIND = "mind-ferries";
/** A second Note of the same Folder, opened beside the first. */
const OTHER = "mind-harbour";
/** A Note no connected AI may read, as the example a new User has open. */
const EXAMPLE = "mind-example";
const DOC = "doc-tariffs";
const pairing = (name: string): AgentPairing => ({
  id: `pairing-${name}`,
  name,
  folderIds: ["folder-ferries"],
  client: "claude-code",
  propose: true,
  lastUsedAt: null,
  createdAt: "2026-11-22T09:00:00.000Z",
});
const CLAUDE = pairing("Claude Code");

const bridge = {
  /** The agents that can read each Note or Document, by `${mindId}/${documentId}`. */
  readers: new Map<string, AgentPairing[]>(),
  asked: [] as AskAgentInput[],
  editWithAi: vi.fn(() => new Promise(() => undefined)),
  getConversation: vi.fn(async () => ({ messages: [] })),
  askMeetingHelp: vi.fn(async () => ({
    asked: true,
    conversation: { id: "conversation-help" },
    answerId: "answer-help",
  })),
  showMeetingPanel: vi.fn(),
  /** What the core tells the windows of each call an agent made. */
  calls: [] as ((activity: AgentActivity) => void)[],
  on: (event: string, listener: (activity: AgentActivity) => void) => {
    if (event === "agents.activity") bridge.calls.push(listener);
    return () => undefined;
  },
  listAgentsToAsk: async (mindId: string | null, documentId?: string) =>
    bridge.readers.get(`${mindId}/${documentId ?? ""}`) ?? [],
  /** Connecting the User's own AI is on: it stays on once they disconnect the last one. */
  agentsOn: false,
  getAgents: async () => ({ enabled: bridge.agentsOn, pairings: [] }),
  /** Whether the User's command-line AI runs on this computer, so a Note has its own input. */
  runsHere: false,
  ownAiRunsHere: async () => bridge.runsHere,
  askAgent: async (input: AskAgentInput) => {
    bridge.asked.push(input);
    return { kind: "copy", text: "The line" };
  },
  frontAgent: async () => false,
  listConversations: async () => [],
  listAgentRequests: async () => [],
  wallOfTurn: async () => null,
  askInConversation: async () => ({
    asked: false,
    reason: "not-ready",
    readiness: { ready: false, reason: "no-provider" },
  }),
  layout: null as WindowLayout | null,
  changeLayout: async (_window: string, change: { place: Partial<AssistantPlace> }) => {
    const layout = bridge.layout as WindowLayout;
    bridge.layout = { ...layout, assistant: { ...layout.assistant, ...change.place } };
    return bridge.layout;
  },
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
  CustomEvent: view.CustomEvent,
  Node: view.Node,
  MutationObserver: view.MutationObserver,
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "" }),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  CSS: { escape: (value: string) => value },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
vi.stubGlobal("navigator", {
  userAgent: "node",
  platform: "MacIntel",
  clipboard: { writeText: async () => undefined },
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
await import("../../src/renderer/src/commands/app");
const { commands } = await import("../../src/renderer/src/commands/registry");
const { assistantHandle, composerHandle, noteHandle } = await import(
  "../../src/renderer/src/commands/handles"
);
const { focusComposer } = await import("../../src/renderer/src/commands/assistant");
const { useAppStore } = await import("../../src/renderer/src/store");
const { useComposer } = await import("../../src/renderer/src/composer");
const { useModelSetup } = await import("../../src/renderer/src/modelSetup");
const { openConversation } = await import("../../src/renderer/src/conversations");
const { requestEdit, useEdits } = await import("../../src/renderer/src/editWithAi");
const { explainSelection } = await import("../../src/renderer/src/editor/explainSelection");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { putQuoteInComposer } = await import("../../src/renderer/src/viewer/selectionActions");
const { askGroup } = await import("../../src/renderer/src/palette");
const { askHelpInAssistant } = await import("../../src/renderer/src/meetingHelp");
const { useMeetings } = await import("../../src/renderer/src/meetings");
const {
  setUpModelInstead,
  useFoldForOwnAi,
  useHiddenForOwnAi,
  useNoAiConnected,
  useNoAiForNote,
  useOwnAiPillAt,
} = await import("../../src/renderer/src/ownAiPanel");
const { useQuietAssistant } = await import("../../src/renderer/src/quietAssistant");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const menuLinePath = "../../src/renderer/src/editor/useMenuEditLine.ts";
const {
  useMenuEditLine,
}: { useMenuEditLine: (editor: Editor, mindId: string, readOnly: boolean) => void } = await import(
  menuLinePath
);
const { AppliedEditLine, appliedLineIn } = await import(
  "../../src/renderer/src/editor/appliedEditLine"
);
const { translate } = await import("../../src/shared/i18n");
const { QUIET_AFTER_MS, useAgentAsked } = await import("../../src/renderer/src/askedAgent");

const NO_MODEL: ChatReadiness = { ready: false, reason: "no-provider" };
const MODEL = {
  ready: true,
  provider: { id: "anthropic", kind: "anthropic" },
  modelId: "claude-haiku-5-5",
  consent: "not-required",
} as unknown as ChatReadiness;

/** "disconnected": their own AI was connected, and they disconnected it (#3764). */
type Kind = "own AI" | "model" | "neither" | "disconnected";
const READINESS: Record<Kind, ChatReadiness> = {
  "own AI": NO_MODEL,
  model: MODEL,
  neither: NO_MODEL,
  disconnected: NO_MODEL,
};

/** The window of a User of `kind`, with one tab in front, as the core keeps it. */
function user(
  kind: Kind,
  { item = { kind: "mind", mindId: MIND }, assistant = DEFAULT_ASSISTANT } = {} as {
    item?: TabItem;
    assistant?: AssistantPlace;
  },
) {
  const readers = kind === "neither" || kind === "disconnected" ? [] : [CLAUDE];
  bridge.agentsOn = kind !== "neither";
  bridge.readers = new Map([
    ["null/", readers],
    [`${MIND}/`, readers],
    [`${OTHER}/`, readers],
    [`null/${DOC}`, readers],
  ]);
  bridge.layout = {
    groups: [
      {
        id: "group",
        tabs: [{ id: "tab", item, preview: false, pinned: false, place: null, opened: 0 }],
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
    chatReadiness: READINESS[kind],
    minds: [{ id: MIND, title: "Ferry report", autoTitle: "", folderId: "folder-ferries" }],
    documents: [{ id: DOC, name: "Tariffs" }],
    settings: { language: "en", user: {}, device: { gettingStarted: {} }, meetingAudio: "mic" },
    layout: bridge.layout,
  } as never);
}

let unmount: (() => Promise<void>) | null = null;
const state = {
  hidden: false,
  quiet: false,
  /** The pill at the foot of the Note `MIND`, of `OTHER`, and of `EXAMPLE`. */
  pill: null as ReturnType<typeof useOwnAiPillAt>,
  otherPill: null as ReturnType<typeof useOwnAiPillAt>,
  examplePill: null as ReturnType<typeof useOwnAiPillAt>,
  /** The Note's foot says asking needs their AI, with Connect your AI. */
  noAi: false,
  /** Nothing offers to ask: the viewer's Ask about this goes. */
  noneConnected: false,
};

/** Draws what the Workbench and the Note's foot read, so the agents are read as the window reads them. */
async function shown() {
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  const Probe = () => {
    useFoldForOwnAi();
    state.pill = useOwnAiPillAt(MIND);
    state.otherPill = useOwnAiPillAt(OTHER);
    state.examplePill = useOwnAiPillAt(EXAMPLE);
    state.hidden = useHiddenForOwnAi();
    state.quiet = useQuietAssistant();
    state.noAi = useNoAiForNote(MIND);
    state.noneConnected = useNoAiConnected();
    return null;
  };
  await act(async () => root.render(createElement(Probe)));
  await act(async () => undefined);
  await act(async () => undefined);
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  return state;
}

const SELECTED = "Fuel cost doubled over the year.";

/** A Note with one paragraph, its words selected, lent to the commands as the Note in focus. */
function selectedNote(): { editor: Editor; doc: Y.Doc } {
  const editor = new Editor({
    element: page.createElement("div", {}),
    extensions: [
      ...noteExtensions(),
      AppliedEditLine.configure({
        translate: (key, params) => translate("en", key, params),
        undoKeys: () => "⌘Z",
      }),
    ],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: SELECTED }] },
      ],
    },
  });
  editor.commands.setTextSelection({ from: 1, to: SELECTED.length + 1 });
  const doc = new Y.Doc();
  noteHandle.current = { editor, mindId: MIND, doc, place: "tab" };
  const done = unmount;
  unmount = async () => {
    await done?.();
    noteHandle.current = null;
    editor.destroy();
  };
  return { editor, doc };
}

const NO_CONTEXT = { selection: [], focus: null, surface: "mind" } as const;
const offered = (id: Parameters<typeof commands.get>[0], ctx = NO_CONTEXT) => {
  const command = commands.get(id);
  if (!command) throw new Error(`No command ${id}.`);
  return command.when?.({ ...ctx }) ?? true;
};

/** The assistant's own commands, which act on the panel; each opens or needs it. */
const PANEL_COMMANDS = [
  "assistant.dock-right",
  "assistant.dock-left",
  "assistant.dock-bottom",
  "assistant.float",
  "assistant.fold",
  "assistant.newChat",
  "assistant.history",
  "composer.addFiles",
  "answer.addToNote",
  "assistant.copyAnswer",
  "assistant.regenerateAnswer",
  "answer.useAllDocuments",
  "answer.stop",
  "assistant.writeNote",
  "assistant.clear",
  "research.start",
  "analysis.start",
  "meeting.help-open",
] as const;

beforeEach(() => {
  bridge.asked = [];
  bridge.runsHere = false;
  bridge.editWithAi.mockClear();
  bridge.getConversation.mockClear();
  bridge.showMeetingPanel.mockClear();
  assistantHandle.current = { openHistory: () => undefined };
  composerHandle.current = { addFiles: () => undefined } as never;
  useEdits.setState({ pending: {}, problems: {} });
  useModelSetup.setState({ waiting: null, wanted: false, ready: false });
  useComposer.setState({ focusWanted: false } as never);
  useAgentAsked.setState({ byKey: {} });
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
  assistantHandle.current = null;
  composerHandle.current = null;
});

describe("the panel itself", () => {
  // protects=rows 1 and 2: with only their own AI the panel is out of sight whatever place was kept, open by the User or folded, so no rail, header or menu of it shows and a window that had it open shows the Note alone; with a model, or with neither, it shows as before; fails_when=any kept place shows it to the own-AI User, or hides it from the others
  test.each([
    ["kept as it starts", DEFAULT_ASSISTANT],
    ["opened by the User before", { ...DEFAULT_ASSISTANT, folded: false, foldedBy: "user" }],
    ["folded by the User before", { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "user" }],
  ] as const)("%s", async (_kept, assistant) => {
    user("own AI", { assistant });
    expect(await shown()).toMatchObject({ hidden: true, quiet: true });
    await unmount?.();
    user("model", { assistant });
    expect(await shown()).toMatchObject({ hidden: false, quiet: false });
    await unmount?.();
    user("neither", { assistant });
    expect(await shown()).toMatchObject({ hidden: false, quiet: false });
    await unmount?.();
    user("disconnected", { assistant });
    expect(await shown()).toMatchObject({ hidden: true, quiet: true });
  });

  // protects=#3764: their AI disconnected, the panel stays out of sight, folded for it, and the Note's foot says what asking needs; a User who never connected one keeps the panel and no such line, and one connected has no such line; fails_when=the panel comes back on disconnect, or the line shows beside an AI that reads the Note
  test("their AI disconnected: no panel, and the Note's foot says what asking needs", async () => {
    user("disconnected", { assistant: { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "agent" } });
    expect(await shown()).toMatchObject({
      hidden: true,
      pill: null,
      noAi: true,
      noneConnected: true,
    });
    expect(useAppStore.getState().layout?.assistant.folded).toBe(true);
    for (const id of PANEL_COMMANDS) expect([id, offered(id)]).toEqual([id, false]);
    await unmount?.();
    user("own AI");
    expect(await shown()).toMatchObject({ noAi: false, noneConnected: false });
    await unmount?.();
    user("neither");
    expect(await shown()).toMatchObject({ hidden: false, noAi: false, noneConnected: false });
  });

  // protects=turning a model on brings the panel, its toggle and its commands back, and the fold made for their own AI goes; fails_when=the panel stays hidden, a command stays unoffered, or it stays folded for an AI the User no longer needs for it
  test("a model set up brings the panel and its toggle back", async () => {
    user("own AI");
    await shown();
    expect(offered("assistant.fold")).toBe(false);
    await act(async () => useAppStore.setState({ chatReadiness: MODEL }));
    await act(async () => undefined);
    expect(state).toMatchObject({ hidden: false, quiet: false, pill: null });
    expect(useAppStore.getState().layout?.assistant.folded).toBe(false);
    for (const id of PANEL_COMMANDS.filter((each) => each !== "meeting.help-open")) {
      expect([id, offered(id)]).toEqual([id, true]);
    }
  });
});

describe("its commands and keys", () => {
  // protects=row 3: none of the panel's commands is offered in ⌘K, a menu or its keys to the own-AI User, Research and Analysis among them; with a model each is, as before; fails_when=any is offered with the panel out of sight, or one is lost for a User with a model
  test.each(PANEL_COMMANDS)("%s", async (id) => {
    user("own AI");
    await shown();
    expect(offered(id)).toBe(false);
    await unmount?.();
    user("model");
    await shown();
    expect(offered(id)).toBe(true);
  });

  // protects=row 16: what used to put the cursor in the composer does nothing to the panel while it is out of sight; fails_when=it unfolds the panel or asks the composer for the focus
  test("the composer's focus moves nothing", async () => {
    user("own AI", { assistant: { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "agent" } });
    await shown();
    focusComposer();
    expect(useAppStore.getState().layout?.assistant.folded).toBe(true);
    expect(useComposer.getState().focusWanted).toBe(false);
  });
});

describe("⌘J", () => {
  // protects=row 4: ⌘J asks the own AI about the Note in front, or the Document in front with the question typed there, and is offered nowhere there is nothing to hand over; with neither, it opens the panel as before; fails_when=it asks nothing, asks about the wrong thing, or is offered on the Library
  test("asks about the Note, or the Document, in front", async () => {
    user("own AI");
    await shown();
    await commands.run("composer.focus");
    expect(bridge.asked).toEqual([{ pairingId: CLAUDE.id, mindId: MIND, ask: { kind: "note" } }]);
    await unmount?.();

    bridge.asked = [];
    user("own AI", { item: { kind: "document", documentId: DOC } });
    await shown();
    await commands.run("composer.focus");
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: null,
        ask: { kind: "question", text: "" },
        onScreen: [DOC],
        scope: null,
      },
    ]);
    await unmount?.();

    user("own AI", { item: { kind: "library" } });
    await shown();
    expect(offered("composer.focus")).toBe(false);
    await unmount?.();

    user("neither");
    await shown();
    expect(offered("composer.focus")).toBe(true);
  });

  // protects=a Note no connected AI may read (the example a new User has open) gives way to the Document opened beside it: ⌘J asks about that Document, and no pill floats over it (#3764); fails_when=⌘J asks nothing, as on the first run's example Note with a file opened beside it, or a pill stands over the Document
  test("a Note no AI may read beside a Document: asks about the Document", async () => {
    user("own AI");
    bridge.readers.set(`${EXAMPLE}/`, []);
    const tab = (id: string, item: TabItem) => ({
      id: `group-${id}`,
      tabs: [{ id, item, preview: false, pinned: false, place: null, opened: 0 }],
      activeTabId: id,
      width: 1,
    });
    bridge.layout = {
      ...(bridge.layout as WindowLayout),
      groups: [
        tab("example", { kind: "mind", mindId: EXAMPLE }),
        tab("file", { kind: "document", documentId: DOC }),
      ],
      focusedGroupId: "group-file",
    } as WindowLayout;
    useAppStore.setState({ layout: bridge.layout });
    expect((await shown()).examplePill).toBeNull();
    await commands.run("composer.focus");
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: null,
        ask: { kind: "question", text: "" },
        onScreen: [DOC],
        scope: null,
      },
    ]);
  });

  // protects=row 4: with words selected in the Note and no menu field to take them, ⌘J hands them to the own AI for the User to say what to do; fails_when=it asks about the whole Note or nothing
  test("with words selected in the Note, hands them over", async () => {
    user("own AI");
    await shown();
    selectedNote();
    await commands.run("composer.focus");
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: MIND,
        ask: { kind: "selection", action: "edit", text: SELECTED },
      },
    ]);
  });

  /** The Note's own input, as NoteAsk draws it, its focus watched. */
  function noteInput() {
    const input = page.createElement("textarea", {});
    input.setAttribute("data-note-ask-input", MIND);
    const focus = vi.fn();
    input.focus = focus;
    page.body.append(input);
    const done = unmount;
    unmount = async () => {
      input.remove();
      await done?.();
    };
    return focus;
  }

  // protects=#3764: with their own AI running on this computer, ⌘J puts the caret in the Note's own input, the words selected kept as its quote, and opens no other app; fails_when=it hands the words to their AI's app, or the input isn't focused
  test("a Note with its own input: the caret goes there, the words still selected", async () => {
    bridge.runsHere = true;
    user("own AI");
    await shown();
    const { editor } = selectedNote();
    const focus = noteInput();
    await commands.run("composer.focus");
    expect(focus).toHaveBeenCalledOnce();
    expect(bridge.asked).toEqual([]);
    expect(editor.state.selection.empty).toBe(false);
  });

  // protects=#3764: Edit with AI… and Translate… from ⌘K, with nothing said yet, put the caret in the Note's own input, where the User says it; fails_when=either hands the words over by a link, which opens a terminal for Claude Code
  test.each(["edit.withAi", "edit.translate"] as const)("%s with its own input", async (id) => {
    bridge.runsHere = true;
    user("own AI");
    await shown();
    selectedNote();
    const focus = noteInput();
    await commands.run(id);
    expect(focus).toHaveBeenCalledOnce();
    expect(bridge.asked).toEqual([]);
  });

  // protects=#3764: their AI disconnected, ⌘J goes to Connect your AI at the Note's foot and hands nothing over; fails_when=it opens the panel, asks an AI, or does nothing
  test("no AI of theirs reads the Note: Connect your AI takes the focus", async () => {
    user("disconnected");
    await shown();
    selectedNote();
    const foot = page.createElement("div", {});
    foot.setAttribute("data-testid", "note-foot-ask");
    foot.setAttribute("data-mind-id", MIND);
    const connect = page.createElement("button", {});
    connect.setAttribute("data-testid", "note-ask-connect");
    const focus = vi.fn();
    connect.focus = focus;
    foot.append(connect);
    page.body.append(foot);
    expect(offered("composer.focus")).toBe(true);
    await commands.run("composer.focus");
    expect(focus).toHaveBeenCalledOnce();
    expect(bridge.asked).toEqual([]);
    expect(useComposer.getState().focusWanted).toBe(false);
    foot.remove();
  });
});

// The selection menu shows none of these to a User with only their own AI (#3764): ⌘K runs them.
describe("Improve, Shorten, Translate, Edit with AI… and Explain", () => {
  const menuActions = [
    ["Improve writing", "improve", undefined, { action: "improve" }],
    ["Shorten", "shorten", undefined, { action: "shorten" }],
    [
      "Translate › Français",
      "translate",
      "French (Français)",
      { action: "translate", language: "French (Français)" },
    ],
    [
      "Edit with AI…",
      "instruction",
      "Say it as the board would.",
      { action: "edit", instruction: "Say it as the board would." },
    ],
  ] as const;

  // protects=row 5: each action hands the own AI the selected words and the task, asks no model, and closes the menu over the words as an edit does; fails_when=a model is asked, the words or the task are lost, or the selection stays
  test.each(menuActions)("%s", async (_label, action, instruction, asked) => {
    user("own AI");
    await shown();
    const { editor, doc } = selectedNote();
    await requestEdit(editor, MIND, doc, action, instruction, undefined, "menu");
    expect(bridge.asked).toEqual([
      { pairingId: CLAUDE.id, mindId: MIND, ask: { kind: "selection", text: SELECTED, ...asked } },
    ]);
    expect(bridge.editWithAi).not.toHaveBeenCalled();
    expect(editor.state.selection.empty).toBe(true);
    expect(useEdits.getState().problems[MIND]).toBeUndefined();
  });

  // protects=row 5: Explain asks the own AI to explain the words in its reply, opens nothing in IncarnaMind and closes the selection as a change handed over does, so selecting the words again opens the menu; with neither, it waits in the panel for a model as before; fails_when=the panel is asked to answer, the own AI isn't asked, or the words stay selected under a menu kept closed
  test("Explain", async () => {
    user("own AI");
    await shown();
    const { editor, doc } = selectedNote();
    expect(await explainSelection(editor, MIND, doc)).toBe(true);
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: MIND,
        ask: { kind: "selection", action: "explain", text: SELECTED },
      },
    ]);
    expect(editor.state.selection.empty).toBe(true);
    expect(useModelSetup.getState().waiting).toBeNull();
    await unmount?.();

    user("neither");
    await shown();
    const asked = selectedNote();
    expect(await explainSelection(asked.editor, MIND, asked.doc)).toBe(true);
    expect(bridge.asked).toHaveLength(1);
    expect(useModelSetup.getState().waiting?.text).toBe(`Explain “${SELECTED}”`);
  });

  // protects=row 5: with no AI of theirs that reads the Note, each action leaves one line saying what it needs where the menu was, with Set up, as a Check does; fails_when=it asks an AI that can't read the Note, or says nothing
  test.each([
    ...menuActions.map(([label, action, instruction]) => [label, action, instruction] as const),
    ["Explain", "explain", undefined] as const,
  ])(
    "%s with no AI that reads the Note says what it needs",
    async (_label, action, instruction) => {
      user("own AI");
      await shown();
      bridge.readers.set(`${MIND}/`, []);
      const { editor, doc } = selectedNote();
      if (action === "explain") await explainSelection(editor, MIND, doc);
      else await requestEdit(editor, MIND, doc, action, instruction, undefined, "menu");
      expect(bridge.asked).toEqual([]);
      expect(useEdits.getState().problems[MIND]).toMatchObject({
        kind: "not-ready",
        readiness: NO_MODEL,
        menu: { blockId: "p1" },
      });
    },
  );

  // protects=row 5: with a model, each action asks the model as before and no own AI; fails_when=a User with a model is sent to their own AI
  test("with a model, as before", async () => {
    user("model");
    await shown();
    const { editor, doc } = selectedNote();
    void requestEdit(editor, MIND, doc, "improve", undefined, undefined, "menu");
    await act(async () => undefined);
    expect(bridge.editWithAi).toHaveBeenCalledOnce();
    expect(bridge.asked).toEqual([]);
  });

  // protects=row 6: ⌘K's Translate… and Edit with AI… hand the words over with the language or the change left to the User's message, where they used to type it in the composer; fails_when=the composer is asked for, or nothing is handed over
  test.each([
    ["edit.translate", { action: "translate" }],
    ["edit.withAi", { action: "edit" }],
  ] as const)("%s from ⌘K", async (id, asked) => {
    user("own AI");
    await shown();
    selectedNote();
    await commands.run(id);
    expect(bridge.asked).toEqual([
      { pairingId: CLAUDE.id, mindId: MIND, ask: { kind: "selection", text: SELECTED, ...asked } },
    ]);
    expect(useComposer.getState().focusWanted).toBe(false);
  });
});

describe("a Note's Ask", () => {
  // protects=row 7: each Note an own AI can read has the pill at its own foot, asking about that Note, two Notes side by side each their own, whichever is in focus (#3764); a Note no AI reads has none; with a model none shows; fails_when=a Note on screen gets no pill, a pill asks about another Note, or one shows with a model
  test("each Note on screen has its own pill", async () => {
    const group = (id: string) => ({
      id: `group-${id}`,
      tabs: [
        {
          id,
          item: { kind: "mind", mindId: id },
          preview: false,
          pinned: false,
          place: null,
          opened: 0,
        },
      ],
      activeTabId: id,
      width: 1,
    });
    const sideBySide = () => {
      bridge.layout = {
        ...(bridge.layout as WindowLayout),
        groups: [group(MIND), group(OTHER)],
        focusedGroupId: `group-${OTHER}`,
      } as WindowLayout;
      useAppStore.setState({ layout: bridge.layout });
    };
    user("own AI");
    sideBySide();
    expect(await shown()).toMatchObject({
      pill: { mindId: MIND, documentId: null, agents: [CLAUDE] },
      otherPill: { mindId: OTHER, documentId: null, agents: [CLAUDE] },
      examplePill: null,
    });
    await unmount?.();
    user("model");
    sideBySide();
    expect(await shown()).toMatchObject({ pill: null, otherPill: null, examplePill: null });
  });

  // protects=row 8: "Use a model in IncarnaMind…" opens Settings › AI and never the panel; fails_when=the panel is unfolded on its setup card
  test("Use a model in IncarnaMind… opens Settings › AI at the model (#3645)", async () => {
    user("own AI", { assistant: { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "agent" } });
    await shown();
    const openSettings = vi.fn();
    useAppStore.setState({ openSettings } as never);
    setUpModelInstead();
    expect(openSettings).toHaveBeenCalledWith("ai", "model");
    expect(useAppStore.getState().layout?.assistant.folded).toBe(true);
    expect(useModelSetup.getState().wanted).toBe(false);
  });
});

describe("asking from elsewhere", () => {
  // protects=row 11, #3764: with only their own AI, connected or disconnected, ⌘K has no Ask row: the Note's own input is the one place to ask; with a model, or with neither, the row asks in the panel as before; fails_when=⌘K offers a second way to ask, or loses the row where the panel is
  test("⌘K's typed Ask", async () => {
    const rows = () =>
      askGroup("What did fuel cost?", "New chat", (key, params) => translate("en", key, params));
    for (const kind of ["own AI", "disconnected", "model", "neither"] as const) {
      await unmount?.();
      unmount = null;
      user(kind);
      await shown();
      const names = rows().flatMap((group) => group.items.map((item) => item.name));
      const asks = kind === "model" || kind === "neither";
      expect([kind, names]).toEqual([kind, asks ? ["Ask “What did fuel cost?”"] : []]);
    }
  });

  // protects=row 12: Ask about this Document or Folder asks the own AI with them named and the question left to the User; fails_when=it waits in the panel, or names something else
  test("Ask about this Document, and this Folder", async () => {
    user("own AI", { item: { kind: "library" } });
    useAppStore.setState({
      library: {
        groups: [{ id: "folder-ferries", name: "Ferries", parentId: null }],
        assignments: [{ documentId: DOC, groupId: "folder-ferries" }],
      },
    } as never);
    await shown();
    await commands.run("document.ask", {
      selection: [{ kind: "document", id: DOC }],
      focus: null,
      surface: "library",
    });
    await commands.run("folder.ask", {
      selection: [{ kind: "folder", id: "folder-ferries" }],
      focus: null,
      surface: "library",
    });
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: null,
        ask: { kind: "question", text: "" },
        onScreen: [DOC],
        scope: null,
      },
      {
        pairingId: CLAUDE.id,
        mindId: null,
        ask: { kind: "question", text: "" },
        onScreen: [],
        scope: { folderIds: ["folder-ferries"], tagIds: [], documentIds: [] },
      },
    ]);
  });

  // protects=row 13: words picked in a Document go to the own AI with the Document and their page, and no chip waits in the panel; a pick with no words names the Document alone; with a model the chip waits as before; fails_when=the words go to the composer out of sight, or lose their Document or page
  test("the viewer's Ask about this", async () => {
    user("own AI", { item: { kind: "document", documentId: DOC } });
    await shown();
    const pick = {
      documentId: DOC,
      documentName: "Tariffs",
      quote: "A return fare costs 14 pounds.",
      pageFrom: 3,
      pageTo: 3,
      location: null,
    };
    expect(putQuoteInComposer(pick)).toBeNull();
    expect(putQuoteInComposer({ ...pick, quote: "" })).toBeNull();
    await act(async () => undefined);
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: null,
        ask: {
          kind: "selection",
          action: "ask",
          text: pick.quote,
          documentId: DOC,
          pageFrom: 3,
          pageTo: 3,
          location: null,
        },
      },
      {
        pairingId: CLAUDE.id,
        mindId: null,
        ask: { kind: "question", text: "" },
        onScreen: [DOC],
        scope: null,
      },
    ]);
    await unmount?.();

    user("model", { item: { kind: "document", documentId: DOC } });
    await shown();
    expect(putQuoteInComposer(pick)).toEqual(pick);
    expect(bridge.asked).toHaveLength(2);
  });

  // protects=row 14: a Conversation the User already has opens to be read, the one time the panel shows, until they fold it; fails_when=their own history can't be read, or the panel stays after they fold it
  test("a Conversation they have opens to be read, until they fold the panel", async () => {
    user("own AI", { assistant: { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "agent" } });
    await shown();
    expect(await openConversation("conversation-old")).toBe(true);
    await act(async () => undefined);
    expect(state.hidden).toBe(false);
    expect(useAppStore.getState().layout?.assistant.folded).toBe(false);
    expect(offered("assistant.fold")).toBe(true);
    await act(async () => useAppStore.getState().placeAssistant({ folded: true }));
    expect(state.hidden).toBe(true);
    expect(offered("assistant.fold")).toBe(false);
  });

  // protects=row 14: while a Conversation is read in the panel, the selection menu's actions still go to their AI and the panel's own features stay unoffered: the reading only shows the panel; fails_when=an action asks the model that isn't set up, or Research or Analysis is offered
  test("reading a Conversation changes where nothing goes", async () => {
    user("own AI", { assistant: { ...DEFAULT_ASSISTANT, folded: true, foldedBy: "agent" } });
    await shown();
    await openConversation("conversation-old");
    await act(async () => undefined);
    expect(state.hidden).toBe(false);
    const { editor, doc } = selectedNote();
    await requestEdit(editor, MIND, doc, "shorten", undefined, undefined, "menu");
    expect(bridge.asked).toEqual([
      {
        pairingId: CLAUDE.id,
        mindId: MIND,
        ask: { kind: "selection", action: "shorten", text: SELECTED },
      },
    ]);
    expect(bridge.editWithAi).not.toHaveBeenCalled();
    expect(offered("research.start")).toBe(false);
    expect(offered("analysis.start")).toBe(false);
    await act(async () => useAppStore.getState().placeAssistant({ folded: true }));
  });

  // protects=row 15: call help asked with only their own AI is read in the floating panel, which shows, and the assistant opens no Conversation for it; fails_when=the help opens the panel, or its answer has nowhere to show
  test("call help stays in the floating panel", async () => {
    user("own AI");
    await shown();
    useMeetings.setState({
      meetings: [{ id: "meeting", mindId: MIND, kind: "meeting", status: "recording" }],
    } as never);
    await askHelpInAssistant("sum");
    expect(bridge.askMeetingHelp).toHaveBeenCalledOnce();
    expect(bridge.showMeetingPanel).toHaveBeenCalledWith(true);
    expect(bridge.getConversation).not.toHaveBeenCalled();
    useMeetings.setState({ meetings: [] } as never);
  });
});

describe("the line about words handed over (#3612)", () => {
  let calls = 0;
  /** A call Claude Code made about the Note, as the core tells the windows once it is recorded. */
  const called = async (tool: AgentActivity["tool"]) => {
    calls += 1;
    const activity: AgentActivity = {
      id: `call-${calls}`,
      pairingId: CLAUDE.id,
      tool,
      summary: "",
      outcome: "done",
      problem: null,
      count: null,
      request: null,
      documentIds: [],
      effects: [{ action: "read", scope: { kind: "mind", mindId: MIND } }],
      durationMs: 10,
      at: new Date(Date.now() + 1000).toISOString(),
    };
    await act(async () => {
      for (const listener of bridge.calls) listener(activity);
    });
  };

  /** The Note's editor with its menu line drawn, as MindEditor draws it. */
  async function withLine() {
    user("own AI");
    await shown();
    const note = selectedNote();
    const container = page.createElement("div", {});
    page.body.append(container);
    const root = createRoot(container);
    const Line = () => {
      useMenuEditLine(note.editor, MIND, false);
      return null;
    };
    await act(async () => root.render(createElement(Line)));
    const done = unmount;
    unmount = async () => {
      await act(() => root.unmount());
      container.remove();
      await done?.();
    };
    return note;
  }

  const lineNow = (editor: Editor) => {
    const line = appliedLineIn(editor.state);
    return line?.kind === "failed" && line.asked ? line : null;
  };

  // protects=after a change is handed over, the line where it will land says it was asked, then that the AI is at work once its first call about the Note comes, and goes when its change arrives; it offers Continue in the open chat and ✕ only; fails_when=the line outlives the change, offers anything else, or says nothing
  test("a change: asked, working, gone when it lands", async () => {
    const { editor, doc } = await withLine();
    await act(() => requestEdit(editor, MIND, doc, "shorten", undefined, undefined, "menu"));
    expect(lineNow(editor)).toMatchObject({
      blockId: "p1",
      text: "Copied for Claude Code: paste the request there and send it.",
      action: { label: "Continue in the open chat" },
    });
    await called("read_request");
    expect(lineNow(editor)?.text).toBe("Changing the words you selected in Claude Code.");
    await called("propose_changes");
    expect(lineNow(editor)).toBeNull();
  });

  // protects=Explain lands nothing in the Note: its line goes at that connection's first call about the Note, which has the words, since the answer comes in its own app; fails_when=it waits for a change that never comes
  test("Explain: gone at the first call about the Note", async () => {
    const { editor, doc } = await withLine();
    await act(async () => {
      await explainSelection(editor, MIND, doc);
    });
    expect(lineNow(editor)?.text).toBe(
      "Copied for Claude Code: paste the request there and send it.",
    );
    await called("read_request");
    expect(lineNow(editor)).toBeNull();
  });

  // protects=with nothing from the AI for the quiet time the line says so, Continue in the open chat copies the same words for the chat the User has open, and ✕ takes the line away; fails_when=the line stays as asked forever, Continue asks something else, or ✕ leaves it
  test("quiet, Continue in the open chat, and ✕", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { editor, doc } = await withLine();
      await act(() => requestEdit(editor, MIND, doc, "improve", undefined, undefined, "menu"));
      await act(async () => vi.advanceTimersByTime(QUIET_AFTER_MS + 1));
      expect(lineNow(editor)?.text).toBe(
        "Nothing from Claude Code yet. Send the request, or ask again.",
      );
      lineNow(editor)?.action?.run();
      await act(async () => undefined);
      expect(bridge.asked.at(-1)).toEqual({
        pairingId: CLAUDE.id,
        mindId: MIND,
        ask: { kind: "selection", action: "improve", text: SELECTED },
        openChat: true,
      });
      await act(async () => lineNow(editor)?.close());
      expect(lineNow(editor)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
