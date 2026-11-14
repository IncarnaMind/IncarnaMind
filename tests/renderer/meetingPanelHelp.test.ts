import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConversationAnswer,
  ConversationMessage,
  Meeting,
  MeetingHelp,
  MeetingHelpKind,
} from "../../src/core/api";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { MEETING_PANEL_BRIDGE_KEY } from "../../src/shared/meetingPanel";

/**
 * The floating panel's latest suggestion, on a core that answers when the test says: a press's
 * reply, the Meeting's new help, a load of the help conversation and each write of an Answer
 * come in the order each test gives them, as they can from the app (#3005).
 */
const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    asks: [] as { kind: string; resolve(answerId: string): void }[],
    loads: [] as ((messages: unknown[]) => void)[],
    added: [] as string[],
    /** Add to note's outcome: the Blocks it adds, or why it fails, once the test says. */
    adding: null as null | { resolve(): void; reject(error: Error): void },
    holdAdding: false,
    reported: [] as unknown[],
    command: null as null | ((command: string) => void),
    /** What the panel asked of the keyboard, in order: true takes it, false gives it back (#2925). */
    keyboard: [] as boolean[],
    /** What the panel told its window of itself: folded, and whether its latest is pinned. */
    states: [] as unknown[],
    /** The unsent line the core holds for the Meeting, as a panel opening asks for it (#2925). */
    held: null as null | { text: string; atMs: number | null },
    /** The conversations Open in assistant asked the app's window for (#2925). */
    opened: [] as unknown[],
    language: "en" as "en" | "zh-CN",
    emit(name: string, payload: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
});

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on(name: string, listener: (payload: unknown) => void) {
      const set = fake.listeners.get(name) ?? new Set();
      fake.listeners.set(name, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    askMeetingHelp: ({ kind }: { kind: string }) =>
      new Promise((resolve) =>
        fake.asks.push({
          kind,
          resolve: (answerId) =>
            resolve({ asked: true, conversation: { id: "help-chat" }, answerId }),
        }),
      ),
    askMeetingQuestion: ({ text }: { text: string }) =>
      new Promise((resolve) =>
        fake.asks.push({
          kind: `question: ${text}`,
          resolve: (answerId) =>
            resolve({ asked: true, conversation: { id: "help-chat" }, answerId }),
        }),
      ),
    getConversation: () =>
      new Promise((resolve) => fake.loads.push((messages) => resolve({ messages }))),
    addToNote: ({ blocks }: { blocks: unknown[] }) => {
      fake.added.push(JSON.stringify(blocks));
      if (!fake.holdAdding) return Promise.resolve({ blockIds: ["block-1"] });
      return new Promise((resolve, reject) => {
        fake.adding = { resolve: () => resolve({ blockIds: ["block-1"] }), reject };
      });
    },
    undoAddToNote: () => Promise.resolve(),
    setQuickNoteDraft: () => Promise.resolve(),
    getQuickNoteDraft: () => Promise.resolve(fake.held),
  },
  files: { onMenuCommand: () => () => undefined, setEditMenu: () => undefined },
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) => translate(fake.language, key, params),
  translateNow: (key: MessageKey, params?: MessageParams) => translate(fake.language, key, params),
  useLanguage: () => fake.language,
}));
vi.mock("../../src/renderer/src/store", async () => {
  const { create } = await import("zustand");
  return {
    useAppStore: create(() => ({
      settings: null,
      reportError: (error: unknown) => {
        fake.reported.push(error);
      },
    })),
  };
});
vi.mock("../../src/renderer/src/conversations", async () => {
  const { create } = await import("zustand");
  return {
    noMoveSinceAsked: () => () => true,
    openConversation: () => Promise.resolve(),
    useConversations: create(() => ({ openId: null })),
  };
});
vi.mock("../../src/renderer/src/answers", async () => {
  const { create } = await import("zustand");
  return { useAnswers: create(() => ({ models: null, loadModels: () => undefined })) };
});
vi.mock("../../src/renderer/src/modelNames", () => ({
  useModelNames: () => () => ({ name: "" }),
  useServiceName: () => "",
}));
vi.mock("../../src/renderer/src/motion", () => ({ exit: () => undefined }));
vi.mock("../../src/renderer/src/components/meetings/LevelBars", () => ({ LevelBars: () => null }));
vi.mock("../../src/renderer/src/components/meetings/MicrophoneButton", () => ({
  MicrophoneButton: () => null,
}));
vi.mock("../../src/renderer/src/components/providers/ChatReadinessNotice", () => ({
  ReadinessExplanation: () => null,
}));

