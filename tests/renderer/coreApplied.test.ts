import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import {
  type ApplyAskedChangesInput,
  type AskedChangeApplication,
  type AskedChangeTransition,
  type AskInConversationInput,
  type ConversationAnswer,
  type ConversationAskResult,
  DEFAULT_ASSISTANT,
  type LayoutChange,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  type WindowLayout,
} from "../../src/core/api";
import { AppliedEditLine, appliedLineIn } from "../../src/renderer/src/editor/appliedEditLine";
import type { FollowedSteps } from "../../src/renderer/src/editor/editorUndo";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { registerMindEditor } from "../../src/renderer/src/editor/openEditors";
import { ProposalReview } from "../../src/renderer/src/editor/proposalReview";
import { nextToRedo, undoSettled, useUndo } from "../../src/renderer/src/undo";
import { fingerprintOfMind, transitionOfMind } from "../../src/shared/mindState";
import { recordProposalRequest, resolveProposals } from "../../src/shared/proposals";

function insertLater(doc: Y.Doc): void {
  const block = doc.getXmlFragment(MIND_CONTENT_FIELD).get(1);
  if (!(block instanceof Y.XmlElement)) throw new Error("No added paragraph.");
  const text = block.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("No added text.");
  text.insert(0, "Later ");
}

