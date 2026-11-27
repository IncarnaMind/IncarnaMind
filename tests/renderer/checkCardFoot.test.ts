import type { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as Y from "yjs";
import type { AgentPairing, ChatReadiness } from "../../src/core/api";
import type { Planned } from "../../src/renderer/src/mindCheck";

/*
 * The Checks card's foot (#3794): the Note's Check is its button in the Note's row, so the card
 * has none of its own, and while a run goes that button's square is its Stop (#3840). Its foot
 * says when nothing changed since the last check, holds the press that fixes what a check found
 * and, once the check is done, a quiet Check again; with none of those it is not drawn.
 */

const pressed = vi.hoisted(() => ({
  running: { value: false },
  unchanged: { value: undefined as true | undefined },
  check: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/renderer/src/mindCheck", () => ({
  useMindCheck: () => pressed.unchanged.value,
  useMindCheckRun: () => null,
  startCheckAsking: pressed.check,
}));
vi.mock("@tiptap/react", () => ({
  useEditorState: ({
    editor,
    selector,
  }: {
    editor: unknown;
    selector: (context: { editor: unknown }) => unknown;
  }) => selector({ editor }),
}));
vi.mock("@tiptap/y-tiptap", () => ({ ySyncPluginKey: {} }));
vi.mock("../../src/renderer/src/checks", () => ({
  useChecks: (
    selector: (state: {
      running: Record<string, unknown>;
      problems: Record<string, unknown>;
    }) => unknown,
  ) =>
    selector({
      running: pressed.running.value
        ? { mind: { requestId: "check-1", action: "whole-mind" } }
        : {},
      problems: {},
    }),
  setCheckCardOpen: vi.fn(),
  stopCheck: vi.fn(),
}));
vi.mock("../../src/renderer/src/savedProviders", () => ({
  useSavedProviders: (select: (state: { providers: never[] }) => unknown) =>
    select({ providers: [] }),
  loadSavedProviders: () => {},
}));
vi.mock("../../src/renderer/src/contradictions", () => ({ useContradictions: () => undefined }));
vi.mock("../../src/renderer/src/editor/ContradictionLine", () => ({
  ContradictionAsk: () => null,
  ContradictionLine: () => null,
}));
vi.mock("../../src/renderer/src/correctionFixes", () => ({
  correctableCount: () => 0,
  correctContradictions: vi.fn(),
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({ useEdits: () => undefined }));
vi.mock("../../src/renderer/src/fixSentence", () => ({
  fixableClaims: () => [],
  fixSentences: vi.fn(),
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => "en",
  useT: () => (key: string) => key,
}));
vi.mock("../../src/renderer/src/layoutSlice", () => ({
  frontTabOfMind: () => null,
  groupsMerged: () => false,
}));
vi.mock("../../src/renderer/src/motion", () => ({ useFade: () => {} }));
const app = vi.hoisted(() => ({
  state: { chatReadiness: null } as { chatReadiness: ChatReadiness | null },
  listeners: [] as ((state: { chatReadiness: ChatReadiness | null }) => void)[],
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => app.state,
    subscribe: (listener: (state: { chatReadiness: ChatReadiness | null }) => void) => {
      app.listeners.push(listener);
      return () => undefined;
    },
  }),
}));
vi.mock("../../src/renderer/src/core", () => ({ core: { on: () => () => undefined } }));
vi.mock("../../src/renderer/src/unreadFiles", () => ({ useCheckUnread: () => [] }));
vi.mock("../../src/renderer/src/useWindowWidth", () => ({ useGroupsMerged: () => false }));
vi.mock("../../src/renderer/src/verify", () => ({
  checkClaims: vi.fn(),
  findClaims: vi.fn(),
  stopVerify: vi.fn(),
}));
vi.mock("../../src/renderer/src/editor/AddedDocumentsLine", () => ({
  useWatchAddedDocuments: () => {},
}));
vi.mock("../../src/renderer/src/editor/changedSentences", () => ({
  useCheckThisMindPlan: () => null,
}));
vi.mock("../../src/renderer/src/editor/checkPlace", () => ({ useCardPlace: () => "card" }));
vi.mock("../../src/renderer/src/editor/MindCheckLine", () => ({
  MindCheckAsk: () => null,
  MindUnchanged: () => createElement("p", { "data-testid": "mind-unchanged" }),
  useRunningCheck: () => null,
}));
vi.mock("../../src/renderer/src/editor/NoteHealth", () => ({
  HealthCard: () => null,
  useHealth: () => ({
    contradicted: [],
    unsupported: [],
    notFound: [],
    checkable: 0,
    toCheck: [],
  }),
}));
vi.mock("../../src/renderer/src/editor/Popover", () => ({ Popover: () => null }));
vi.mock("../../src/renderer/src/editor/VerifyLine", () => ({
  useVerifyState: () => null,
  VerifyCard: () => null,
  verifyDone: () => false,
}));
vi.mock("../../src/renderer/src/components/tabs/tabItems", () => ({ useTabPlace: () => null }));

const planned: Planned = {
  mode: "changed",
  allDocuments: false,
  watch: null,
  plan: {
    kind: "ready",
    sentences: 4,
    findsClaims: true,
    inFolder: true,
    model: null,
  },
};

/** As the card takes them; the card itself is imported at run time, as a .tsx file. */
interface FootProps {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  askingMind: boolean;
  planned: Planned | null;
  again: number | null;
}

let root: Root | null = null;
let container: HTMLElement;
let Foot: ComponentType<FootProps>;

async function render(at: Planned | null, again: number | null = null) {
  await act(() =>
    root?.render(
      createElement(Foot, {
        editor: {} as Editor,
        doc: {} as Y.Doc,
        mindId: "mind",
        askingMind: false,
        planned: at,
        again,
      }),
    ),
  );
}

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  pressed.running.value = false;
  const modulePath = "../../src/renderer/src/editor/CheckBadge.tsx";
  const module: { CheckActions: ComponentType<FootProps> } = await import(modulePath);
  Foot = module.CheckActions;
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  pressed.unchanged.value = undefined;
  pressed.check.mockClear();
});

