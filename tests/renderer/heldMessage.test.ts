/**
 * A held message in the Note's conversation (#3765), its editor as the window draws it: the words
 * stay put while the core has them, are kept when the message went meanwhile, and an editor the
 * conversation folds away before it opens holds nothing in the core.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NoteHeldEdit, NoteTurn } from "../../src/core/api";
import { type MessageKey, translate } from "../../src/shared/i18n";

const calls = vi.hoisted(() => ({
  editHeldInNote: vi.fn<(mindId: string, turnId: string, edit: NoteHeldEdit) => Promise<boolean>>(),
  keepInInput: vi.fn<(mindId: string, words: string) => void>(),
  reportError: vi.fn<(error: unknown) => void>(),
}));

vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey) => translate("en", key),
}));
vi.mock("../../src/renderer/src/ownAiInNote", () => ({
  editHeldInNote: calls.editHeldInNote,
  keepInInput: calls.keepInInput,
  discardInNote: vi.fn(async () => undefined),
  sendNowInNote: vi.fn(async () => undefined),
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ reportError: calls.reportError }) },
}));
vi.mock("../../src/renderer/src/commands/keymap", () => ({ keysHere: () => "⌘↵" }));

function newPage() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.assign(document, { oninput: null });
  const window = document.defaultView;
  // linkedom's text areas have no caret; the editor puts it at the end as it opens.
  Object.assign(window.HTMLTextAreaElement.prototype, { setSelectionRange: () => undefined });
  for (const [name, value] of Object.entries({
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  return document;
}
newPage();
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

const turn = { id: "t2", request: "and when", outcome: "held" } as NoteTurn;
let root: Root | null = null;
let container: HTMLElement;
let HeldMessage: ComponentType<{ mindId: string; turn: NoteTurn; oldest: boolean }>;

/** A promise the test settles itself. */
function later<T>() {
  let settle: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

beforeEach(async () => {
  vi.clearAllMocks();
  calls.editHeldInNote.mockResolvedValue(true);
  const document = newPage();
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const path = "../../src/renderer/src/components/noteAsk/HeldMessage.tsx";
  ({ HeldMessage } = await import(path));
  await act(async () =>
    root?.render(createElement(HeldMessage, { mindId: "m1", turn, oldest: true })),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const one = (testId: string): Element => {
  const found = container.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Missing: ${testId}`);
  return found;
};
const field = () => container.querySelector("textarea") as HTMLTextAreaElement;
// linkedom keeps the attribute as React wrote it, "readOnly"; a browser reads it as "readonly".
const readOnly = () => field().hasAttribute("readOnly") || field().hasAttribute("readonly");
const press = (testId: string) =>
  act(async () => {
    one(testId).dispatchEvent(new window.Event("click", { bubbles: true }));
  });
async function type(value: string) {
  await act(async () => {
    const element = field();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const edits = () => calls.editHeldInNote.mock.calls.map(([, , edit]) => edit.kind);

describe("a held message's editor", () => {
  // protects=while Save waits for the core, the words can't change under it, and a Save that fails leaves them to try again (#3765); fails_when=the field takes typing while Save is pending, or the editor closes on a failed Save
  test("keeps its words fixed while Save is pending, and open to change again if it fails", async () => {
    await press("note-column-edit");
    await type("and where");
    const saving = later<boolean>();
    calls.editHeldInNote.mockReturnValueOnce(saving.promise);
    await press("note-column-edit-save");
    expect(readOnly()).toBe(true);
    expect((one("note-column-edit-save") as HTMLButtonElement).disabled).toBe(true);
    expect((one("note-column-edit-cancel") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => saving.fail(new Error("refused")));
    expect(calls.reportError).toHaveBeenCalledOnce();
    expect(readOnly()).toBe(false);
    expect(field().value).toBe("and where");
    expect((one("note-column-edit-save") as HTMLButtonElement).disabled).toBe(false);
    expect(calls.editHeldInNote.mock.calls.at(-1)?.[2]).toEqual({
      kind: "save",
      words: "and where",
    });
  });

  // protects=a Save that finds its message gone keeps the new words for the input, after what is typed there (#3765); fails_when=the words are dropped
  test("keeps the saved words for the input when the message went meanwhile", async () => {
    await press("note-column-edit");
    await type("and where");
    calls.editHeldInNote.mockResolvedValueOnce(false);
    await press("note-column-edit-save");
    expect(calls.keepInInput).toHaveBeenCalledWith("m1", "and where");
    expect(container.querySelector("textarea")).toBeNull();
  });

  // protects=words changed in an editor whose message went, never sent, as the editor went with it, are kept for the input (#3765); fails_when=they are lost with the editor
  test("keeps changed words for the input when the message goes with the editor open", async () => {
    await press("note-column-edit");
    await type("and where");
    calls.editHeldInNote.mockResolvedValueOnce(false);
    await act(async () => root?.unmount());
    root = null;
    await vi.waitFor(() => expect(calls.keepInInput).toHaveBeenCalledWith("m1", "and where"));
    expect(edits()).toEqual(["open", "cancel"]);
  });

  // protects=a Save that fails after the conversation folded keeps its words for the input and closes the editor in the core, so the message and those after it go (#3765); fails_when=the words are lost, or the core keeps the editor open and the held messages wait for it
  test("keeps the words and closes the editor in the core when Save fails after the fold", async () => {
    await press("note-column-edit");
    await type("and where");
    const saving = later<boolean>();
    calls.editHeldInNote.mockReturnValueOnce(saving.promise);
    await press("note-column-edit-save");
    await act(async () => root?.unmount());
    root = null;
    expect(edits()).toEqual(["open", "save"]);
    await act(async () => saving.fail(new Error("refused")));
    await vi.waitFor(() => expect(edits()).toEqual(["open", "save", "cancel"]));
    expect(calls.keepInInput).toHaveBeenCalledWith("m1", "and where");
  });

  // protects=an editor folded away before the core opened it doesn't hold the message there, so it still goes when the reply ends (#3765); fails_when=the core keeps the editor open and the message stays Waiting
  test("closes in the core an editor the conversation folded away before it opened", async () => {
    const opening = later<boolean>();
    calls.editHeldInNote.mockReturnValueOnce(opening.promise);
    await press("note-column-edit");
    await act(async () => root?.unmount());
    root = null;
    await act(async () => opening.settle(true));
    await vi.waitFor(() => expect(edits()).toEqual(["open", "cancel"]));
  });
});