const panelBridge = {
  keys: () => Promise.resolve({}),
  onKeys: () => () => undefined,
  onHelp: () => () => undefined,
  onCommand: (listener: (command: string) => void) => {
    fake.command = listener;
    return () => undefined;
  },
  resize: () => undefined,
  state: (value: unknown) => {
    fake.states.push(value);
  },
  close: () => undefined,
  setUp: () => undefined,
  openInAssistant: (at: unknown) => fake.opened.push(at),
  keyboard: (take: boolean) => fake.keyboard.push(take),
};

const WANT =
  "★ They want the rollout finished before their June audit\n6:00 “before our audit in June” [^1]\n→ Confirm the June date first";
const SUM = "- Their audit is in June\n- They asked for a fixed monthly price";

const helpOf = (kind: MeetingHelpKind, answerId: string): MeetingHelp => ({
  kind,
  question: null,
  conversationId: "help-chat",
  answerId,
  heard: null,
  atMs: 60_000,
});

/** The Meeting's help so far, oldest first, as the core keeps it while it records. */
const asked: MeetingHelp[] = [];

const meetingWith = (help: MeetingHelp | null) => {
  if (help && !asked.some((each) => each.answerId === help.answerId)) asked.push(help);
  return meetingOf(help, help ? [...asked] : []);
};

const meetingOf = (help: MeetingHelp | null, helps: MeetingHelp[]) =>
  ({
    id: "meeting-1",
    mindId: "note-1",
    kind: "meeting",
    status: "recording",
    sources: { microphone: "on", system: "off" },
    recordedMs: 61_000,
    recordingSince: null,
    microphonePausedAtMs: null,
    help,
    helps,
    helpTemplate: null,
  }) as unknown as Meeting;

/** What they said at 6:00, the reading's quoted words found there: its moment shows ✓. */
const SAID = {
  marker: 1,
  passageId: "call-1",
  documentId: "transcript",
  documentName: "Transcript · Northwind call",
  quote: "We need it all live before our audit in June.",
  location: { kind: "time", from: 360_000, to: 364_000, speaker: "Them" },
  check: "found",
  checkReason: null,
  quotedWordsFound: ["before our audit in June"],
};

const answerOf = (
  id: string,
  text: string,
  status: ConversationAnswer["status"],
): ConversationAnswer =>
  ({
    kind: "answer",
    id,
    conversationId: "help-chat",
    questionId: `question-${id}`,
    text,
    citations: text.includes("[^1]") ? [SAID] : [],
    figures: [],
    analyses: [],
    model: null,
    status,
    errorKind: null,
    errorMessage: null,
  }) as unknown as ConversationAnswer;

