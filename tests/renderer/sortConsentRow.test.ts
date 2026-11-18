import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, ExternalService, LibrarySnapshot, Settings } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";

/*
 * The sidebar's row that asks before the first Document goes to a cloud service (#3353), rendered
 * by the sidebar's own status row: it shows while the switch asks and Documents wait, with or
 * without a Folder, names every service it asks for, and has two answers. Allow is the consent,
 * then the Documents that waited are read as the User asked: organized where there are Folders,
 * tagged where there are none. Don't allow turns the switch off as the User's own no. When nothing
 * asks, no row shows.
 */

const ANTHROPIC: ExternalService = { id: "https://api.anthropic.com", name: "Anthropic" };
const OPENAI: ExternalService = { id: "https://api.openai.com", name: "OpenAI" };

const calls: { name: string; input: unknown }[] = [];
let library: LibrarySnapshot;

let root: Root | null = null;
let container: HTMLElement;
let SidebarStatus: ComponentType<{ problemsOnly?: boolean }>;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;

const snapshot = (asksFor: ExternalService[], folder: boolean): LibrarySnapshot => ({
  groups: folder
    ? [
        {
          id: "folder-1",
          name: "Harbour",
          parentId: null,
          keepInside: false,
        } as LibrarySnapshot["groups"][number],
      ]
    : [],
  deletedGroups: [],
  assignments: [],
  settings: {
    classifier: { kind: "automatic" },
    automatic: false,
    organizeWith: null,
    taggingStopped: [],
  },
  asksFor,
  reviewCount: 0,
});

const waitingDocument = (id: string, name: string) =>
  ({
    id,
    name,
    status: "ready",
    tagging: "off",
    meetingMindId: null,
    linkedFolderId: null,
    tags: [],
  }) as unknown as Document;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    {
      on: () => () => undefined,
      getLibrary: async () => library,
      saveLibrarySettings: async (input: { automatic: boolean }) => {
        calls.push({ name: "saveLibrarySettings", input });
        library = {
          ...library,
          settings: { ...library.settings, automatic: input.automatic },
          asksFor: [],
        };
      },
      allowOrganize: async (serviceId: string) => {
        calls.push({ name: "allowOrganize", input: serviceId });
        return { ready: true, model: "chat" };
      },
      startOrganize: async () => {
        calls.push({ name: "startOrganize", input: null });
        return { ready: false, needs: "model", noProvider: false };
      },
      retagDocuments: async (ids: string[]) => {
        calls.push({ name: "retagDocuments", input: ids });
      },
    },
    {
      get: (each, name) =>
        name in each
          ? (each as Record<string, unknown>)[name as string]
          : () => Promise.resolve(undefined),
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
  const { useJoinedMeetings } = await import("../../src/renderer/src/joinedMeetings");
  const { useMeetingsLeftApart } = await import("../../src/renderer/src/meetingsLeftApart");
  useJoinedMeetings.setState({ joined: [], loaded: true });
  useMeetingsLeftApart.setState({ left: [], loaded: true });
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  calls.length = 0;
  vi.unstubAllGlobals();
});

async function show(
  language: "en" | "zh-CN",
  { asksFor = [ANTHROPIC], folder = false }: { asksFor?: ExternalService[]; folder?: boolean } = {},
) {
  library = snapshot(asksFor, folder);
  useAppStore.setState({
    settings: { language, device: {} } as unknown as Settings,
    documents: [waitingDocument("doc-1", "Survey 1"), waitingDocument("doc-2", "Survey 2")],
    examples: null,
    otherExamples: [],
    library,
  } as never);
  await act(() => root?.render(createElement(SidebarStatus, { problemsOnly: true })));
}

const row = () => container.querySelector('[data-testid="sort-consent"]');
const allowButton = () => row()?.querySelector('[data-testid="sort-consent-allow"]') ?? null;
const noButton = (language: "en" | "zh-CN") =>
  row()?.querySelector(`button[aria-label="${translate(language, "library.toSort.dontAllow")}"]`) ??
  null;

async function press(target: Element | null) {
  if (!target) throw new Error("Missing click target");
  await act(async () => {
    target.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

describe.each(["en", "zh-CN"] as const)("the row that asks first (%s)", (language) => {
  test("with no Folder it asks to tag, names the service, and its Allow tags those that waited", async () => {
    await show(language);
    expect(row()?.querySelector('[data-testid="status-label"]')?.textContent).toBe(
      translate(language, "library.toTag.other", { count: 2 }),
    );
    expect(row()?.textContent).toContain(
      translate(language, "library.toTag.sends.other", { count: 2, service: "Anthropic" }),
    );
    expect(allowButton()?.textContent).toBe(
      translate(language, "library.toSort.allow", { service: "Anthropic" }),
    );
    expect(noButton(language)).not.toBeNull();

    await press(allowButton());
    expect(calls.map((each) => each.name)).toEqual(["saveLibrarySettings", "retagDocuments"]);
    expect(calls[0]?.input).toMatchObject({ automatic: true, turnOn: true });
    expect(calls[1]?.input).toEqual(["doc-1", "doc-2"]);
  });

  test("with a Folder it asks to organize, and its Allow covers Organize before it runs", async () => {
    await show(language, { folder: true });
    expect(row()?.querySelector('[data-testid="status-label"]')?.textContent).toBe(
      translate(language, "library.toSort.other", { count: 2 }),
    );

    await press(allowButton());
    expect(calls.map((each) => each.name)).toEqual([
      "saveLibrarySettings",
      "allowOrganize",
      "startOrganize",
    ]);
    expect(calls[0]?.input).toMatchObject({ automatic: true, turnOn: true });
    expect(calls[1]?.input).toBe(ANTHROPIC.id);
  });

  test("names every service it asks for", async () => {
    await show(language, { asksFor: [ANTHROPIC, OPENAI] });
    const services = translate(language, "library.toSort.allow", {
      service: language === "en" ? "Anthropic and OpenAI" : "Anthropic 和 OpenAI",
    });
    expect(allowButton()?.textContent).toBe(services);
  });

  test("Don't allow turns the switch off as the User's no, and the row goes", async () => {
    await show(language);
    await press(noButton(language));
    expect(calls).toEqual([
      {
        name: "saveLibrarySettings",
        input: expect.objectContaining({ automatic: false, turnOn: false }),
      },
    ]);
    await vi.waitFor(() => expect(row()).toBeNull());
  });

  test("nothing asks: no row, though Documents wait", async () => {
    await show(language, { asksFor: [] });
    expect(row()).toBeNull();
  });
});
