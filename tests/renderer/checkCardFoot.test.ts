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
 * has none of its own. Its foot says when nothing changed since the last check, holds the press
 * that fixes what a check found, and Stop while a run goes; with none of those it is not drawn.
 */

const pressed = vi.hoisted(() => ({
  running: { value: false },
  unchanged: { value: undefined as true | undefined },
}));
vi.mock("../../src/renderer/src/mindCheck", () => ({
  useMindCheck: () => pressed.unchanged.value,
  useMindCheckRun: () => null,
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
}

let root: Root | null = null;
let container: HTMLElement;
let Foot: ComponentType<FootProps>;

async function render(at: Planned | null) {
  await act(() =>
    root?.render(
      createElement(Foot, {
        editor: {} as Editor,
        doc: {} as Y.Doc,
        mindId: "mind",
        askingMind: false,
        planned: at,
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

// protects=#3794: while a run goes the card's foot has its Stop, and no Check beside it; fails_when=the run can't be stopped from the open card, or a Check is drawn there
test("while a run goes, the foot has its Stop", async () => {
  pressed.running.value = true;
  await render(null);
  expect(container.querySelector('[data-testid="card-foot-progress"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="card-foot-stop"]')?.textContent).toBe(
    "checks.stop",
  );
  expect(container.querySelectorAll("button")).toHaveLength(1);
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

// protects=#3756: a check run on the User's own AI in the background is stopped from the card's foot, as a run on a model is, and a card whose line offers the next step has no foot at all; fails_when=the run's Stop is missing from the foot, or an empty foot is drawn under the line
test("a background run's Stop is the foot's, and a card with nothing in its foot has none", async () => {
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
  expect(container.querySelector('[data-testid="checks-asked-stop"]')?.textContent).toBe(
    "checks.stop",
  );

  await run("failed");
  expect(container.querySelector('[data-testid="checks-asked-stop"]')).toBeNull();
  expect(container.innerHTML).toBe("");
  await act(() => useAgentAsked.setState({ byKey: {} }));
});