function applicationWithChange(later: boolean): {
  doc: Y.Doc;
  application: AskedChangeApplication;
} {
  const before = new Y.Doc();
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "original" },
          content: [{ type: "text", text: "Original" }],
        },
        {
          type: "paragraph",
          attrs: {
            id: "added",
            [PROPOSAL_ATTRIBUTE]: { id: "change", request: "request", kind: "insert" },
          },
          content: [{ type: "text", text: "AI text" }],
        },
      ] satisfies JSONContent[],
    },
  });
  prosemirrorToYXmlFragment(source.state.doc, before.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  recordProposalRequest(before, "request", {
    source: "edit-with-ai",
    requested: "edit",
    providerId: "local",
    modelId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const reviewBefore = Y.encodeStateAsUpdate(before);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, reviewBefore);
  resolveProposals(doc.getXmlFragment(MIND_CONTENT_FIELD), () => true, "accept");
  const afterVector = Y.encodeStateVector(doc);
  const afterFingerprint = fingerprintOfMind(doc);
  if (later) insertLater(doc);
  before.destroy();
  return {
    doc,
    application: {
      undoId: "test",
      reviewBefore,
      afterVector,
      afterFingerprint,
      accepted: ["change"],
      requests: ["request"],
      held: false,
    },
  };
}

function editorWith(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      ProposalReview,
      AppliedEditLine.configure({ translate: (key) => key, undoKeys: () => "" }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

interface UndoBridge {
  undoAskedChanges(undoId: string): Promise<AskedChangeTransition | null>;
  redoAskedChanges(undoId: string): Promise<AskedChangeTransition | null>;
  releaseAskedChanges(undoId: string): Promise<void>;
}

type ApplyBridge = (input: ApplyAskedChangesInput) => Promise<AskedChangeApplication | null>;
type LayoutBridge = (change: LayoutChange) => Promise<WindowLayout>;

const OPEN_LAYOUT: WindowLayout = {
  groups: [{ id: "group", tabs: [], activeTabId: null, width: 1 }],
  focusedGroupId: "group",
  reopenable: 0,
  assistant: DEFAULT_ASSISTANT,
};
const listeners = new Map<string, Set<(payload: unknown) => void>>();
let activeUndoBridge: UndoBridge | null = null;
let activeApply: ApplyBridge = async () => null;
let activeLayout: LayoutBridge = async () => OPEN_LAYOUT;
let activeAsk: (input: AskInConversationInput) => Promise<ConversationAskResult> = async () => {
  throw new Error("No Question is asked in this test.");
};
const delegatedBridge = {
  listConversations: async () => [],
  getConversation: async () => ({ messages: [] }),
  askInConversation: (input: AskInConversationInput) => activeAsk(input),
  on: (event: string, listener: (payload: unknown) => void) => {
    const registered = listeners.get(event) ?? new Set<(payload: unknown) => void>();
    registered.add(listener);
    listeners.set(event, registered);
    return () => registered.delete(listener);
  },
  applyAskedChanges: (input: ApplyAskedChangesInput) => activeApply(input),
  changeLayout: (_windowId: string, change: LayoutChange) => activeLayout(change),
  undoAskedChanges: (undoId: string) => {
    if (!activeUndoBridge) throw new Error("No Undo bridge.");
    return activeUndoBridge.undoAskedChanges(undoId);
  },
  redoAskedChanges: (undoId: string) => {
    if (!activeUndoBridge) throw new Error("No Undo bridge.");
    return activeUndoBridge.redoAskedChanges(undoId);
  },
  releaseAskedChanges: (undoId: string) => {
    if (!activeUndoBridge) throw new Error("No Undo bridge.");
    return activeUndoBridge.releaseAskedChanges(undoId);
  },
};

function mountDom(
  bridge: UndoBridge,
  {
    apply = async () => null,
    layout = async () => OPEN_LAYOUT,
  }: { apply?: ApplyBridge; layout?: LayoutBridge } = {},
): void {
  activeUndoBridge = bridge;
  activeApply = apply;
  activeLayout = layout;
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  Object.assign(globalThis, {
    window,
    document,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
  });
  Object.assign(window, { incarnamind: delegatedBridge });
}

let answerIds = 0;
const conversationWithChange = (application: AskedChangeApplication): ConversationAnswer => ({
  kind: "answer",
  id: `answer-${++answerIds}`,
  conversationId: "conversation",
  questionId: "question",
  text: "Done.",
  citations: [],
  figures: [],
  analyses: [],
  model: null,
  status: "done",
  errorKind: null,
  errorMessage: null,
  errorSignInRoute: null,
  citationSupport: null,
  toolCalls: [
    {
      id: `call-${application.undoId}`,
      tool: "add_to_mind",
      source: "minds",
      input: {},
      status: "done",
      resultCount: null,
      mindChange: {
        mindId: "mind",
        created: false,
        request: "request",
        proposals: 1,
        paragraphs: 1,
      },
    },
  ],
  textOrigin: null,
  read: null,
  steps: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function conversationWithMadeChange(application: AskedChangeApplication): ConversationAnswer {
  const answer = conversationWithChange(application);
  answer.toolCalls.push({
    id: "made-call",
    tool: "create_mind",
    source: "minds",
    input: {},
    status: "done",
    resultCount: null,
    mindChange: {
      mindId: "made",
      created: true,
      request: "made-request",
      proposals: 1,
      paragraphs: 1,
    },
  });
  return answer;
}

function emitConversation(answer: ConversationAnswer): void {
  for (const listener of listeners.get("conversation.message") ?? []) listener(answer);
}

async function applyCoreChange(doc: Y.Doc, application: AskedChangeApplication): Promise<Editor> {
  const { applyArrived } = await import("../../src/renderer/src/appliedEdits");
  const editor = editorWith(doc);
  expect(
    applyArrived(
      editor,
      "mind",
      new Set(["request"]),
      { created: false, changed: 0, wrote: 1, tables: 0 },
      { application },
    ),
  ).toBe("applied");
  return editor;
}

async function coreFollowed(
  doc: Y.Doc,
  application: AskedChangeApplication,
): Promise<FollowedSteps> {
  const { onAskedApplied } = await import("../../src/renderer/src/appliedEdits");
  let followed: FollowedSteps | null = null;
  const stop = onAskedApplied((_mindId, _requests, applied) => {
    followed = applied.followed;
  });
  await applyCoreChange(doc, application);
  stop();
  if (followed === null) throw new Error("The core change wasn't followed.");
  return followed;
}

beforeEach(() => {
  useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
});

async function eventually<T>(check: () => T | null): Promise<T> {
  for (let index = 0; index < 30; index++) {
    const value = check();
    if (value !== null) return value;
    await Promise.resolve();
  }
  throw new Error("The expected state didn't arrive.");
}

// Value: protects=Review never restores over later text; fails_when=snapshot anchors are used after state diverges; why_new=only matching Review was covered; seam=none; no_claim=full app timing (real editor, later Yjs edit)
describe("Review of a core-applied change", () => {
  test.each([
    { later: false, review: true },
    { later: true, review: false },
  ])(
    "Review is offered only while the editor matches the accepted state: %s",
    async ({ later, review }) => {
      mountDom({
        releaseAskedChanges: async () => undefined,
        undoAskedChanges: async () => null,
        redoAskedChanges: async () => null,
      });
      const { offersReview } = await import("../../src/renderer/src/appliedEdits");
      const { doc, application } = applicationWithChange(later);
      const editor = await applyCoreChange(doc, application);
      expect(offersReview(editor)).toBe(review);
      expect(useUndo.getState().done).toHaveLength(review ? 1 : 0);
      const line = appliedLineIn(editor.state);
      expect(line?.kind).toBe("applied");
      if (line?.kind !== "applied") throw new Error("No applied line.");
      expect(line.changes.length).toBe(review ? 1 : 0);
      doc.destroy();
    },
  );
});

// Value: protects=direct core Undo and global Redo share one stack entry; fails_when=card Undo leaves the change done or duplicates it; why_new=prior e2e regenerated into an editor-owned step first; seam=none; no_claim=full app keyboard routing (covered by e2e)
test("direct core Undo and global Redo move the same change between stacks", async () => {
  const { doc, application } = applicationWithChange(false);
  mountDom({
    releaseAskedChanges: async () => undefined,
    undoAskedChanges: async () => transitionOfMind(doc),
    redoAskedChanges: async () => transitionOfMind(doc),
  });
  const { undoCoreChange } = await import("../../src/renderer/src/appliedEdits");
  const followed = await coreFollowed(doc, application);
  const change = useUndo.getState().done.at(-1);
  if (!change) throw new Error("The core change wasn't offered as Undo.");

  await undoCoreChange(followed);
  const { FROM_CORE } = await import("../../src/renderer/src/mindCopies");
  doc.emit("update", [new Uint8Array(), FROM_CORE, doc, new Y.Transaction(doc, FROM_CORE, true)]);
  expect(useUndo.getState().done).toEqual([]);
  expect(useUndo.getState().undone).toEqual([change]);
  await useUndo.getState().redo();
  expect(useUndo.getState().done).toEqual([change]);
  expect(useUndo.getState().undone).toEqual([]);
  doc.destroy();
});

// Value: protects=an unrelated new change releases an evicted core Redo; fails_when=its registration and core managers stay retained; why_new=global Redo eviction was unobserved; seam=none; no_claim=shared document garbage collection (release call asserted)
test("a new change releases an evicted core Redo", async () => {
  const { doc, application } = applicationWithChange(false);
  let releases = 0;
  mountDom({
    undoAskedChanges: async () => transitionOfMind(doc),
    redoAskedChanges: async () => transitionOfMind(doc),
    releaseAskedChanges: async () => {
      releases += 1;
    },
  });
  const { undoCoreChange } = await import("../../src/renderer/src/appliedEdits");
  const followed = await coreFollowed(doc, application);
  await undoCoreChange(followed);
  expect(useUndo.getState().undone).toHaveLength(1);
  useUndo.getState().push({ said: () => "Another change", undo: async () => undefined });
  expect(useUndo.getState().undone).toEqual([]);
  expect(releases).toBe(1);
  doc.destroy();
});

// Value: protects=a deletion after Undo invalidates Redo even without a clock change; fails_when=the state vector masks it and leaves Redo offered; why_new=Yjs deletion-only updates advance no clocks; seam=none; no_claim=hash collision behavior (content comparison only)
test("a deletion after core Undo withdraws Redo without advancing the state vector", async () => {
  const { doc, application } = applicationWithChange(false);
  mountDom({
    releaseAskedChanges: async () => undefined,
    undoAskedChanges: async () => transitionOfMind(doc),
    redoAskedChanges: async () => transitionOfMind(doc),
  });
  const { undoCoreChange } = await import("../../src/renderer/src/appliedEdits");
  const followed = await coreFollowed(doc, application);
  await undoCoreChange(followed);
  expect(useUndo.getState().undone).toHaveLength(1);
  const before = Y.encodeStateVector(doc);
  const block = doc.getXmlFragment(MIND_CONTENT_FIELD).get(1);
  if (!(block instanceof Y.XmlElement)) throw new Error("No added paragraph.");
  const text = block.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("No added text.");
  text.delete(0, 1);
  expect(Y.encodeStateVector(doc)).toEqual(before);
  expect(nextToRedo(useUndo.getState())).toBeUndefined();
  expect(useUndo.getState().undone).toEqual([]);
  doc.destroy();
});

// Value: protects=a later edit invalidates an in-flight core Undo without leaving stale Redo; fails_when=the response re-adds the withdrawn change; why_new=review reproduced the race; seam=none; no_claim=remote-window event ordering (local Yjs edit)
test("a later edit while core Undo is in flight withdraws its Redo", async () => {
  const deferred: { finish?: (vector: AskedChangeTransition | null) => void } = {};
  const response = new Promise<AskedChangeTransition | null>((resolve) => {
    deferred.finish = resolve;
  });
  mountDom({
    releaseAskedChanges: async () => undefined,
    undoAskedChanges: () => response,
    redoAskedChanges: async () => null,
  });
  const { doc, application } = applicationWithChange(false);
  await applyCoreChange(doc, application);
  const change = useUndo.getState().done.at(-1);
  if (!change) throw new Error("The core change wasn't offered as Undo.");

  const back = useUndo.getState().undo();
  for (let index = 0; index < 3; index++) await Promise.resolve();
  expect(useUndo.getState().running?.change).toBe(change);
  insertLater(doc);
  expect(nextToRedo(useUndo.getState())).toBeUndefined();
  if (!deferred.finish) throw new Error("Undo didn't reach the core.");
  deferred.finish(transitionOfMind(doc));
  await back;
  expect(useUndo.getState().running).toBeNull();
  expect(useUndo.getState().done).toEqual([]);
  expect(useUndo.getState().undone).toEqual([]);
  doc.destroy();
});

// Value: protects=a deletion before the Undo response invalidates stale Redo; fails_when=the clock-free deletion is mistaken for catch-up; why_new=final fingerprint validation; seam=deferred core response; no_claim=remote-window event ordering beyond this sequence
test("a deletion before the Undo response withdraws Redo", async () => {
  const { doc, application } = applicationWithChange(false);
  const beforeUndo = Y.encodeStateVector(doc);
  const responseDoc = new Y.Doc();
  Y.applyUpdate(responseDoc, application.reviewBefore);
  resolveProposals(responseDoc.getXmlFragment(MIND_CONTENT_FIELD), () => true, "reject");
  const response = transitionOfMind(responseDoc, beforeUndo);
  const deferred: { finish?: (vector: AskedChangeTransition | null) => void } = {};
  mountDom({
    undoAskedChanges: () =>
      new Promise((resolve) => {
        deferred.finish = resolve;
      }),
    redoAskedChanges: async () => null,
    releaseAskedChanges: async () => undefined,
  });
  await applyCoreChange(doc, application);
  const change = useUndo.getState().done.at(-1);
  if (!change) throw new Error("The core change wasn't offered as Undo.");
  const back = useUndo.getState().undo();
  for (let index = 0; index < 3; index++) await Promise.resolve();
  expect(useUndo.getState().running?.change).toBe(change);
  const block = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  if (!(block instanceof Y.XmlElement)) throw new Error("No original paragraph.");
  const text = block.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("No original text.");
  const { FROM_CORE } = await import("../../src/renderer/src/mindCopies");
  doc.transact(() => text.delete(0, 1), FROM_CORE);
  if (!deferred.finish) throw new Error("Undo didn't reach the core.");
  deferred.finish(response);
  await back;
  expect(nextToRedo(useUndo.getState())).toBeUndefined();
  expect(useUndo.getState().undone).toEqual([]);
  responseDoc.destroy();
  doc.destroy();
});

// Value: protects=an application without an editor is undone or retained by its actual core result; fails_when=regeneration assumes success or leaks the entry; why_new=open failure had no follower; seam=real conversation-finish path with layout failure; no_claim=layout failure presentation
test.each([
  { succeeds: true, stayed: false },
  { succeeds: false, stayed: true },
])(
  "regeneration without an editor respects the core Undo result: %s",
  async ({ succeeds, stayed }) => {
    const { doc, application } = applicationWithChange(false);
    let undoCalls = 0;
    let releases = 0;
    mountDom(
      {
        undoAskedChanges: async () => {
          undoCalls += 1;
          return succeeds ? transitionOfMind(doc) : null;
        },
        redoAskedChanges: async () => null,
        releaseAskedChanges: async () => {
          releases += 1;
        },
      },
      {
        apply: async () => application,
        layout: async () => {
          throw new Error("Open failed.");
        },
      },
    );
    const { applyWhatWasAsked, useAskedChanges } = await import(
      "../../src/renderer/src/askedChanges"
    );
    const answer = conversationWithChange(application);
    await applyWhatWasAsked(answer.id);
    emitConversation(answer);
    await applyWhatWasAsked(answer.id);
    expect(undoCalls).toBe(1);
    expect(releases).toBe(1);
    expect(useAskedChanges.getState().onTop[`${answer.id} mind`] === true).toBe(stayed);
    doc.destroy();
  },
);

// Value: protects=a failed core Undo is released and later entries finish; fails_when=one IPC error stops cleanup or skips the next Mind; why_new=CodeRabbit found the rejection path; seam=two core applications and a re-ask; no_claim=notice presentation (reportError is called by the implementation)
test("a failed core Undo is released and later entries finish", async () => {
  const { doc, application } = applicationWithChange(false);
  const other = { ...application, undoId: "other" };
  const undoCalls: string[] = [];
  const releases: string[] = [];
  mountDom(
    {
      undoAskedChanges: async (undoId) => {
        undoCalls.push(undoId);
        if (undoId === application.undoId) throw new Error("Undo failed.");
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => null,
      releaseAskedChanges: async (undoId) => {
        releases.push(undoId);
      },
    },
    {
      apply: async (input) => (input.mindId === "other" ? other : application),
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  answer.toolCalls.push({
    id: "other-call",
    tool: "add_to_mind",
    source: "minds",
    input: {},
    status: "done",
    resultCount: null,
    mindChange: {
      mindId: "other",
      created: false,
      request: "request",
      proposals: 1,
      paragraphs: 1,
    },
  });
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await applyWhatWasAsked(answer.id);
  expect(undoCalls).toEqual([application.undoId, "other"]);
  expect(releases).toEqual([application.undoId, "other"]);
  expect(useAskedChanges.getState().outcomes[answer.id]).toBeUndefined();
  expect(useAskedChanges.getState().onTop[`${answer.id} mind`]).toBe(true);
  expect(useAskedChanges.getState().onTop[`${answer.id} other`]).not.toBe(true);
  doc.destroy();
});

// Value: protects=a background tab never delays regeneration for its inactive editor; fails_when=finish waits for that editor; why_new=background opening preserves the made Mind in front; seam=real conversation finish and re-ask; no_claim=editor recovery (covered separately)
test("a background edit doesn't hold regeneration for its inactive editor", async () => {
  const { doc, application } = applicationWithChange(false);
  let undoCalls = 0;
  const opens: LayoutChange[] = [];
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => null,
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async (input) => (input.mindId === "mind" ? application : null),
      layout: async (change) => {
        opens.push(change);
        return OPEN_LAYOUT;
      },
    },
  );
  const { applyWhatWasAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithMadeChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  expect(opens).toContainEqual({
    type: "open",
    item: { kind: "mind", mindId: "mind" },
    where: { in: "place" },
    behind: true,
  });
  const making = applyWhatWasAsked(answer.id);
  await eventually(() => (undoCalls === 1 ? true : null));
  await making;
  doc.destroy();
});

// Value: protects=an editor activated during core apply gets Review and Undo immediately; fails_when=the background return misses its earlier open event; why_new=review found the activation race; seam=editor registration inside the core response; no_claim=inactive recovery (covered separately)
test("an editor opened during a background core apply is followed immediately", async () => {
  const { doc, application } = applicationWithChange(false);
  let editor: Editor | null = null;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        editor = editorWith(doc);
        onTestFinished(registerMindEditor("mind", editor));
        return application;
      },
    },
  );
  const { applyWhatWasAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const { offersReview } = await import("../../src/renderer/src/appliedEdits");
  const answer = conversationWithMadeChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  await eventually(() => (editor && offersReview(editor) ? true : null));
  expect(useUndo.getState().done).toHaveLength(1);
  doc.destroy();
});

// Value: protects=a response before the accepted Yjs update is catch-up, not divergence; fails_when=Review and core Undo are released while the editor is behind; why_new=independent review reproduced the ordering; seam=real background apply and later accepted update; no_claim=an actually diverged editor (covered by Review invalidation tests)
test("an editor behind the accepted update recovers Review and Undo on arrival", async () => {
  const { doc, application } = applicationWithChange(false);
  const lagging = new Y.Doc();
  Y.applyUpdate(lagging, application.reviewBefore);
  let editor: Editor | null = null;
  let releases = 0;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => {
        releases += 1;
      },
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        editor = editorWith(lagging);
        onTestFinished(registerMindEditor("mind", editor));
        return application;
      },
    },
  );
  const { applyWhatWasAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const { offersReview } = await import("../../src/renderer/src/appliedEdits");
  const answer = conversationWithMadeChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  expect(useUndo.getState().done).toHaveLength(0);
  expect(releases).toBe(0);

  Y.applyUpdate(lagging, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(lagging)));

  await eventually(() => (editor && offersReview(editor) ? true : null));
  expect(useUndo.getState().done).toHaveLength(1);
  expect(releases).toBe(0);
  lagging.destroy();
  doc.destroy();
});

// Value: protects=regeneration waits for in-flight Redo then undoes once; fails_when=old text survives or the old stack entry remains; why_new=review reproduced the race; seam=real conversation-finish path and global Redo; no_claim=multi-window remote edits (single-window sequence)
test("regeneration waits for in-flight core Redo and undoes it once", async () => {
  const { doc, application } = applicationWithChange(false);
  const deferred: { finish?: (vector: AskedChangeTransition | null) => void } = {};
  let undoCalls = 0;
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: () =>
        new Promise((resolve) => {
          deferred.finish = resolve;
        }),
      releaseAskedChanges: async () => undefined,
    },
    { apply: async () => application },
  );
  const { onAskedApplied, undoCoreChange } = await import("../../src/renderer/src/appliedEdits");
  const { applyWhatWasAsked } = await import("../../src/renderer/src/askedChanges");
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  const editor = editorWith(doc);
  const followed = new Promise<FollowedSteps>((resolve) => {
    const stop = onAskedApplied((_mindId, _requests, applied) => {
      stop();
      resolve(applied.followed);
    });
  });
  emitConversation(answer);
  const unregister = registerMindEditor("mind", editor);
  onTestFinished(unregister);
  const followedSteps = await followed;
  await undoCoreChange(followedSteps);
  expect(undoCalls).toBe(1);
  const change = useUndo.getState().undone.at(-1);
  if (!change) throw new Error("The core change wasn't offered as Redo.");
  const redoing = useUndo.getState().redo();
  const making = applyWhatWasAsked(answer.id);
  let completed = false;
  void making.then(() => {
    completed = true;
  });
  for (let index = 0; index < 4; index++) await Promise.resolve();
  expect(completed).toBe(false);
  expect(undoCalls).toBe(1);
  if (!deferred.finish) throw new Error("Redo wasn't held.");
  deferred.finish(transitionOfMind(doc));
  await redoing;
  await making;
  expect(undoCalls).toBe(2);
  expect(useUndo.getState().done).toEqual([]);
  expect(useUndo.getState().undone).toEqual([]);
  expect(useUndo.getState().running).toBeNull();
  doc.destroy();
});

