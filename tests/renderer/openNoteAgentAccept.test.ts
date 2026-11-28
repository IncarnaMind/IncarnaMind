/**
 * Renderer behavior for outside-app Note writes (#3839):
 * - D1: Mounted editor single-threaded accept, typing race refusal (0 words lost), and Chinese IME
 *   composing (`view.composing === true`) refusal on both the SAME paragraph and ANOTHER paragraph
 *   with 0 DOM mutation and 0 IME text wiped; composing gate defers incoming `mind.update`.
 * - D2: >50% User-text rewrite held as `Apply · Discard`, survives closed-Note reopen without
 *   falling back to `Accept all · Reject all`, and clicking Apply saves Checkpoint + updates `#3866`
 *   `uncheckedBlocks` (flipping Checked / 已核对 to unchecked).
 * - D3: Front tab shows inline `AppliedEditLine` only (suppressing `SidebarStatus` notice);
 *   hidden tab & closed Note keep `SidebarStatus` notice with Open and draw `AppliedEditLine` on
 *   tab switch / Note open with 1-step Undo.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  type AgentNoteChange,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type ProposalRequest,
} from "../../src/core/api";
import { BRIDGE_KEY, FILES_BRIDGE_KEY } from "../../src/shared/bridge";
import { translate } from "../../src/shared/i18n";
import { readMindCheck, writeMindCheck } from "../../src/shared/mindCheck";
import {
  pendingProposals,
  recordProposalRequest,
  resolveProposals,
  targetHash,
} from "../../src/shared/proposals";

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
const applyMindUpdate = vi.fn(async () => undefined);

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
let AppliedEditLine: typeof import("../../src/renderer/src/editor/appliedEditLine").AppliedEditLine;
let appliedLineIn: typeof import("../../src/renderer/src/editor/appliedEditLine").appliedLineIn;
let ProposalReview: typeof import("../../src/renderer/src/editor/proposalReview").ProposalReview;
let registerMindEditor: typeof import("../../src/renderer/src/editor/openEditors").registerMindEditor;
let prepareOpenNoteWrite: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").prepareOpenNoteWrite;
let acceptOpenNoteWrite: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").acceptOpenNoteWrite;
let installOpenNoteAgentAccept: typeof import("../../src/renderer/src/editor/openNoteAgentAccept").installOpenNoteAgentAccept;
let actOnAppliedEdit: typeof import("../../src/renderer/src/appliedEdits").actOnAppliedEdit;
let syncHeldOutsideProposals: typeof import("../../src/renderer/src/appliedEdits").syncHeldOutsideProposals;
let showClosedAgentLine: typeof import("../../src/renderer/src/appliedEdits").showClosedAgentLine;
let useAgentNotes: typeof import("../../src/renderer/src/agentNotes").useAgentNotes;
let takeClosedAgentChange: typeof import("../../src/renderer/src/agentNotes").takeClosedAgentChange;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let useUndo: typeof import("../../src/renderer/src/undo").useUndo;
let openMindCopy: typeof import("../../src/renderer/src/mindCopies").openMindCopy;
let FROM_CORE: typeof import("../../src/renderer/src/mindCopies").FROM_CORE;
let takeAgentOwnChanges: typeof import("../../src/renderer/src/editor/agentOwnUndo").takeAgentOwnChanges;
let drawHistory: typeof import("../../src/renderer/src/editor/keptHistories").drawHistory;
let keepHistory: typeof import("../../src/renderer/src/editor/keptHistories").keepHistory;
let agentOwnChangeRequestId: typeof import("../../src/shared/agentOwnChanges").agentOwnChangeRequestId;
let noteHealth: typeof import("../../src/renderer/src/editor/healthCounts").noteHealth;
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
  ]);
  ({ noteExtensions } = schemaMod);
  ({ AppliedEditLine, appliedLineIn } = lineMod);
  ({ ProposalReview } = reviewMod);
  ({ registerMindEditor } = openMod);
  ({ prepareOpenNoteWrite, acceptOpenNoteWrite, installOpenNoteAgentAccept } = acceptMod);
  ({ actOnAppliedEdit, syncHeldOutsideProposals, showClosedAgentLine } = appliedMod);
  ({ useAgentNotes, takeClosedAgentChange } = notesMod);
  ({ useAppStore } = storeMod);
  ({ useUndo } = undoMod);
  ({ openMindCopy, FROM_CORE } = copiesMod);
  ({ takeAgentOwnChanges } = ownUndoMod);
  ({ drawHistory, keepHistory } = keptMod);
  ({ agentOwnChangeRequestId } = ownSharedMod);
  ({ noteHealth } = healthMod);
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

describe("mounted editor lossless writes, IME protection, held reopen, and D3 notices (#3839)", () => {
  it.each([
    ["en", "Tides rise and fall twice a day.", "twice", "three times", "Added by typing."],
    ["zh-CN", "潮水每天沿着海岸涨落两次。", "两次", "三次", "用户刚输入的文字。"],
  ] as const)(
    "D1: typing during write refuses with changed (0 words lost), then re-read and reapply succeeds with 1-step Undo (%s)",
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
    "D1 (ZH): Chinese IME composing (view.composing === true) in %s refuses write with 0 DOM mutation and 0 IME wiped",
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

      const prepBusy = await prepareOpenNoteWrite(mindId);
      expect(prepBusy).toEqual({ open: true, busy: true });
      expect(editor.view.dom.innerHTML).toBe(beforeHtml);
      expect(saveCheckpoint).not.toHaveBeenCalled();

      // Also test the 1ms race: composing starts right AFTER prepareWrite returned ready.
      Object.defineProperty(editor.view, "composing", { value: false, configurable: true });
      const prepReady = await prepareOpenNoteWrite(mindId);
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

      const raceResult = await acceptOpenNoteWrite({
        mindId,
        request: "req-ime",
        token: prepReady.token,
        stateVector,
        changed: 1,
        added: 0,
        tables: 0,
      });
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
    "D2 + D4: held >50% rewrite restores Apply · Discard on closed-Note reopen and Apply saves Checkpoint + updates uncheckedBlocks (%s)",
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

  it("D3: suppresses SidebarStatus notice when Note is front tab, keeps it for hidden tab & closed Note, and draws inline lines with 1-step Undo", async () => {
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
});
