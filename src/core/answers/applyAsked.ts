import * as Y from "yjs";
import { askedFor, waitsForUser } from "../../shared/askedChanges";
import { originMaps } from "../../shared/blockOrigins";
import {
  aiUseOfAccepted,
  pendingProposals,
  type ResolvedProposal,
  resolveProposals,
} from "../../shared/proposals";
import {
  type ApplyAskedChangesInput,
  type AskedChangeApplication,
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
  requests: ReadonlySet<string>;
  scope: (Y.XmlFragment | Y.Map<unknown>)[];
  state: "done" | "undone";
  onTop: boolean;
  stale: boolean;
  busy: boolean;
  disposed: boolean;
  changed: () => void;
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
    if (step.disposed) return;
    step.disposed = true;
    step.doc.off("update", step.changed);
    step.manager.destroy();
    step.rejection?.destroy();
  };

  const release = (undoId: string) => {
    const step = applied.get(undoId)?.undo;
    if (step) dispose(step);
    applied.delete(undoId);
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
          if (
            requests.size === 0 ||
            !pendingProposals(blocks).some((ref) => requests.has(ref.request))
          ) {
            return null;
          }
          const picked = (ref: { request: string }) => requests.has(ref.request);
          if (waitsForUser(doc, requests)) {
            return {
              undoId,
              reviewBefore: new Uint8Array(),
              afterVector: new Uint8Array(),
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
            requests,
            scope,
            state: "done",
            onTop: true,
            stale: false,
            busy: false,
            disposed: false,
            changed: () => undefined,
          });
          return { undoId, reviewBefore, afterVector, requests: [...requests], held: false };
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
          if (undo.busy) return;
          undo.stale = true;
          if (undo.state === "done") dispose(undo);
        };
        undo.doc.on("update", undo.changed);
        undo.doc.on("destroy", () => release(undoId));
      }
      record(entry);
      return application;
    },

    undo(undoId: string): boolean {
      const step = applied.get(undoId)?.undo;
      if (step?.state !== "done" || !step.onTop || step.busy || step.disposed) return false;
      options.requireMind(step.mindId);
      step.busy = true;
      try {
        const popped = step.manager.undo();
        if (!popped) return false;
        if (!step.rejection) {
          step.rejection = new Y.UndoManager(step.scope, {
            captureTimeout: 0,
            trackedOrigins: new Set([step.rejectOrigin]),
          });
        }
        content.edit(
          step.mindId,
          (blocks) => {
            resolveProposals(blocks, (ref) => step.requests.has(ref.request), "reject");
          },
          step.rejectOrigin,
        );
        step.state = "undone";
        step.onTop = false;
        step.stale = false;
        return true;
      } finally {
        step.busy = false;
      }
    },

    redo(undoId: string): boolean {
      const step = applied.get(undoId)?.undo;
      if (step?.state !== "undone" || step.stale || step.busy || step.disposed || !step.rejection) {
        return false;
      }
      options.requireMind(step.mindId);
      const rejection = step.rejection;
      step.busy = true;
      try {
        if (!rejection.undo()) return false;
        if (!step.manager.redo()) return false;
        content.edit(step.mindId, () => undefined);
        step.state = "done";
        step.onTop = true;
        step.stale = false;
        return true;
      } finally {
        step.busy = false;
      }
    },

    release,
  };
}