// Value: protects=headless Undo keeps a working global Redo and regeneration still releases once; fails_when=the initial Undo releases the only core entry; why_new=independent review found no Redo route; seam=real card Undo, global Redo and re-ask; no_claim=editor-follower Redo (covered separately)
test("a failed open leaves working card Undo and global Redo", async () => {
  const { doc, application } = applicationWithChange(false);
  let undoCalls = 0;
  let redoCalls = 0;
  let releases = 0;
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => {
        redoCalls += 1;
        return transitionOfMind(doc);
      },
      releaseAskedChanges: async () => {
        releases += 1;
      },
    },
    {
      apply: async () => application,
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );
  expect(undoCalls).toBe(1);
  expect(releases).toBe(0);
  expect(nextToRedo(useUndo.getState())).toBeDefined();

  await useUndo.getState().redo();
  expect(redoCalls).toBe(1);
  expect(releases).toBe(0);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("applied");
  expect(useUndo.getState().done).toHaveLength(1);

  await applyWhatWasAsked(answer.id);
  expect(undoCalls).toBe(2);
  expect(releases).toBe(1);
  expect(useUndo.getState().done).toEqual([]);
  expect(useUndo.getState().undone).toEqual([]);
  doc.destroy();
});

// Value: protects=taking a headless change back does not clear unrelated Redo; fails_when=the card's first Undo pushes a new edit and erases the existing undone stack; why_new=review found push semantics on an old change; seam=unrelated Undo followed by card Undo; no_claim=the headless change's own Redo (covered above)
test("headless Undo preserves unrelated Redo history", async () => {
  const { doc, application } = applicationWithChange(false);
  let otherRedos = 0;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async () => application,
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const other = {
    said: () => "Other change",
    undo: async () => undefined,
    redo: async () => {
      otherRedos += 1;
    },
  };
  useUndo.getState().push(other);
  await useUndo.getState().undo();
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);

  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );

  expect(useUndo.getState().undone).toHaveLength(2);
  await useUndo.getState().redo();
  expect(otherRedos).toBe(0);
  expect(useUndo.getState().undone).toEqual([other]);
  await applyWhatWasAsked(answer.id);
  expect(useUndo.getState().undone).toEqual([other]);
  doc.destroy();
});

