/**
 * The card of a Word file the User's AI saved (#3751): Open and Show in Finder, each press saying
 * why it didn't work under the card, as Export's saved line does. Only the newest press's problem
 * shows: an older one that fails late never puts its line under a newer one's.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

/** A press's answer, held until the test settles it. */
function held() {
  let fail: (error: Error) => void = () => {};
  let done: () => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  return { promise, fail, done };
}

/** The card in a DOM with no layout, the system's Open and Show answered as each test says. */
async function mounted(open: () => Promise<void>, show: () => Promise<void>) {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (target, name) => (name === "on" ? target.on : vi.fn(async () => [])) },
  );
  const window = Object.assign(document.defaultView, {
    incarnamind: bridge,
    incarnamindFiles: { openSavedFile: open, showSavedFile: show },
  });
  for (const [key, value] of Object.entries({ document, window, IS_REACT_ACT_ENVIRONMENT: true })) {
    vi.stubGlobal(key, value);
  }
  const path = "../../src/renderer/src/components/noteAsk/SavedFileCard.tsx";
  const { SavedFileCard } = (await import(path)) as {
    SavedFileCard: ComponentType<{ file: { path: string; name: string } }>;
  };
  const container = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  const file = {
    path: "/Users/ada/Documents/IncarnaMind/Harbour brief.docx",
    name: "Harbour brief.docx",
  };
  await act(async () => root.render(createElement(SavedFileCard, { file })));
  const press = (testId: string) =>
    act(async () => {
      (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null)?.click();
    });
  return {
    open: () => press("note-column-saved-open"),
    show: () => press("note-column-saved-show"),
    problem: () =>
      container.querySelector('[data-testid="note-column-saved-problem"]')?.textContent ?? null,
    unmount: () => act(async () => root.unmount()),
  };
}

describe("the card of a Word file the User's AI saved", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // protects=an Open that fails after a newer Show has said why it failed leaves the Show's line, the newest press's, under the card (#3751); fails_when=the older Open's late failure replaces the newer Show's line
  test("an older press that fails late keeps the newer press's problem", async () => {
    const opening = held();
    const card = await mounted(
      () => opening.promise,
      () => Promise.reject(new Error("The folder can't be shown.")),
    );
    await card.open();
    await card.show();
    expect(card.problem()).toContain("The folder can't be shown.");

    await act(async () => opening.fail(new Error("The file is open elsewhere.")));
    expect(card.problem()).toContain("The folder can't be shown.");
    expect(card.problem()).not.toContain("open elsewhere");
    await card.unmount();
  });

  // protects=an Open that fails after a newer Show worked shows no problem line at all: the newest press went well (#3751); fails_when=the older Open's late failure puts a line under the card
  test("an older press that fails after a newer one worked shows no problem", async () => {
    const opening = held();
    const card = await mounted(
      () => opening.promise,
      () => Promise.resolve(),
    );
    await card.open();
    await card.show();
    await act(async () => opening.fail(new Error("The file is open elsewhere.")));
    expect(card.problem()).toBeNull();
    await card.unmount();
  });
});
