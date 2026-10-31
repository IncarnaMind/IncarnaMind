import { parseHTML } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CoreBridge, DocumentCheckPlan, RunEstimate, SearchScope } from "../../src/core/api";

const bridge = vi.hoisted(() => ({
  planDocumentCheck: vi.fn<CoreBridge["planDocumentCheck"]>(),
  on: vi.fn(() => () => {}),
}));
const read = vi.hoisted(() => vi.fn());
const dismissDocumentPicker = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
const checksState = vi.hoisted(() => ({
  pickDocument: {} as Record<string, unknown>,
  running: {} as Record<string, unknown>,
  documentProgress: {},
}));
vi.mock("../../src/renderer/src/checks", () => ({
  checkSentences: read,
  dismissDocumentPicker,
  planDocumentRead: (
    _editor: unknown,
    mindId: string,
    _doc: unknown,
    { within }: { within: SearchScope },
  ) => bridge.planDocumentCheck({ mindId, within } as never),
  setDocumentProgress: vi.fn(),
  stopCheck: vi.fn(),
  useChecks: (selector: (state: unknown) => unknown) => selector(checksState),
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => "en",
  useT: () => (key: string, params?: { scope?: string; pages?: number }) =>
    `${key}:${params?.scope ?? ""}:${params?.pages ?? ""}`,
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: () => null }));
vi.mock("../../src/renderer/src/turnWall", () => ({ useTurnWall: () => null }));
vi.mock("../../src/renderer/src/scopeDocuments", () => ({
  useScopeName: (scope: SearchScope | null) => ({
    name: scope?.documentIds[0] ?? "",
    more: 0,
    kind: "document",
    deleted: false,
  }),
}));
vi.mock("../../src/renderer/src/components/DocumentOrFolderPicker", async () => {
  const { createElement: element } = await import("react");
  return {
    DocumentOrFolderPicker: ({
      onChoose,
      onClose,
    }: {
      onChoose(scope: SearchScope): void;
      onClose(): void;
    }) =>
      element(
        "div",
        null,
        ...["A", "B"].map((id) =>
          element(
            "button",
            {
              key: id,
              "data-testid": `pick-${id}`,
              onClick: () => {
                onClose();
                onChoose({ folderIds: [], tagIds: [], documentIds: [id] });
              },
            },
            id,
          ),
        ),
        element("button", { "data-testid": "picker-close", onClick: onClose }, "Close"),
      ),
  };
});
vi.mock("../../src/renderer/src/components/ProblemLine", async () => {
  const { createElement: element } = await import("react");
  return { ProblemLine: () => element("p", null, "Problem") };
});
vi.mock("../../src/renderer/src/editor/MindCheckLine", async () => {
  const { createElement: element } = await import("react");
  return {
    AskBlock: ({
      testId,
      question,
      estimate,
      check,
      notNow,
    }: {
      testId: string;
      question: string;
      estimate: { title: string } | null;
      check: { testId: string; onClick(): void };
      notNow: { testId: string; onClick(): void };
    }) =>
      element(
        "div",
        { "data-testid": testId },
        element("span", { "data-testid": "ask-question" }, question),
        estimate && element("span", { "data-testid": "ask-estimate" }, estimate.title),
        element("button", { "data-testid": check.testId, onClick: check.onClick }, "Read"),
        element("button", { "data-testid": notNow.testId, onClick: notNow.onClick }, "Not now"),
      ),
  };
});

const scope = (id: string): SearchScope => ({ folderIds: [], tagIds: [], documentIds: [id] });
const estimate = (amount: number): RunEstimate => ({
  billing: "per-token",
  calls: 3,
  tokens: 1000,
  cost: { amount, currency: "USD" },
  cap: null,
  spentTowardCap: null,
  setAsideTowardCap: null,
});
const ready = (
  pages: number,
  amount: number,
  id = `plan-${pages}`,
  parts: number | null = 1,
): DocumentCheckPlan => ({
  kind: "ready",
  id,
  parts,
  documents: [],
  pages,
  readable: pages,
  tokens: 1000,
  estimate: estimate(amount),
});
const deferred = <T>() => {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = (value) => done(value);
  });
  return { promise, resolve };
};

let root: Root;
let container: HTMLElement;
let window: ReturnType<typeof parseHTML>["window"];

