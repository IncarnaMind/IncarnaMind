import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentPairing,
  Document,
  LibraryGroup,
  LibrarySnapshot,
  OllamaStatus,
} from "../../src/core/api";

/*
 * A reply that comes after a newer one, in a row of Settings, doesn't put the older state back
 * (#2302): the Ollama card's look, and an agent's Folders after a refused change.
 */

let root: Root | null = null;
let container: HTMLElement;
const calls = new Map<string, (...args: unknown[]) => Promise<unknown>>();

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name: string) =>
        name === "on" ? each.on : (calls.get(name) ?? (() => Promise.resolve(undefined))),
    },
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
    navigator: { languages: ["en-US"], clipboard: { writeText: async () => undefined } },
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
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  calls.clear();
  vi.unstubAllGlobals();
});

const running: OllamaStatus = {
  running: true,
  baseUrl: "http://127.0.0.1:11434",
  models: ["qwen3.5:4b"],
  cloudModels: [],
  recommendedModel: "qwen3.5:4b",
};

/** A look that ran out of time: nothing was heard. */
const unheard: OllamaStatus = {
  running: false,
  unknown: true,
  baseUrl: "http://127.0.0.1:11434",
  installed: true,
  recommendedModel: "qwen3.5:4b",
};

describe("The Ollama card", () => {
  test("an earlier look that ran out of time doesn't replace a later one that found it running", async () => {
    const looks: PromiseWithResolvers<OllamaStatus>[] = [];
    calls.set("detectOllama", () => {
      const look = Promise.withResolvers<OllamaStatus>();
      looks.push(look);
      return look.promise;
    });
    // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
    const cardPath = "../../src/renderer/src/components/providers/OllamaCard.tsx";
    const { useOllamaStatus } = (await import(cardPath)) as {
      useOllamaStatus(): { status: OllamaStatus | null; detect(): Promise<void> };
    };
    const seen: { now: ReturnType<typeof useOllamaStatus> | null } = { now: null };
    const Probe = () => {
      seen.now = useOllamaStatus();
      return null;
    };
    await act(() => root?.render(createElement(Probe)));
    expect(looks).toHaveLength(1);

    // Look again: Ollama answers this time.
    await act(async () => {
      void seen.now?.detect();
    });
    await act(async () => looks[1]?.resolve(running));
    await act(async () => looks[0]?.resolve(unheard));

    expect(seen.now?.status).toEqual(running);
  });
});

const folder = (id: string, name: string): LibraryGroup => ({
  id,
  name,
  description: "",
  countsOwnFiles: false,
  keepInside: false,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
});

const pairing = (folderIds: string[]): AgentPairing => ({
  id: "pairing",
  name: "Claude Code",
  folderIds,
  client: null,
  lastUsedAt: null,
  createdAt: "2026-10-31T09:00:00.000Z",
});

describe("A connected agent's Folders", () => {
  test("a refused change goes back to the Folders the core said last, not those it was asked with", async () => {
    const folders = [
      folder("tides", "Tides"),
      folder("harbours", "Harbours"),
      folder("ports", "Ports"),
    ];
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({
      documents: folders.map((each) => ({ id: `in ${each.id}`, name: each.name }) as Document),
      library: {
        groups: folders,
        assignments: folders.map((each) => ({ documentId: `in ${each.id}`, groupId: each.id })),
      } as unknown as LibrarySnapshot,
    });
    const updating = Promise.withResolvers<AgentPairing>();
    calls.set("updateAgent", () => updating.promise);
    const rowPath = "../../src/renderer/src/components/agents/AgentPairingRow.tsx";
    const { AgentPairingRow } = (await import(rowPath)) as {
      AgentPairingRow: ComponentType<Record<string, unknown>>;
    };
    const show = (folderIds: string[]) =>
      act(() =>
        root?.render(
          createElement(AgentPairingRow, {
            pairing: pairing(folderIds),
            skillInstalled: false,
            folders,
            justSetUp: null,
            onUndone: () => undefined,
          }),
        ),
      );
    const reads = () => container.querySelector('[data-testid="agent-pairing-reads"]')?.textContent;
    await show(["tides"]);
    await act(async () => {
      container
        .querySelector('[data-testid="agent-folders"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    const harbours = container.querySelector<HTMLInputElement>('[data-folder="harbours"]');
    if (!harbours) throw new Error("The Folders aren't listed.");
    await act(async () => {
      // A click ticks the box first, as a browser's does, then says so.
      harbours.checked = true;
      harbours.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(reads()).toContain("Harbours");

    // Another window gives the agent Ports while this change waits; then the core refuses it.
    await show(["tides", "ports"]);
    await act(async () => updating.reject(new Error("The agent's Folders couldn't be changed.")));

    expect(reads()).toContain("Tides, Ports");
    expect(reads()).not.toContain("Harbours");
  });
});