// Value: protects=a failed headless Undo or Redo is visible and cannot repeat a released id; fails_when=the running entry is withdrawn before the global error handler or application stays live; why_new=review reproduced silent null/IPC failures; seam=card Undo with null and rejected core responses; no_claim=error wording (covered by shared error tests)
test.each([null, new Error("IPC failed")])(
  "a failed headless Undo reports and closes the lifecycle: %s",
  async (failure) => {
    const { doc, application } = applicationWithChange(false);
    let undoCalls = 0;
    let releases = 0;
    mountDom(
      {
        undoAskedChanges: async () => {
          undoCalls += 1;
          if (failure) throw failure;
          return null;
        },
        redoAskedChanges: async () => transitionOfMind(doc),
        releaseAskedChanges: async () => {
          releases += 1;
        },
      },
      {
        apply: async () => application,
        layout: async () => {
          throw new Error("Open failed.");
        },
      },
    );
    const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
      "../../src/renderer/src/askedChanges"
    );
    const answer = conversationWithChange(application);
    await applyWhatWasAsked(answer.id);
    emitConversation(answer);
    await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
    undoAsked(answer.id, "mind");
    await eventually(() => (useUndo.getState().line ? true : null));

    expect(useUndo.getState().line).toMatchObject({ problem: { step: "undo" } });
    expect(releases).toBe(1);
    expect(useUndo.getState().running).toBeNull();
    undoAsked(answer.id, "mind");
    await Promise.resolve();
    expect(undoCalls).toBe(1);
    doc.destroy();
  },
);

