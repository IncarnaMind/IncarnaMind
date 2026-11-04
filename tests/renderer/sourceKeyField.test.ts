import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { expect, test, vi } from "vitest";
import type { SourceProviderInfo } from "../../src/core/api";

/*
 * Find sources' key field keeps what the User types after a key was sent (#2302). React reads a
 * field's typing only when it finds a document with typing events as it loads, so the document
 * comes before React here.
 */

const document = new DOMParser().parseFromString(
  "<html><head></head><body></body></html>",
  "text/html",
);
const window = document.defaultView;
const calls = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const bridge = new Proxy(
  { on: () => () => undefined },
  {
    get: (each, name: string) =>
      name === "on" ? each.on : (calls.get(name) ?? (() => Promise.resolve(undefined))),
  },
);
Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
// How React tells, as it loads, that this document has typing events.
Object.assign(document, { oninput: null });
const globals: Record<string, unknown> = {
  document,
  window,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Event: window.Event,
  Node: window.Node,
  navigator: { languages: ["en-US"], userAgent: "node" },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

const govInfo: SourceProviderInfo = {
  id: "govinfo",
  name: "GovInfo",
  service: { id: "https://api.govinfo.gov", name: "GovInfo" },
  searches: false,
  consent: "accepted",
  termsUrl: "https://www.govinfo.gov/about/policies",
  searchedByDefault: false,
  key: "unset",
  keyNeeded: true,
  keySignUp: null,
};

test("a key typed in the field opened again while the last one was kept stays", async () => {
  const keeping = Promise.withResolvers<void>();
  const kept: unknown[][] = [];
  calls.set("setSourceProviderKey", (...args) => {
    kept.push(args);
    return keeping.promise;
  });
  calls.set("listSourceProviders", async () => [govInfo]);
  const fieldPath = "../../src/renderer/src/components/SourceKeyField.tsx";
  const { SourceKeyField } = (await import(fieldPath)) as {
    SourceKeyField: ComponentType<{ provider: SourceProviderInfo }>;
  };
  const { useFindSources } = await import("../../src/renderer/src/findSources");
  const container: HTMLElement = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SourceKeyField, { provider: govInfo })));
  const field = () => container.querySelector<HTMLInputElement>('[data-testid="find-sources-key"]');
  const type = (text: string) =>
    act(async () => {
      const input = field();
      if (!input) throw new Error("The key field isn't open.");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        input,
        text,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const toggle = () =>
    act(async () => {
      container
        .querySelector('[data-testid="find-sources-key-open"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });

  await toggle();
  await type("first-key-1234");
  await act(async () => {
    const form = field()?.closest("form");
    form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  // Closed and opened again while the key is kept, with another one typed.
  await toggle();
  await toggle();
  await type("second-key-5678");
  await act(async () => keeping.resolve());

  expect(kept).toEqual([["govinfo", "first-key-1234"]]);
  expect(useFindSources.getState().keyOpen).toBe("govinfo");
  expect(field()?.value).toBe("second-key-5678");
  await act(async () => root.unmount());
});