let root: Root | null = null;
let container: HTMLElement;
let MeetingPanel: ComponentType;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  Object.assign(window, {
    [MEETING_PANEL_BRIDGE_KEY]: panelBridge,
    screen: { availHeight: 900 },
  });
  for (const [name, value] of Object.entries({
    document,
    window,
    navigator: { platform: "MacIntel" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  fake.asks.length = 0;
  fake.loads.length = 0;
  fake.added.length = 0;
  fake.adding = null;
  fake.holdAdding = false;
  fake.reported.length = 0;
  fake.keyboard.length = 0;
  fake.states.length = 0;
  fake.held = null;
  fake.opened.length = 0;
  asked.length = 0;
  fake.language = "en";
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const panelPath = "../../src/renderer/src/meetingPanel/MeetingPanel";
  ({ MeetingPanel } = await import(panelPath));
  const helpPath = "../../src/renderer/src/meetingHelp";
  const { useMeetingHelp } = await import(helpPath);
  useMeetingHelp.setState({ pending: {}, blocked: {} });
  const meetingsPath = "../../src/renderer/src/meetings";
  const { useMeetings } = await import(meetingsPath);
  useMeetings.setState({ meetings: [] });
  await act(async () => root?.render(createElement(MeetingPanel)));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const run = (step: () => void) =>
  act(async () => {
    step();
  });
const changed = (help: MeetingHelp | null) =>
  run(() => fake.emit("meetings.changed", [meetingWith(help)]));
const written = (message: ConversationMessage) =>
  run(() => fake.emit("conversation.message", message));
const replied = (ask: number, answerId: string) => run(() => fake.asks[ask]?.resolve(answerId));
/** Every load of the help conversation still out comes back, in the order they were asked. */
const loaded = (messages: ConversationMessage[]) =>
  run(() => {
    for (const load of fake.loads.splice(0)) load(messages);
  });

const all = (testId: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));

async function click(element: Element | undefined) {
  if (!element) throw new Error("Nothing to click.");
  await run(() => element.dispatchEvent(new window.Event("click", { bubbles: true })));
}

/** Presses a prompt of the ask bar: in the bar, or under More…. */
async function press(kind: MeetingHelpKind) {
  const inBar = container.querySelector(`[data-testid="ask-bar"] > [data-kind="${kind}"]`);
  if (inBar) return click(inBar);
  await click(all("help-more")[0]);
  await click(
    container.querySelector(`[data-testid="help-more-list"] [data-kind="${kind}"]`) ?? undefined,
  );
}

/** What the latest suggestion shows: its heading, its outline, its text, and what it offers. */
const shown = () => ({
  heading: all("help-heading").at(-1)?.textContent ?? "",
  outline: all("help-outline").length > 0,
  text: all("help-option")
    .map((each) => each.textContent ?? "")
    .join(" | "),
  pin: all("help-pin").length > 0,
  add: all("help-add").length > 0,
  added: all("help-added").length > 0,
  checks: all("help-quote-found").length,
});

/** The panel between a press of Sum up so far and its reply's first words. */
const sumOutline = {
  heading: "Sum up so far",
  outline: true,
  text: "",
  pin: false,
  add: false,
  added: false,
  checks: 0,
};

/** Add to note, which reads the help conversation once more before it adds. */
async function addToNote(messages: ConversationMessage[]) {
  await click(all("help-add")[0]);
  await loaded(messages);
}

async function wantShown() {
  await changed(null);
  await press("want");
  await replied(0, "answer-want");
  await changed(helpOf("want", "answer-want"));
  await loaded([answerOf("answer-want", WANT, "done")]);
  expect(shown()).toMatchObject({
    heading: expect.stringContaining("What do they want?"),
    text: expect.stringContaining("before their June audit"),
    pin: true,
    add: true,
    checks: 1,
  });
}

describe("a second prompt pressed after a finished first one", () => {
  // protects=#3005: from a press until its own reply starts, the panel shows that prompt's heading and outline, never the reply before or what it offers; fails_when=the reply to the press clears its outline while the Meeting's help is still the one before, or a load begun for that help writes its Answer under the new heading; no_claim=how soon the reply starts.
  test.each([
    ["the press's reply", "before"],
    ["the Meeting's new help", "after"],
  ] as const)(
    "shows its own heading and outline until its reply starts, with %s arriving first",
    async (_first, reply) => {
      await wantShown();
      await press("sum");
      expect(shown()).toEqual(sumOutline);
      const steps =
        reply === "before"
          ? [() => replied(1, "answer-sum"), () => changed(helpOf("sum", "answer-sum"))]
          : [() => changed(helpOf("sum", "answer-sum")), () => replied(1, "answer-sum")];
      for (const step of steps) {
        await step();
        expect(shown()).toEqual(sumOutline);
      }
      await loaded([
        answerOf("answer-want", WANT, "done"),
        answerOf("answer-sum", "", "streaming"),
      ]);
      expect(shown()).toEqual(sumOutline);

      await written(answerOf("answer-sum", "- Their audit is in June\n- They", "streaming"));
      expect(shown()).toMatchObject({
        heading: "Sum up so far",
        text: expect.stringContaining("Their audit is in June"),
        pin: false,
        add: false,
        checks: 0,
      });
      await written(answerOf("answer-sum", SUM, "done"));
      expect(shown()).toMatchObject({
        heading: "Sum up so far",
        text: "Their audit is in June | They asked for a fixed monthly price",
        pin: true,
        add: true,
        checks: 0,
      });
      await addToNote([answerOf("answer-want", WANT, "done"), answerOf("answer-sum", SUM, "done")]);
      expect(fake.added).toHaveLength(1);
      expect(fake.added[0]).toContain("fixed monthly price");
      expect(fake.added[0]).not.toContain("June audit");
    },
  );

  test("pressed while another prompt is still being asked, shows its own heading until its own reply starts", async () => {
    await wantShown();
    await press("say");
    await press("sum");
    expect(shown()).toEqual(sumOutline);
    await replied(1, "answer-say");
    await changed(helpOf("say", "answer-say"));
    expect(shown()).toEqual(sumOutline);
    await replied(2, "answer-sum");
    expect(shown()).toEqual(sumOutline);
    await changed(helpOf("sum", "answer-sum"));
    await loaded([answerOf("answer-sum", "", "streaming")]);
    expect(shown()).toEqual(sumOutline);
    await written(answerOf("answer-sum", SUM, "done"));
    expect(shown()).toMatchObject({
      heading: "Sum up so far",
      text: "Their audit is in June | They asked for a fixed monthly price",
      pin: true,
    });
  });

  test("keeps a pinned suggestion shown while it waits, and Pin from ⌘K then changes nothing", async () => {
    const headings = () => all("help-heading").map((each) => each.textContent ?? "");
    await wantShown();
    await click(all("help-pin")[0]);
    await press("sum");
    await loaded([answerOf("answer-want", WANT, "done")]);
    expect(headings()).toEqual([expect.stringContaining("What do they want?"), "Sum up so far"]);
    await run(() => fake.command?.("pin"));
    expect(headings()).toEqual([expect.stringContaining("What do they want?"), "Sum up so far"]);
    expect(all("help-pin").map((each) => each.getAttribute("aria-pressed"))).toEqual(["true"]);
  });
});

describe("a press whose Meeting stops before its reply", () => {
  // protects=#3005: holding a press's outline for its help never outlives the Meeting; fails_when=a press answered after Stop keeps waiting for a help that never comes; no_claim=what Stop shows.
  test.each([
    ["before the reply", "stop"],
    ["after the reply, before the Meeting's new help", "reply"],
  ] as const)("leaves nothing waiting, stopped %s", async (_when, first) => {
    const { useMeetingHelp } = await import("../../src/renderer/src/meetingHelp");
    const stop = () =>
      run(() => fake.emit("meetings.changed", [{ ...meetingWith(null), status: "ready" }]));
    const want = { kind: "want", question: null };
    await changed(null);
    await press("want");
    expect(useMeetingHelp.getState().pending).toEqual({ "meeting-1": want });
    if (first === "stop") {
      await stop();
      await replied(0, "answer-want");
    } else {
      await replied(0, "answer-want");
      expect(useMeetingHelp.getState().pending).toEqual({ "meeting-1": want });
      await stop();
    }
    expect(useMeetingHelp.getState().pending).toEqual({});
  });
});

describe("a help asked in the app's window while the panel shows", () => {
  // protects=#3005: a help that replaces the panel's with no press there shows only its own Answer and offers only its own Pin and Add to note; fails_when=the suggestion keeps the Answer, or the Added line and its Undo, of the help before; no_claim=the press's outline, which only a press in the panel draws.
  test("replaces the suggestion whole, even while the panel still loads the one before", async () => {
    await changed(helpOf("want", "answer-want"));
    expect(fake.loads).toHaveLength(1);
    await changed(helpOf("sum", "answer-sum"));
    await loaded([answerOf("answer-want", WANT, "done"), answerOf("answer-sum", "", "streaming")]);
    expect(shown()).toEqual(sumOutline);
  });

  test("after Add to note on the one before, offers its own Add to note, not the Added line and Undo", async () => {
    await wantShown();
    await addToNote([answerOf("answer-want", WANT, "done")]);
    expect(shown()).toMatchObject({ added: true, add: false });
    await changed(helpOf("sum", "answer-sum"));
    await loaded([answerOf("answer-sum", SUM, "done")]);
    expect(shown()).toMatchObject({
      heading: "Sum up so far",
      text: "Their audit is in June | They asked for a fixed monthly price",
      added: false,
      add: true,
      checks: 0,
    });
  });
});

describe("an Add to note still on its way when the suggestion is replaced", () => {
  // protects=#3005: replacing the suggestion never loses why its Add to note failed (AGENTS.md rule 6); fails_when=the failure lands on a suggestion no longer shown and is dropped; no_claim=where the app shows it.
  test("still reports its failure", async () => {
    await wantShown();
    fake.holdAdding = true;
    await addToNote([answerOf("answer-want", WANT, "done")]);
    await changed(helpOf("sum", "answer-sum"));
    await run(() => fake.adding?.reject(new Error("The note can't be changed now.")));
    expect(fake.reported).toEqual([new Error("The note can't be changed now.")]);
  });
});

describe("a help's Answer, as the panel reads it", () => {
  // protects=#3005: the hook gives a help's own Answer only, so whatever shows it can't pair a heading with the reply before; fails_when=it hands out the Answer it held for the help before, for one render or from a load begun for that help; no_claim=when the Answer comes.
  test("is never the Answer of the help before, not for a render nor from that help's load", async () => {
    const hookPath = "../../src/renderer/src/components/meetings/HelpSuggestion";
    const { useHelpAnswer }: { useHelpAnswer(help: MeetingHelp): ConversationAnswer | null } =
      await import(hookPath);
    const seen: string[] = [];
    function Probe({ help }: { help: MeetingHelp }) {
      seen.push(`${help.answerId} shows ${useHelpAnswer(help)?.id ?? "none"}`);
      return null;
    }
    const show = (help: MeetingHelp) => run(() => root?.render(createElement(Probe, { help })));
    await show(helpOf("want", "answer-want"));
    await loaded([answerOf("answer-want", WANT, "done")]);
    expect(seen.at(-1)).toBe("answer-want shows answer-want");

    await show(helpOf("sum", "answer-sum"));
    await show(helpOf("no", "answer-no"));
    await loaded([
      answerOf("answer-want", WANT, "done"),
      answerOf("answer-sum", SUM, "done"),
      answerOf("answer-no", "", "streaming"),
    ]);
    expect(seen.filter((each) => !each.startsWith("answer-want"))).toEqual(
      expect.arrayContaining(["answer-no shows answer-no"]),
    );
    expect(
      seen.filter((each) => {
        const [help, , answer] = each.split(" ");
        return help !== "answer-want" && answer !== "none" && answer !== help;
      }),
    ).toEqual([]);
  });

  test("keeps what its own Answer has written: a late load, of the help before or its own older one, takes nothing back", async () => {
    const hookPath = "../../src/renderer/src/components/meetings/HelpSuggestion";
    const { useHelpAnswer }: { useHelpAnswer(help: MeetingHelp): ConversationAnswer | null } =
      await import(hookPath);
    let shownText: string | null = null;
    function Probe({ help }: { help: MeetingHelp }) {
      shownText = useHelpAnswer(help)?.text ?? null;
      return null;
    }
    const show = (help: MeetingHelp) => run(() => root?.render(createElement(Probe, { help })));
    await show(helpOf("want", "answer-want"));
    await show(helpOf("sum", "answer-sum"));
    const [wantLoad, sumLoad] = fake.loads;
    await written(answerOf("answer-sum", "- Their audit is in June", "streaming"));
    const older = [answerOf("answer-want", WANT, "done"), answerOf("answer-sum", "", "streaming")];
    await run(() => wantLoad?.(older));
    expect(shownText).toBe("- Their audit is in June");
    await run(() => sumLoad?.(older));
    expect(shownText).toBe("- Their audit is in June");
  });
});

describe("the keyboard (#2925)", () => {
  /** A key that reaches the panel's window, as a browser sends one nothing in the page used. */
  const key = (name: string) =>
    run(() =>
      window.dispatchEvent(
        Object.assign(new window.Event("keydown", { cancelable: true }), { key: name }),
      ),
    );

  test("the panel never asks for it by itself: not as it appears, nor as help is asked and its answer arrives, nor on a click on a prompt, More… or a button", async () => {
    await changed(null);
    await press("say");
    await replied(0, "answer-say");
    await changed(helpOf("say", "answer-say"));
    await loaded([answerOf("answer-say", WANT, "done")]);
    expect(shown().pin).toBe(true);
    await click(all("help-pin")[0]);
    await press("sum");
    await click(all("quick-note-send")[0]);
    expect(fake.keyboard).toEqual([]);
  });

  test("⌃⌥N or ⌘K's Quick note on a collapsed panel opens it and asks for it once; Esc and collapsing give it back", async () => {
    await changed(null);
    await click(all("panel-collapse")[0]);
    expect(all("panel-pill")).toHaveLength(1);
    // Collapsing gives the keyboard back whether or not the field had it: the main process ignores a panel that hasn't it.
    expect(fake.keyboard).toEqual([false]);

    await run(() => fake.command?.("note"));
    expect(all("quick-note-field")).toHaveLength(1);
    expect(fake.keyboard).toEqual([false, true]);

    await key("Escape");
    expect(fake.keyboard).toEqual([false, true, false]);
    await click(all("panel-collapse")[0]);
    expect(fake.keyboard).toEqual([false, true, false, false]);
  });

  test("an Esc something in the panel already used, such as closing a list, gives nothing back", async () => {
    await changed(null);
    const used = Object.assign(new window.Event("keydown", { cancelable: true }), {
      key: "Escape",
    });
    used.preventDefault();
    await run(() => window.dispatchEvent(used));
    expect(fake.keyboard).toEqual([]);
  });
});

describe("A panel opening again (#2925)", () => {
  test.each([
    { language: "English", line: "Kept for the field" },
    { language: "Chinese", line: "留在输入框里" },
  ])(
    "shows the unsent line the core still holds, one its Note refused ($language)",
    async ({ line }) => {
      fake.held = { text: line, atMs: 3000 };
      await changed(null);
      await run(() => undefined);
      const field = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="quick-note-field"]',
      );
      expect(field?.value).toBe(line);
    },
  );

  test("with nothing held, its field is empty", async () => {
    await changed(null);
    await run(() => undefined);
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="quick-note-field"]');
    expect(field?.value).toBe("");
  });
});

