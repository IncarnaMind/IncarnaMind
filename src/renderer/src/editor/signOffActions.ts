import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useContext, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import {
  type CalculatedFigureAttributes,
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
  checkedByMe,
  citationSignOffBasis,
  figureSignOffBasis,
  figureSignOffSources,
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
import { type Undoable, useUndo } from "../undo";
import { sentenceAround } from "./citationSentence";
import { asOneStep, offerEditorUndo, undoStackOf } from "./editorUndo";
import { SignOffsContext } from "./mindContext";
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

/** The mark on a calculated figure as it shows now: it rests on its result and its inputs. */
export function calculatedFigureSignOff(
  records: readonly SignOffRecord[],
  figure: CalculatedFigureAttributes,
  versions: ReadonlyMap<string, string>,
  personId: string | null,
): { mark: FigureMark; now: SignOffNow | null } {
  const basis = figureSignOffBasis({
    id: figure.id,
    reading: { chars: figure.figure.shown },
    calculated: figure,
  });
  const record = signOffOn(records, { kind: "figure", id: figure.id }, personId);
  const now = record
    ? signOffNow(
        signOffShown(
          record,
          basis,
          figureSignOffSources({ source: null, sourceInput: null, calculated: figure }),
          versions,
        ),
        personId,
      )
    : null;
  return { mark: { id: figure.id, basis, now }, now };
}

/** How many of the Note's items the User checked, and how many changed since they did. */
export function signOffCounts(
  doc: ProseMirrorNode,
  records: readonly SignOffRecord[],
  rows: readonly FigureScheduleRow[] | null,
  versions: ReadonlyMap<string, string>,
  personId: string | null,
): { checked: number; changed: number } {
  let checked = 0;
  let changed = 0;
  const count = (now: SignOffNow | null) => {
    if (!now?.mine) return;
    if (now.state === "checked") checked++;
    else changed++;
  };
  if (records.some((record) => record.target.kind === "citation"))
    doc.descendants((node, pos) => {
      if (node.type.name === CITATION_NODE)
        count(
          citationSignOff(records, doc, pos, node.attrs as CitationAttributes, versions, personId),
        );
    });
  for (const row of rows ?? []) count(row.signOff);
  return { checked, changed };
}

/** The Note's counts of the User's own checks, kept up to date as the text and the marks change. */
export function useSignOffCounts(editor: Editor): { checked: number; changed: number } {
  const { records, rows } = useContext(SignOffsContext);
  const personId = usePersonId();
  const versions = useDocumentVersions();
  return useEditorState({
    editor,
    selector: ({ editor: current }) =>
      signOffCounts(current.state.doc, records, rows, versions, personId),
    equalityFn: (a, b) => a?.checked === b?.checked && a?.changed === b?.changed,
  });
}

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
 * its own, which it returns for the schedule to withdraw when it closes.
 */
function inNote(
  mindId: string,
  copy: Y.Doc | null,
  change: (doc: Y.Doc) => void,
  said: WordsInLine,
): Undoable | null {
  const editor = mindEditor(mindId);
  if (editor && noteDocOf(editor)) {
    if (!editor.isEditable) throw new Error(translateNow("figures.changed"));
    inEditor(editor, change, said);
    return null;
  }
  if (!copy) return null;
  const origin = { signOffs: mindId };
  const steps = new Y.UndoManager(copy.getMap(MIND_SIGN_OFFS_FIELD), {
    trackedOrigins: new Set([origin]),
  });
  copy.transact(() => change(copy), origin);
  const undoable: Undoable = {
    said,
    undo: async () => {
      steps.undo();
    },
    redo: async () => {
      steps.redo();
    },
  };
  useUndo.getState().push(undoable);
  return undoable;
}

/**
 * "Checked by me" on the Citation at `pos`: marks it, giving it an id of its own first, or takes
 * the User's mark off. A mark that changed since is marked again, as checked now.
 */
export function toggleCitationSignOff(editor: Editor, pos: number, signer: Signer): void {
  const doc = noteDocOf(editor);
  const node = editor.state.doc.nodeAt(pos);
  if (!doc || node?.type.name !== CITATION_NODE) return;
  const attributes = node.attrs as CitationAttributes;
  const versions = new Map(
    useAppStore.getState().documents.map((each) => [each.id, each.contentHash]),
  );
  const now = citationSignOff(
    signOffsOf(doc),
    editor.state.doc,
    pos,
    attributes,
    versions,
    signer.personId,
  );
  const id = typeof attributes.id === "string" ? attributes.id : crypto.randomUUID();
  const target: SignOffTarget = { kind: "citation", id };
  const off = checkedByMe(now);
  const basis = citationBasisAt(editor.state.doc, pos, attributes);
  inEditor(
    editor,
    (note) => {
      if (attributes.id !== id)
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...attributes, id }));
      removeSignOff(note, target, new Date().toISOString(), signer.personId);
      if (!off) addSignOff(note, markBy(target, basis, signer));
    },
    (t) => t(off ? "signOff.removed" : "signOff.added"),
  );
}

/** A figure to mark: its id, what its mark rests on now, and the mark it has. */
export interface FigureMark {
  id: string;
  basis: string;
  now: SignOffNow | null;
}

export const figureMarkOf = (row: FigureScheduleRow): FigureMark => ({
  id: row.id,
  basis: figureSignOffBasis(row),
  now: row.signOff,
});

/**
 * "Checked by me" on figures: marks each one the User hasn't checked as it is now, or, `off`,
 * takes their marks off. With the `basis` of the schedule the figures came from, refused once
 * the Note moved on, so a mark never lands on a figure that has changed since.
 */
export function setFigureSignOffs(
  note: { mindId: string; basis: string | null; copy: Y.Doc | null },
  figures: readonly FigureMark[],
  off: boolean,
  signer: Signer,
): Undoable | null {
  const chosen = figures.filter((figure) =>
    off ? figure.now?.mine === true : !checkedByMe(figure.now),
  );
  if (chosen.length === 0) return null;
  const shown = mindEditor(note.mindId);
  const doc = (shown && noteDocOf(shown)) ?? note.copy;
  if (!doc || (note.basis !== null && fingerprintOfMind(doc) !== note.basis))
    throw new Error(translateNow("figures.changed"));
  const count = chosen.length;
  return inNote(
    note.mindId,
    note.copy,
    (marks) => {
      const at = new Date().toISOString();
      for (const figure of chosen) {
        if (figure.now?.mine) removeSignOff(marks, figure.now.target, at, signer.personId);
        if (!off)
          addSignOff(marks, markBy({ kind: "figure", id: figure.id }, figure.basis, signer));
      }
    },
    (t) =>
      count === 1
        ? t(off ? "signOff.removed" : "signOff.added")
        : t(off ? "signOff.removedCount" : "signOff.addedCount", { count }),
  );
}