// Value: protects=a failed headless Redo is visible and releases its retained entry; fails_when=Redo fails silently or leaves a repeatable released id; why_new=the retained Redo lifecycle needs its own failure case; seam=successful Undo then null core Redo; no_claim=IPC failure wording (covered by the Undo failure cases)
test("a failed headless Redo reports and closes the lifecycle", async () => {
  const { doc, application } = applicationWithChange(false);
  let redoCalls = 0;
  let releases = 0;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => {
        redoCalls += 1;
        return null;
      },
      releaseAskedChanges: async () => {
        releases += 1;
      },
    },
    {
      apply: async () => application,
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );

  await useUndo.getState().redo();
  expect(useUndo.getState().line).toMatchObject({ problem: { step: "redo" } });
  expect(redoCalls).toBe(1);
  expect(releases).toBe(1);
  expect(useUndo.getState().running).toBeNull();
  await useUndo.getState().redo();
  expect(redoCalls).toBe(1);
  doc.destroy();
});

// Value: protects=regeneration after headless Undo releases without applying a second Undo; fails_when=the retained Redo entry leaks or is undone again; why_new=headless Redo requires retaining the core entry; seam=card Undo then re-ask; no_claim=the successful Redo path (covered above)
test("regeneration after headless Undo releases without a second Undo", async () => {
  const { doc, application } = applicationWithChange(false);
  let undoCalls = 0;
  let releases = 0;
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => {
        releases += 1;
      },
    },
    {
      apply: async () => application,
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );

  await applyWhatWasAsked(answer.id);

  expect(undoCalls).toBe(1);
  expect(releases).toBe(1);
  expect(useUndo.getState().done).toEqual([]);
  expect(useUndo.getState().undone).toEqual([]);
  doc.destroy();
});