describe("The Meeting's thread (#2925)", () => {
  const SAY = "★ We can **start in June** [^1]\n→ keeps it moving";
  const NO = "★ We can't go lower this quarter\n→ keeps the margin";
  const ASK = "★ When does your audit start?\n→ learns their date";
  const replies = [
    answerOf("answer-want", WANT, "done"),
    answerOf("answer-sum", SUM, "done"),
    answerOf("answer-say", SAY, "done"),
    answerOf("answer-no", NO, "done"),
    answerOf("answer-ask", ASK, "done"),
    answerOf("answer-question", "The audit is in June [^1]", "done"),
  ];
  const lines = () => all("help-earlier").map((each) => each.textContent ?? "");
  const headings = () => all("help-heading").map((each) => each.textContent ?? "");
  const helped = async (...kinds: [MeetingHelpKind, string][]) => {
    for (const [kind, answerId] of kinds) {
      await changed(helpOf(kind, answerId));
      await loaded(replies);
    }
  };
  const questionOf = (question: string, answerId: string): MeetingHelp => ({
    ...helpOf("say", answerId),
    kind: "question",
    question,
    atMs: 125_000,
  });

  // protects=each earlier item is one line with its time, what was asked and the start of its reply, an option to say in quotation marks; three show, then Show earlier with the rest's count; fails_when=an earlier item shows whole, a line misses its time or question, or more than three show before Show earlier; no_claim=how the line is cut short.
  test("earlier items are one line each, three of them, then Show earlier; the newest shows whole", async () => {
    await helped(
      ["want", "answer-want"],
      ["sum", "answer-sum"],
      ["say", "answer-say"],
      ["no", "answer-no"],
      ["ask", "answer-ask"],
    );
    expect(lines()).toEqual([
      "1:00·Sum up so far·Their audit is in June",
      "1:00·What should I say?·“We can start in June”",
      "1:00·Say no politely·“We can't go lower this quarter”",
    ]);
    expect(headings()).toEqual([expect.stringContaining("What to ask next")]);
    expect(all("help-show-earlier").map((each) => each.textContent)).toEqual(["Show earlier (1)"]);
    await click(all("help-show-earlier")[0]);
    await loaded(replies);
    expect(lines()).toHaveLength(4);
    expect(lines()[0]).toBe(
      "1:00·What do they want?·They want the rollout finished before their June audit",
    );
    expect(all("help-show-earlier")).toHaveLength(0);
  });

  // protects=a click on an earlier line opens it whole and closes the one open, and a new ask opens its own item and closes the one the User opened; fails_when=two show whole, the click opens nothing, or a new ask leaves the earlier one open; no_claim=scrolling.
  test("a click on an earlier line opens it and closes the open one; the next ask opens its own", async () => {
    await helped(["want", "answer-want"], ["sum", "answer-sum"]);
    await click(all("help-earlier")[0]);
    await loaded(replies);
    expect(headings()).toEqual([expect.stringContaining("What do they want?")]);
    expect(lines()).toEqual(["1:00·Sum up so far·Their audit is in June"]);
    await press("say");
    await loaded(replies);
    expect(headings()).toEqual(["What should I say?"]);
    expect(lines()).toHaveLength(2);
  });

  // protects=Add to note's Undo stays with its reply for its time, though the reply closes to its line and opens again; fails_when=the reply opened again offers Add to note while what it added is in the Note; no_claim=how long Undo stays.
  test("a reply added to the Note, closed to its line and opened again, still offers its Undo", async () => {
    await helped(["want", "answer-want"], ["sum", "answer-sum"]);
    await addToNote(replies);
    expect(all("help-added")).toHaveLength(1);
    await click(all("help-earlier")[0]);
    await loaded(replies);
    expect(headings()).toEqual([expect.stringContaining("What do they want?")]);
    expect(all("help-added")).toHaveLength(0);
    await click(all("help-earlier")[0]);
    await loaded(replies);
    expect(headings()).toEqual(["Sum up so far"]);
    expect(all("help-added")).toHaveLength(1);
    expect(all("help-add")).toHaveLength(0);
  });

  // protects=while a reply is written nothing is drawn under the line being written, so nothing below it moves as it grows: the outline holds the place only until the first line, and the sources come once it ends (#2925); fails_when=an outline or the sources sit under a line still growing; no_claim=how fast it is written.
  test("while a reply is written, nothing is drawn under its newest line: no outline after the first line, and the sources once it ends", async () => {
    await changed(helpOf("want", "answer-want"));
    await loaded([answerOf("answer-want", "", "streaming")]);
    expect(all("help-outline")).toHaveLength(2);
    await written(answerOf("answer-want", "★ They want the rollout finished [^1]", "streaming"));
    expect(all("help-outline")).toHaveLength(0);
    expect(all("help-sources")).toHaveLength(0);
    await written(answerOf("answer-want", WANT, "done"));
    expect(all("help-sources")).toHaveLength(1);
  });

  // protects=a typed question shows as the question, its own heading, in its pending outline and once answered, with Open in assistant going on in the app's window at that Answer; a line names it by the question; fails_when=it shows under a button's name or none, or Open in assistant opens another conversation; no_claim=the main window's side.
  test("a typed question shows as the question, with Open in assistant, and its earlier line names it", async () => {
    const { askQuestion } = await import("../../src/renderer/src/meetingHelp");
    await changed(null);
    await run(() => void askQuestion(meetingWith(null), "When is their audit?"));
    expect(headings()).toEqual(["When is their audit?"]);
    expect(all("help-outline").length).toBeGreaterThan(0);
    await replied(0, "answer-question");
    await changed(questionOf("When is their audit?", "answer-question"));
    await loaded(replies);
    expect(headings()).toEqual(["When is their audit?"]);
    expect(all("help-option").map((each) => each.textContent)).toEqual([
      expect.stringContaining("The audit is in June"),
    ]);
    await click(all("help-open-assistant")[0]);
    expect(fake.opened).toEqual([{ conversationId: "help-chat", answerId: "answer-question" }]);

    await helped(["sum", "answer-sum"]);
    expect(lines()).toEqual(["2:05·When is their audit?·The audit is in June"]);
    expect(all("help-open-assistant")).toHaveLength(0);
  });
});

