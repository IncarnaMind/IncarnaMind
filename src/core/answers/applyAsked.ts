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
import type { MindContent } from "../mindContent";

interface CoreUndo {
  manager: Y.UndoManager;
  doc: Y.Doc;
  mindId: string;
  requests: ReadonlySet<string>;
  state: "done" | "undone";
  onTop: boolean;
}

interface AskedChangesOptions {
  now(): string;
  recordAiUse(inputs: RecordAiUseInput[]): void;
}

/** Applies one turn's asked changes in the core, keeping Review and one core Undo for its card. */
export function createAskedChanges(content: MindContent, options: AskedChangesOptions) {
  const applied = new Map<string, { application: AskedChangeApplication; undo: CoreUndo | null }>();
  const keyOf = ({ answerId, mindId, requests }: ApplyAskedChangesInput) =>
    JSON.stringify([answerId, mindId, [...requests].sort()]);

  return {
    apply(input: ApplyAskedChangesInput): AskedChangeApplication | null {
      const undoId = keyOf(input);
      const existing = applied.get(undoId);
      if (existing) return existing.application;
      const { mindId } = input;
      const origin = {};
      const steps: CoreUndo[] = [];
      const accepted: ResolvedProposal[] = [];
      const application = content.edit(
        mindId,
        (blocks) => {
          const doc = blocks.doc;
          if (!doc) return null;
          const requests = new Set(input.requests.filter((request) => askedFor(doc, request)));
          if (
            requests.size === 0 ||
            !pendingProposals(blocks).some((ref) => requests.has(ref.request))
          ) {
            return null;
          }
          const picked = (ref: { request: string }) => requests.has(ref.request);
          const reviewBefore = Y.encodeStateAsUpdate(doc);
          if (waitsForUser(doc, requests)) {
            return { undoId, reviewBefore, requests: [...requests], held: true };
          }
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
          steps.push({
            manager,
            doc,
            mindId,
            requests,
            state: "done",
            onTop: true,
          });
          return { undoId, reviewBefore, requests: [...requests], held: false };
        },
        origin,
      );
      if (!application) return null;
      const [undo] = steps;
      undo?.doc.on("update", () => {
        undo.onTop = false;
      });
      applied.set(undoId, { application, undo: undo ?? null });
      if (undo) {
        const entries = aiUseOfAccepted(undo.doc, mindId, accepted, options.now());
        if (entries.length > 0) options.recordAiUse(entries);
      }
      return application;
    },

    undo(undoId: string): boolean {
      const step = applied.get(undoId)?.undo;
      if (step?.state !== "done" || !step.onTop || step.doc.isDestroyed) return false;
      const popped = step.manager.undo();
      if (!popped) return false;
      step.state = "undone";
      step.onTop = false;
      content.edit(step.mindId, (blocks) => {
        resolveProposals(blocks, (ref) => step.requests.has(ref.request), "reject");
      });
      return true;
    },
  };
}
