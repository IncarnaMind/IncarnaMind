/**
 * What an outside agent hands over opens in the window's tabs (#3534), and a file handed over again
 * takes the tab of its earlier version's check, as Show version does (#3493): the file is one tab,
 * not one a version. The real core keeps the window's tabs behind the bridge; which Notes check
 * which versions of a file is the core's answer, given here.
 */
import { DOMParser } from "linkedom";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import type { AgentOpened, HandedFileOfMind, LayoutChange } from "../../src/core/api";
import { createTempDataFolder, startCore } from "../helpers/core";

const AT = "2026-11-21T09:00:00.000Z";

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const handed = new Map<string, HandedFileOfMind>();
let real: Core | null = null;
const coreOf = () => {
  if (!real) throw new Error("No core.");
  return real;
};

const bridge = {
  on: (event: string, listener: (payload: unknown) => void) => {
    const registered = listeners.get(event) ?? new Set<(payload: unknown) => void>();
    registered.add(listener);
    listeners.set(event, registered);
    return () => registered.delete(listener);
  },
  getLayout: (windowId: string) => coreOf().getLayout(windowId),
  changeLayout: (windowId: string, change: LayoutChange) => coreOf().changeLayout(windowId, change),
  handedFileOf: async (mindId: string) => handed.get(mindId) ?? null,
};

const page = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
Object.assign(page.defaultView, { incarnamind: bridge, incarnamindFiles: bridge });
/** Whether the User is in this window, as the page's `document.hasFocus()` says. */
let inThisWindow = true;
Object.assign(page, { hasFocus: () => inThisWindow });
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { installAgentOpened } = await import("../../src/renderer/src/agentOpened");
const { useAppStore } = await import("../../src/renderer/src/store");
installAgentOpened();

/** The core says that `mindIds`, in order, check the versions of one file an agent handed over. */
function handedOver(fileId: string, mindIds: readonly string[]): void {
  const versions = mindIds.map((mindId, index) => ({
    number: index + 1,
    contentHash: `${fileId}-${index + 1}`,
    size: 1,
    mindId,
    agent: "Claude Code",
    createdAt: AT,
  }));
  mindIds.forEach((mindId, index) => {
    handed.set(mindId, {
      file: {
        id: fileId,
        title: "Harbour review",
        kind: "pptx",
        folderId: null,
        agent: "Claude Code",
        documentId: null,
        version: mindIds.length,
        createdAt: AT,
        updatedAt: AT,
      },
      version: index + 1,
      versions,
    });
  });
}

const announce = (opened: AgentOpened) => {
  for (const listener of listeners.get("agents.opened") ?? []) listener(opened);
};
const behind = (mindId: string): AgentOpened => ({ item: { kind: "mind", mindId }, front: false });

/** The Notes the window's tabs show, in order, and the one in front. */
function tabs(): { notes: string[]; front: string | null } {
  const layout = useAppStore.getState().layout;
  const notes = (layout?.groups ?? []).flatMap((group) =>
    group.tabs.flatMap((tab) => (tab.item.kind === "mind" ? [tab.item.mindId] : [])),
  );
  const focused = layout?.groups.find((group) => group.id === layout.focusedGroupId);
  const shown = focused?.tabs.find((tab) => tab.id === focused.activeTabId);
  return { notes, front: shown?.item.kind === "mind" ? shown.item.mindId : null };
}

/** The User in "Field notes", and the Notes that check versions 1 and 2 of a deck. */
async function inANote() {
  handed.clear();
  inThisWindow = true;
  real = startCore(await createTempDataFolder());
  const notes = (await coreOf().createMind({ title: "Field notes" })).id;
  const first = (await coreOf().createMind({ title: "Checking version 1: Harbour review" })).id;
  const second = (await coreOf().createMind({ title: "Checking: Harbour review" })).id;
  await useAppStore.getState().loadLayout();
  useAppStore.getState().openMind(notes);
  await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes], front: notes }));
  return { notes, first, second };
}

