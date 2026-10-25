import { getSchema } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { type KeptCitationText, MIND_CONTENT_FIELD } from "../../core/api";
import { allOrigins } from "../../shared/blockOrigins";
import { citationState, type LiveDocument } from "../../shared/citations";
import { mindCheckOf } from "../../shared/mindCheck";
import { mindScopeOf } from "../../shared/mindScope";
import { claimsOf } from "./editor/claimChecks";
import { noteHealth } from "./editor/healthCounts";
import { BLOCK_ID_ATTRIBUTE, noteExtensions } from "./editor/noteSchema";

let schema: ReturnType<typeof getSchema> | undefined;

export function readNoteState({
  doc,
  documents,
  keptCitationTexts,
  folderId,
}: {
  doc: Y.Doc;
  documents: readonly LiveDocument[];
  keptCitationTexts: readonly KeptCitationText[];
  folderId: string | null;
}) {
  schema ??= getSchema(noteExtensions());
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(MIND_CONTENT_FIELD), schema);
  const origins = allOrigins(doc);
  const { claims, kept } = claimsOf(root, {
    versions: new Map(documents.map((document) => [document.id, document.contentHash])),
    folderId,
    scope: mindScopeOf(doc),
  });
  const health = noteHealth(root, {
    claims,
    kept,
    skipped: new Set(mindCheckOf(doc)?.skipped ?? []),
    citationCheck: (attributes) => citationState(attributes, documents, keptCitationTexts).check,
    writtenByAnswer: (blockId) => typeof blockId === "string" && origins.has(blockId),
  });
  const filedAnswers = new Set<string>();
  root.forEach((block) => {
    const id = block.attrs[BLOCK_ID_ATTRIBUTE];
    const reference = typeof id === "string" ? origins.get(id)?.from : undefined;
    if (reference?.artifactKind === "conversation" && reference.anchor.kind === "message") {
      filedAnswers.add(reference.anchor.messageId);
    }
  });
  return { health, filedAnswers };
}

export type NoteState = ReturnType<typeof readNoteState>;
