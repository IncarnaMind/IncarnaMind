/**
 * Renderer behavior for outside-app Note writes (#3839):
 * - Mounted editor single-threaded accept, typing race refusal (0 words lost), bounded settle wait
 *   for IME composition and unrelated typing, and Chinese IME composing (`view.composing === true`)
 *   refusal on both the same paragraph and another paragraph with 0 DOM mutation and 0 IME wiped;
 *   composing gate defers incoming `mind.update`.
 * - >50% User-text rewrite held as `Apply · Discard`, survives closed-Note reopen without falling
 *   back to `Accept all · Reject all`, never overwrites an `applied` Undo line, and clicking Apply
 *   saves Checkpoint + updates `#3866` `uncheckedBlocks`.
 * - Front tab shows inline `AppliedEditLine` only (suppressing `SidebarStatus` notice); hidden tab
 *   and closed Note keep `SidebarStatus` notice with Open and draw `AppliedEditLine` on tab switch
 *   or Note open with 1-step Undo.
 * - Real app extensions (`NoteTabs`) empty-tab staging and remote fix-up handling.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  type AgentNoteChange,
  BLOCK_ID_ATTRIBUTE,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  NOTE_TAB_NODE,
  NOTE_TAB_TITLE_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type ProposalRequest,
} from "../../src/core/api";
import { TranslatableError } from "../../src/core/errors";
import { blockProposal, setProposal } from "../../src/core/proposals/write";
import { BRIDGE_KEY, FILES_BRIDGE_KEY } from "../../src/shared/bridge";
import { translate } from "../../src/shared/i18n";
import { readMindCheck, writeMindCheck } from "../../src/shared/mindCheck";
import {
  decisionsOn,
  pendingProposals,
  recordProposalRequest,
  resolveProposals,
  targetHash,
} from "../../src/shared/proposals";
import { textOriginOf } from "../../src/shared/textOrigins";
import { editorExtensions } from "../helpers/editor";

function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "getSelection", { value: () => null });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}
const page = domDocument();

const coreListeners = new Map<string, Set<(payload: unknown) => void>>();
const emitCore = (event: string, payload: unknown) => {
  for (const listener of coreListeners.get(event) ?? []) listener(payload);
};

const saveCheckpoint = vi.fn(async () => ({}));
const recordAiUse = vi.fn(async () => []);
const undoAgentChange = vi.fn(async () => "done" as const);
const redoAgentChange = vi.fn(async () => "done" as const);
const claimAgentChange = vi.fn(async () => true);
const applyMindUpdate = vi.fn(
  async (_mindId: string, _update: Uint8Array): Promise<void> => undefined,
);

const bridge = new Proxy(
  {
    on(event: string, listener: (payload: unknown) => void) {
      const set = coreListeners.get(event) ?? new Set();
      set.add(listener);
      coreListeners.set(event, set);
      return () => set.delete(listener);
    },
    saveCheckpoint,
    recordAiUse,
    undoAgentChange,
    redoAgentChange,
    claimAgentChange,
    applyMindUpdate,
    openMind: vi.fn(async () => ({
      state: new Uint8Array([0, 0]) as Uint8Array,
      access: "edit" as const,
    })),
    closeMind: vi.fn(async () => undefined),
    watchComparisonMind: vi.fn(async () => undefined),
    unwatchComparisonMind: vi.fn(async () => undefined),
  },
  {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => undefined;
    },
  },
);

const filesBridge = {
  onOpenNoteWriteRequest: () => () => undefined,
  replyOpenNoteWriteRequest: vi.fn(),
  logError: vi.fn(),
  titleBar: "mac",
  onFullScreenChange: () => () => undefined,
};

Object.assign(page.defaultView, {
  [BRIDGE_KEY]: bridge,
  [FILES_BRIDGE_KEY]: filesBridge,
});
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

let noteExtensions: typeof import("../../src/renderer/src/editor/noteSchema").noteExtensions;
let NoteTabs: typeof import("../../src/renderer/src/editor/noteTabs").NoteTabs;
let noteTabsOf: typeof import("../../src/renderer/src/editor/noteTabs").noteTabsOf;
let AppliedEditLine: typeof import("../../src/renderer/src/editor/appliedEditLine").AppliedEditLine;
let appliedLineIn: typeof import("../../src/renderer/src/editor/appliedEditLine").appliedLineIn;
let setAppliedLine: typeof import("../../src/renderer/src/editor/appliedEditLine").setAppliedLine;
let ProposalReview: typeof import("../../src/renderer/src/editor/proposalReview").ProposalReview;
let registerMindEditor: typeof import("../../src/renderer/src/editor/openEditors").registerMindEditor;
let prepareOpenNoteWrite: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").prepareOpenNoteWrite;
let verifyOpenNoteWrite: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").verifyOpenNoteWrite;
let acceptOpenNoteWrite: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").acceptOpenNoteWrite;
let cancelOpenNoteWrite: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").cancelOpenNoteWrite;
let installOpenNoteAgentAccept: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").installOpenNoteAgentAccept;
let actOnAppliedEdit: typeof import("../../src/renderer/src/appliedEdits").actOnAppliedEdit;
let syncHeldOutsideProposals: typeof import("../../src/renderer/src/appliedEdits").syncHeldOutsideProposals;
let showClosedAgentLine: typeof import("../../src/renderer/src/appliedEdits").showClosedAgentLine;
let useAgentNotes: typeof import("../../src/renderer/src/agentNotes").useAgentNotes;
let takeClosedAgentChange: typeof import("../../src/renderer/src/agentNotes").takeClosedAgentChange;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let useUndo: typeof import("../../src/renderer/src/undo").useUndo;
let openMindCopy: typeof import("../../src/renderer/src/mindCopies").openMindCopy;
let flushMindUpdates: typeof import("../../src/renderer/src/mindCopies").flushMindUpdates;
let FROM_CORE: typeof import("../../src/renderer/src/mindCopies").FROM_CORE;
let undoStackOf: typeof import("../../src/renderer/src/editor/editorUndo").undoStackOf;
let takeAgentOwnChanges: typeof import("../../src/renderer/src/editor/agentOwnUndo").takeAgentOwnChanges;
let drawHistory: typeof import("../../src/renderer/src/editor/keptHistories").drawHistory;
let keepHistory: typeof import("../../src/renderer/src/editor/keptHistories").keepHistory;
let agentOwnChangeRequestId: typeof import("../../src/shared/agentOwnChanges").agentOwnChangeRequestId;
let noteHealth: typeof import("../../src/renderer/src/editor/healthCounts").noteHealth;
let resolveProposalsIn: typeof import("../../src/renderer/src/editWithAi").resolveProposalsIn;
let currentLanguage: "en" | "zh-CN" = "en";

beforeAll(async () => {
  const [
    schemaMod,
    lineMod,
    reviewMod,
    openMod,
    acceptMod,
    appliedMod,
    notesMod,
    storeMod,
    undoMod,
    copiesMod,
    ownUndoMod,
    keptMod,
    ownSharedMod,
    healthMod,
    tabsMod,
    editWithAiMod,
    editorUndoMod,
  ] = await Promise.all([
    import("../../src/renderer/src/editor/noteSchema"),
    import("../../src/renderer/src/editor/appliedEditLine"),
    import("../../src/renderer/src/editor/proposalReview"),
    import("../../src/renderer/src/editor/openEditors"),
    import("../../src/renderer/src/editor/openNoteAgentAccept"),
    import("../../src/renderer/src/appliedEdits"),
    import("../../src/renderer/src/agentNotes"),
    import("../../src/renderer/src/store"),
    import("../../src/renderer/src/undo"),
    import("../../src/renderer/src/mindCopies"),
    import("../../src/renderer/src/editor/agentOwnUndo"),
    import("../../src/renderer/src/editor/keptHistories"),
    import("../../src/shared/agentOwnChanges"),
    import("../../src/renderer/src/editor/healthCounts"),
    import("../../src/renderer/src/editor/noteTabs"),
    import("../../src/renderer/src/editWithAi"),
    import("../../src/renderer/src/editor/editorUndo"),
  ]);
  ({ noteExtensions } = schemaMod);
  ({ NoteTabs, noteTabsOf } = tabsMod);
  ({ AppliedEditLine, appliedLineIn, setAppliedLine } = lineMod);
  ({ ProposalReview } = reviewMod);
  ({ registerMindEditor } = openMod);
  ({
    prepareOpenNoteWrite,
    verifyOpenNoteWrite,
    acceptOpenNoteWrite,
    cancelOpenNoteWrite,
    installOpenNoteAgentAccept,
  } = acceptMod);
  ({ actOnAppliedEdit, syncHeldOutsideProposals, showClosedAgentLine } = appliedMod);
  ({ useAgentNotes, takeClosedAgentChange } = notesMod);
  ({ useAppStore } = storeMod);
  ({ useUndo } = undoMod);
  ({ openMindCopy, flushMindUpdates, FROM_CORE } = copiesMod);
  ({ undoStackOf } = editorUndoMod);
  ({ takeAgentOwnChanges } = ownUndoMod);
  ({ drawHistory, keepHistory } = keptMod);
  ({ agentOwnChangeRequestId } = ownSharedMod);
  ({ noteHealth } = healthMod);
  ({ resolveProposalsIn } = editWithAiMod);
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  saveCheckpoint.mockClear();
  recordAiUse.mockClear();
  undoAgentChange.mockClear();
  redoAgentChange.mockClear();
  claimAgentChange.mockClear();
  applyMindUpdate.mockClear();
  useAgentNotes.setState({ lines: [] });
  useUndo.setState({ done: [], undone: [], aside: [], line: null, running: null });
  useAppStore.setState({ layout: null, minds: [] });
  currentLanguage = "en";
});

function mountEditor(
  mindId: string,
  content: JSONContent[],
  existingDoc?: Y.Doc,
  history?: Y.UndoManager,
) {
  const doc = existingDoc ?? new Y.Doc();
  if (!existingDoc) {
    const schema = new Editor({ element: null, extensions: noteExtensions() });
    prosemirrorToYXmlFragment(
      schema.schema.nodeFromJSON({ type: "doc", content }),
      doc.getXmlFragment(MIND_CONTENT_FIELD),
    );
    schema.destroy();
  }
  const host = document.createElement("div");
  const editor = new Editor({
    element: host,
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({
        document: doc,
        field: MIND_CONTENT_FIELD,
        ...(history && { yUndoOptions: { undoManager: history } }),
      }),
      ProposalReview.configure({
        translate: (key, params) => translate(currentLanguage, key, params),
      }),
      AppliedEditLine.configure({
        translate: (key, params) => translate(currentLanguage, key, params),
        undoKeys: () => "⌘Z",
      }),
    ],
  });
  const unregister = registerMindEditor(mindId, editor);
  cleanups.push(() => {
    unregister();
    editor.destroy();
    if (!existingDoc) doc.destroy();
  });
  return { doc, editor };
}

function stageInlineProposal(
  doc: Y.Doc,
  blockIndex: number,
  oldWord: string,
  newWord: string,
  request: string,
  proposalId: string,
  held?: true,
): Uint8Array {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const block = blocks.get(blockIndex);
  if (!(block instanceof Y.XmlElement)) throw new Error("Missing paragraph block.");
  const text = block.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("Missing text node.");
  const plain = text.toString();
  const at = plain.indexOf(oldWord);
  if (at < 0) throw new Error(`Word ${oldWord} not found in ${plain}`);
  const ref = { id: proposalId, request, target: targetHash(oldWord) };
  const made: ProposalRequest = {
    source: "outside-agent",
    agent: "Claude Code",
    pairingId: "pair-1",
    createdAt: "2026-11-28T09:00:00.000Z",
    ...(held && { held: true as const }),
  };
  doc.transact(() => {
    text.format(at, oldWord.length, { [PROPOSAL_DELETE_MARK]: ref });
    text.insert(at + oldWord.length, newWord, { [PROPOSAL_INSERT_MARK]: ref });
    recordProposalRequest(doc, request, made);
  }, FROM_CORE);
  return Y.encodeStateVector(doc);
}

describe("mounted editor lossless writes, IME protection, held reopen, and notices (#3839)", () => {
  it.each([
    ["en", "Tides rise and fall twice a day.", "twice", "three times", "Added by typing."],
    ["zh-CN", "潮水每天沿着海岸涨落两次。", "两次", "三次", "用户刚输入的文字。"],
  ] as const)(
    "typing in targeted paragraph refuses with changed (0 words lost), then re-read and reapply succeeds with 1-step Undo (%s)",
    async (language, para, oldWord, newWord, typed) => {
      currentLanguage = language;
      const stop = installOpenNoteAgentAccept();
      cleanups.push(stop);

      const mindId = `mind-typing-${language}`;
      const { doc, editor } = mountEditor(mindId, [
        { type: "paragraph", attrs: { id: "b1" }, content: [{ type: "text", text: para }] },
      ]);

      // Prepare succeeds when idle.
      const prep = await prepareOpenNoteWrite(mindId);
      expect(prep.open).toBe(true);
      if (!prep.open || prep.busy) throw new Error("Expected prepared token.");

      // User types between prepare and accept -> must refuse with "changed" and keep every typed word.
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ` ${typed}`);
      expect(editor.getText()).toContain(typed);

      const stateVector = stageInlineProposal(doc, 0, oldWord, newWord, "req-1", "prop-1");
      const refused = await acceptOpenNoteWrite({
        mindId,
        request: "req-1",
        token: prep.token,
        stateVector,
        changed: 1,
        added: 0,
        tables: 0,
      });
      expect(refused).toBe("changed");
      expect(editor.getText()).toContain(typed);
      expect(saveCheckpoint).not.toHaveBeenCalled();

      // Core rolls back req-1, AI re-reads and reapplies cleanly.
      doc.transact(() => {
        resolveProposals(
          doc.getXmlFragment(MIND_CONTENT_FIELD),
          (ref) => ref.request === "req-1",
          "reject",
        );
      }, FROM_CORE);

      const prep2 = await prepareOpenNoteWrite(mindId);
      if (!prep2.open || prep2.busy) throw new Error("Expected second token.");
      const sv2 = stageInlineProposal(doc, 0, oldWord, newWord, "req-2", "prop-2");
      const applied = await acceptOpenNoteWrite({
        mindId,
        request: "req-2",
        token: prep2.token,
        stateVector: sv2,
        changed: 1,
        added: 0,
        tables: 0,
      });
      expect(applied).toBe("applied");
      expect(saveCheckpoint).toHaveBeenCalledWith(mindId, "accept");
      expect(editor.getText()).toContain(newWord);
      expect(editor.getText()).toContain(typed);
      expect(pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD))).toEqual([]);
      expect(appliedLineIn(editor.state)?.kind).toBe("applied");

      // Single-step Undo restores the pre-edit text while keeping what the User typed.
      actOnAppliedEdit(editor, "undo");
      expect(editor.getText()).toContain(oldWord);
      expect(editor.getText()).toContain(typed);
      expect(appliedLineIn(editor.state)).toBeNull();
    },
  );

  it.each([
    ["same paragraph", 0, "两次", "三次"],
    ["another paragraph", 1, "两次", "三次"],
  ] as const)(
    "Chinese IME composing (view.composing === true) in %s refuses write with 0 DOM mutation and 0 IME wiped once settle wait expires",
    async (_caseName, composeBlockIndex, oldWord, newWord) => {
      currentLanguage = "zh-CN";
      const stop = installOpenNoteAgentAccept();
      cleanups.push(stop);

      const mindId = `mind-ime-${composeBlockIndex}`;
      const p1 = "潮水每天沿着海岸涨落两次。";
      const p2 = "这里正在用中文输入法组字。";
      const seedDoc = new Y.Doc();
      const seedSchema = new Editor({ element: null, extensions: noteExtensions() });
      prosemirrorToYXmlFragment(
        seedSchema.schema.nodeFromJSON({
          type: "doc",
          content: [
            { type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: p1 }] },
            { type: "paragraph", attrs: { id: "p2" }, content: [{ type: "text", text: p2 }] },
          ],
        }),
        seedDoc.getXmlFragment(MIND_CONTENT_FIELD),
      );
      seedSchema.destroy();
      const seedState = Y.encodeStateAsUpdate(seedDoc);
      bridge.openMind.mockResolvedValueOnce({ state: seedState, access: "edit" as const });
      const doc = await new Promise<Y.Doc>((resolve, reject) => {
        const stopCopy = openMindCopy(
          mindId,
          (copy) => {
            if (copy.doc) resolve(copy.doc);
            else reject(new Error("Missing doc from openMindCopy."));
          },
          reject,
        );
        cleanups.push(stopCopy);
      });
      const { editor } = mountEditor(mindId, [], doc);

      // Simulate active Chinese IME composition (`view.composing === true`) in same or another paragraph.
      Object.defineProperty(editor.view, "composing", { value: true, configurable: true });
      const beforeHtml = editor.view.dom.innerHTML;

      const prepBusy = await prepareOpenNoteWrite(mindId, { settleWaitMs: 60 });
      expect(prepBusy).toEqual({ open: true, busy: true });
      expect(editor.view.dom.innerHTML).toBe(beforeHtml);
      expect(saveCheckpoint).not.toHaveBeenCalled();

      // Also test the 1ms race: composing starts right AFTER prepareWrite returned ready.
      Object.defineProperty(editor.view, "composing", { value: false, configurable: true });
      const prepReady = await prepareOpenNoteWrite(mindId, { settleWaitMs: 60 });
      if (!prepReady.open || prepReady.busy) throw new Error("Expected ready token.");

      // IME starts in `composeBlockIndex` before acceptInEditor runs; incoming mind.update is deferred by composing gate.
      Object.defineProperty(editor.view, "composing", { value: true, configurable: true });
      editor.view.dom.dispatchEvent(new page.defaultView.Event("compositionstart"));
      const htmlDuringIme = editor.view.dom.innerHTML;

      // Core stages proposal on its copy and broadcasts mind.update while IME is active.
      const beforeVector = Y.encodeStateVector(doc);
      const stateVector = stageInlineProposal(seedDoc, 0, oldWord, newWord, "req-ime", "prop-ime");
      const update = Y.encodeStateAsUpdate(seedDoc, beforeVector);
      seedDoc.destroy();
      emitCore("mind.update", { mindId, update });
      // Composing gate defers Y.applyUpdate while composing === true -> 0 DOM mutation!
      expect(Y.encodeStateVector(doc)).toEqual(beforeVector);
      expect(editor.view.dom.innerHTML).toBe(htmlDuringIme);

      const raceResult = await acceptOpenNoteWrite(
        {
          mindId,
          request: "req-ime",
          token: prepReady.token,
          stateVector,
          changed: 1,
          added: 0,
          tables: 0,
        },
        { settleWaitMs: 60, typingQuietMs: 20 },
      );
      expect(raceResult).toBe("changed");
      expect(editor.view.dom.innerHTML).toBe(htmlDuringIme);
      expect(saveCheckpoint).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "en",
      "Tides rise twice a day along the coast.",
      "Harbour ferries cross every hour all winter.",
    ],
    ["zh-CN", "潮水每天沿着海岸涨落两次。", "渡轮整个冬季每小时往返港口一次。"],
  ] as const)(
    "held >50% rewrite restores Apply · Discard on closed-Note reopen and Apply saves Checkpoint + updates uncheckedBlocks (%s)",
    async (language, original, rewrite) => {
      currentLanguage = language;
      const mindId = `mind-held-${language}`;

      // Build persisted Y.Doc while Note is closed: already checked + >50% held outside-agent rewrite.
      const stored = new Y.Doc();
      cleanups.push(() => stored.destroy());
      const schema = new Editor({ element: null, extensions: noteExtensions() });
      prosemirrorToYXmlFragment(
        schema.schema.nodeFromJSON({
          type: "doc",
          content: [
            { type: "paragraph", attrs: { id: "b1" }, content: [{ type: "text", text: original }] },
          ],
        }),
        stored.getXmlFragment(MIND_CONTENT_FIELD),
      );
      schema.destroy();
      stored.transact(() => {
        writeMindCheck(stored.getMap(MIND_SETTINGS_FIELD), {
          at: "2026-11-28T09:00:00.000Z",
          sentences: 1,
          stop: null,
          skipped: [],
          unexamined: [],
        });
      });
      stageInlineProposal(stored, 0, original, rewrite, "req-held", "prop-held", true);

      // Reopen the Note in a brand-new mounted editor from persisted Yjs bytes.
      const reopenedDoc = new Y.Doc();
      cleanups.push(() => reopenedDoc.destroy());
      Y.applyUpdate(reopenedDoc, Y.encodeStateAsUpdate(stored));
      const { editor } = mountEditor(mindId, [], reopenedDoc);

      syncHeldOutsideProposals(mindId, editor);
      const heldLine = appliedLineIn(editor.state);
      expect(heldLine).toMatchObject({
        kind: "held",
        request: "req-held",
        asked: { mindId, requests: ["req-held"] },
      });

      // Click Apply -> Checkpoint saved, changes land, #3866 uncheckedBlocks marks block "b1" unchecked!
      actOnAppliedEdit(editor, "apply");
      expect(saveCheckpoint).toHaveBeenCalledWith(mindId, "accept");
      expect(editor.getText()).toContain(rewrite);
      expect(pendingProposals(reopenedDoc.getXmlFragment(MIND_CONTENT_FIELD))).toEqual([]);
      expect(appliedLineIn(editor.state)?.kind).toBe("applied");

      const checkAfter = readMindCheck(reopenedDoc.getMap(MIND_SETTINGS_FIELD));
      expect(checkAfter?.uncheckedBlocks).toContain("b1");
      const health = noteHealth(editor.state.doc, {
        claims: [],
        uncheckedBlocks: new Set(checkAfter?.uncheckedBlocks ?? []),
        citationCheck: () => "found",
      });
      expect(health.toCheck.length).toBeGreaterThan(0);
    },
  );

  it("suppresses SidebarStatus notice when Note is front tab, keeps it for hidden tab & closed Note, and draws inline lines with 1-step Undo", async () => {
    const frontId = "mind-front";
    const hiddenId = "mind-hidden";
    const closedId = "mind-closed";

    useAppStore.setState({
      minds: [
        {
          id: frontId,
          title: "Front",
          autoTitle: "",
          kind: "mind",
          folderId: null,
          createdAt: "2026-11-28T09:00:00.000Z",
          updatedAt: "2026-11-28T09:00:00.000Z",
        },
        {
          id: hiddenId,
          title: "Hidden",
          autoTitle: "",
          kind: "mind",
          folderId: null,
          createdAt: "2026-11-28T09:00:00.000Z",
          updatedAt: "2026-11-28T09:00:00.000Z",
        },
        {
          id: closedId,
          title: "Closed",
          autoTitle: "",
          kind: "mind",
          folderId: null,
          createdAt: "2026-11-28T09:00:00.000Z",
          updatedAt: "2026-11-28T09:00:00.000Z",
        },
      ],
      layout: {
        focusedGroupId: "g1",
        reopenable: 0,
        conversationId: null,
        assistant: {
          dock: "right",
          folded: true,
          width: 320,
          height: 240,
          float: { width: 320, height: 240, corner: "bottom-right", x: 16, y: 16 },
        },
        groups: [
          {
            id: "g1",
            width: 1,
            activeTabId: "t-front",
            tabs: [
              {
                id: "t-front",
                item: { kind: "mind", mindId: frontId },
                preview: false,
                pinned: false,
                place: null,
                opened: 1,
              },
              {
                id: "t-hidden",
                item: { kind: "mind", mindId: hiddenId },
                preview: false,
                pinned: false,
                place: null,
                opened: 1,
              },
            ],
          },
        ],
      },
    });

    // 1. Front tab change -> SidebarStatus notice is suppressed!
    const frontChange: AgentNoteChange = {
      mindId: frontId,
      agent: "Claude Code",
      kind: "changed",
      changed: 1,
      added: 0,
      tables: 0,
      named: { start: "Tides rise", added: false },
      firstBlockId: "b1",
      appliedInEditor: true,
      step: null,
    };
    emitCore("agents.noteChanged", frontChange);
    expect(useAgentNotes.getState().lines.map((each) => each.mindId)).not.toContain(frontId);

    // 2. Hidden tab change -> SidebarStatus notice IS shown, AND switching to tab draws AppliedEditLine + 1-step Undo!
    const seedDoc = new Y.Doc();
    const schema = new Editor({ element: null, extensions: noteExtensions() });
    prosemirrorToYXmlFragment(
      schema.schema.nodeFromJSON({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: "hb1" },
            content: [{ type: "text", text: "Original hidden text." }],
          },
        ],
      }),
      seedDoc.getXmlFragment(MIND_CONTENT_FIELD),
    );
    schema.destroy();
    const initialHiddenState = Y.encodeStateAsUpdate(seedDoc);
    bridge.openMind.mockResolvedValueOnce({ state: initialHiddenState, access: "edit" as const });

    const openedHidden = new Promise<Y.Doc>((resolve, reject) => {
      const stopHiddenCopy = openMindCopy(
        hiddenId,
        (copy) => {
          if (copy.doc) resolve(copy.doc);
          else reject(new Error("Hidden copy opened without doc"));
        },
        reject,
      );
      cleanups.push(stopHiddenCopy);
    });
    const hiddenDoc = await openedHidden;
    const hiddenHistory = new Y.UndoManager(hiddenDoc.getXmlFragment(MIND_CONTENT_FIELD), {
      captureTimeout: 0,
    });
    const releaseKept = keepHistory(hiddenHistory, "t-hidden", hiddenId);
    cleanups.push(() => {
      releaseKept();
      hiddenHistory.destroy();
    });
    const stopOwn = takeAgentOwnChanges(hiddenId, hiddenDoc, hiddenHistory);
    cleanups.push(stopOwn);

    const editedRemote = new Y.Doc();
    Y.applyUpdate(editedRemote, Y.encodeStateAsUpdate(hiddenDoc));
    const remoteText = (editedRemote.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    remoteText.insert(remoteText.length, " Updated.");
    const update = Y.encodeStateAsUpdate(editedRemote, Y.encodeStateVector(hiddenDoc));
    editedRemote.destroy();
    seedDoc.destroy();

    const stepId = "step-hidden-1";
    expect(hiddenHistory.undoStack).toHaveLength(0);
    emitCore("mind.update", {
      mindId: hiddenId,
      update,
      cause: { requestId: agentOwnChangeRequestId(hiddenId), request: stepId, apply: true },
    });
    expect(hiddenHistory.undoStack).toHaveLength(1);

    const hiddenChange: AgentNoteChange = {
      mindId: hiddenId,
      agent: "Claude Code",
      kind: "changed",
      changed: 1,
      added: 0,
      tables: 0,
      named: { start: "Original hidden text.", added: false },
      firstBlockId: "hb1",
      step: stepId,
    };
    emitCore("agents.noteChanged", hiddenChange);
    expect(useAgentNotes.getState().lines.map((each) => each.mindId)).toContain(hiddenId);

    // Switching to the hidden tab mounts its editor on hiddenDoc + drawHistory -> draws AppliedEditLine + 1-step Undo!
    const { editor: hiddenEditor } = mountEditor(hiddenId, [], hiddenDoc, hiddenHistory);
    const stopHiddenDraw = drawHistory(hiddenHistory, hiddenEditor);
    cleanups.push(stopHiddenDraw);
    await Promise.resolve();
    expect(hiddenEditor.getText()).toContain("Original hidden text. Updated.");
    expect(appliedLineIn(hiddenEditor.state)).toMatchObject({
      kind: "applied",
      blockId: "hb1",
      facts: { named: { start: "Original hidden text.", added: false } },
    });
    actOnAppliedEdit(hiddenEditor, "undo");
    expect(hiddenEditor.getText()).toBe("Original hidden text.");
    expect(appliedLineIn(hiddenEditor.state)).toBeNull();

    // 3. Closed Note change -> SidebarStatus notice IS shown, opening Note draws inline AppliedEditLine bound to core Undo!
    const closedChange: AgentNoteChange = {
      mindId: closedId,
      agent: "Claude Code",
      kind: "changed",
      changed: 1,
      added: 0,
      tables: 0,
      named: { start: "Closed note paragraph", added: false },
      firstBlockId: "cb1",
      step: "step-closed-1",
    };
    emitCore("agents.noteChanged", closedChange);
    expect(useAgentNotes.getState().lines.map((each) => each.mindId)).toContain(closedId);

    const pendingClosed = takeClosedAgentChange(closedId);
    expect(pendingClosed).not.toBeNull();
    const { editor: closedEditor } = mountEditor(closedId, [
      {
        type: "paragraph",
        attrs: { id: "cb1" },
        content: [{ type: "text", text: "Closed note paragraph updated." }],
      },
    ]);
    // Switch layout so closed Note is shown, then attach its closed-Note inline line.
    useAppStore.setState({
      layout: {
        focusedGroupId: "g1",
        reopenable: 0,
        conversationId: null,
        assistant: {
          dock: "right",
          folded: true,
          width: 320,
          height: 240,
          float: { width: 320, height: 240, corner: "bottom-right", x: 16, y: 16 },
        },
        groups: [
          {
            id: "g1",
            width: 1,
            activeTabId: "t-closed",
            tabs: [
              {
                id: "t-closed",
                item: { kind: "mind", mindId: closedId },
                preview: false,
                pinned: false,
                place: null,
                opened: 1,
              },
            ],
          },
        ],
      },
    });
    if (pendingClosed)
      showClosedAgentLine(closedEditor, pendingClosed.change, pendingClosed.undoable);
    expect(appliedLineIn(closedEditor.state)).toMatchObject({
      kind: "applied",
      blockId: "cb1",
      facts: { named: { start: "Closed note paragraph", added: false } },
    });

    // Clicking Undo on the inline line invokes core.undoAgentChange("step-closed-1") and clears the line!
    actOnAppliedEdit(closedEditor, "undo");
    await Promise.resolve();
    expect(undoAgentChange).toHaveBeenCalledWith("step-closed-1");
    expect(appliedLineIn(closedEditor.state)).toBeNull();
  });

  // protects=flushDomObserver calls forceFlush() before flush() so ProseMirror's 20ms flushingSoon window cannot hide in-flight typing (#3839); fails_when=forceFlush is skipped or called after flush
  it("calls domObserver.forceFlush() before flush() during prepare and accept", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);
    const mindId = "mind-force-flush";
    const { doc, editor } = mountEditor(mindId, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice a day." }],
      },
    ]);
    const calls: string[] = [];
    const observer = (
      editor.view as unknown as { domObserver: { forceFlush(): void; flush(): void } }
    ).domObserver;
    vi.spyOn(observer, "forceFlush").mockImplementation(() => {
      calls.push("forceFlush");
    });
    vi.spyOn(observer, "flush").mockImplementation(() => {
      calls.push("flush");
    });
    const prep = await prepareOpenNoteWrite(mindId);
    expect(prep.open).toBe(true);
    if (!prep.open || prep.busy) throw new Error("Expected ready token.");
    expect(calls[0]).toBe("forceFlush");
    expect(calls).toContain("flush");

    calls.length = 0;
    const sv = stageInlineProposal(doc, 0, "twice", "three times", "req-ff", "prop-ff");
    const result = await acceptOpenNoteWrite({
      mindId,
      request: "req-ff",
      token: prep.token,
      stateVector: sv,
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(result).toBe("applied");
    expect(calls[0]).toBe("forceFlush");
    expect(calls).toContain("flush");
  });

  // protects=notifyCompositionEnd flushes DOM via forceFlush() BEFORE draining deferred mind.update, and fallback timer drains deferred updates if view.composing clears without a DOM compositionend (#3839); fails_when=deferred updates run before forceFlush or stay wedged forever
  it("flushes committed IME DOM before draining deferred updates and unblocks without compositionend", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);
    const mindId = "mind-ime-drain";
    const seed = new Y.Doc();
    const schema = new Editor({ element: null, extensions: noteExtensions() });
    prosemirrorToYXmlFragment(
      schema.schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "潮水。" }] },
        ],
      }),
      seed.getXmlFragment(MIND_CONTENT_FIELD),
    );
    schema.destroy();
    bridge.openMind.mockResolvedValueOnce({
      state: Y.encodeStateAsUpdate(seed),
      access: "edit" as const,
    });
    const doc = await new Promise<Y.Doc>((resolve, reject) => {
      const stopCopy = openMindCopy(
        mindId,
        (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("Missing doc"))),
        reject,
      );
      cleanups.push(stopCopy);
    });
    const { editor } = mountEditor(mindId, [], doc);

    // Part 1: forceFlush runs BEFORE deferred mind.update applies on compositionend.
    const order: string[] = [];
    const observer = (
      editor.view as unknown as { domObserver: { forceFlush(): void; flush(): void } }
    ).domObserver;
    vi.spyOn(observer, "forceFlush").mockImplementation(() => {
      order.push("forceFlush");
    });
    vi.spyOn(observer, "flush").mockImplementation(() => {
      order.push("flush");
    });
    doc.on("update", () => order.push("doc-update"));

    Object.defineProperty(editor.view, "composing", { value: true, configurable: true });
    const remote1 = new Y.Doc();
    Y.applyUpdate(remote1, Y.encodeStateAsUpdate(doc));
    (
      (remote1.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText
    ).insert(0, "远方");
    const upd1 = Y.encodeStateAsUpdate(remote1, Y.encodeStateVector(doc));
    remote1.destroy();

    emitCore("mind.update", { mindId, update: upd1 });
    expect(order).toEqual([]);

    Object.defineProperty(editor.view, "composing", { value: false, configurable: true });
    editor.view.dom.dispatchEvent(new page.defaultView.Event("compositionend"));
    await Promise.resolve();
    expect(order.indexOf("forceFlush")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("doc-update")).toBeGreaterThan(order.indexOf("forceFlush"));

    // Part 2: view.composing clears via blur/timeout WITHOUT DOM compositionend -> fallback poll drains!
    order.length = 0;
    Object.defineProperty(editor.view, "composing", { value: true, configurable: true });
    const remote2 = new Y.Doc();
    Y.applyUpdate(remote2, Y.encodeStateAsUpdate(doc));
    (
      (remote2.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText
    ).insert(0, "后续");
    const upd2 = Y.encodeStateAsUpdate(remote2, Y.encodeStateVector(doc));
    remote2.destroy();

    emitCore("mind.update", { mindId, update: upd2 });
    expect(order).toEqual([]);

    // Flip view.composing false WITHOUT dispatching compositionend.
    Object.defineProperty(editor.view, "composing", { value: false, configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(order).toContain("forceFlush");
    expect(order).toContain("doc-update");
    expect(editor.getText()).toContain("后续");
    seed.destroy();
  });

  // protects=split panes all flush on accept, an edit flushed from a second pane refuses with changed, and a second pane opened between prepare and accept refuses with changed (#3839); fails_when=only primary flushes or a newly opened pane slips past gens
  it("flushes all split-pane editors and refuses if a second pane edits or opens after prepare", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);
    const mindId = "mind-split";

    // Case A: second pane already open at prepare; its forceFlush reveals an unflushed local edit during accept.
    const pane1 = mountEditor(mindId, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice." }],
      },
    ]);
    const pane2 = mountEditor(mindId, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice." }],
      },
    ]);
    const prep1 = await prepareOpenNoteWrite(mindId);
    if (!prep1.open || prep1.busy) throw new Error("Expected ready token.");

    let pane2Flushed = false;
    const pane2Observer = (
      pane2.editor.view as unknown as { domObserver: { forceFlush(): void; flush(): void } }
    ).domObserver;
    vi.spyOn(pane2Observer, "forceFlush").mockImplementation(() => {
      pane2Flushed = true;
      pane2.editor.commands.insertContentAt(pane2.editor.state.doc.content.size - 1, " typed");
    });
    const sv1 = stageInlineProposal(pane1.doc, 0, "twice", "daily", "req-sp1", "prop-sp1");
    const res1 = await acceptOpenNoteWrite({
      mindId,
      request: "req-sp1",
      token: prep1.token,
      stateVector: sv1,
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(pane2Flushed).toBe(true);
    expect(res1).toBe("changed");

    // Case B: a brand-new split pane opens for mindId between prepare and accept -> refused with "changed"!
    const mindId2 = "mind-split-new";
    const first = mountEditor(mindId2, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice." }],
      },
    ]);
    const prep2 = await prepareOpenNoteWrite(mindId2);
    if (!prep2.open || prep2.busy) throw new Error("Expected ready token.");
    // Verify works cleanly when unchanged, before second pane opens.
    const prepVerify = await prepareOpenNoteWrite(mindId2);
    if (!prepVerify.open || prepVerify.busy) throw new Error("Expected verify token.");
    expect(verifyOpenNoteWrite(mindId2, prepVerify.token)).toBe(true);

    // Now open a brand-new split pane with its own Y.Doc not present in prep2's gens.
    mountEditor(mindId2, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice." }],
      },
    ]);
    const sv2 = stageInlineProposal(first.doc, 0, "twice", "daily", "req-sp2", "prop-sp2");
    const res2 = await acceptOpenNoteWrite({
      mindId: mindId2,
      request: "req-sp2",
      token: prep2.token,
      stateVector: sv2,
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(res2).toBe("changed");
  });

  // protects=NoteTabs remote-change fix-ups never count as User typing, and staging an empty tab to an open Note with the app's extensions lands cleanly on the first try with zero stray blank paragraphs (#3839); fails_when=NoteTabs empty-line fix-up triggers changed or leaks blank paragraphs
  it("lands a staged empty tab cleanly with the app's NoteTabs extension without counting remote fix-ups as typing", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);
    const mindId = "mind-notetabs";
    const doc = new Y.Doc();
    cleanups.push(() => doc.destroy());
    const schema = new Editor({ element: null, extensions: editorExtensions() });
    prosemirrorToYXmlFragment(
      schema.schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: NOTE_TAB_NODE, attrs: { id: "tab-1", [NOTE_TAB_TITLE_ATTRIBUTE]: "Summary" } },
          {
            type: "paragraph",
            attrs: { id: "p-1" },
            content: [{ type: "text", text: "Harbour report for the coast." }],
          },
        ],
      }),
      doc.getXmlFragment(MIND_CONTENT_FIELD),
    );
    schema.destroy();

    const host = document.createElement("div");
    const editor = new Editor({
      element: host,
      extensions: [
        ...editorExtensions(),
        NoteTabs.configure({ mindId }),
        Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
        ProposalReview.configure({
          translate: (key, params) => translate(currentLanguage, key, params),
        }),
        AppliedEditLine.configure({
          translate: (key, params) => translate(currentLanguage, key, params),
          undoKeys: () => "⌘Z",
        }),
      ],
    });
    const unregister = registerMindEditor(mindId, editor);
    cleanups.push(() => {
      unregister();
      editor.destroy();
    });

    const prep = await prepareOpenNoteWrite(mindId);
    if (!prep.open || prep.busy) throw new Error("Expected ready token.");

    // Stage an empty tab Proposal from core (FROM_CORE).
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    const prop = blockProposal({ id: "prop-tab", request: "req-tab" }, "insert", "");
    doc.transact(() => {
      const tabEl = new Y.XmlElement(NOTE_TAB_NODE);
      tabEl.setAttribute(BLOCK_ID_ATTRIBUTE, "tab-2");
      tabEl.setAttribute(NOTE_TAB_TITLE_ATTRIBUTE, "Notes");
      setProposal(tabEl, prop);
      blocks.insert(blocks.length, [tabEl]);
      recordProposalRequest(doc, "req-tab", {
        source: "outside-agent",
        agent: "Claude Code",
        pairingId: "pair-1",
        createdAt: "2026-11-28T09:00:00.000Z",
        staging: true,
      });
    }, FROM_CORE);

    // NoteTabs must NOT insert a stray empty paragraph while the tab is only a staged insert Proposal.
    expect(blocks.length).toBe(3);

    const outcome = await acceptOpenNoteWrite({
      mindId,
      request: "req-tab",
      token: prep.token,
      stateVector: Y.encodeStateVector(doc),
      changed: 0,
      added: 1,
      tables: 0,
    });
    expect(outcome).toBe("applied");
    expect(noteTabsOf(editor.state).tabs.map((each) => each.title)).toEqual(["Summary", "Notes"]);
    expect(pendingProposals(blocks)).toEqual([]);

    // Now test a remote change triggering NoteTabs' empty-tab fix-up on an existing tab: must NOT count as User typing!
    const prep2 = await prepareOpenNoteWrite(mindId);
    if (!prep2.open || prep2.busy) throw new Error("Expected second token.");
    doc.transact(() => {
      // Remove the empty line after "Notes" remotely so NoteTabs' appendTransaction re-inserts one on remote sync.
      if (blocks.length > 3) blocks.delete(3, blocks.length - 3);
    }, FROM_CORE);
    const sv2 = stageInlineProposal(doc, 1, "Harbour", "Coastal", "req-tab-2", "prop-tab-2");
    const outcome2 = await acceptOpenNoteWrite({
      mindId,
      request: "req-tab-2",
      token: prep2.token,
      stateVector: sv2,
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(outcome2).toBe("applied");
    expect(editor.getText()).toContain("Coastal report for the coast.");
  });

  // protects=when Chinese IME or unrelated typing settles within the bounded wait in another paragraph, the write lands cleanly without losing User text, whereas committing in the targeted paragraph still refuses cleanly (#3839); fails_when=any unrelated typing or brief IME commit always refuses
  it("waits briefly for Chinese IME and unrelated typing to settle before accepting or refusing", async () => {
    currentLanguage = "zh-CN";
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);

    // Case 1: IME composing in paragraph 2 commits within the bounded settle window -> AI edit on paragraph 1 applies cleanly!
    const mindId1 = "mind-settle-ime-other";
    const seed = new Y.Doc();
    const schema = new Editor({ element: null, extensions: noteExtensions() });
    prosemirrorToYXmlFragment(
      schema.schema.nodeFromJSON({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: "p1" },
            content: [{ type: "text", text: "潮水每天沿着海岸涨落两次。" }],
          },
          {
            type: "paragraph",
            attrs: { id: "p2" },
            content: [{ type: "text", text: "港务记录。" }],
          },
        ],
      }),
      seed.getXmlFragment(MIND_CONTENT_FIELD),
    );
    schema.destroy();
    bridge.openMind.mockResolvedValueOnce({
      state: Y.encodeStateAsUpdate(seed),
      access: "edit" as const,
    });
    const doc1 = await new Promise<Y.Doc>((resolve, reject) => {
      const stopCopy = openMindCopy(
        mindId1,
        (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("Missing doc"))),
        reject,
      );
      cleanups.push(stopCopy);
    });
    const { editor: editor1 } = mountEditor(mindId1, [], doc1);
    const prep1 = await prepareOpenNoteWrite(mindId1, { settleWaitMs: 300 });
    if (!prep1.open || prep1.busy) throw new Error("Expected ready token.");

    Object.defineProperty(editor1.view, "composing", { value: true, configurable: true });
    editor1.view.dom.dispatchEvent(new page.defaultView.Event("compositionstart"));
    const beforeVec = Y.encodeStateVector(doc1);
    const sv1 = stageInlineProposal(seed, 0, "两次", "三次", "req-settle-1", "prop-settle-1");
    const upd1 = Y.encodeStateAsUpdate(seed, beforeVec);
    seed.destroy();
    emitCore("mind.update", { mindId: mindId1, update: upd1 });

    // Commit Chinese text into paragraph 2 after 30ms (within settleWaitMs).
    setTimeout(() => {
      Object.defineProperty(editor1.view, "composing", { value: false, configurable: true });
      editor1.commands.insertContentAt(editor1.state.doc.content.size - 1, "补充海港信息。");
      editor1.view.dom.dispatchEvent(new page.defaultView.Event("compositionend"));
    }, 30);

    const res1 = await acceptOpenNoteWrite(
      {
        mindId: mindId1,
        request: "req-settle-1",
        token: prep1.token,
        stateVector: sv1,
        changed: 1,
        added: 0,
        tables: 0,
      },
      { settleWaitMs: 400, typingQuietMs: 30 },
    );
    expect(res1).toBe("applied");
    expect(editor1.getText()).toContain("三次");
    expect(editor1.getText()).toContain("补充海港信息。");

    // Case 2: Unrelated typing in paragraph 2 pauses -> AI edit on paragraph 1 lands cleanly with both edits intact!
    const mindId2 = "mind-settle-typing-other";
    const { doc: doc2, editor: editor2 } = mountEditor(mindId2, [
      {
        type: "paragraph",
        attrs: { id: "a1" },
        content: [{ type: "text", text: "Tides rise twice a day." }],
      },
      {
        type: "paragraph",
        attrs: { id: "a2" },
        content: [{ type: "text", text: "Harbour timetable." }],
      },
    ]);
    const prep2 = await prepareOpenNoteWrite(mindId2);
    if (!prep2.open || prep2.busy) throw new Error("Expected ready token.");
    editor2.commands.insertContentAt(editor2.state.doc.content.size - 1, " Checked Monday.");
    const sv2 = stageInlineProposal(doc2, 0, "twice", "daily", "req-settle-2", "prop-settle-2");
    const res2 = await acceptOpenNoteWrite(
      {
        mindId: mindId2,
        request: "req-settle-2",
        token: prep2.token,
        stateVector: sv2,
        changed: 1,
        added: 0,
        tables: 0,
      },
      { settleWaitMs: 300, typingQuietMs: 30 },
    );
    expect(res2).toBe("applied");
    expect(editor2.getText()).toContain("daily");
    expect(editor2.getText()).toContain("Checked Monday.");

    // Case 3: IME composing in the SAME targeted paragraph commits within settleWaitMs -> refuses cleanly with 0 words lost!
    const mindId3 = "mind-settle-ime-same";
    const { doc: doc3, editor: editor3 } = mountEditor(mindId3, [
      {
        type: "paragraph",
        attrs: { id: "s1" },
        content: [{ type: "text", text: "潮水每天沿着海岸涨落两次。" }],
      },
    ]);
    const prep3 = await prepareOpenNoteWrite(mindId3, { settleWaitMs: 300 });
    if (!prep3.open || prep3.busy) throw new Error("Expected ready token.");
    const sv3 = stageInlineProposal(doc3, 0, "两次", "三次", "req-settle-3", "prop-settle-3");
    Object.defineProperty(editor3.view, "composing", { value: true, configurable: true });
    editor3.view.dom.dispatchEvent(new page.defaultView.Event("compositionstart"));
    setTimeout(() => {
      Object.defineProperty(editor3.view, "composing", { value: false, configurable: true });
      editor3.commands.insertContentAt(editor3.state.doc.content.size - 1, "海港实测");
      editor3.view.dom.dispatchEvent(new page.defaultView.Event("compositionend"));
    }, 30);
    const res3 = await acceptOpenNoteWrite(
      {
        mindId: mindId3,
        request: "req-settle-3",
        token: prep3.token,
        stateVector: sv3,
        changed: 1,
        added: 0,
        tables: 0,
      },
      { settleWaitMs: 400, typingQuietMs: 30 },
    );
    expect(res3).toBe("changed");
    expect(editor3.getText()).toContain("海港实测");
  });

  // protects=cancelOpenNoteWrite aborts an in-flight acceptOpenNoteWrite cleanly without mutating the doc after a main-process timeout (#3839); fails_when=cancelled accept still mutates the doc
  it("aborts an in-flight accept cleanly on cancelOpenNoteWrite without mutating the document", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);
    const mindId = "mind-cancel";
    const { doc, editor } = mountEditor(mindId, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice a day." }],
      },
    ]);
    const prep = await prepareOpenNoteWrite(mindId);
    if (!prep.open || prep.busy) throw new Error("Expected ready token.");

    // State vector ahead of current doc so acceptOpenNoteWrite waits for vector arrival.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const aheadVector = stageInlineProposal(
      remote,
      0,
      "twice",
      "daily",
      "req-cancel",
      "prop-cancel",
    );
    remote.destroy();

    const pendingAccept = acceptOpenNoteWrite({
      mindId,
      request: "req-cancel",
      token: prep.token,
      stateVector: aheadVector,
      changed: 1,
      added: 0,
      tables: 0,
    });
    cancelOpenNoteWrite(mindId, "req-cancel", prep.token);
    expect(await pendingAccept).toBe("changed");
    expect(editor.getText()).toContain("twice");
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  // protects=syncHeldOutsideProposals never replaces an existing "applied" Undo line with a held line (#3839); fails_when=applied Undo line disappears when held proposals exist
  it("never overwrites an applied Undo line when syncing held outside-agent Proposals", () => {
    const mindId = "mind-keep-applied-line";
    const { doc, editor } = mountEditor(mindId, [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "Tides rise twice a day along the coast." }],
      },
    ]);
    stageInlineProposal(
      doc,
      0,
      "Tides rise twice a day along the coast.",
      "Harbour ferries cross hourly.",
      "req-held-keep",
      "prop-held-keep",
      true,
    );
    setAppliedLine(editor, {
      kind: "applied",
      blockId: "b1",
      blocks: { paragraphs: 1, tables: 0 },
      reason: null,
      kept: null,
    });
    syncHeldOutsideProposals(mindId, editor);
    expect(appliedLineIn(editor.state)?.kind).toBe("applied");
  });

  // protects=when core.applyMindUpdate rejects for a non-missedChange error, acceptOpenNoteWrite does not return applied and preserves the editor error report, while a recovered missedChange retry still returns applied (#3839); fails_when=rejected save returns applied or drops the error report
  it("returns failed instead of applied when core.applyMindUpdate rejects while keeping the error report", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);

    const openCopyFor = async (
      mindId: string,
      text: string,
      onFailed: (error: unknown) => void,
    ) => {
      const seed = new Y.Doc();
      const schema = new Editor({ element: null, extensions: noteExtensions() });
      prosemirrorToYXmlFragment(
        schema.schema.nodeFromJSON({
          type: "doc",
          content: [{ type: "paragraph", attrs: { id: "b1" }, content: [{ type: "text", text }] }],
        }),
        seed.getXmlFragment(MIND_CONTENT_FIELD),
      );
      schema.destroy();
      bridge.openMind.mockResolvedValueOnce({
        state: Y.encodeStateAsUpdate(seed),
        access: "edit" as const,
      });
      seed.destroy();
      const doc = await new Promise<Y.Doc>((resolve, reject) => {
        const stopCopy = openMindCopy(
          mindId,
          (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("Missing doc"))),
          onFailed,
        );
        cleanups.push(stopCopy);
      });
      return mountEditor(mindId, [], doc);
    };

    // Case 1: non-missedChange rejection -> reports error AND returns "failed", never "applied".
    const saveError = new Error("Disk full");
    const reported: unknown[] = [];
    const { doc, editor } = await openCopyFor("mind-save-fail", "Tides rise twice a day.", (err) =>
      reported.push(err),
    );
    const prep = await prepareOpenNoteWrite("mind-save-fail");
    if (!prep.open || prep.busy) throw new Error("Expected ready token.");
    const sv = stageInlineProposal(doc, 0, "twice", "daily", "req-fail", "prop-fail");
    applyMindUpdate.mockRejectedValueOnce(saveError);

    const outcome = await acceptOpenNoteWrite({
      mindId: "mind-save-fail",
      request: "req-fail",
      token: prep.token,
      stateVector: sv,
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(reported).toEqual([saveError]);
    expect(outcome).toBe("failed");
    expect(appliedLineIn(editor.state)).toBeNull();
    expect(editor.getText()).toBe("Tides rise twice a day.");

    // Case 2: missedChange fails once then succeeds on retry -> returns "applied" with no error report.
    const retryReported: unknown[] = [];
    const { doc: doc2 } = await openCopyFor("mind-save-retry", "Tides rise twice a day.", (err) =>
      retryReported.push(err),
    );
    const prep2 = await prepareOpenNoteWrite("mind-save-retry");
    if (!prep2.open || prep2.busy) throw new Error("Expected ready token.");
    const sv2 = stageInlineProposal(doc2, 0, "twice", "daily", "req-retry", "prop-retry");
    const missed = new TranslatableError({ key: "error.mind.missedChange" });
    applyMindUpdate.mockRejectedValueOnce(missed);
    applyMindUpdate.mockResolvedValueOnce(undefined);

    const retryOutcome = await acceptOpenNoteWrite({
      mindId: "mind-save-retry",
      request: "req-retry",
      token: prep2.token,
      stateVector: sv2,
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(retryReported).toEqual([]);
    expect(retryOutcome).toBe("applied");
  });

  // protects=when acceptOpenNoteWrite fails to save, it undoes the applied transaction so the editor shows the User's text exactly as before and a following save sends nothing of the refused change (#3839); fails_when=refused text stays in the editor or leaks into core on a later save
  it("restores the editor document before returning failed so a following save sends nothing of the refused change", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);

    const mindId = "mind-save-fail-restore";
    const original = "Tides rise twice a day.";
    const coreDoc = new Y.Doc();
    cleanups.push(() => coreDoc.destroy());
    const schema = new Editor({ element: null, extensions: noteExtensions() });
    prosemirrorToYXmlFragment(
      schema.schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", attrs: { id: "b1" }, content: [{ type: "text", text: original }] },
        ],
      }),
      coreDoc.getXmlFragment(MIND_CONTENT_FIELD),
    );
    schema.destroy();
    coreDoc.transact(() => {
      writeMindCheck(coreDoc.getMap(MIND_SETTINGS_FIELD), {
        at: "2026-11-28T09:00:00.000Z",
        sentences: 1,
        stop: null,
        skipped: [],
        unexamined: [],
      });
    });

    let rejectSaves = false;
    const saveError = new Error("Disk full");
    applyMindUpdate.mockImplementation(async (_id: string, update: Uint8Array) => {
      if (rejectSaves) throw saveError;
      const { from } = Y.parseUpdateMeta(update);
      const have = Y.decodeStateVector(Y.encodeStateVector(coreDoc));
      const missed = [...from].some(([client, clock]) => clock > (have.get(client) ?? 0));
      const hadPending = coreDoc.store.pendingStructs !== null || coreDoc.store.pendingDs !== null;
      Y.applyUpdate(coreDoc, update);
      const nowPending = coreDoc.store.pendingStructs !== null || coreDoc.store.pendingDs !== null;
      if (missed || (!hadPending && nowPending)) {
        throw new TranslatableError({ key: "error.mind.missedChange" });
      }
    });
    cleanups.push(() => {
      applyMindUpdate.mockImplementation(async () => undefined);
    });

    bridge.openMind.mockResolvedValueOnce({
      state: Y.encodeStateAsUpdate(coreDoc),
      access: "edit" as const,
    });
    const reported: unknown[] = [];
    const doc = await new Promise<Y.Doc>((resolve, reject) => {
      const stopCopy = openMindCopy(
        mindId,
        (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("Missing doc"))),
        (error) => reported.push(error),
      );
      cleanups.push(stopCopy);
    });
    const { editor } = mountEditor(mindId, [], doc);

    // Record a prior User Undo step so rollback proves it drops only the failed agent accept.
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Here.");
    expect(await flushMindUpdates(mindId)).toBe(true);
    const beforeAccept = `${original} Here.`;
    expect(editor.getText()).toBe(beforeAccept);
    expect(undoStackOf(editor)?.undoStack).toHaveLength(1);

    const prep = await prepareOpenNoteWrite(mindId);
    if (!prep.open || prep.busy) throw new Error("Expected ready token.");

    // Core stages the Proposal and broadcasts mind.update to the open editor copy.
    const beforeStage = Y.encodeStateVector(coreDoc);
    const sv = stageInlineProposal(coreDoc, 0, "twice", "daily", "req-restore", "prop-restore");
    emitCore("mind.update", { mindId, update: Y.encodeStateAsUpdate(coreDoc, beforeStage) });

    // Storage fails while acceptOpenNoteWrite saves the accepted edit.
    rejectSaves = true;
    const outcome = await acceptOpenNoteWrite({
      mindId,
      request: "req-restore",
      token: prep.token,
      stateVector: sv,
      changed: 1,
      added: 0,
      tables: 0,
    });

    expect(outcome).toBe("failed");
    expect(reported.length).toBeGreaterThan(0);
    expect(appliedLineIn(editor.state)).toBeNull();
    expect(editor.getText()).toBe(beforeAccept);
    expect(pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD))).toEqual([]);
    expect(textOriginOf(doc, "b1")).toBeNull();
    expect(readMindCheck(doc.getMap(MIND_SETTINGS_FIELD))?.uncheckedBlocks).toBeUndefined();
    expect(decisionsOn(doc, "req-restore").accepted).toBe(0);
    expect(undoStackOf(editor)?.undoStack).toHaveLength(1);
    expect(undoStackOf(editor)?.redoStack).toHaveLength(0);
    expect(useUndo.getState().done).toHaveLength(0);
    expect(useUndo.getState().undone).toHaveLength(0);

    // Core rejects its staged Proposal and broadcasts the cleanup to the editor.
    const beforeReject = Y.encodeStateVector(coreDoc);
    coreDoc.transact(() => {
      resolveProposals(
        coreDoc.getXmlFragment(MIND_CONTENT_FIELD),
        (ref) => ref.request === "req-restore",
        "reject",
      );
    });
    emitCore("mind.update", { mindId, update: Y.encodeStateAsUpdate(coreDoc, beforeReject) });
    expect(editor.getText()).toBe(beforeAccept);

    // Storage recovers and the User makes a following edit -> core receives only the User's text.
    rejectSaves = false;
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Still here.");
    expect(await flushMindUpdates(mindId)).toBe(true);

    const coreBlocks = coreDoc.getXmlFragment(MIND_CONTENT_FIELD);
    const coreParagraph = coreBlocks.get(0);
    if (!(coreParagraph instanceof Y.XmlElement)) throw new Error("Missing core paragraph.");
    expect(coreParagraph.toString()).toBe(
      `<paragraph id="b1">${beforeAccept} Still here.</paragraph>`,
    );
    expect(coreParagraph.toString()).not.toContain("daily");
    expect(pendingProposals(coreBlocks)).toEqual([]);
    expect(textOriginOf(coreDoc, "b1")).toBeNull();
    expect(readMindCheck(coreDoc.getMap(MIND_SETTINGS_FIELD))?.uncheckedBlocks).toBeUndefined();
    expect(decisionsOn(coreDoc, "req-restore").accepted).toBe(0);
  });

  // protects=failed accept rollback preserves a newer applied/held line and still clears its own line on a remounted kept-history editor (#3839); fails_when=rollback wipes a newer line or leaves a phantom applied line after tab remount
  it("keeps a newer line intact and clears its own line on a remounted editor when rolling back a failed save", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);

    const openDocWith = async (mindId: string, text: string) => {
      const seed = new Y.Doc();
      const schema = new Editor({ element: null, extensions: noteExtensions() });
      prosemirrorToYXmlFragment(
        schema.schema.nodeFromJSON({
          type: "doc",
          content: [{ type: "paragraph", attrs: { id: "b1" }, content: [{ type: "text", text }] }],
        }),
        seed.getXmlFragment(MIND_CONTENT_FIELD),
      );
      schema.destroy();
      bridge.openMind.mockResolvedValueOnce({
        state: Y.encodeStateAsUpdate(seed),
        access: "edit" as const,
      });
      seed.destroy();
      return new Promise<Y.Doc>((resolve, reject) => {
        const stopCopy = openMindCopy(
          mindId,
          (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("Missing doc"))),
          () => undefined,
        );
        cleanups.push(stopCopy);
      });
    };

    // Part 1: a newer line set while the save is in flight survives rollback.
    const mindId1 = "mind-fail-newer-line";
    const doc1 = await openDocWith(mindId1, "Tides rise twice a day.");
    const { editor: editor1 } = mountEditor(mindId1, [], doc1);
    const prep1 = await prepareOpenNoteWrite(mindId1);
    if (!prep1.open || prep1.busy) throw new Error("Expected ready token.");
    const sv1 = stageInlineProposal(doc1, 0, "twice", "daily", "req-nl", "prop-nl");

    const deferred1: { reject(error: unknown): void }[] = [];
    let hold1 = true;
    applyMindUpdate.mockImplementation(async () => {
      if (!hold1) return;
      await new Promise<void>((_resolve, reject) => {
        deferred1.push({ reject });
      });
    });
    cleanups.push(() => {
      applyMindUpdate.mockImplementation(async () => undefined);
    });

    const pending1 = acceptOpenNoteWrite({
      mindId: mindId1,
      request: "req-nl",
      token: prep1.token,
      stateVector: sv1,
      changed: 1,
      added: 0,
      tables: 0,
    });
    await vi.waitFor(() => expect(appliedLineIn(editor1.state)?.kind).toBe("applied"));
    const newerLine = {
      kind: "applied" as const,
      blockId: "b1",
      blocks: { paragraphs: 2, tables: 0 },
      reason: "Newer edit",
      kept: null,
    };
    setAppliedLine(editor1, newerLine);
    expect(appliedLineIn(editor1.state)).toBe(newerLine);

    hold1 = false;
    for (const item of deferred1) item.reject(new Error("Disk full"));
    expect(await pending1).toBe("failed");
    expect(editor1.getText()).toBe("Tides rise twice a day.");
    expect(appliedLineIn(editor1.state)).toBe(newerLine);

    // Part 2: a kept-history tab that remounts during the pending save still gets its own line cleared.
    const mindId2 = "mind-fail-remount";
    const doc2 = await openDocWith(mindId2, "Tides rise twice a day.");
    const history2 = new Y.UndoManager(doc2.getXmlFragment(MIND_CONTENT_FIELD), {
      captureTimeout: 0,
    });
    const release2 = keepHistory(history2, "tab-remount", mindId2);
    cleanups.push(() => {
      release2();
      history2.destroy();
    });
    const { editor: firstEditor } = mountEditor(mindId2, [], doc2, history2);
    const stopDraw1 = drawHistory(history2, firstEditor);
    cleanups.push(stopDraw1);
    await Promise.resolve();

    const prep2 = await prepareOpenNoteWrite(mindId2);
    if (!prep2.open || prep2.busy) throw new Error("Expected second token.");
    const sv2 = stageInlineProposal(doc2, 0, "twice", "daily", "req-rm", "prop-rm");

    const deferred2: { reject(error: unknown): void }[] = [];
    let hold2 = true;
    applyMindUpdate.mockImplementation(async () => {
      if (!hold2) return;
      await new Promise<void>((_resolve, reject) => {
        deferred2.push({ reject });
      });
    });

    const pending2 = acceptOpenNoteWrite({
      mindId: mindId2,
      request: "req-rm",
      token: prep2.token,
      stateVector: sv2,
      changed: 1,
      added: 0,
      tables: 0,
    });
    await vi.waitFor(() => expect(appliedLineIn(firstEditor.state)?.kind).toBe("applied"));

    // Remount the kept-history tab onto a fresh editor before the save fails.
    stopDraw1();
    await Promise.resolve();
    firstEditor.destroy();
    const { editor: secondEditor } = mountEditor(mindId2, [], doc2, history2);
    const stopDraw2 = drawHistory(history2, secondEditor);
    cleanups.push(stopDraw2);
    await Promise.resolve();
    expect(appliedLineIn(secondEditor.state)?.kind).toBe("applied");

    hold2 = false;
    for (const item of deferred2) item.reject(new Error("Disk full"));
    expect(await pending2).toBe("failed");
    expect(secondEditor.getText()).toBe("Tides rise twice a day.");
    expect(appliedLineIn(secondEditor.state)).toBeNull();
  });

  // protects=resolveProposalsIn("all") leaves every held request untouched, including held requests beyond the first and persisted held outside-agent requests (#3839); fails_when=Accept all or Reject all resolves a second held request or a persisted held request
  it("resolveProposalsIn all leaves every held request untouched, including held requests beyond the first", () => {
    const mindId = "mind-multi-held";
    const { doc, editor } = mountEditor(mindId, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "First held paragraph." }],
      },
      {
        type: "paragraph",
        attrs: { id: "p2" },
        content: [{ type: "text", text: "Second held paragraph." }],
      },
      {
        type: "paragraph",
        attrs: { id: "p3" },
        content: [{ type: "text", text: "Ordinary proposal paragraph." }],
      },
    ]);
    stageInlineProposal(doc, 0, "First held", "Rewritten one", "req-held-1", "prop-h1", true);
    stageInlineProposal(doc, 1, "Second held", "Rewritten two", "req-held-2", "prop-h2", true);
    stageInlineProposal(doc, 2, "Ordinary", "Updated", "req-normal-1", "prop-n1");

    syncHeldOutsideProposals(mindId, editor);
    expect(appliedLineIn(editor.state)).toMatchObject({
      kind: "held",
      request: "req-held-1",
      asked: { mindId, requests: ["req-held-1", "req-held-2"] },
    });

    // Accept all must accept only req-normal-1 and leave BOTH held requests pending.
    resolveProposalsIn(editor, mindId, "all", "accept");
    const afterAccept = pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).map(
      (each) => each.request,
    );
    expect(afterAccept).toEqual(["req-held-1", "req-held-2"]);
    expect(editor.getText()).toContain("Updated proposal paragraph.");
    expect(editor.getText()).not.toContain("Ordinary");
    expect(editor.getText()).toContain("First held");
    expect(editor.getText()).toContain("Second held");

    // Reject all must reject only a new normal proposal and still leave BOTH held requests pending.
    stageInlineProposal(doc, 2, "Updated", "Third try", "req-normal-2", "prop-n2");
    resolveProposalsIn(editor, mindId, "all", "reject");
    const afterReject = pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).map(
      (each) => each.request,
    );
    expect(afterReject).toEqual(["req-held-1", "req-held-2"]);

    // Even while an applied Undo line is shown instead of the held line, persisted held: true requests stay protected.
    setAppliedLine(editor, {
      kind: "applied",
      blockId: "p3",
      blocks: { paragraphs: 1, tables: 0 },
      reason: null,
      kept: null,
    });
    resolveProposalsIn(editor, mindId, "all", "accept");
    const afterAppliedLine = pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).map(
      (each) => each.request,
    );
    expect(afterAppliedLine).toEqual(["req-held-1", "req-held-2"]);
  });

  // protects=acceptOpenNoteWrite rechecks the >50% User-text hold on the live mounted document before accepting a staged rewrite, holding it for Apply / Discard if concurrent User edits elsewhere pushed removal over half (#3839); fails_when=staged rewrite applies immediately past the >50% hold
  it("holds a staged rewrite for Apply / Discard when User edits elsewhere make it remove more than half of User text", async () => {
    const stop = installOpenNoteAgentAccept();
    cleanups.push(stop);

    const mindId = "mind-recheck-hold";
    // 40 letters in paragraph 1, 60 letters in paragraph 2 (40 / 100 = 40% at staging time).
    const p1 = "abcdefghij".repeat(4);
    const p2 = "klmnopqrst".repeat(6);
    const replacement = "zzzzzzzzzz".repeat(4);
    const { doc, editor } = mountEditor(mindId, [
      { type: "paragraph", attrs: { id: "r1" }, content: [{ type: "text", text: p1 }] },
      { type: "paragraph", attrs: { id: "r2" }, content: [{ type: "text", text: p2 }] },
    ]);

    const prep = await prepareOpenNoteWrite(mindId);
    if (!prep.open || prep.busy) throw new Error("Expected ready token.");

    // Core stages rewrite of p1 (was 40/100 = 40% when staged).
    const sv = stageInlineProposal(doc, 0, p1, replacement, "req-recheck", "prop-recheck");

    // User shortens unrelated paragraph 2 from 60 letters to 10 letters before acceptance -> now 40/50 = 80% > 50%!
    const p2Start = editor.state.doc.child(0).nodeSize + 1;
    const p2End = p2Start + p2.length;
    editor.commands.insertContentAt({ from: p2Start, to: p2End }, "shortnotes");

    const outcome = await acceptOpenNoteWrite(
      {
        mindId,
        request: "req-recheck",
        token: prep.token,
        stateVector: sv,
        changed: 1,
        added: 0,
        tables: 0,
      },
      { settleWaitMs: 300, typingQuietMs: 10 },
    );

    expect(outcome).toBe("held");
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(
      pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => each.request),
    ).toEqual(["req-recheck"]);
    expect(appliedLineIn(editor.state)).toMatchObject({
      kind: "held",
      request: "req-recheck",
      asked: { mindId, requests: ["req-recheck"] },
    });
    expect(editor.getText()).toContain("shortnotes");
  });
});
