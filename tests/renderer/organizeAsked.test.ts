/**
 * Organize asked of the User's own AI, with no model set up in IncarnaMind (#3610). The Library's
 * top says the AI was asked, then that it is at work once it reads the Documents waiting, then
 * what its Suggestions would do, with Review and Confirm all, or that it had nothing to suggest;
 * each Document with a Suggestion says so on its row. The core is the real one and the agent calls
 * it through the shim the app ships, so what the line counts is what the Review holds; the link
 * Claude Code would open is recorded, and nothing of this computer opens.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import type { SortingBatch } from "../../src/core/agents/sorting";
import { ALL_SHARED_ID, type OrganizeTarget } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { agentsAdapter, buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
const view = page.defaultView;

let real: Core | null = null;
const stillToCome = () => Promise.resolve(undefined);
/** What the window listens to, some of it from when its modules load, heard from each test's core. */
const listening = new Set<{
  event: string;
  listener: (value: never) => void;
  stop: (() => void) | undefined;
}>();
const bridge = new Proxy(
  {},
  {
    get: (_each, name: string) => {
      if (name === "listApprovalRequests" || name === "listUserQuestions") return async () => [];
      if (name === "on")
        return (event: string, listener: (value: never) => void) => {
          const each = { event, listener, stop: real?.on(event as never, listener) };
          listening.add(each);
          return () => {
            each.stop?.();
            listening.delete(each);
          };
        };
      const method: unknown = real && Reflect.get(real, name);
      return typeof method === "function" ? method.bind(real) : stillToCome;
    },
  },
);
// This DOM has no layout to animate: motion is off, as Settings can turn it.
Object.assign(view, {
  incarnamind: bridge,
  incarnamindFiles: bridge,
  matchMedia: () => ({ matches: false }),
});