// Value: protects=editor recovery cannot displace a headless Undo still running; fails_when=handoff withdraws the running entry before it reaches the undone stack; why_new=review resolved recovery before Undo; seam=deferred recovery and core Undo; no_claim=handoff after Undo settles (covered by ordinary recovery)
test("editor recovery waits for an in-flight headless Undo", async () => {
  const { doc, application } = applicationWithChange(false);
  const recovery = Promise.withResolvers<AskedChangeApplication | null>();
  const undoing = Promise.withResolvers<AskedChangeTransition | null>();
  let applyCalls = 0;
  let releases = 0;
  mountDom(
    {
      undoAskedChanges: () => undoing.promise,
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => {
        releases += 1;
      },
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        applyCalls += 1;
        return applyCalls === 1 ? application : recovery.promise;
      },
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  const editor = editorWith(doc);
  onTestFinished(registerMindEditor("mind", editor));
  await eventually(() => (applyCalls === 2 ? true : null));
  undoAsked(answer.id, "mind");
  await eventually(() => (useUndo.getState().running ? true : null));

  recovery.resolve(application);
  for (let index = 0; index < 3; index++) await Promise.resolve();
  undoing.resolve(transitionOfMind(doc));
  await undoSettled();

  expect(useUndo.getState().done).toEqual([]);
  expect(useUndo.getState().undone).toHaveLength(1);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("undone");
  expect(releases).toBe(0);
  doc.destroy();
});

// Value: protects=recovery cannot cancel a headless Undo queued behind another change; fails_when=only the headless running slot is checked; why_new=review resolved recovery while an unrelated operation held the queue; seam=deferred unrelated Undo, queued card Undo and recovery; no_claim=the already-running recovery race (covered above)
test("editor recovery waits for a queued headless Undo", async () => {
  const { doc, application } = applicationWithChange(false);
  const recovery = Promise.withResolvers<AskedChangeApplication | null>();
  const otherUndo = Promise.withResolvers<void>();
  let applyCalls = 0;
  let undoCalls = 0;
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        applyCalls += 1;
        return applyCalls === 1 ? application : recovery.promise;
      },
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  const other = {
    said: () => "Other change",
    undo: () => otherUndo.promise,
    redo: async () => undefined,
  };
  useUndo.getState().push(other);
  const earlier = useUndo.getState().undo();
  const editor = editorWith(doc);
  onTestFinished(registerMindEditor("mind", editor));
  await eventually(() => (applyCalls === 2 ? true : null));
  undoAsked(answer.id, "mind");

  recovery.resolve(application);
  for (let index = 0; index < 3; index++) await Promise.resolve();
  expect(undoCalls).toBe(0);
  otherUndo.resolve();
  await earlier;
  await undoSettled();

  expect(undoCalls).toBe(1);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("undone");
  expect(useUndo.getState().undone).toHaveLength(2);
  doc.destroy();
});