async function click(testId: string) {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`No ${testId}.`);
  await act(async () => {
    element.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function render() {
  const module = "../../src/renderer/src/editor/DocumentCheckAction";
  const { DocumentCheckAction } = (await import(module)) as {
    DocumentCheckAction: ComponentType<Record<string, unknown>>;
  };
  const editor = { isDestroyed: false };
  const claim = { check: { id: "claim" }, from: 0, to: 1 };
  await act(async () => {
    root.render(
      createElement(DocumentCheckAction, {
        // The component uses these only as opaque arguments to the mocked check.
        editor: editor as never,
        mindId: "mind",
        doc: {} as never,
        claim: claim as never,
        offer: true,
      }),
    );
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  checksState.pickDocument = {};
  checksState.running = {};
  read.mockResolvedValue(undefined);
  ({ window } = parseHTML("<!doctype html><html><body></body></html>"));
  container = window.document.createElement("div");
  window.document.body.appendChild(container);
  Object.assign(globalThis, {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot: makeRoot } = await import("react-dom/client");
  root = makeRoot(container);
  await render();
});

afterEach(async () => {
  if (container.hasChildNodes()) await act(async () => root.unmount());
});

test("a replaced selection cannot supply the confirmation or its scope", async () => {
  const a = deferred<DocumentCheckPlan>();
  const b = deferred<DocumentCheckPlan>();
  bridge.planDocumentCheck.mockImplementation(({ within }) =>
    within.documentIds[0] === "A" ? a.promise : b.promise,
  );
  await click("claim-check-document");
  await click("pick-A");
  await click("claim-check-document");
  await click("pick-B");
  await act(async () => b.resolve(ready(12, 1)));
  expect(container.querySelector('[data-testid="ask-question"]')?.textContent).toContain(":B:12");
  expect(container.querySelector('[data-testid="ask-estimate"]')).not.toBeNull();

  await act(async () => a.resolve(ready(99, 2)));
  expect(container.querySelector('[data-testid="ask-question"]')?.textContent).toBe(
    "claim.readAsk:B:12",
  );
  await click("document-check-read");
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[4]).toMatchObject({ within: scope("B"), plan: "plan-12" });
});

test("only the latest low-estimate selection can auto-read", async () => {
  const a = deferred<DocumentCheckPlan>();
  bridge.planDocumentCheck.mockImplementation(({ within }) =>
    within.documentIds[0] === "A" ? a.promise : Promise.resolve(ready(3, 0.4)),
  );
  await click("claim-check-document");
  await click("pick-A");
  await click("claim-check-document");
  await click("pick-B");
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

  await act(async () => a.resolve(ready(99, 0.4)));

  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[4]).toMatchObject({ within: scope("B"), plan: "plan-3" });
  expect(container.querySelector('[data-testid="document-check-ask"]')).toBeNull();
});

test("dismissing the action invalidates a pending low-estimate plan", async () => {
  const a = deferred<DocumentCheckPlan>();
  bridge.planDocumentCheck.mockReturnValue(a.promise);
  await click("claim-check-document");
  await click("pick-A");
  await act(async () => root.unmount());

  await act(async () => a.resolve(ready(3, 0.4)));

  expect(read).not.toHaveBeenCalled();
});

test("a read whose parts aren't sorted yet asks its cost, however small", async () => {
  bridge.planDocumentCheck.mockResolvedValue(ready(3, 0.1, "plan-unsorted", null));
  await click("claim-check-document");
  await click("pick-A");

  expect(read).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="document-check-ask"]')).not.toBeNull();
  await click("document-check-read");
  expect(read.mock.calls[0]?.[4]).toMatchObject({ within: scope("A"), plan: "plan-unsorted" });
});

// The most is the budget the read is held to, so only what it costs about decides whether it asks.
const priced = (parts: number | null, about: number, most: number): DocumentCheckPlan => {
  const plan = ready(3, about, `plan-${parts}-${about}-${most}`, parts);
  if (plan.kind !== "ready" || plan.estimate?.billing !== "per-token") return plan;
  return {
    ...plan,
    estimate: {
      ...plan.estimate,
      upTo: { calls: 40, tokens: 9000, cost: { amount: most, currency: "USD" } },
    },
  };
};

// An unsorted sentence's parts, and so its cost, aren't known before a model call.
test.each([
  { sorted: "sorted", parts: 1, about: 0.12, most: 0.5, reads: true },
  { sorted: "sorted", parts: 1, about: 0.5, most: 3, reads: true },
  { sorted: "sorted", parts: 1, about: 0.6, most: 3, reads: false },
  { sorted: "unsorted", parts: null, about: 0.12, most: 0.5, reads: false },
  { sorted: "unsorted", parts: null, about: 0.6, most: 3, reads: false },
])(
  "a read of $sorted parts, about $about and at most $most dollars, starts unasked: $reads",
  async ({ parts, about, most, reads }) => {
    const plan = priced(parts, about, most);
    bridge.planDocumentCheck.mockResolvedValue(plan);
    await click("claim-check-document");
    await click("pick-A");

    if (reads) {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect(container.querySelector('[data-testid="document-check-ask"]')).toBeNull();
      return;
    }
    expect(read).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="document-check-ask"]')).not.toBeNull();
    await click("document-check-read");
    expect(read.mock.calls[0]?.[4]).toMatchObject({ plan: plan.kind === "ready" ? plan.id : "" });
  },
);

test("a read asked again waits while the Note's check runs, then sizes it and asks", async () => {
  bridge.planDocumentCheck.mockResolvedValue(ready(12, 2));
  checksState.running = { mind: { requestId: "earlier", action: "check-against-document" } };
  checksState.pickDocument = { claim: scope("A") };
  await render();

  expect(bridge.planDocumentCheck).not.toHaveBeenCalled();
  expect(
    container.querySelector('[data-testid="claim-check-document"]')?.hasAttribute("disabled"),
  ).toBe(true);

  checksState.running = {};
  await render();
  await vi.waitFor(() => expect(bridge.planDocumentCheck).toHaveBeenCalledOnce());
  expect(dismissDocumentPicker).toHaveBeenCalledWith("claim");
  expect(container.querySelector('[data-testid="ask-question"]')?.textContent).toContain(":A:12");
  expect(read).not.toHaveBeenCalled();
});

test("a read asked again asks before reading, however small", async () => {
  bridge.planDocumentCheck.mockResolvedValue(ready(3, 0.1));
  checksState.pickDocument = { claim: scope("A") };
  await render();

  await vi.waitFor(() => expect(bridge.planDocumentCheck).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="document-check-ask"]')).not.toBeNull(),
  );
  expect(read).not.toHaveBeenCalled();
  await click("document-check-read");
  expect(read.mock.calls[0]?.[4]).toMatchObject({ within: scope("A"), plan: "plan-3" });
});

test("a request the card never took up goes when the card closes", async () => {
  checksState.running = { mind: { requestId: "earlier", action: "check-against-document" } };
  checksState.pickDocument = { claim: scope("A") };
  await render();
  dismissDocumentPicker.mockClear();

  await act(async () => root.unmount());

  expect(dismissDocumentPicker).toHaveBeenCalledWith("claim");
  expect(bridge.planDocumentCheck).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
