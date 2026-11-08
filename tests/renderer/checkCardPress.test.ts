import type { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as Y from "yjs";
import type { CheckEstimateView } from "../../src/renderer/src/editor/checkEstimateState";
import type { Planned } from "../../src/renderer/src/mindCheck";

/*
 * The badge card's one Check (#2313): its press hands the plan the card showed a price for to
 * `startCheck`, so a plan made since that price asks again instead of running at once on the new
 * plan's cost, unseen. A press with no price yet asks with the couldn't-estimate line instead.
 */

const pressed = vi.hoisted(() => ({
  check: vi.fn(),
  unpriced: vi.fn(),
  running: { value: false },
}));
vi.mock("../../src/renderer/src/mindCheck", () => ({
  startCheck: pressed.check,
  startCheckUnpriced: pressed.unpriced,
  useMindCheck: () => undefined,
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
  useChecks: (selector: (state: { running: Record<string, unknown> }) => unknown) =>
    selector({
      running: pressed.running.value
        ? { mind: { requestId: "check-1", action: "whole-mind" } }
        : {},
    }),
  setCheckCardOpen: vi.fn(),
  stopCheck: vi.fn(),
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
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => "en",
  useT: () => (key: string) => key,
}));
vi.mock("../../src/renderer/src/layoutSlice", () => ({
  frontTabOfMind: () => null,
  groupsMerged: () => false,
}));
vi.mock("../../src/renderer/src/motion", () => ({ useFade: () => {} }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) }),
}));
vi.mock("../../src/renderer/src/unreadFiles", () => ({ useCheckUnread: () => [] }));
vi.mock("../../src/renderer/src/useWindowWidth", () => ({ useGroupsMerged: () => false }));
vi.mock("../../src/renderer/src/verify", () => ({
  checkClaims: vi.fn(),
  stopVerify: vi.fn(),
}));
vi.mock("../../src/renderer/src/editor/AddedDocumentsLine", () => ({
  useWatchAddedDocuments: () => {},
}));
vi.mock("../../src/renderer/src/editor/changedSentences", () => ({
  checkTitle: () => undefined,
  useCheckEstimate: () => ({ line: null, state: "none" }),
  useCheckThisMindPlan: () => null,
}));
vi.mock("../../src/renderer/src/editor/checkPlace", () => ({ useCardPlace: () => "card" }));
vi.mock("../../src/renderer/src/editor/MindCheckLine", () => ({
  MindCheckAsk: () => null,
  MindUnchanged: () => null,
  RunningText: () => null,
}));
vi.mock("../../src/renderer/src/editor/NoteHealth", () => ({
  HealthCard: () => null,
  PartMark: () => null,
  partLabel: () => "",
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
const price: CheckEstimateView["line"] = { parts: ["About $1.40"], title: "About $1.40" };

/** As the card takes them; the card itself is imported at run time, as a .tsx file. */
interface PressProps {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  askingMind: boolean;
  planned: Planned | null;
  estimate: CheckEstimateView["line"];
  estimateState: CheckEstimateView["state"];
}

let root: Root | null = null;
let container: HTMLElement;
let Press: ComponentType<PressProps>;

async function render(
  estimateState: CheckEstimateView["state"],
  at: Planned | null,
  line: CheckEstimateView["line"] = price,
) {
  await act(() =>
    root?.render(
      createElement(Press, {
        editor: {} as Editor,
        doc: {} as Y.Doc,
        mindId: "mind",
        askingMind: false,
        planned: at,
        estimate: line,
        estimateState,
      }),
    ),
  );
}

async function press() {
  const button = container.querySelector('[data-testid="badge-check-mind"]');
  if (!button) throw new Error("The card draws no Check button.");
  await act(() => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
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
  pressed.check.mockClear();
  pressed.unpriced.mockClear();
  pressed.running.value = false;
  const modulePath = "../../src/renderer/src/editor/CheckBadge.tsx";
  const module: { CheckActions: ComponentType<PressProps> } = await import(modulePath);
  Press = module.CheckActions;
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

// protects=#2313: the card's press hands `startCheck` the plan its price line was for; fails_when=it presses without that plan, so a plan made since the price runs at once, unpriced; no_claim=the press waiting for a price.
test("the card's press hands over the plan its price was for", async () => {
  await render("price", planned);
  await press();

  expect(pressed.check).toHaveBeenCalledWith("mind", planned);
  expect(pressed.unpriced).not.toHaveBeenCalled();
});

// protects=#2313: with no price yet the card asks instead of running, with no plan to hand over; fails_when=it presses the priced way while the estimate is pending; no_claim=the priced press above.
test("the card's press with no price asks instead", async () => {
  await render("pending", planned);
  await press();

  expect(pressed.unpriced).toHaveBeenCalledWith("mind");
  expect(pressed.check).not.toHaveBeenCalled();
});

// protects=#2313: at rest the foot shows the Check alone, with no progress line or Stop to make an empty band; fails_when=the run's line is laid out before a run; no_claim=the card's press.
test("the foot shows no run line or Stop before a run", async () => {
  await render("price", planned);
  expect(container.querySelector('[data-testid="card-foot-progress"]')).toBeNull();
  expect(container.querySelector('[data-testid="card-foot-stop"]')).toBeNull();
  expect(container.querySelector('[data-testid="badge-check-mind"]')).not.toBeNull();
});

// protects=#2313: at the press the run's words take Check's own row, and the hidden Check keeps the row's height; fails_when=the run's line is drawn as a new row, or the Check's room goes, so the foot moves; no_claim=the rest above.
test("the run's line takes Check's own row", async () => {
  await render("price", planned);
  pressed.running.value = true;
  await render("price", null);

  expect(container.querySelector('[data-testid="card-foot-progress"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="card-foot-stop"]')).not.toBeNull();
  const check = container.querySelector('[data-testid="badge-check-mind"]');
  expect(check?.getAttribute("data-hidden")).toBe("");
  expect(check?.getAttribute("disabled")).not.toBeNull();
});

// protects=#2313: while the run is on the price line stays as it was, shown, so no blank band takes its room; fails_when=the price line is hidden or removed at the press; no_claim=the price line shown before the run above.
test("the price line stays through the run", async () => {
  await render("price", planned);
  pressed.running.value = true;
  await render("price", null);

  const price = container.querySelector(".check-card-estimate");
  if (!price) throw new Error("The price line's room went at the press.");
  expect(price.getAttribute("data-hidden")).toBeNull();
  expect(container.querySelector('[data-testid="check-estimate"]')?.textContent).toBe(
    "About $1.40",
  );
});

// protects=#2313: after the run ends a card with no new price keeps the last price line shown, and the Check comes back; fails_when=the price line goes at the end of the run, so the foot goes blank; no_claim=the run above.
test("the last price line stays after the run ends", async () => {
  await render("price", planned);
  pressed.running.value = true;
  await render("price", null);
  pressed.running.value = false;
  await render("none", planned, null);

  const price = container.querySelector(".check-card-estimate");
  if (!price) throw new Error("The card went blank when the run ended.");
  expect(price.getAttribute("data-hidden")).toBeNull();
  expect(container.querySelector('[data-testid="check-estimate"]')).not.toBeNull();
  const check = container.querySelector('[data-testid="badge-check-mind"]');
  expect(check?.getAttribute("data-hidden")).toBeNull();
});

// protects=#2313: a card that never showed a price line keeps no empty line above Check; fails_when=the progress line's room is laid out at rest; no_claim=the price line's card above.
test("a card with no price line keeps no empty line at rest", async () => {
  await render("none", planned, null);
  expect(container.querySelector('[data-testid="card-foot-progress"]')).toBeNull();
});
