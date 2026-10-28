import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type CitationAttributes,
  type FigureScheduleRow,
  MIND_SIGN_OFFS_FIELD,
  type SignOffNow,
  type SignOffTarget,
} from "../../../core/api";
import { fingerprintOfMind } from "../../../shared/mindState";
import {
  addSignOff,
  citationSignOffBasis,
  figureSignOffBasis,
  removeSignOff,
  type SignOffRecord,
  signOffNow,
  signOffOn,
  signOffShown,
  signOffsOf,
} from "../../../shared/signOffs";
import { translateNow } from "../i18n";
import type { WordsInLine } from "../lineNames";
import { useAppStore } from "../store";
import { useUndo } from "../undo";
import { sentenceAround } from "./citationSentence";
import { asOneStep, offerEditorUndo, undoStackOf } from "./editorUndo";
import { mindEditor } from "./openEditors";

/** Who a mark is by: Settings' name for them, and their person id. */
export interface Signer {
  name: string;
  personId: string;
}

let madePersonId: string | null = null;

/**
 * The User as their marks name them. Their person id is made the first time they need one and
 * kept with their settings, so it is the same on every device they use.
 */
export function currentSigner(): Signer | null {
  const { settings, updateSettings, reportError } = useAppStore.getState();
  if (!settings) return null;
  let personId = settings.user.personId ?? madePersonId;
  if (personId === null) {
    personId = crypto.randomUUID();
    madePersonId = personId;
  }
  if (settings.user.personId === null) updateSettings({ user: { personId } }).catch(reportError);
  return { name: settings.author, personId };
}

/** The User's person id, or null before their first mark. */
export function usePersonId(): string | null {
  return useAppStore((state) => state.settings?.user.personId ?? madePersonId);
}

/** The Note's own document the editor is bound to. */
export const noteDocOf = (editor: Editor): Y.Doc | null =>
  ySyncPluginKey.getState(editor.state)?.type?.doc ?? null;

