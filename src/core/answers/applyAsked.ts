import * as Y from "yjs";
import { askedFor, waitsForUser } from "../../shared/askedChanges";
import { originMaps } from "../../shared/blockOrigins";
import { fingerprintOfMind, transitionOfMind } from "../../shared/mindState";
import {
  aiUseOfAccepted,
  outOfDateProposals,
  pendingProposals,
  type ResolvedProposal,
  resolveProposals,
} from "../../shared/proposals";
import {
  type ApplyAskedChangesInput,
  type AskedChangeApplication,
  type AskedChangeTransition,
  MIND_REVISIONS_FIELD,
  type RecordAiUseInput,
} from "../api";
import { InvalidInputError, isRecord } from "../errors";
import type { MindContent } from "../mindContent";
import { parseIds } from "../minds";

interface CoreUndo {
  manager: Y.UndoManager;
  rejection: Y.UndoManager | null;
  rejectOrigin: object;
  doc: Y.Doc;
  mindId: string;
  proposalIds: ReadonlySet<string>;
  scope: (Y.XmlFragment | Y.Map<unknown>)[];
  state: "done" | "undone";
  onTop: boolean;
  busy: boolean;
  changed: () => void;
  destroyed: () => void;
}

interface AppliedEntry {
  application: AskedChangeApplication;
  undo: CoreUndo | null;
  aiUse: RecordAiUseInput[];
  recorded: boolean;
}

interface AskedChangesOptions {
  now(): string;
  requireMind(mindId: unknown): string;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  reportError(mindId: string, error: unknown): void;
}