// protects=#3756: a Check that finds nothing changed says so, with its way to check every sentence again, even when no time of the last check is known; fails_when=the line goes when the plan names no time, so the press runs nothing and nothing says why
test("nothing changed is said even with no time to name", async () => {
  pressed.unchanged.value = true;
  await render({ ...planned, plan: { kind: "unchanged", since: null } });
  expect(container.querySelector('[data-testid="mind-unchanged"]')).not.toBeNull();
});

// protects=#3794: the card has no Check of its own, so at rest with nothing to fix its foot is not drawn at all; fails_when=a Check, or an empty band, is drawn in the card's foot
test("at rest, with nothing to fix, the card has no foot and no Check", async () => {
  await render(planned);
  expect(container.innerHTML).toBe("");
});

// protects=#3840: while a run goes the Note's button and its square are its count and its Stop, so the card has no foot: no second Stop, no Check again; fails_when=a Stop or any other press is drawn in the card's foot during a run
test("while a run goes, the card has no foot and no second Stop", async () => {
  pressed.running.value = true;
  await render(null, 0);
  expect(container.innerHTML).toBe("");
});

// protects=#3840: once the Note's check is done its foot offers to check again in quiet words, or the sentences new or edited since by their number, and the press runs the Note's one Check; fails_when=a done card has no way to check again, or offers it as a dark button
test("once done, a quiet Check again, or Check N new", async () => {
  await render(planned, 0);
  const again = container.querySelector<HTMLButtonElement>('[data-testid="check-card-again"]');
  expect(again?.textContent).toBe("claim.checkAgain");
  expect(again?.className).toBe("check-card-again");
  await act(() => again?.click());
  expect(pressed.check).toHaveBeenCalledWith("mind");

  await render(planned, 2);
  expect(container.querySelector('[data-testid="check-card-again"]')?.textContent).toBe(
    "checks.checkNew",
  );
  await render(planned, 1);
  expect(container.querySelector('[data-testid="check-card-again"]')?.textContent).toBe(
    "checks.checkNew.one",
  );
});

// protects=#3840: Check again on a Note unchanged since its check says so in the foot, and the quiet Check again gives way to it; fails_when=both show, or the unchanged line goes
test("nothing changed takes the place of Check again", async () => {
  pressed.unchanged.value = true;
  await render({ ...planned, plan: { kind: "unchanged", since: "2026-11-02T21:00:00.000Z" } }, 0);
  expect(container.querySelector('[data-testid="mind-unchanged"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="check-card-again"]')).toBeNull();
});

// protects=a check asked of the User's own AI is forgotten once a model is set up, while an Organize asked of that AI stays (#3587); fails_when=the asked check outlives the model being set up, or the Organize's ask goes with it
test("a check asked of the User's own AI goes once a model is set up; an Organize's stays", async () => {
  const { rememberAsked, useAgentAsked } = await import("../../src/renderer/src/askedAgent");
  const codex = { id: "pairing-codex", name: "Codex", client: "codex" } as AgentPairing;
  const asked = () => Object.values(useAgentAsked.getState().byKey).map((each) => each.for.kind);
  const readiness = async (chatReadiness: ChatReadiness) => {
    await act(() => {
      app.state = { chatReadiness };
      for (const listener of app.listeners) listener(app.state);
    });
  };
  await readiness({ ready: false, reason: "no-provider" });
  const at = new Date().toISOString();
  rememberAsked(codex, { kind: "check", mindId: "mind" }, { copied: true, at });
  rememberAsked(codex, { kind: "organize", target: { ids: null } }, { copied: true, at });
  await render(planned);
  expect(asked().sort()).toEqual(["check", "organize"]);

  await readiness({ ready: true } as ChatReadiness);
  expect(asked()).toEqual(["organize"]);
  // An ask that answers after the model was set up leaves no check asked either.
  rememberAsked(codex, { kind: "check", mindId: "mind" }, { copied: true, at });
  expect(asked()).toEqual(["organize"]);
});

// protects=#3840: a check run on the User's own AI in the background is stopped by the Note's button's square, as a run on a model is, so the card has no Stop of its own; a card whose line offers the next step has no foot at all (#3756); fails_when=a second Stop is drawn in the card, or an empty foot under the line
test("a background run has no Stop in the card, and a card with nothing in its foot has none", async () => {
  const { useAgentAsked } = await import("../../src/renderer/src/askedAgent");
  const claude = {
    id: "pairing-claude",
    name: "Claude Code",
    client: "claude-code",
  } as AgentPairing;
  const run = (state: "working" | "failed") =>
    act(() =>
      useAgentAsked.setState({
        byKey: {
          "mind:mind": {
            agent: claude,
            for: { kind: "check", mindId: "mind" },
            copied: false,
            state,
            at: new Date().toISOString(),
            seen: true,
            background: true,
          },
        },
      }),
    );
  await act(() => {
    app.state = { chatReadiness: { ready: false, reason: "no-provider" } };
    for (const listener of app.listeners) listener(app.state);
  });
  await run("working");
  await render(planned);
  expect(container.querySelector('[data-testid="checks-asked-stop"]')).toBeNull();
  expect(container.innerHTML).toBe("");

  await run("failed");
  expect(container.querySelector('[data-testid="checks-asked-stop"]')).toBeNull();
  expect(container.innerHTML).toBe("");
  await act(() => useAgentAsked.setState({ byKey: {} }));
});
