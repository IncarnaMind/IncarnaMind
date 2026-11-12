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
    getConversation: () =>
      new Promise((resolve) => fake.loads.push((messages) => resolve({ messages }))),
    addToNote: ({ blocks }: { blocks: unknown[] }) => {
      fake.added.push(JSON.stringify(blocks));
      return Promise.resolve({ blockIds: ["block-1"] });
    },
    undoAddToNote: () => Promise.resolve(),
  },
  files: {},
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) => translate("en", key, params),
  translateNow: (key: MessageKey, params?: MessageParams) => translate("en", key, params),
  useLanguage: () => "en",
}));
vi.mock("../../src/renderer/src/store", async () => {
  const { create } = await import("zustand");
  return {
    useAppStore: create(() => ({
      settings: null,
      reportError: (error: unknown) => {
        throw error;
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
  onCommand: () => () => undefined,
  resize: () => undefined,
  state: () => undefined,
  close: () => undefined,
  setUp: () => undefined,
};

const WANT =
  "★ They want the rollout finished before their June audit [^1]\n→ Confirm the June date first";
const SUM = "- Their audit is in June\n- They asked for a fixed monthly price";

const helpOf = (kind: MeetingHelpKind, answerId: string): MeetingHelp => ({
  kind,
  conversationId: "help-chat",
  answerId,
  heard: null,
});

const meetingWith = (help: MeetingHelp | null) =>
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
    helpTemplate: null,
  }) as unknown as Meeting;

/** The price sheet's line, its sentence passed by the check: the chip shows ✓. */
const PASSED = {
  marker: 1,
  documentId: "price-sheet",
  documentName: "Northwind price sheet",
  quote: "Rollout before the June audit",
  location: null,
  check: "found",
  judgedAt: "2026-11-12T20:00:00.000Z",
  passedAt: [0],
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
    citations: text.includes("[^1]") ? [PASSED] : [],
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
  Object.assign(window, { [MEETING_PANEL_BRIDGE_KEY]: panelBridge });
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
  checks: container.querySelectorAll('[data-testid="help-citation"][data-passed="true"]').length,
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
});

describe("a press whose Meeting stops before its reply", () => {
  // protects=#3005: holding a press's outline for its help never outlives the Meeting; fails_when=a press answered after Stop keeps waiting for a help that never comes; no_claim=what Stop shows.
  test("leaves nothing waiting", async () => {
    const { useMeetingHelp } = await import("../../src/renderer/src/meetingHelp");
    await changed(null);
    await press("want");
    expect(useMeetingHelp.getState().pending).toEqual({ "meeting-1": "want" });
    await run(() => fake.emit("meetings.changed", [{ ...meetingWith(null), status: "ready" }]));
    await replied(0, "answer-want");
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
});
