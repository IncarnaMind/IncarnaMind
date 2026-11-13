import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AddedToNote,
  AddQuickNoteInput,
  Meeting,
  MeetingHelpKind,
  MeetingHelpTemplate,
  UndoAddToNoteInput,
  UndoAddToNoteResult,
} from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { askBarKinds } from "../../src/renderer/src/meetingPanel/askBarKinds";
import {
  type Draft,
  type QuickNotes,
  quickNotesFor,
} from "../../src/renderer/src/meetingPanel/quickNotes";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import type { FieldMode } from "../../src/shared/meetingPanel";

const state = vi.hoisted(() => ({ language: { current: "en" as Language } }));

vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) =>
    translate(state.language.current, key, params),
}));
vi.mock("../../src/renderer/src/meetingHelp", async () => {
  const { create } = await import("zustand");
  return {
    useMeetingHelp: create(() => ({ pending: {} as Record<string, { kind: MeetingHelpKind }> })),
  };
});
vi.mock("../../src/renderer/src/motion", () => ({ exit: vi.fn() }));

/** A page as the panel's, with its typing events: React reads the field's typing only when it finds them as it loads. */
function newPage() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.assign(document, { oninput: null });
  const window = document.defaultView;
  // React reads an input method's composition events only when the window has them as it loads.
  Object.assign(window, { CompositionEvent: window.Event });
  for (const [name, value] of Object.entries({
    document,
    window,
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
  return document;
}
newPage();
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

type Keys = Partial<Record<MeetingHelpKind, string>>;
interface AskBarProps {
  meeting: Meeting;
  keys: Keys;
  mode: FieldMode;
  onMode(mode: FieldMode): void;
  fieldWanted: FieldMode | null;
  onAsk(kind: MeetingHelpKind): void;
  onQuestion(text: string): Promise<boolean>;
  onReach(reach: number): void;
  onTakeKeyboard(): void;
  onFieldTaken(): void;
  notes: QuickNotes | null;
}

describe("the ask bar's prompts, in order", () => {
  test("with no template, three prompts are in the bar and the other four under More…", () => {
    expect(askBarKinds(null)).toEqual({
      bar: ["say", "answer", "want"],
      more: ["sum", "no", "ask", "check"],
    });
  });

  test.each([
    ["interview", ["followUp", "leading", "notCovered", "sum", "no", "ask", "check"]],
    ["sales", ["objection", "nextStep", "facts", "sum", "no", "ask", "check"]],
    ["team", ["decisions", "disagree", "sum", "no", "ask", "check"]],
  ] as const)("the %s template's own prompts come first under More…", (template, more) => {
    expect(askBarKinds(template)).toEqual({ bar: ["say", "answer", "want"], more });
  });
});

let root: Root | null = null;
let container: HTMLElement;
let AskBar: ComponentType<AskBarProps>;
let usePending: {
  setState(next: {
    pending: Record<string, { kind: MeetingHelpKind | "question"; question: string | null }>;
  }): void;
};
const onAsk = vi.fn<(kind: MeetingHelpKind) => void>();
const onReach = vi.fn<(reach: number) => void>();
const onTakeKeyboard = vi.fn<() => void>();
const onFieldTaken = vi.fn<() => void>();
const onMode = vi.fn<(mode: FieldMode) => void>();
const onQuestion = vi.fn<(text: string) => Promise<boolean>>();
const ADDED: AddedToNote = { mindId: "mind-1", blockIds: ["block-1"] };
/** The core as quick notes reach it: each call recorded, each answer set by the test. */
const quickCore = {
  addQuickNote: vi.fn<(input: AddQuickNoteInput) => Promise<AddedToNote>>(),
  undoAddToNote: vi.fn<(input: UndoAddToNoteInput) => Promise<UndoAddToNoteResult>>(),
  setQuickNoteDraft: vi.fn<(input: AddQuickNoteInput) => Promise<void>>(),
};
/** The panel's lines by Meeting, which outlive the bar as the panel keeps them. */
let drafts: Map<string, Draft>;
let notes: QuickNotes;
const kept = (): Draft => drafts.get("meeting-1") ?? { text: "", began: null };
/** The texts the core was told the field holds, in order, repeats folded. */
const keptTexts = () =>
  quickCore.setQuickNoteDraft.mock.calls
    .map(([input]) => input.text)
    .filter((text, index, all) => index === 0 || all[index - 1] !== text);
/** The quick notes asked for, as [text, atMs]. */
const added = () => quickCore.addQuickNote.mock.calls.map(([input]) => [input.text, input.atMs]);

/** Recording since 12:00:00 with 4 min 7 s already recorded before it, or paused at 4:07. */
const RECORDING_SINCE = "2026-11-12T12:00:00.000Z";
const meetingOf = (
  helpTemplate: MeetingHelpTemplate | null,
  status: "recording" | "paused" = "recording",
): Meeting =>
  ({
    id: "meeting-1",
    helpTemplate,
    status,
    recordedMs: 247_000,
    recordingSince: status === "recording" ? RECORDING_SINCE : null,
  }) as Meeting;

beforeEach(async () => {
  vi.clearAllMocks();
  quickCore.addQuickNote.mockReset().mockResolvedValue(ADDED);
  quickCore.undoAddToNote.mockReset().mockResolvedValue({ kept: 0 });
  quickCore.setQuickNoteDraft.mockReset().mockResolvedValue(undefined);
  drafts = new Map();
  notes = quickNotesFor("meeting-1", quickCore, drafts, (error) => {
    throw error;
  });
  state.language.current = "en";
  const document = newPage();
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const barPath = "../../src/renderer/src/meetingPanel/AskBar.tsx";
  ({ AskBar } = await import(barPath));
  const helpPath = "../../src/renderer/src/meetingHelp";
  ({ useMeetingHelp: usePending } = await import(helpPath));
  usePending.setState({ pending: {} });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const KEYS: Keys = { say: "⌃⌥1", answer: "⌃⌥2", want: "⌃⌥3", sum: "⌃⌥4", no: "⌃⌥5" };

async function show(
  template: MeetingHelpTemplate | null = null,
  keys: Keys = KEYS,
  {
    meeting = meetingOf(template),
    fieldWanted = null,
    mode = "note",
    quickNotes = true,
  }: {
    meeting?: Meeting;
    fieldWanted?: FieldMode | null;
    mode?: FieldMode;
    quickNotes?: boolean;
  } = {},
) {
  await act(async () =>
    root?.render(
      createElement(AskBar, {
        meeting,
        keys,
        mode,
        onMode,
        fieldWanted,
        onAsk,
        onQuestion,
        onReach,
        onTakeKeyboard,
        onFieldTaken,
        notes: quickNotes ? notes : null,
      }),
    ),
  );
}

const all = (testId: string) => Array.from(container.querySelectorAll(`[data-testid="${testId}"]`));

function one(testId: string): Element {
  const [found] = all(testId);
  if (!found) throw new Error(`Missing: ${testId}`);
  return found;
}

/** Each prompt's name and its key, in reading order, inside `scope`. */
const promptsIn = (scope: Element) =>
  Array.from(scope.querySelectorAll('[data-testid="help-prompt"]')).map((each) => [
    each.getAttribute("data-kind"),
    each.querySelector('[data-testid="help-prompt-keys"]')?.textContent ?? null,
  ]);

/** The labels with these words are wider than their row; every other label fits, as measured in a browser. */
function cutLabelsOf(names: string[]) {
  const wide = (element: Element) => names.includes(element.textContent ?? "");
  const prototype = window.HTMLElement.prototype;
  Object.defineProperty(prototype, "scrollWidth", {
    configurable: true,
    get(this: Element) {
      return wide(this) ? 200 : 100;
    },
  });
  Object.defineProperty(prototype, "clientWidth", { configurable: true, get: () => 100 });
}

const fire = (target: Element, type: string) =>
  act(async () => {
    target.dispatchEvent(new window.Event(type, { bubbles: true }));
  });

const field = () => one("quick-note-field") as HTMLTextAreaElement;

/** Types into the field as a browser does: its value changes, then an input event. */
async function type(value: string) {
  await act(async () => {
    const element = field();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** A key pressed in the field; `composing` while an input method holds the text. */
async function press(key: string, { shift = false, composing = false } = {}): Promise<Event> {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, {
    key,
    shiftKey: shift,
    isComposing: composing,
    keyCode: composing ? 229 : 0,
  });
  await act(async () => {
    field().dispatchEvent(event);
  });
  return event;
}

const slashRows = () =>
  all("help-slash-list").flatMap((list) => promptsIn(list).map(([kind]) => kind));
const chosenRow = () =>
  all("help-prompt")
    .find((each) => each.getAttribute("aria-selected") === "true")
    ?.getAttribute("data-kind");

describe("the ask bar", () => {
  test('shows three prompts with their keys, then More… with "/", the field, and no list', async () => {
    await show();
    const bar = one("ask-bar");
    expect(promptsIn(bar)).toEqual([
      ["say", "⌃⌥1"],
      ["answer", "⌃⌥2"],
      ["want", "⌃⌥3"],
    ]);
    expect(one("help-more").textContent).toBe("More…/");
    expect(field().getAttribute("placeholder")).toBe("Note for this meeting…");
    expect(one("help-more").getAttribute("aria-expanded")).toBe("false");
    expect(all("help-more-list")).toHaveLength(0);
    expect(all("help-slash-list")).toHaveLength(0);
  });

  test('shows no key where none is held, and More… keeps its "/", which is the field\'s', async () => {
    await show(null, {});
    expect(promptsIn(one("ask-bar"))).toEqual([
      ["say", null],
      ["answer", null],
      ["want", null],
    ]);
    expect(one("help-more").textContent).toBe("More…/");
  });

  test("a row has no tooltip while its label fits", async () => {
    await show();
    await fire(one("help-more"), "click");
    expect(all("help-prompt").map((each) => each.getAttribute("title"))).toEqual(
      Array(7).fill(null),
    );
  });

  test("a row whose label is cut short has the whole label and its key as its tooltip", async () => {
    cutLabelsOf(["What should I say?", "Say no politely"]);
    await show();
    await fire(one("help-more"), "click");
    const titles = all("help-prompt").map((each) => [
      each.getAttribute("data-kind"),
      each.getAttribute("title"),
    ]);
    expect(titles).toEqual([
      ["say", "What should I say? (⌃⌥1)"],
      ["answer", null],
      ["want", null],
      ["sum", null],
      ["no", "Say no politely (⌃⌥5)"],
      ["ask", null],
      ["check", null],
    ]);
  });

  test("a cut label with no key has the label alone as its tooltip", async () => {
    cutLabelsOf(["What should I say?"]);
    await show(null, {});
    expect(one("help-prompt").getAttribute("title")).toBe("What should I say?");
  });

  test('where the panel has no quick notes (Linux), there is no field, and More… shows no "/"', async () => {
    await show(null, KEYS, { quickNotes: false });
    expect(all("quick-note-field")).toHaveLength(0);
    expect(all("help-more-keys")).toHaveLength(0);
    expect(one("help-more").textContent).toBe("More…");
    expect(one("ask-bar").textContent).not.toMatch(/Note for this meeting|\//);
  });

  test("is in Chinese in a Chinese interface", async () => {
    state.language.current = "zh-CN";
    await show();
    expect(one("help-more").textContent).toBe("更多…/");
    expect(field().getAttribute("placeholder")).toBe("记一笔…");
  });

  test("More… opens the other four over the answers, with their keys", async () => {
    await show();
    await fire(one("help-more"), "click");
    const list = one("help-more-list");
    expect(one("help-more").getAttribute("aria-expanded")).toBe("true");
    expect(promptsIn(list)).toEqual([
      ["sum", "⌃⌥4"],
      ["no", "⌃⌥5"],
      ["ask", null],
      ["check", null],
    ]);
  });

  test("a meeting template's own prompts come first in the list", async () => {
    await show("interview");
    await fire(one("help-more"), "click");
    expect(promptsIn(one("help-more-list")).map(([kind]) => kind)).toEqual([
      "followUp",
      "leading",
      "notCovered",
      "sum",
      "no",
      "ask",
      "check",
    ]);
  });

  test("choosing a row asks that prompt and closes the list", async () => {
    await show();
    await fire(one("help-more"), "click");
    const sumUp = all("help-prompt").find((each) => each.getAttribute("data-kind") === "sum");
    if (!sumUp) throw new Error("The list has no Sum up so far.");
    await fire(sumUp, "click");
    expect(onAsk.mock.calls).toEqual([["sum"]]);
    expect(all("help-more-list")).toHaveLength(0);
    expect(one("help-more").getAttribute("aria-expanded")).toBe("false");
  });

  test("a prompt in the bar asks at once", async () => {
    await show();
    await fire(one("help-prompt"), "click");
    expect(onAsk.mock.calls).toEqual([["say"]]);
    expect(all("help-more-list")).toHaveLength(0);
  });

  test("a second click on More… closes the list", async () => {
    await show();
    await fire(one("help-more"), "click");
    await fire(one("help-more"), "click");
    expect(all("help-more-list")).toHaveLength(0);
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("a press outside the bar closes the list, a press inside it does not", async () => {
    await show();
    await fire(one("help-more"), "click");
    await fire(one("help-more-list"), "pointerdown");
    expect(all("help-more-list")).toHaveLength(1);
    await fire(document.body, "pointerdown");
    expect(all("help-more-list")).toHaveLength(0);
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("a prompt asked another way, by its shortcut, closes the list", async () => {
    await show();
    await fire(one("help-more"), "click");
    await act(async () =>
      usePending.setState({ pending: { "meeting-1": { kind: "check", question: null } } }),
    );
    expect(all("help-more-list")).toHaveLength(0);
  });

  test('a prompt asked by its shortcut closes the "/" list too, and clears the "/"', async () => {
    await show();
    await type("/su");
    await act(async () =>
      usePending.setState({ pending: { "meeting-1": { kind: "check", question: null } } }),
    );
    expect(all("help-slash-list")).toHaveLength(0);
    expect(field().value).toBe("");
  });

  test("tells the panel how far the list reaches only while it is open", async () => {
    await show();
    expect(onReach).toHaveBeenLastCalledWith(0);
    await fire(one("help-more"), "click");
    expect(onReach).toHaveBeenCalledTimes(2);
    expect(onReach).not.toHaveBeenLastCalledWith(0);
    await fire(one("help-more"), "click");
    expect(onReach).toHaveBeenLastCalledWith(0);
  });
});

describe("the field, for quick notes (#2925)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse("2026-11-12T12:00:10.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("Enter adds what was typed with the Meeting's time when typing began, says so in the field for 3 s, and leaves it empty for the next line", async () => {
    await show();
    await type("Ask about SSO");
    vi.setSystemTime(Date.parse("2026-11-12T12:00:25.000Z"));
    await type("Ask about SSO pricing");

    const enter = await press("Enter");

    expect(enter.defaultPrevented).toBe(true);
    // 4:07 recorded before, and 10 s of this stretch when the first letter went in.
    expect(added()).toEqual([["Ask about SSO pricing", 257_000]]);
    expect(field().value).toBe("");
    expect(field().getAttribute("placeholder")).toBe("Added to notes at 4:17");
    expect(one("quick-note-undo").textContent).toBe("Undo");
    await act(async () => vi.advanceTimersByTime(2_999));
    expect(all("quick-note-undo")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(all("quick-note-undo")).toHaveLength(0);
    expect(field().getAttribute("placeholder")).toBe("Note for this meeting…");
  });

  test("the next line takes its own time, from when it was begun", async () => {
    await show();
    await type("First");
    await press("Enter");
    vi.setSystemTime(Date.parse("2026-11-12T12:01:00.000Z"));
    await type("Second");
    await press("Enter");
    expect(added()).toEqual([
      ["First", 257_000],
      ["Second", 307_000],
    ]);
  });

  test("Shift-Enter starts a new line and sends nothing", async () => {
    await show();
    await type("Budget");
    const shiftEnter = await press("Enter", { shift: true });
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(quickCore.addQuickNote).not.toHaveBeenCalled();
  });

  test("nothing, or only spaces, sends nothing", async () => {
    await show();
    await press("Enter");
    await type("   \n ");
    await press("Enter");
    await fire(one("quick-note-send"), "click");
    expect(quickCore.addQuickNote).not.toHaveBeenCalled();
  });

  test("the send button adds it as Enter does", async () => {
    await show();
    await type("Owner is Dana");
    await fire(one("quick-note-send"), "click");
    expect(added()).toEqual([["Owner is Dana", 257_000]]);
    expect(one("quick-note-send").getAttribute("aria-label")).toBe("Add to notes");
  });

  test("begun while the Meeting is paused, it has no time and the field says only that it went in", async () => {
    await show(null, KEYS, { meeting: meetingOf(null, "paused") });
    await type("Side chat");
    await press("Enter");
    expect(added()).toEqual([["Side chat", null]]);
    expect(field().getAttribute("placeholder")).toBe("Added to notes");
  });

  test("in Chinese, the field says it went in at its time", async () => {
    state.language.current = "zh-CN";
    await show();
    await type("问一下单点登录");
    await press("Enter");
    expect(field().getAttribute("placeholder")).toBe("已记入笔记 4:17");
  });

  test("Undo takes the quick note back and the field says nothing more", async () => {
    await show();
    await type("Budget 40k");
    await press("Enter");
    await fire(one("quick-note-undo"), "click");
    expect(quickCore.undoAddToNote.mock.calls).toEqual([[ADDED]]);
    expect(all("quick-note-undo")).toHaveLength(0);
    expect(field().getAttribute("placeholder")).toBe("Note for this meeting…");
  });

  test("Undo says so when the User changed the line since, and it stays", async () => {
    quickCore.undoAddToNote.mockResolvedValue({ kept: 1 });
    await show();
    await type("Budget 40k");
    await press("Enter");
    await fire(one("quick-note-undo"), "click");
    expect(one("quick-note-problem").textContent).toBe("Kept the Block you edited");
  });

  test("a note that couldn't go in comes back into the field, with why", async () => {
    quickCore.addQuickNote.mockRejectedValue(new Error("The note is read-only."));
    await show();
    await type("Budget 40k");
    await press("Enter");
    expect(field().value).toBe("Budget 40k");
    expect(one("quick-note-problem").textContent).toBe("The note is read-only.");
    expect(all("quick-note-undo")).toHaveLength(0);
  });

  test("a note that couldn't go in after the User began the next line comes back before it: neither is lost", async () => {
    const refused = Promise.withResolvers<AddedToNote>();
    quickCore.addQuickNote.mockReturnValueOnce(refused.promise);
    await show();
    await type("Budget 40k");
    await press("Enter");
    await type("Owner is Dana");
    await act(async () => refused.reject(new Error("The note is read-only.")));
    expect(field().value).toBe("Budget 40k\nOwner is Dana");
    expect(one("quick-note-problem").textContent).toBe("The note is read-only.");
  });

  test("an Undo that couldn't be done says why and offers Undo again", async () => {
    quickCore.undoAddToNote.mockRejectedValueOnce(new Error("The note is read-only."));
    await show();
    await type("Budget 40k");
    await press("Enter");
    await fire(one("quick-note-undo"), "click");
    expect(one("quick-note-problem").textContent).toBe("The note is read-only.");
    expect(field().getAttribute("placeholder")).toBe("Added to notes at 4:17");
    await fire(one("quick-note-undo"), "click");
    expect(quickCore.undoAddToNote.mock.calls).toEqual([[ADDED], [ADDED]]);
    expect(all("quick-note-undo")).toHaveLength(0);
  });

  test.each([
    { language: "English", first: "Ask", line: "Ask about SSO" },
    { language: "Chinese", first: "问一下", line: "问一下单点登录" },
  ])(
    "what the field holds is kept as it changes, with when typing began, and Enter forgets it ($language)",
    async ({ first, line }) => {
      await show();
      await type(first);
      vi.setSystemTime(Date.parse("2026-11-12T12:00:20.000Z"));
      await type(line);
      expect(kept()).toEqual({ text: line, began: { ms: 257_000 } });
      await press("Enter");
      expect(kept()).toEqual({ text: "", began: null });
      expect(keptTexts()).toEqual([first, line, ""]);
    },
  );

  test.each([
    { language: "English", line: "Budget is 40k" },
    { language: "Chinese", line: "预算 4 万" },
  ])(
    "the bar shown again after a collapse has the line kept, and sends it with its time ($language)",
    async ({ line }) => {
      drafts.set("meeting-1", { text: line, began: { ms: 200_000 } });
      await show();
      expect(field().value).toBe(line);
      await press("Enter");
      expect(added()).toEqual([[line, 200_000]]);
    },
  );

  test("a bar shown with an empty field never tells the core to forget a line it holds", async () => {
    await show();
    await show("sales");
    expect(quickCore.setQuickNoteDraft).not.toHaveBeenCalled();
  });

  test("a note refused while the panel was collapsed comes back when the bar shows again", async () => {
    const refused = Promise.withResolvers<AddedToNote>();
    quickCore.addQuickNote.mockReturnValueOnce(refused.promise);
    await show();
    await type("Budget 40k");
    await press("Enter");
    await act(async () => root?.render(null));
    await act(async () => refused.reject(new Error("The note is read-only.")));
    await show();
    expect(field().value).toBe("Budget 40k");
    expect(keptTexts().at(-1)).toBe("Budget 40k");
  });

  test("each Meeting keeps its own line", () => {
    const other = quickNotesFor("meeting-2", quickCore, drafts, () => undefined);
    notes.keep({ text: "For the first call", began: null });
    expect(other.draft()).toEqual({ text: "", began: null });
    other.keep({ text: "For the second", began: { ms: 5_000 } });
    expect(notes.draft().text).toBe("For the first call");
    expect(quickCore.setQuickNoteDraft.mock.calls.at(-1)).toEqual([
      { meetingId: "meeting-2", text: "For the second", atMs: 5_000 },
    ]);
  });

  test("while an input method composes, what it hasn't committed isn't kept; what it commits is", async () => {
    await show();
    await type("记一笔");
    await fire(field(), "compositionstart");
    await type("记一笔jia");
    expect(kept().text).toBe("记一笔");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field()), "value")?.set;
      setter?.call(field(), "记一笔加");
      field().dispatchEvent(new window.Event("compositionend", { bubbles: true }));
    });
    expect(kept().text).toBe("记一笔加");
    expect(keptTexts()).not.toContain("记一笔jia");
  });

  test("an Enter that ends a Chinese input method's composition neither sends nor chooses; the next one does", async () => {
    await show();
    await type("记一笔");
    const composing = await press("Enter", { composing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(quickCore.addQuickNote).not.toHaveBeenCalled();
    await press("Enter");
    expect(added()).toEqual([["记一笔", 257_000]]);

    await type("/su");
    await press("Enter", { composing: true });
    expect(onAsk).not.toHaveBeenCalled();
    await press("Enter");
    expect(onAsk.mock.calls).toEqual([["sum"]]);
  });
});

describe("the field's Note | Ask (#2925)", () => {
  const radio = (mode: FieldMode) => one(`field-mode-${mode}`) as HTMLInputElement;
  const choose = (mode: FieldMode) =>
    act(async () => {
      radio(mode).checked = true;
      radio(mode).dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  const sentToCore = () => quickCore.setQuickNoteDraft.mock.calls.map(([input]) => input.text);

  beforeEach(() => {
    onQuestion.mockResolvedValue(true);
  });

  // protects=Note | Ask is a two-way switch at the field's left, Note by default, and choosing one tells the panel, which keeps it; fails_when=the switch is missing, starts in Ask, or choosing does nothing; no_claim=how long the panel keeps it.
  test("sits at the field's left, Note chosen, and choosing Ask tells the panel", async () => {
    await show();
    const row = one("quick-note");
    expect(row.firstElementChild?.getAttribute("data-testid")).toBe("field-mode");
    expect(radio("note").checked).toBe(true);
    expect(radio("ask").checked).toBe(false);
    await choose("ask");
    expect(onMode.mock.calls).toEqual([["ask"]]);
    expect(onTakeKeyboard).not.toHaveBeenCalled();
  });

  test.each([
    {
      language: "en" as const,
      labels: ["Note", "Ask"],
      placeholder: "Ask about this call…",
      name: "Ask about this call",
      send: "Ask",
    },
    {
      language: "zh-CN" as const,
      labels: ["笔记", "追问"],
      placeholder: "问问这场通话…",
      name: "问问这场通话",
      send: "提问",
    },
  ])("in Ask, the field says what Enter does ($language)", async ({ language, ...said }) => {
    state.language.current = language;
    await show(null, KEYS, { mode: "ask" });
    expect(
      all("field-mode")
        .flatMap((each) => [...each.querySelectorAll("label")])
        .map((each) => each.textContent),
    ).toEqual(said.labels);
    expect(field().getAttribute("placeholder")).toBe(said.placeholder);
    expect(field().getAttribute("aria-label")).toBe(said.name);
    expect(one("quick-note-send").getAttribute("aria-label")).toBe(said.send);
  });

  // protects=in Ask, Enter asks the question typed and leaves the field empty for the next, adding nothing to the Note and keeping nothing for it; fails_when=the question becomes a quick note, stays in the field, or is kept to go into the Note on Stop; no_claim=the answer.
  test("in Ask, Enter asks what was typed, empties the field for the next, and nothing goes to the Note", async () => {
    await show(null, KEYS, { mode: "ask" });
    await type("Does single sign-on cost extra?");
    const enter = await press("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onQuestion.mock.calls).toEqual([["Does single sign-on cost extra?"]]);
    expect(field().value).toBe("");
    expect(quickCore.addQuickNote).not.toHaveBeenCalled();
    expect(sentToCore().every((text) => text === "")).toBe(true);
    expect(all("quick-note-undo")).toHaveLength(0);
  });

  test("in Ask, a question that couldn't be asked comes back into the field, unless something was typed since", async () => {
    onQuestion.mockResolvedValue(false);
    await show(null, KEYS, { mode: "ask" });
    await type("Who signs the order form?");
    await press("Enter");
    expect(field().value).toBe("Who signs the order form?");

    let resolve: (asked: boolean) => void = () => undefined;
    onQuestion.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await press("Enter");
    await type("Another");
    await act(async () => resolve(false));
    expect(field().value).toBe("Another");
  });

  // protects=a line typed in Note and then switched to Ask stays in the field but is no longer kept for the Note, and switched back it is again; fails_when=switching clears the field, or a question goes into the Note on Stop; no_claim=the panel's own memory of the mode.
  test("a line typed in Note stays in the field in Ask, kept for the Note only while in Note", async () => {
    await show();
    await type("Pricing");
    await show(null, KEYS, { mode: "ask" });
    expect(field().value).toBe("Pricing");
    await show(null, KEYS, { mode: "note" });
    expect(sentToCore()).toEqual(["Pricing", "", "Pricing"]);
  });

  test('"/" lists the prompts in Ask too, and Enter asks the prompt, not a question', async () => {
    await show(null, KEYS, { mode: "ask" });
    await type("/su");
    expect(slashRows()[0]).toBe("sum");
    await press("Enter");
    expect(onAsk.mock.calls).toEqual([["sum"]]);
    expect(onQuestion).not.toHaveBeenCalled();
  });

  test("in Ask, Enter that ends a Chinese input method's composition sends nothing; the next does", async () => {
    await show(null, KEYS, { mode: "ask" });
    await type("单点登录要另外收费吗");
    await press("Enter", { composing: true });
    expect(onQuestion).not.toHaveBeenCalled();
    await press("Enter");
    expect(onQuestion.mock.calls).toEqual([["单点登录要另外收费吗"]]);
  });
});

describe('the "/" list (#2925)', () => {
  test('"/su" lists Sum up so far first; Enter asks it and empties the field, adding no note', async () => {
    await show();
    await type("/su");
    expect(slashRows()).toEqual(["sum", "say"]);
    expect(chosenRow()).toBe("sum");
    expect(field().getAttribute("aria-activedescendant")).toBe(
      all("help-prompt").find((each) => each.getAttribute("data-kind") === "sum")?.id,
    );

    const enter = await press("Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(onAsk.mock.calls).toEqual([["sum"]]);
    expect(quickCore.addQuickNote).not.toHaveBeenCalled();
    expect(field().value).toBe("");
    expect(all("help-slash-list")).toHaveLength(0);
  });

  test("a bare \"/\" lists every prompt the meeting has, a template's too, in the bar's order then More…'s", async () => {
    await show("team");
    await type("/");
    expect(slashRows()).toEqual([
      "say",
      "answer",
      "want",
      "decisions",
      "disagree",
      "sum",
      "no",
      "ask",
      "check",
    ]);
  });

  test("↓ and ↑ move through the list and wrap at its ends; a row pointed at is chosen too", async () => {
    await show();
    await type("/");
    expect(chosenRow()).toBe("say");
    await press("ArrowDown");
    expect(chosenRow()).toBe("answer");
    await press("ArrowUp");
    await press("ArrowUp");
    expect(chosenRow()).toBe("check");
    await press("ArrowDown");
    expect(chosenRow()).toBe("say");
    const want = one("help-slash-list").querySelector('[data-kind="want"]');
    if (!want) throw new Error("The list has no What do they want?");
    await fire(want, "mousemove");
    expect(chosenRow()).toBe("want");
    await press("Enter");
    expect(onAsk.mock.calls).toEqual([["want"]]);
  });

  test("typing more starts again at the best match", async () => {
    await show();
    await type("/");
    await press("ArrowDown");
    await type("/c");
    expect(chosenRow()).toBe(slashRows()[0]);
  });

  test('Esc closes the list and clears the "/", and goes no further', async () => {
    await show();
    await type("/su");
    const escaped = await press("Escape");
    expect(escaped.defaultPrevented).toBe(true);
    expect(field().value).toBe("");
    expect(all("help-slash-list")).toHaveLength(0);
  });

  test('a "/" later in a sentence opens nothing, and Enter adds the line', async () => {
    await show();
    await type("Price / seat is 45");
    expect(all("help-slash-list")).toHaveLength(0);
    await press("Enter");
    expect(added().map(([text]) => text)).toEqual(["Price / seat is 45"]);
    expect(field().getAttribute("placeholder")).toMatch(/^Added to notes at (\d+:)?\d+:\d{2}$/);
  });

  test.each([
    {
      language: "en" as const,
      first: "Sum up so far",
      next: "What should I say?",
      none: "No matches",
    },
    {
      language: "zh-CN" as const,
      first: "到目前为止的总结",
      next: "我该怎么说？",
      none: "没有匹配项",
    },
  ])(
    "a screen reader hears the row Enter will ask as it changes, and that nothing matches ($language)",
    async ({ language, first, next, none }) => {
      state.language.current = language;
      await show();
      const said = () => one("help-slash-said").textContent;
      expect(said()).toBe("");
      await type(language === "en" ? "/su" : "/zj");
      expect(said()).toBe(first);
      if (language === "en") {
        await press("ArrowDown");
        expect(said()).toBe(next);
      }
      await type("/xyz");
      expect(said()).toBe(none);
    },
  );

  test("nothing that matches says so, and Enter then does nothing", async () => {
    await show();
    await type("/xyz");
    expect(one("help-slash-none").textContent).toBe("No matches");
    await press("Enter");
    expect(onAsk).not.toHaveBeenCalled();
    expect(quickCore.addQuickNote).not.toHaveBeenCalled();
    expect(field().value).toBe("/xyz");
  });

  test('"/" closes More…, and More… closes "/" and clears it', async () => {
    await show();
    await fire(one("help-more"), "click");
    await type("/");
    expect(all("help-more-list")).toHaveLength(0);
    expect(all("help-slash-list")).toHaveLength(1);
    await fire(one("help-more"), "click");
    expect(all("help-more-list")).toHaveLength(1);
    expect(all("help-slash-list")).toHaveLength(0);
    expect(field().value).toBe("");
  });

  test("Esc closes an open More… first, the innermost thing", async () => {
    await show();
    await fire(one("help-more"), "click");
    const escaped = await press("Escape");
    expect(escaped.defaultPrevented).toBe(true);
    expect(all("help-more-list")).toHaveLength(0);
  });

  test("Esc with no list open is left for the panel, which gives the keyboard back, and the text stays", async () => {
    await show();
    await type("Unsent line");
    const escaped = await press("Escape");
    expect(escaped.defaultPrevented).toBe(false);
    expect(field().value).toBe("Unsent line");
  });
});

describe("a list left open (#2925)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pointer = (type: "pointerleave" | "pointerenter") =>
    act(async () => {
      document.documentElement.dispatchEvent(new window.Event(type));
    });

  test("closes once the pointer has been off the panel for a second, as the panel can't see a click in the meeting app", async () => {
    await show();
    await fire(one("help-more"), "click");
    await pointer("pointerleave");
    await act(async () => vi.advanceTimersByTime(999));
    expect(all("help-more-list")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(all("help-more-list")).toHaveLength(0);
  });

  test("stays open while the pointer comes back to the panel within the second", async () => {
    await show();
    await fire(one("help-more"), "click");
    await pointer("pointerleave");
    await act(async () => vi.advanceTimersByTime(600));
    await pointer("pointerenter");
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(all("help-more-list")).toHaveLength(1);
  });

  test('the "/" list closes the same way, its "/" cleared', async () => {
    await show();
    await type("/su");
    await pointer("pointerleave");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(all("help-slash-list")).toHaveLength(0);
    expect(field().value).toBe("");
  });

  test("with no list open, the pointer leaving changes nothing", async () => {
    await show();
    await type("A line");
    await pointer("pointerleave");
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(field().value).toBe("A line");
  });
});

describe("the keyboard: the panel never takes it by itself (#2925)", () => {
  test("not when it appears, on a click on a prompt, More… or a list's row, nor when an answer is asked for or arrives", async () => {
    await show();
    await fire(one("help-prompt"), "click");
    await act(async () =>
      usePending.setState({ pending: { "meeting-1": { kind: "say", question: null } } }),
    );
    await act(async () => usePending.setState({ pending: {} }));
    await fire(one("help-more"), "click");
    const sumUp = all("help-prompt").find((each) => each.getAttribute("data-kind") === "sum");
    if (!sumUp) throw new Error("The list has no Sum up so far.");
    await fire(sumUp, "click");
    await fire(one("quick-note-send"), "click");
    await show("sales");
    expect(onTakeKeyboard).not.toHaveBeenCalled();
    expect(onAsk.mock.calls).toEqual([["say"], ["sum"]]);
  });

  test("a press in the field takes it", async () => {
    await show();
    await fire(field(), "mousedown");
    expect(onTakeKeyboard).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["⌃⌥N or ⌘K's Quick note", "note"],
    ["⌘K's Ask about this call", "ask"],
  ] as const)(
    "%s takes it once, the cursor in the field in its mode, and a later render doesn't again",
    async (_name, wanted) => {
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      await show(null, KEYS, { fieldWanted: wanted, mode: wanted === "note" ? "ask" : "note" });
      expect(onTakeKeyboard).toHaveBeenCalledTimes(1);
      expect(onFieldTaken).toHaveBeenCalledTimes(1);
      expect(onMode.mock.calls).toEqual([[wanted]]);
      expect(focus.mock.contexts).toEqual([field()]);
      await show(null, KEYS, { fieldWanted: null, mode: wanted });
      await show("sales", KEYS, { fieldWanted: null, mode: wanted });
      expect(onTakeKeyboard).toHaveBeenCalledTimes(1);
    },
  );

  test("while the field is being written in, a press on a prompt keeps the cursor there; otherwise it is left alone", async () => {
    await show();
    const mouseDown = async (target: Element) => {
      const event = new window.Event("mousedown", { bubbles: true, cancelable: true });
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(await mouseDown(one("help-prompt"))).toBe(false);
    // The field has the focus, as the browser reports it.
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => field() });
    expect(await mouseDown(one("help-prompt"))).toBe(true);
    expect(await mouseDown(one("help-more"))).toBe(true);
    const ask = one("field-mode-ask").closest("label");
    if (!ask) throw new Error("Ask has no label.");
    expect(await mouseDown(ask)).toBe(true);
  });
});
