import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EmbeddingModelError, EmbeddingModelStatus, Settings } from "../../src/core/api";

/*
 * The problem line a failed model download shows (#1578), rendered by the sidebar's own status
 * row: when every one of several sources failed it says so once, with Try again, and the source
 * choice shows only under Details; one source alone, or a model that wouldn't start, keeps the
 * plain line. The words are the real i18n's, in both languages.
 */

const TEST_ID = "embedding-model";

const WORDS = {
  en: {
    line: "Couldn’t download the search model from any source",
    plain: "Search model download failed",
    notStarted: "Search model couldn’t start",
    tryAgain: "Try again",
    retry: "Retry",
    details: "Details",
    label: "Download source:",
    choices: ["Automatic", "Hugging Face", "ModelScope"],
    failed: ["Hugging Face: fetch failed", "ModelScope: fetch failed"],
  },
  "zh-CN": {
    line: "未能从任何来源下载搜索模型",
    plain: "搜索模型下载失败",
    notStarted: "搜索模型无法启动",
    tryAgain: "重试",
    retry: "重试",
    details: "详情",
    label: "下载来源：",
    choices: ["自动", "Hugging Face", "魔搭社区"],
    failed: ["Hugging Face：fetch failed", "魔搭社区：fetch failed"],
  },
} as const;

type Language = keyof typeof WORDS;
const LANGUAGES = ["en", "zh-CN"] as const satisfies readonly Language[];

const huggingface = { source: "huggingface", message: "fetch failed" } as const;
const modelscope = { source: "modelscope", message: "fetch failed" } as const;

const everySourceFailed: EmbeddingModelError = {
  kind: "network",
  message: "fetch failed",
  sources: [huggingface, modelscope],
};
const oneSourceFailed: EmbeddingModelError = {
  kind: "network",
  message: "fetch failed",
  sources: [huggingface],
};
const wouldNotStart: EmbeddingModelError = {
  kind: "load",
  message: "bad model",
  sources: [huggingface, modelscope],
};

let root: Root | null = null;
let container: HTMLElement;
let SidebarStatus: ComponentType<{ problemsOnly?: boolean }>;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  // The core and file bridges the sidebar loads with: `on` hands back its stop, the rest resolve.
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
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const sidebarPath = "../../src/renderer/src/components/SidebarStatus.tsx";
  const sidebar: { SidebarStatus: ComponentType<{ problemsOnly?: boolean }> } = await import(
    sidebarPath
  );
  SidebarStatus = sidebar.SidebarStatus;
  ({ useAppStore } = await import("../../src/renderer/src/store"));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function show(error: EmbeddingModelError, language: Language) {
  const model: EmbeddingModelStatus = {
    name: "multilingual-e5-small",
    host: "huggingface.co",
    state: "failed",
    downloadedBytes: 0,
    totalBytes: 135_000_000,
    error,
  };
  const settings = { language, device: { modelSource: "auto" } } as unknown as Settings;
  useAppStore.setState({ embeddingModel: model, settings });
  await act(() => root?.render(createElement(SidebarStatus, { problemsOnly: true })));
}

const part = (id: string) => container.querySelector(`[data-testid="${TEST_ID}-${id}"]`);

async function click(target: Element | null) {
  if (!target) throw new Error("Missing click target");
  await act(() => {
    target.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

const textsOf = (element: Element | null, selector: string) =>
  [...(element?.querySelectorAll(selector) ?? [])].map((each) => each.textContent);

describe("the problem line when every download source fails (#1578)", () => {
  test.each(LANGUAGES)(
    "says it plainly, offers Try again, and shows the source only in Details (%s)",
    async (language) => {
      const words = WORDS[language];
      await show(everySourceFailed, language);

      expect(part("failed")?.textContent).toContain(words.line);
      expect(part("retry")?.textContent).toBe(words.tryAgain);
      expect(part("details")?.textContent).toBe(words.details);

      // The choice shows nowhere but under Details, which the line offers and keeps shut.
      expect(container.textContent).not.toContain(words.label);
      expect(part("sources")).toBeNull();

      await click(part("details"));

      expect(part("sources")?.textContent).toContain(words.label);
      expect(textsOf(part("sources"), "li")).toEqual(words.failed);
      expect(textsOf(part("sources"), "option")).toEqual(words.choices);
    },
  );

  test.each(LANGUAGES)("a single source failing keeps the plain line (%s)", async (language) => {
    const words = WORDS[language];
    await show(oneSourceFailed, language);

    expect(part("failed")?.textContent).toContain(words.plain);
    expect(part("failed")?.textContent).not.toContain(words.line);
    expect(part("retry")?.textContent).toBe(words.retry);
    expect(part("details")).toBeNull();
    expect(container.textContent).not.toContain(words.label);
  });

  test.each(LANGUAGES)(
    "a model that downloaded but wouldn’t start is no source failure, with several sources tried (%s)",
    async (language) => {
      const words = WORDS[language];
      await show(wouldNotStart, language);

      expect(part("failed")?.textContent).toContain(words.notStarted);
      expect(part("retry")?.textContent).toBe(words.retry);
      expect(part("details")).toBeNull();
      expect(container.textContent).not.toContain(words.label);
    },
  );
});
