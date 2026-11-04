import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FigureSchedule } from "../../src/core/api";

/*
 * The Figure schedule's two check starts (#2313): Check again on chosen figures and the re-check
 * after Change to the source's figure go through the same asking entry as every other way in —
 * the price above $1 or under a spending cap, and the couldn't-estimate line — never a run at
 * once with the price unseen.
 */

const started = vi.hoisted(() => ({
  figures: vi.fn(async () => null),
  note: vi.fn(async () => null),
  direct: vi.fn(),
  change: vi.fn(() => null),
}));
vi.mock("../../src/renderer/src/mindCheck", () => ({
  startFigureCheckAsking: started.figures,
  startCheckAsking: started.note,
  checkMind: started.direct,
}));
vi.mock("../../src/renderer/src/components/figures/FigureScheduleView", () => ({
  FigureScheduleView: ({
    onCheckAgain,
    onChangeToSource,
  }: {
    onCheckAgain(ids: string[]): void;
    onChangeToSource(ids: string[]): void;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "view-check-again",
          onClick: () => onCheckAgain(["f1", "f2"]),
        },
        "Check again",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "view-change-source",
          onClick: () => onChangeToSource(["f1"]),
        },
        "Change to the source's figure",
      ),
    ),
}));
vi.mock("../../src/renderer/src/figures", () => ({
  useFigureSchedule: () => ({ rows: [], basis: null }) as unknown as FigureSchedule,
  focusFigure: vi.fn(),
}));
vi.mock("../../src/renderer/src/mindCopies", () => ({
  openMindCopy: (
    _mindId: string,
    opened: (copy: { doc: object; access: string }) => void,
  ): (() => void) => {
    opened({ doc: {}, access: "edit" });
    return () => {};
  },
}));
vi.mock("../../src/renderer/src/core", () => ({
  core: { searchEvidence: vi.fn(), citeSelection: vi.fn() },
}));
const state = vi.hoisted(() => ({
  documents: [],
  minds: [{ id: "mind", folderId: null }],
  reportError: vi.fn(),
  openMind: vi.fn(async () => {}),
}));
vi.mock("../../src/renderer/src/store", () => {
  const store = state;
  return {
    useAppStore: Object.assign((selector: (each: typeof store) => unknown) => selector(store), {
      getState: () => store,
    }),
  };
});
vi.mock("../../src/renderer/src/undo", () => ({
  useUndo: { getState: () => ({ withdraw: vi.fn() }) },
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  translateNow: (key: string) => key,
  useLanguage: () => "en",
  useT: () => (key: string) => key,
}));
vi.mock("../../src/renderer/src/components/tabs/tabItems", () => ({ useTabPlace: () => null }));
vi.mock("../../src/renderer/src/components/ExportResultLine", () => ({
  ExportResultLine: () => null,
}));
vi.mock("../../src/renderer/src/components/SearchPicker", () => ({ SearchPicker: () => null }));
vi.mock("../../src/renderer/src/exports", () => ({ exportFigureSchedule: vi.fn() }));
vi.mock("../../src/renderer/src/checks", () => ({ stopCheck: vi.fn() }));
vi.mock("../../src/renderer/src/editor/figureActions", () => ({
  addFigureCitation: vi.fn(),
  changeFiguresToSource: started.change,
  editNote: vi.fn(() => null),
  keepFigureViews: vi.fn(() => null),
  setFigureTotalRole: vi.fn(() => null),
}));
vi.mock("../../src/renderer/src/editor/signOffActions", () => ({
  currentSigner: () => "someone",
  figureMarkOf: vi.fn(),
  setFigureSignOffs: vi.fn(() => null),
}));
vi.mock("../../src/renderer/src/openCited", () => ({
  openCited: vi.fn(),
  quoteSaysSo: vi.fn(),
}));

let root: Root | null = null;
let container: HTMLElement;
let Tab: ComponentType<{ mindId: string }>;

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
  started.figures.mockClear();
  started.note.mockClear();
  started.direct.mockClear();
  const modulePath = "../../src/renderer/src/components/figures/FigureScheduleTab.tsx";
  const module: { FigureScheduleTab: ComponentType<{ mindId: string }> } = await import(modulePath);
  Tab = module.FigureScheduleTab;
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function click(testId: string) {
  const button = container.querySelector(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`No ${testId} drawn.`);
  await act(() => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function render() {
  await act(() => root?.render(createElement(Tab, { mindId: "mind" })));
}

// protects=#2313: Check again on chosen figures asks through the same entry as every other way in; fails_when=it calls the core's check directly and spends above $1 or under a cap unseen; no_claim=the figures it checks.
test("Check again on chosen figures asks before it checks them", async () => {
  await render();
  await click("view-check-again");

  expect(started.figures).toHaveBeenCalledWith("mind", ["f1", "f2"]);
  expect(started.direct).not.toHaveBeenCalled();
});

// protects=#2313: the re-check after Change to the source's figure asks too; fails_when=it runs the changed check directly with no price question; no_claim=the figures it changes.
test("the re-check after Change to the source's figure asks too", async () => {
  await render();
  await click("view-change-source");

  expect(started.note).toHaveBeenCalledWith("mind");
  expect(started.direct).not.toHaveBeenCalled();
});