/** Applies one turn's asked changes in the core, keeping Review and one core Undo for its card. */
export function createAskedChanges(content: MindContent, options: AskedChangesOptions) {
  const applied = new Map<string, AppliedEntry>();
  const keyOf = ({ answerId, mindId, requests }: ApplyAskedChangesInput) =>
    JSON.stringify([answerId, mindId, [...requests].sort()]);

  const dispose = (step: CoreUndo) => {
    step.doc.off("update", step.changed);
    step.doc.off("destroy", step.destroyed);
    if (!step.doc.isDestroyed) {
      step.manager.clear();
      step.rejection?.clear();
    }
    step.manager.destroy();
    step.rejection?.destroy();
  };

  const release = (undoId: string) => {
    const step = applied.get(undoId)?.undo;
    applied.delete(undoId);
    if (step) dispose(step);
  };

  const record = (entry: AppliedEntry) => {
    if (entry.recorded || entry.aiUse.length === 0) return;
    try {
      options.recordAiUse(entry.aiUse);
      entry.recorded = true;
    } catch (error) {
      options.reportError(entry.undo?.mindId ?? "", error);
    }
  };

  const parseInput = (input: ApplyAskedChangesInput) => {
    if (!isRecord(input)) throw new InvalidInputError("applyAskedChanges expects an object.");
    const { answerId, mindId, requests } = input;
    if (typeof answerId !== "string" || answerId === "") {
      throw new InvalidInputError("An Answer id must be a non-empty string.");
    }
    return {
      answerId,
      mindId: options.requireMind(mindId),
      requests: parseIds(requests, "Change requests"),
    };
  };

  return {
    apply(input: ApplyAskedChangesInput): AskedChangeApplication | null {
      const parsed = parseInput(input);
      const undoId = keyOf(parsed);
      const existing = applied.get(undoId);
      if (existing) {
        record(existing);
        return existing.application;
      }
      const { mindId, requests: wanted } = parsed;
      const origin = {};
      const steps: CoreUndo[] = [];
      const accepted: ResolvedProposal[] = [];
      const application = content.edit(
        mindId,
        (blocks) => {
          const doc = blocks.doc;
          if (!doc) return null;
          const requests = new Set(wanted.filter((request) => askedFor(doc, request)));
          const pending = pendingProposals(blocks);
          if (requests.size === 0 || !pending.some((ref) => requests.has(ref.request))) {
            return null;
          }
          const stale = outOfDateProposals(blocks);
          if (!pending.some((ref) => requests.has(ref.request) && !stale.has(ref.id))) return null;
          const picked = (ref: { request: string }) => requests.has(ref.request);
          if (waitsForUser(doc, requests)) {
            return {
              undoId,
              reviewBefore: new Uint8Array(),
              afterVector: new Uint8Array(),
              afterFingerprint: "",
              accepted: [],
              requests: [...requests],
              held: true,
            };
          }
          const reviewBefore = Y.encodeStateAsUpdate(doc);
          const scope = [blocks, ...originMaps(doc), doc.getMap(MIND_REVISIONS_FIELD)];
          const manager = new Y.UndoManager(scope, {
            captureTimeout: 0,
            trackedOrigins: new Set([origin]),
          });
          const resolved = resolveProposals(blocks, picked, "accept");
          if (resolved.length === 0) {
            manager.destroy();
            return null;
          }
          accepted.push(...resolved);
          const afterVector = Y.encodeStateVector(doc);
          steps.push({
            manager,
            rejection: null,
            rejectOrigin: {},
            doc,
            mindId,
            proposalIds: new Set(accepted.map((each) => each.id)),
            scope,
            state: "done",
            onTop: true,
            busy: false,
            changed: () => undefined,
            destroyed: () => undefined,
          });
          return {
            undoId,
            reviewBefore,
            afterVector,
            afterFingerprint: fingerprintOfMind(doc),
            accepted: accepted.map((each) => each.id),
            requests: [...new Set(accepted.map((each) => each.request))],
            held: false,
          };
        },
        origin,
      );
      if (!application) return null;
      if (application.held) return application;
      const [undo] = steps;
      const entry: AppliedEntry = {
        application,
        undo: undo ?? null,
        aiUse: undo ? aiUseOfAccepted(undo.doc, mindId, accepted, options.now()) : [],
        recorded: false,
      };
      applied.set(undoId, entry);
      if (undo) {
        undo.changed = () => {
          undo.onTop = false;
          if (!undo.busy) release(undoId);
        };
        undo.doc.on("update", undo.changed);
        undo.destroyed = () => release(undoId);
        undo.doc.on("destroy", undo.destroyed);
      }
      record(entry);
      return application;
    },

    undo(undoId: string): AskedChangeTransition | null {
      const step = applied.get(undoId)?.undo;
      if (step?.state !== "done" || !step.onTop || step.busy) return null;
      options.requireMind(step.mindId);
      step.busy = true;
      const before = Y.encodeStateVector(step.doc);
      try {
        if (step.manager.undoStack.length === 0) return null;
        if (!step.rejection) {
          step.rejection = new Y.UndoManager(step.scope, {
            captureTimeout: 0,
            trackedOrigins: new Set([step.rejectOrigin]),
          });
        }
        const popped = step.manager.undo();
        if (!popped) return null;
        if (!step.rejection) {
          step.rejection = new Y.UndoManager(step.scope, {
            captureTimeout: 0,
            trackedOrigins: new Set([step.rejectOrigin]),
          });
        }
        content.edit(
          step.mindId,
          (blocks) => {
            resolveProposals(blocks, (ref) => step.proposalIds.has(ref.id), "reject");
          },
          step.rejectOrigin,
        );
        step.state = "undone";
        step.onTop = false;
        return transitionOfMind(step.doc, before);
      } finally {
        step.busy = false;
      }
    },

    redo(undoId: string): AskedChangeTransition | null {
      const step = applied.get(undoId)?.undo;
      if (step?.state !== "undone" || step.busy || !step.rejection) return null;
      options.requireMind(step.mindId);
      const rejection = step.rejection;
      step.busy = true;
      const before = Y.encodeStateVector(step.doc);
      try {
        if (rejection.undoStack.length === 0 || step.manager.redoStack.length === 0) return null;
        if (!rejection.undo()) return null;
        if (!step.manager.redo()) return null;
        content.edit(step.mindId, () => undefined);
        step.state = "done";
        step.onTop = true;
        return transitionOfMind(step.doc, before);
      } finally {
        step.busy = false;
      }
    },

    release,
  };
}