const kept = new Map<string, string>();
const globals: Record<string, unknown> = {
  document: page,
  window: view,
  HTMLElement: view.HTMLElement,
  Element: view.Element,
  Event: view.Event,
  Node: view.Node,
  MutationObserver: view.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  localStorage: {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
vi.stubGlobal("navigator", { userAgent: "node", clipboard: { writeText: async () => undefined } });

const { act, createElement, Fragment } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
// The commands whose shortcuts the Undo line names.
await import("../../src/renderer/src/commands/app");
const { useAgentAsked } = await import("../../src/renderer/src/askedAgent");
const { useOrganizeReview } = await import("../../src/renderer/src/organizeReview");
const { setMotionPreference } = await import("../../src/renderer/src/motion");
setMotionPreference("off");
// The components load by path: this project type-checks its tests without JSX.
const components = "../../src/renderer/src/components/library";
const {
  OrganizeButton,
}: {
  OrganizeButton: ComponentType<{
    target: OrganizeTarget;
    testId: string;
    className: string;
    children: string;
  }>;
} = await import(`${components}/OrganizeButton.tsx`);
const { OrganizeLines }: { OrganizeLines: ComponentType } = await import(
  `${components}/OrganizeLines.tsx`
);
const { SuggestionMark }: { SuggestionMark: ComponentType<{ documentId: string }> } = await import(
  `${components}/SuggestionMark.tsx`
);
const { OrganizeReviewPage }: { OrganizeReviewPage: ComponentType } = await import(
  `${components}/OrganizeReviewPage.tsx`
);

const LOOSE = { ids: null };
const DOCUMENTS = {
  "Quay repair": "# Quay repair\n\nThe east quay is repaired in May.",
  "Dredging plan": "# Dredging plan\n\nThe channel is dredged to 6 metres.",
  "Pier survey": "# Pier survey\n\nThe north pier needs new piles.",
  "Holiday list": "# Holiday list\n\nSun cream, a hat and books.",
};

const links: string[] = [];
let unmount: (() => Promise<void>) | null = null;
let closeAgent: (() => Promise<void>) | null = null;

/**
 * A Library of these Documents in no Folder, with Claude Code connected to all of it and no model
 * set up, drawn as its top and rows show them; `agent` calls IncarnaMind as Claude Code would.
 */
async function library(
  language: "en" | "zh-CN" = "en",
  { inView = false }: { inView?: boolean } = {},
) {
  const dataDir = await createTempDataFolder();
  real = startCore(dataDir, {
    agents: {
      ...(await agentsAdapter(dataDir)),
      openLink: async (url: string) => {
        links.push(url);
      },
    },
  });
  for (const each of listening) each.stop = real.on(each.event as never, each.listener);
  if (language !== "en") await real.updateSettings({ user: { language } });
  await real.setAgentsEnabled(true);
  const { launch } = await real.connectAgent({
    name: "Claude Code",
    client: "claude-code",
    folderIds: [ALL_SHARED_ID],
  });
  const sources = await createSourceFolder();
  const added = await addAndProcess(
    real,
    await Promise.all(
      Object.entries(DOCUMENTS).map(([name, text]) => writeSourceFile(sources, `${name}.md`, text)),
    ),
  );
  useAppStore.setState({
    chatReadiness: { ready: false, reason: "no-provider" },
    documents: await real.listDocuments(),
    library: await real.getLibrary(),
    settings: { language, user: {}, device: {} },
    // The Library's tab in front, or nothing: the Review opens by itself only in view.
    layout: inView
      ? {
          groups: [
            { id: "g", tabs: [{ id: "t", item: { kind: "library" } }], activeTabId: "t", width: 1 },
          ],
          focusedGroupId: "g",
          reopenable: 0,
          conversationId: null,
        }
      : null,
  } as never);
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  /** The Library's page as it shows: the Review in place of its top and rows while open. */
  const Shown = () =>
    useOrganizeReview((state) => state.open)
      ? createElement(OrganizeReviewPage)
      : createElement(
          Fragment,
          null,
          createElement(OrganizeButton, {
            target: LOOSE,
            testId: "library-sort-into-folders",
            className: "",
            children: "Organize",
          }),
          createElement(OrganizeLines),
          ...added.map((doc) =>
            createElement(
              "div",
              { key: doc.id, "data-row": doc.name },
              createElement(SuggestionMark, { documentId: doc.id }),
            ),
          ),
        );
  await act(async () => root.render(createElement(Shown)));
  unmount = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  const part = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  /** The line's words, before its actions. */
  const words = () =>
    part("organize-asked")?.querySelector(".meta-part")?.textContent?.replace(/^ · /, "");
  const row = (name: string) => container.querySelector(`[data-row="${name}"]`)?.textContent ?? "";
  const settle = async (check: () => void) =>
    vi.waitFor(async () => {
      await act(async () => undefined);
      check();
    });
  await settle(() => expect(part("library-sort-into-folders")?.textContent).not.toBe("Organize"));
  const agent = await connectLegacyAgent(launch);
  closeAgent = () => agent.close();
  /** The Documents' ids and versions as list_sorting gives them, by name. */
  const listed = async () => {
    const { documents } = (await agent.callTool({ name: "list_sorting", arguments: {} }))
      .structuredContent as unknown as SortingBatch;
    return (name: string) => {
      const doc = documents.find((each) => each.name === name);
      if (!doc) throw new Error(`${name} isn't waiting to be organized.`);
      return { documentId: doc.id, version: doc.version };
    };
  };
  const propose = (proposals: object[]) =>
    agent.callTool({ name: "propose_sorting", arguments: { proposals } });
  return { container, part, words, row, settle, listed, propose };
}

beforeAll(async () => {
  await buildAgentShim();
}, 60_000);
beforeEach(() => {
  links.length = 0;
  useAgentAsked.setState({ byKey: {} });
  useOrganizeReview.setState({ review: null, count: null, open: false });
});
afterEach(async () => {
  await closeAgent?.();
  closeAgent = null;
  await unmount?.();
  unmount = null;
  await real?.close();
  real = null;
});

describe("Organize asked of the User's own AI", () => {
  // protects=after the press the Library's top says the AI was asked, then that it is organizing once it reads the waiting Documents, then what its Suggestions would do with Review and Confirm all, and each row with a Suggestion names its new Folder while nothing is made; Confirm all files them through the Review's own Confirm (#3610); fails_when=the Library looks as before the press, the Suggestions land with only a count, a row doesn't say it waits, or anything is made before Confirm
  test("says it was asked, that it works, then what it suggests, with Review and Confirm all", async () => {
    const { part, words, row, settle, listed, propose } = await library();
    expect(part("library-sort-into-folders")?.textContent).toBe("Ask Claude Code to organize");
    await act(async () => part("library-sort-into-folders")?.click());
    await settle(() => expect(links).toHaveLength(1));
    await settle(() =>
      expect(part("organize-asked")?.textContent).toBe(
        "Asked Claude Code: send the request there.",
      ),
    );
    expect(part("organize-asked")?.dataset.state).toBe("asked");

    const of = await listed();
    await settle(() =>
      expect(part("organize-asked")?.textContent).toBe("Organizing your Documents in Claude Code."),
    );
    expect(part("organize-asked")?.dataset.state).toBe("working");

    await propose([
      { ...of("Quay repair"), newFolder: "Harbour works", newTags: ["Quays"] },
      { ...of("Dredging plan"), newFolder: "Harbour works" },
      { ...of("Pier survey"), newFolder: "Harbour works" },
      of("Holiday list"),
    ]);
    await settle(() =>
      expect(words()).toBe(
        "Suggested by Claude Code: 3 Documents will move into 1 new Folder. Nothing has moved yet.",
      ),
    );
    expect(part("organize-asked")?.dataset.state).toBe("landed");
    expect(part("organize-asked-review")?.textContent).toBe("Review");
    expect(part("organize-asked-confirm")?.textContent).toBe("Confirm all");
    expect(part("organize-waiting")).toBeNull();
    expect(row("Quay repair")).toBe("Suggested: “Harbour works”");
    expect(row("Pier survey")).toBe("Suggested: “Harbour works”");
    expect(row("Holiday list")).toBe("");
    expect((await (real as Core).getLibrary()).groups).toEqual([]);

    await act(async () => part("organize-asked-confirm")?.click());
    await settle(() => expect(part("organize-asked")).toBeNull());
    const { groups, assignments } = await (real as Core).getLibrary();
    expect(groups.map((each) => each.name)).toEqual(["Harbour works"]);
    expect(assignments.filter((each) => each.groupId === groups[0]?.id)).toHaveLength(3);
    expect(row("Quay repair")).toBe("");
  });

  // protects=Review opens the Review and ends what the AI's line says, so after Not Now the Library's top counts the Suggestions as any others (#3610); fails_when=the AI's line stays after the User has looked, or two lines say the same Suggestions
  test("the Review, once opened, takes the AI's line's place", async () => {
    const { part, settle, listed, propose } = await library();
    await act(async () => part("library-sort-into-folders")?.click());
    const of = await listed();
    await propose([{ ...of("Quay repair"), newFolder: "Harbour works" }]);
    await settle(() => expect(part("organize-asked-review")).not.toBeNull());
    await act(async () => part("organize-asked-review")?.click());
    expect(useOrganizeReview.getState().open).toBe(true);
    await act(async () => useOrganizeReview.setState({ open: false }));
    await settle(() => expect(part("organize-asked")).toBeNull());
    expect(part("organize-waiting")?.textContent).toContain("1 Document to confirm");
  });

  // protects=when the AI finds nothing to suggest the Library's top says so in the interface's language, where before it looked unchanged (#3610); fails_when=nothing is said, or it says the AI is still at work
  test.each([
    ["en", "Claude Code had no Folder or Tag to suggest."],
    ["zh-CN", "Claude Code 没有可建议的文件夹或标签。"],
  ] as const)("says when the AI had nothing to suggest (%s)", async (language, words) => {
    const { part, settle, listed, propose } = await library(language);
    await act(async () => part("library-sort-into-folders")?.click());
    const of = await listed();
    await propose(Object.keys(DOCUMENTS).map((name) => of(name)));
    await settle(() => expect(part("organize-asked")?.textContent).toBe(words));
    expect(part("organize-asked")?.dataset.state).toBe("landed");
    expect(part("organize-asked-confirm")).toBeNull();
  });

  // protects=with the Library in view, the Review opens by itself once the AI has answered for every Document it read, as the Library's own Organize opens it when it ends, and not after a part of them; it names the AI once under its title and its rows don't repeat it (#3610); fails_when=the Review opens halfway, stays closed once the AI has finished, or every row repeats the AI's name
  test("opens the Review by itself once the AI has answered for every Document it read", async () => {
    const { container, part, words, settle, listed, propose } = await library("en", {
      inView: true,
    });
    await act(async () => part("library-sort-into-folders")?.click());
    const of = await listed();
    await propose([
      { ...of("Quay repair"), newFolder: "Harbour works" },
      { ...of("Dredging plan"), newFolder: "Harbour works" },
    ]);
    await settle(() => expect(part("organize-asked")?.dataset.state).toBe("landed"));
    expect(words()).toBe(
      "Suggested by Claude Code: 2 Documents will move into 1 new Folder. Nothing has moved yet.",
    );
    expect(useOrganizeReview.getState().open).toBe(false);

    await propose([{ ...of("Pier survey"), newFolder: "Harbour works" }, of("Holiday list")]);
    await settle(() => expect(part("organize-review")).not.toBeNull());
    expect(part("organize-review-will-move")?.textContent).toBe(
      "Suggested by Claude Code: 3 Documents will move into 1 new Folder. Nothing has moved yet.",
    );
    expect(container.textContent?.split("Suggested by Claude Code")).toHaveLength(2);
    expect(useAgentAsked.getState().byKey).toEqual({});
    expect((await (real as Core).getLibrary()).groups).toEqual([]);
  });

  // protects=with no model set up, the Review's ⋯ offers Discard alone, since Fewer Folders, More Folders and Try Again plan on a model in IncarnaMind and could only answer with a notice; with one set up they are there (#3610); fails_when=the menu offers what can't run, or hides it from a User with a model
  test("offers only Discard in the Review's ⋯ with no model set up", async () => {
    const { part, settle, listed, propose } = await library("en", { inView: true });
    await act(async () => part("library-sort-into-folders")?.click());
    const of = await listed();
    await propose(
      Object.keys(DOCUMENTS).map((name) => ({ ...of(name), newFolder: "Harbour works" })),
    );
    await settle(() => expect(part("organize-review")).not.toBeNull());
    const items = async () => {
      const menu = part("organize-review-menu-items");
      if (!menu) throw new Error("The Review has no ⋯ menu.");
      // The browser shows the popover; this DOM can't, so the menu hears that it opens.
      Object.assign(menu, { hidePopover: () => undefined, matches: () => false });
      const opens = Object.assign(new view.Event("beforetoggle"), { newState: "open" });
      await act(async () => menu.dispatchEvent(opens));
      return [...menu.querySelectorAll("[data-testid]")].map((each) =>
        each.getAttribute("data-testid"),
      );
    };
    expect(await items()).toEqual(["organize-review-discard"]);
    await act(async () => useAppStore.setState({ chatReadiness: { ready: true } } as never));
    expect(await items()).toEqual([
      "organize-review-fewer",
      "organize-review-more",
      "organize-review-again",
      "organize-review-discard",
    ]);
  });

  // protects=the Chinese Library's top says the AI is organizing and then what it suggests, in the Review's own words (#3610); fails_when=a Chinese User sees English, or the line counts differently from the Review
  test("says it in Chinese", async () => {
    const { part, words, row, settle, listed, propose } = await library("zh-CN");
    await act(async () => part("library-sort-into-folders")?.click());
    const of = await listed();
    await settle(() =>
      expect(part("organize-asked")?.textContent).toBe(
        translate("zh-CN", "agents.asked.organizing", { agent: "Claude Code" }),
      ),
    );
    await propose([
      { ...of("Quay repair"), newFolder: "港口工程" },
      { ...of("Dredging plan"), newFolder: "港口工程" },
    ]);
    await settle(() =>
      expect(words()).toBe("Claude Code 建议：2 个文档将放入 1 个新文件夹。还没有移动任何文档。"),
    );
    expect(part("organize-asked-confirm")?.textContent).toBe("全部确认");
    expect(row("Quay repair")).toBe("建议放入“港口工程”");
  });
});