// Value: protects=a card Undo queued after recovery's wait cannot be cancelled by handoff; fails_when=the follower withdraws the queued headless change before its turn; why_new=review found the queue-snapshot race; seam=recovery waiting on another operation, then card Undo; no_claim=recovery before the card operation (covered above)
test("a card Undo queued after recovery's wait still runs", async () => {
  const { doc, application } = applicationWithChange(false);
  const recovery = Promise.withResolvers<AskedChangeApplication | null>();
  const otherUndo = Promise.withResolvers<void>();
  let applyCalls = 0;
  let undoCalls = 0;
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        applyCalls += 1;
        return applyCalls === 1 ? application : recovery.promise;
      },
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );
  await useUndo.getState().redo();
  const other = {
    said: () => "Other change",
    undo: () => otherUndo.promise,
    redo: async () => undefined,
  };
  useUndo.getState().push(other);
  const earlier = useUndo.getState().undo();
  const editor = editorWith(doc);
  onTestFinished(registerMindEditor("mind", editor));
  await eventually(() => (applyCalls === 2 ? true : null));
  recovery.resolve(application);
  for (let index = 0; index < 3; index++) await Promise.resolve();

  undoAsked(answer.id, "mind");
  otherUndo.resolve();
  await earlier;
  await undoSettled();

  expect(undoCalls).toBe(2);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("undone");
  expect(useUndo.getState().undone).toHaveLength(2);
  doc.destroy();
});

// Value: protects=Redo keeps its stack entry until editor recovery installs the follower; fails_when=handoff withdraws before asynchronous apply finishes; why_new=review found a global-Undo gap; seam=deferred recovery after headless Redo; no_claim=the follower's later Undo (covered by core follower tests)
test("headless Redo keeps its change until the editor follower exists", async () => {
  const { doc, application } = applicationWithChange(false);
  const recovery = Promise.withResolvers<AskedChangeApplication | null>();
  let applyCalls = 0;
  let releases = 0;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => {
        releases += 1;
      },
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        applyCalls += 1;
        return applyCalls === 1 ? application : recovery.promise;
      },
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const { offersReview } = await import("../../src/renderer/src/appliedEdits");
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  const other = {
    said: () => "Other change",
    undo: async () => undefined,
    redo: async () => undefined,
  };
  useUndo.getState().push(other);
  await useUndo.getState().undo();
  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );
  const editor = editorWith(doc);
  onTestFinished(registerMindEditor("mind", editor));

  await useUndo.getState().redo();
  await eventually(() => (applyCalls === 2 ? true : null));
  expect(useUndo.getState().done).toHaveLength(1);
  expect(useUndo.getState().undone).toEqual([other]);

  recovery.resolve(application);
  await eventually(() => (offersReview(editor) ? true : null));
  expect(useUndo.getState().done).toHaveLength(1);
  expect(useUndo.getState().undone).toEqual([other]);
  expect(releases).toBe(0);
  doc.destroy();
});

// Value: protects=a later editor restores Review from the core's idempotent application; fails_when=the route never returns or a second write occurs; why_new=open failure recovery; seam=real editor registration; no_claim=full app open timing (unit lifecycle)
test("a later editor restores Review without applying twice", async () => {
  const { doc, application } = applicationWithChange(false);
  let applyCalls = 0;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async () => {
        applyCalls += 1;
        return application;
      },
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const { onAskedApplied, offersReview } = await import("../../src/renderer/src/appliedEdits");
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const followed = new Promise<FollowedSteps>((resolve) => {
    const stop = onAskedApplied((_mindId, _requests, applied) => {
      stop();
      resolve(applied.followed);
    });
  });
  const editor = editorWith(doc);
  const unregister = registerMindEditor("mind", editor);
  onTestFinished(unregister);
  await followed;
  expect(offersReview(editor)).toBe(true);
  expect(useUndo.getState().done).toHaveLength(1);
  expect(applyCalls).toBe(2);
  doc.destroy();
});