/** The Note's standing marks, kept up to date as they change. */
export function useSignOffs(doc: Y.Doc | null): readonly SignOffRecord[] {
  const [records, setRecords] = useState<readonly SignOffRecord[]>(() =>
    doc ? signOffsOf(doc) : [],
  );
  useEffect(() => {
    if (!doc) {
      setRecords([]);
      return;
    }
    const map = doc.getMap(MIND_SIGN_OFFS_FIELD);
    const read = () => setRecords(signOffsOf(doc));
    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [doc]);
  return records;
}

/** Each live Document's version now, by id: a source quoted at an older one has changed. */
export function useDocumentVersions(): ReadonlyMap<string, string> {
  const documents = useAppStore((state) => state.documents);
  return useMemo(() => new Map(documents.map((each) => [each.id, each.contentHash])), [documents]);
}

const citationBasisAt = (doc: ProseMirrorNode, pos: number, attributes: CitationAttributes) =>
  citationSignOffBasis(sentenceAround(doc, pos)?.text ?? "", attributes);

/** The mark on the Citation at `pos` as it shows now, or null when no one marked it. */
export function citationSignOff(
  records: readonly SignOffRecord[],
  doc: ProseMirrorNode,
  pos: number,
  attributes: CitationAttributes,
  versions: ReadonlyMap<string, string>,
  personId: string | null,
): SignOffNow | null {
  if (typeof attributes.id !== "string") return null;
  const record = signOffOn(records, { kind: "citation", id: attributes.id }, personId);
  return record
    ? signOffNow(
        signOffShown(record, citationBasisAt(doc, pos, attributes), [attributes], versions),
        personId,
      )
    : null;
}

/** Whether "Checked by me" shows ticked: the User's own mark stands on it as it is now. */
export const checkedByMe = (now: SignOffNow | null): boolean =>
  now?.mine === true && now.state === "checked";

const markBy = (target: SignOffTarget, contentHash: string, signer: Signer): SignOffRecord => ({
  id: crypto.randomUUID(),
  target,
  at: new Date().toISOString(),
  contentHash,
  deletedAt: null,
  name: signer.name,
  personId: signer.personId,
});

/** Makes `change` to the Note's marks one step of the note's Undo, with its line. */
function inEditor(editor: Editor, change: (doc: Y.Doc) => void, said: WordsInLine): void {
  const doc = noteDocOf(editor);
  if (!doc || !editor.isEditable) return;
  undoStackOf(editor)?.addToScope(doc.getMap(MIND_SIGN_OFFS_FIELD));
  asOneStep(editor, () => doc.transact(() => change(doc), ySyncPluginKey));
  offerEditorUndo(editor, said);
}

/**
 * Makes `change` in the Note's editor when it is open, so its ⌘Z takes it back with its other
 * edits; else in `copy`, the schedule's copy of the Note the core keeps in step, with an Undo of
 * its own.
 */
function inNote(
  mindId: string,
  copy: Y.Doc | null,
  change: (doc: Y.Doc) => void,
  said: WordsInLine,
): void {
  const editor = mindEditor(mindId);
  if (editor && noteDocOf(editor)) {
    if (!editor.isEditable) throw new Error(translateNow("figures.changed"));
    inEditor(editor, change, said);
    return;
  }
  if (!copy) return;
  const origin = { signOffs: mindId };
  const steps = new Y.UndoManager(copy.getMap(MIND_SIGN_OFFS_FIELD), {
    trackedOrigins: new Set([origin]),
  });
  copy.transact(() => change(copy), origin);
  useUndo.getState().push({
    said,
    undo: async () => {
      steps.undo();
    },
    redo: async () => {
      steps.redo();
    },
  });
}

/**
 * "Checked by me" on the Citation at `pos`: marks it, giving it an id of its own first, or takes
 * the User's mark off. A mark that changed since is marked again, as checked now.
 */
export function toggleCitationSignOff(
  editor: Editor,
  pos: number,
  now: SignOffNow | null,
  signer: Signer,
): void {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== CITATION_NODE) return;
  const attributes = node.attrs as CitationAttributes;
  const id = typeof attributes.id === "string" ? attributes.id : crypto.randomUUID();
  const target: SignOffTarget = { kind: "citation", id };
  const off = checkedByMe(now);
  const basis = citationBasisAt(editor.state.doc, pos, attributes);
  inEditor(
    editor,
    (doc) => {
      if (attributes.id !== id)
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...attributes, id }));
      removeSignOff(doc, target, new Date().toISOString(), signer.personId);
      if (!off) addSignOff(doc, markBy(target, basis, signer));
    },
    (t) => t(off ? "signOff.removed" : "signOff.added"),
  );
}

/**
 * "Checked by me" on figures of the Note's schedule: marks each one the User hasn't checked as it
 * is now, or, `off`, takes their marks off. Refused once the Note moved on from `basis`, the
 * schedule the rows came from, so a mark never lands on a figure that has changed.
 */
export function setFigureSignOffs(
  input: { mindId: string; basis: string; copy: Y.Doc | null },
  rows: readonly FigureScheduleRow[],
  off: boolean,
  signer: Signer,
): void {
  const chosen = rows.filter((row) =>
    off ? row.signOff?.mine === true : !checkedByMe(row.signOff),
  );
  if (chosen.length === 0) return;
  const shown = mindEditor(input.mindId);
  const note = (shown && noteDocOf(shown)) ?? input.copy;
  if (!note || fingerprintOfMind(note) !== input.basis)
    throw new Error(translateNow("figures.changed"));
  const count = chosen.length;
  inNote(
    input.mindId,
    input.copy,
    (doc) => {
      const at = new Date().toISOString();
      for (const row of chosen) {
        if (row.signOff?.mine) removeSignOff(doc, row.signOff.target, at, signer.personId);
        if (!off)
          addSignOff(doc, markBy({ kind: "figure", id: row.id }, figureSignOffBasis(row), signer));
      }
    },
    (t) =>
      count === 1
        ? t(off ? "signOff.removed" : "signOff.added")
        : t(off ? "signOff.removedCount" : "signOff.addedCount", { count }),
  );
}