describe("what an agent made while the User is in another app", () => {
  // protects=a Note an agent wrote while the User was in the agent's app is the tab in front when they come back (#3534); fails_when=it opens behind the tab the window showed, so the User has to find it
  test("a Note it wrote takes the front tab", async () => {
    const { notes } = await inANote();
    const written = (await coreOf().createMind({ title: "Tide report" })).id;
    inThisWindow = false;
    announce(behind(written));
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, written], front: written }));
  });

  // protects=back in the window, the next Note an agent writes opens behind again, so the keyboard stays where the User types (#3371); fails_when=one Note written while away leaves every later one taking the front
  test("back in the window, the next one opens behind", async () => {
    const { notes } = await inANote();
    const away = (await coreOf().createMind({ title: "Tide report" })).id;
    const back = (await coreOf().createMind({ title: "Ferry log" })).id;
    inThisWindow = false;
    announce(behind(away));
    await vi.waitFor(() => expect(tabs().front).toBe(away));
    inThisWindow = true;
    announce(behind(back));
    await vi.waitFor(() => expect(tabs().notes).toEqual([notes, away, back]));
    expect(tabs().front).toBe(away);
  });

  // protects=a newer version's check of a handed-over file, made while the User was away, is in front in the earlier one's place (#3493, #3534); fails_when=it stays behind, or opens a second tab
  test("a file handed over again comes in front in its earlier version's place", async () => {
    const { notes, first, second } = await inANote();
    handedOver("deck", [first]);
    announce(behind(first));
    await vi.waitFor(() => expect(tabs().notes).toEqual([notes, first]));

    handedOver("deck", [first, second]);
    inThisWindow = false;
    announce(behind(second));
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, second], front: second }));
  });
});

describe("a file an agent handed over again", () => {
  // protects=two hand-overs of one file leave one tab, the newer version's check where the first was, behind the Note the User is in (#3493); fails_when=each version piles up a tab of its own, or the newer comes in front
  test("leaves one tab, the newer version's, where the first was, behind the Note in front", async () => {
    const { notes, first, second } = await inANote();
    handedOver("deck", [first]);
    announce(behind(first));
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, first], front: notes }));

    handedOver("deck", [first, second]);
    announce(behind(second));
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, second], front: notes }));
  });

  // protects=the User reading version 1's check sees version 2's in the same tab when it is handed over, as Show version swaps them (#3493); fails_when=version 1 stays in front with version 2 a tab behind it
  test("the User looking at version 1 sees version 2 in its place", async () => {
    const { notes, first, second } = await inANote();
    handedOver("deck", [first]);
    announce(behind(first));
    await vi.waitFor(() => expect(tabs().notes).toEqual([notes, first]));
    useAppStore.getState().openMind(first);
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, first], front: first }));

    handedOver("deck", [first, second]);
    announce(behind(second));
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, second], front: second }));
  });

  // protects=asked from IncarnaMind, the newer version's check comes in front in the earlier one's place (#3534); fails_when=it opens a second tab, or stays behind
  test("asked from IncarnaMind, version 2 comes in front in version 1's place", async () => {
    const { notes, first, second } = await inANote();
    handedOver("deck", [first]);
    announce(behind(first));
    await vi.waitFor(() => expect(tabs().notes).toEqual([notes, first]));

    handedOver("deck", [first, second]);
    announce({ item: { kind: "mind", mindId: second }, front: true });
    await vi.waitFor(() => expect(tabs()).toEqual({ notes: [notes, second], front: second }));
  });

  // protects=a tab the User pinned is theirs: the earlier version's pinned check stays, and the newer opens beside it (#3493); fails_when=a pinned tab is closed or replaced
  test("a pinned first version stays, and version 2 opens beside it", async () => {
    const { notes, first, second } = await inANote();
    handedOver("deck", [first]);
    announce(behind(first));
    await vi.waitFor(() => expect(tabs().notes).toEqual([notes, first]));
    const pinned = useAppStore
      .getState()
      .layout?.groups.flatMap((group) => group.tabs)
      .find((tab) => tab.item.kind === "mind" && tab.item.mindId === first);
    if (!pinned) throw new Error("Version 1's check has no tab.");
    await useAppStore.getState().changeLayout({ type: "pin", tabId: pinned.id, pinned: true });

    handedOver("deck", [first, second]);
    announce(behind(second));
    await vi.waitFor(() => expect(tabs().notes).toHaveLength(3));
    expect(tabs()).toEqual({ notes: [first, notes, second], front: notes });
  });

  // protects=a file's check takes only the tab of its own earlier version: another file's, and a Note an agent wrote, each open a tab of their own behind; fails_when=a hand-over of one file closes another file's tab
  test("a hand-over of a different file never takes another file's tab", async () => {
    const { notes, first } = await inANote();
    const workbook = (await coreOf().createMind({ title: "Checking: Fuel budget" })).id;
    const written = (await coreOf().createMind({ title: "Tide report" })).id;
    handedOver("deck", [first]);
    announce(behind(first));
    await vi.waitFor(() => expect(tabs().notes).toEqual([notes, first]));

    handedOver("workbook", [workbook]);
    announce(behind(workbook));
    await vi.waitFor(() => expect(tabs().notes).toHaveLength(3));
    announce(behind(written));
    await vi.waitFor(() => expect(tabs().notes).toHaveLength(4));
    expect(tabs().notes).toEqual(expect.arrayContaining([notes, first, workbook, written]));
    expect(tabs().front).toBe(notes);
  });
});
