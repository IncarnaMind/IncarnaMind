import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Language } from "../../src/core/language";

/*
 * A verdict card's last line names what checked its sentence, and when (#1667): the model whose
 * verdict it is, or, for a sentence its Citation states word for word, that no AI model did. A
 * card with no verdict has no such line.
 */

let root: Root | null = null;
let container: HTMLElement;
let CheckedByLine: ComponentType<Record<string, unknown>>;
let setLanguage: (language: Language) => void;

const CHECKED_AT = "2026-10-23T14:03:00.000Z";

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (each, name) => (name === "on" ? each.on : () => Promise.resolve(undefined)) },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  setLanguage = (language) =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, language } as never,
    });
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const linePath = "../../src/renderer/src/editor/CheckedByLine.tsx";
  ({ CheckedByLine } = await import(linePath));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function lineOf(check: Record<string, unknown>, verdict = true, language: Language = "en") {
  setLanguage(language);
  await act(() =>
    root?.render(
      createElement(CheckedByLine, {
        check: { providerId: null, modelId: null, checkedAt: CHECKED_AT, ...check },
        verdict,
      }),
    ),
  );
  return container.querySelector('[data-testid="claim-checked-by"]')?.textContent ?? null;
}

describe("the line that names what checked a sentence", () => {
  // protects=a verdict's card names its model, by its menu name, with the time, in English and Chinese (#1667); fails_when=the line is gone or names the model by its id; no_claim=the time's own format, which src/shared/dates.ts owns.
  test.each([
    ["en", /^Checked with Claude Haiku 5\.5, /u],
    ["zh-CN", /^由 Claude Haiku 5\.5 核对，/u],
  ] as const)("names the model that checked it (%s)", async (language, said) => {
    expect(await lineOf({ modelId: "claude-haiku-5-5" }, true, language)).toMatch(said);
  });

  // protects=a sentence its Citation states word for word says no AI model checked it, in English and Chinese (#1667); fails_when=the copy test's card names a model, or none; no_claim=none beyond protects.
  test.each([
    ["en", /^Checked word for word against its quote, no AI model, /u],
    ["zh-CN", /^与引文逐字一致，未使用 AI 模型，/u],
  ] as const)("says no AI model checked a copy (%s)", async (language, said) => {
    expect(await lineOf({ wordForWord: true }, true, language)).toMatch(said);
  });

  // protects=a card with no verdict, or whose model isn't known, has no line (#1667); fails_when=a not-checked card names a model; no_claim=none beyond protects.
  test("a card with no verdict, or no model known, has no line", async () => {
    expect(await lineOf({ modelId: "claude-haiku-5-5" }, false)).toBeNull();
    expect(await lineOf({})).toBeNull();
  });
});