describe("A Citation of an earlier call in a reply (#3005)", () => {
  // protects=#3005: the number's tooltip names the Transcript, its place and its call's start, joined as the interface language joins a Citation's source; fails_when=the parts are joined with an English comma in Chinese; no_claim=the place's own wording.
  test.each([
    {
      language: "en" as const,
      name: "Transcript · Meeting, 7 November",
      shape: /^Transcript · Meeting, 7 November, \S.*, started \S.*$/,
      foreign: "，",
    },
    {
      language: "zh-CN" as const,
      name: "转写稿 · 会议，11月7日",
      shape: /^转写稿 · 会议，11月7日，\S.*，开始于 \S.*$/,
      foreign: ", ",
    },
  ])(
    "names its source and its call's start ($language)",
    async ({ language, name, shape, foreign }) => {
      fake.language = language;
      const earlierCall = {
        id: "meeting-0",
        mindId: "note-0",
        kind: "meeting",
        status: "ready",
        startedAt: "2026-11-07T15:00:00.000Z",
        transcript: { documentId: "earlier-transcript" },
        help: null,
        helpTemplate: null,
      } as unknown as Meeting;
      const answer = {
        ...answerOf("answer-want", WANT, "done"),
        citations: [
          {
            marker: 1,
            documentId: "earlier-transcript",
            documentName: name,
            quote: "Rollout before the June audit",
            location: { kind: "time", from: 1942, to: 4012, speaker: "Them" },
            check: "not-checked",
            checkReason: null,
          },
        ],
      } as unknown as ConversationAnswer;
      await changed(null);
      await press("want");
      await replied(0, "answer-want");
      await run(() =>
        fake.emit("meetings.changed", [meetingWith(helpOf("want", "answer-want")), earlierCall]),
      );
      await loaded([answer]);

      // The reading's moment is plain, so its number sits on the moment line the app draws.
      const title = all("help-quote-number")[0]?.getAttribute("title") ?? "";
      expect(title).toMatch(shape);
      expect(title).not.toContain(foreign);
    },
  );
});