// Value: protects=Undo pressed on the card while its Note opens stays undone; fails_when=the open's reply writes the undone application back and the editor's recovery applies it again; why_new=#2302; seam=held layout change, card Undo, then the editor opening; no_claim=the open that succeeds (guarded by the same check)
test("Undo pressed while the Note opens stays undone when its editor opens (#2302)", async () => {
  const { doc, application } = applicationWithChange(false);
  const opening = Promise.withResolvers<WindowLayout>();
  let applyCalls = 0;
  mountDom(
    {
      undoAskedChanges: async () => transitionOfMind(doc),
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async (input) => {
        if (input.mindId !== "mind") return null;
        applyCalls += 1;
        return application;
      },
      layout: () => opening.promise,
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  const answer = conversationWithChange(application);
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  undoAsked(answer.id, "mind");
  await eventually(() =>
    useAskedChanges.getState().outcomes[answer.id]?.mind === "undone" ? "undone" : null,
  );
  opening.reject(new Error("Open failed."));
  for (let index = 0; index < 10; index++) await Promise.resolve();
  const editor = editorWith(doc);
  onTestFinished(registerMindEditor("mind", editor));
  for (let index = 0; index < 10; index++) await Promise.resolve();
  await undoSettled();

  expect(applyCalls).toBe(1);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("undone");
  expect(nextToRedo(useUndo.getState())).toBeDefined();
  doc.destroy();
});

// Value: protects=a new Answer's changes stay applied when it ends while an Undo still runs; fails_when=asking makes way for the Answer's own changes after the Undo and erases its outcome; why_new=#2302; seam=held unrelated Undo, then the Answer's last write; no_claim=asking again (makes way on purpose, covered above)
test("a new Answer that ends while an Undo runs keeps what it applied (#2302)", async () => {
  const { doc, application } = applicationWithChange(false);
  let undoCalls = 0;
  mountDom(
    {
      undoAskedChanges: async () => {
        undoCalls += 1;
        return transitionOfMind(doc);
      },
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async () => application,
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const answer = conversationWithChange(application);
  const asking = Promise.withResolvers<ConversationAskResult>();
  activeAsk = () => asking.promise;
  const { useAskedChanges } = await import("../../src/renderer/src/askedChanges");
  const { askInAssistant } = await import("../../src/renderer/src/conversations");
  const otherUndo = Promise.withResolvers<void>();
  useUndo.getState().push({
    said: () => "Other change",
    undo: () => otherUndo.promise,
    redo: async () => undefined,
  });
  const earlier = useUndo.getState().undo();
  const asked = askInAssistant({ text: "Add a line about tides.", mindId: null });
  asking.resolve({
    asked: true,
    conversation: {
      id: answer.conversationId,
      title: "",
      autoTitle: "Add a line about tides.",
      folderId: null,
      askedFrom: [],
      createdAt: answer.createdAt,
      updatedAt: answer.updatedAt,
    },
    questionId: answer.questionId,
    answerId: answer.id,
  });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  otherUndo.resolve();
  await earlier;
  await asked;
  await undoSettled();

  expect(undoCalls).toBe(0);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("applied");
  expect(useAskedChanges.getState().facts[`${answer.id} mind`]).toMatchObject({ mindId: "mind" });
  doc.destroy();
});

// Value: protects=an editor that opens while the card's Undo runs asks the core for nothing; fails_when=recovery asks the core to apply again before the Undo has ended; why_new=#2302 review; seam=held core Undo, then the editor opening; no_claim=recovery before the Undo (covered above)
test("an editor opened while the card's Undo runs doesn't ask the core to apply again (#2302)", async () => {
  const { doc, application } = applicationWithChange(false);
  const undoing = Promise.withResolvers<AskedChangeTransition | null>();
  const answer = conversationWithChange(application);
  let applyCalls = 0;
  mountDom(
    {
      undoAskedChanges: () => undoing.promise,
      redoAskedChanges: async () => transitionOfMind(doc),
      releaseAskedChanges: async () => undefined,
    },
    {
      apply: async (input) => {
        // Answers of earlier tests in this file are still followed: only this one's count.
        if (input.answerId !== answer.id) return null;
        applyCalls += 1;
        return application;
      },
      layout: async () => {
        throw new Error("Open failed.");
      },
    },
  );
  const { applyWhatWasAsked, undoAsked, useAskedChanges } = await import(
    "../../src/renderer/src/askedChanges"
  );
  await applyWhatWasAsked(answer.id);
  emitConversation(answer);
  await eventually(() => useAskedChanges.getState().outcomes[answer.id]?.mind ?? null);
  undoAsked(answer.id, "mind");
  await eventually(() => (useUndo.getState().running ? true : null));
  const editor = editorWith(doc);
  onTestFinished(registerMindEditor("mind", editor));
  for (let index = 0; index < 10; index++) await Promise.resolve();
  undoing.resolve(transitionOfMind(doc));
  await undoSettled();
  for (let index = 0; index < 10; index++) await Promise.resolve();

  expect(applyCalls).toBe(1);
  expect(useAskedChanges.getState().outcomes[answer.id]?.mind).toBe("undone");
  doc.destroy();
});