describe("A reply whose Citation is cells of a table (#2847)", () => {
  // protects=Pin keeps a suggestion's ids and tells its window only whether it is pinned, and Add to note writes the reply's own text and Citations, so neither carries a quote's cells anywhere: they stay on the call help Citation the panel draws; fails_when=the cells, or a heading only they hold, reach the Note's blocks or the window's state; no_claim=how the panel draws the cells.
  test("Pin and Add to note carry none of its cells", async () => {
    const cells = [
      { name: "Plan", value: "Enterprise" },
      { name: "Price", value: "$45 per seat a month" },
      { name: "Sign-on", value: "Yes" },
    ];
    const answer = {
      ...answerOf("answer-cells", "★ Enterprise is $45 a seat [^1]\n→ answers at once", "done"),
      citations: [
        { ...SAID, quote: "Enterprise\t$45 per seat a month\tYes", location: null, cells },
      ],
    } as unknown as ConversationAnswer;
    await changed(helpOf("answer", "answer-cells"));
    await loaded([answer]);
    expect(container.textContent).toContain("Sign-on “Yes”");
    await click(all("help-pin")[0]);
    await addToNote([answer]);
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0]).not.toContain("cells");
    expect(fake.added[0]).not.toContain("Sign-on");
    expect(JSON.stringify(fake.states)).not.toContain("Sign-on");
    expect(fake.states.at(-1)).toEqual({ folded: false, pinned: true });
  });
});
