/**
 * What the User does with a Document's highlights and notes (#327): make one
 * from a selection, edit its note or colour, delete it (each with Undo), put it
 * in a Note with a checked Citation, collect a Document's, a Folder's or one
 * colour's into a new Mind, and export them.
 */
import type { Editor } from "@tiptap/core";
import type {
  Annotation,
  AnnotationColour,
  AnnotationEdit,
  AnnotationGroup,
  AnnotationsIn,
  CitationAttributes,
  CitedArea,
  Document,
  SelectedPart,
} from "../../core/api";
import { CITATION_NODE } from "../../core/api";
import type { NodeJSON } from "../../shared/blockJson";
import { mindName } from "../../shared/naming";
import { type AddTarget, addInEditor } from "./addToNote";
import { useAnnotationDrafts } from "./annotationDrafts";
import { useAnnotations } from "./annotations";
import { readMindHandle } from "./commands/handles";
import { core } from "./core";
import { offerEditorUndo } from "./editor/editorUndo";
import { whenMindEditor } from "./editor/openEditors";
import { translateNow } from "./i18n";
import { useNotices } from "./notices";
import { useAppStore } from "./store";
import { type Undoable, useUndo } from "./undo";
import type { ViewerSelection } from "./viewer/selectionActions";

const MIND_OPEN_WAIT_MS = 5000;

const nameOf = (mindId: string) => {
  const mind = useAppStore.getState().minds.find((each) => each.id === mindId);
  return mind ? mindName(mind) : "";
};

function pushUndo(undoable: Undoable): void {
  useUndo.getState().push(undoable);
}

/** Highlights words selected in the viewer, in `colour`, with a note when "Add a note…" made it. */
export async function highlightSelection(
  selection: ViewerSelection,
  colour: AnnotationColour,
  note: string | null = null,
): Promise<Annotation | null> {
  try {
    const annotation = await core.createAnnotation({
      documentId: selection.document.id,
      parts: selection.parts,
      colour,
      note,
    });
    remember(annotation, colour, note === null ? "annotations.highlighted" : "annotations.noted");
    return annotation;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return null;
  }
}

/** The words and region of a place the User drew on a page (#118). */
export interface AreaSelection {
  parts: SelectedPart[];
  area: CitedArea;
  unit: number | null;
  around?: { before?: string; after?: string };
}

/** Highlights a region of a page, with the words in it where it has any (#327). */
export async function highlightArea(
  document: Document,
  selection: AreaSelection,
  colour: AnnotationColour,
): Promise<Annotation | null> {
  try {
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: selection.parts,
      colour,
      area: selection.area,
      unit: selection.unit,
      ...(selection.around && { around: selection.around }),
    });
    remember(annotation, colour, "annotations.highlighted");
    return annotation;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return null;
  }
}

/** Keeps the colour for the next one, and offers Undo: Delete takes the highlight back. */
function remember(
  annotation: Annotation,
  colour: AnnotationColour,
  said: "annotations.highlighted" | "annotations.noted",
): void {
  useAnnotations.getState().chooseColour(colour);
  pushUndo({
    said: (t) => t(said),
    undo: async () => {
      await core.deleteAnnotation(annotation.id);
    },
    redo: async () => {
      await core.restoreAnnotation(annotation.id);
    },
  });
}

/**
 * Recolours a highlight, or writes its note. Returns whether the core saved it,
 * so an editor keeps the User's words when it didn't.
 */
export async function editAnnotation(
  annotation: Annotation,
  edit: AnnotationEdit,
): Promise<boolean> {
  // Only the fields this action changed are taken back: a later note or colour stays.
  const before: AnnotationEdit = {
    ...(edit.note !== undefined && { note: annotation.note }),
    ...(edit.colour !== undefined && { colour: annotation.colour }),
  };
  const said =
    edit.note === null && annotation.note !== null
      ? ("annotations.commentRemoved" as const)
      : edit.note !== undefined && edit.colour === undefined
        ? ("annotations.edited" as const)
        : ("annotations.recoloured" as const);
  try {
    await core.updateAnnotation(annotation.id, edit);
    pushUndo({
      said: (t) => t(said),
      undo: async () => {
        await core.updateAnnotation(annotation.id, before);
      },
      redo: async () => {
        await core.updateAnnotation(annotation.id, edit);
      },
    });
    return true;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
}

/** Deletes a highlight, with Undo that puts it back. */
export async function deleteAnnotation(annotation: Annotation): Promise<void> {
  try {
    await core.deleteAnnotation(annotation.id);
    useAnnotationDrafts.getState().end(annotation.id);
    pushUndo({
      said: (t) => t("annotations.deleted"),
      undo: async () => {
        await core.restoreAnnotation(annotation.id);
      },
      redo: async () => {
        await core.deleteAnnotation(annotation.id);
      },
    });
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

const citationOf = (annotation: Annotation): CitationAttributes => ({
  passageId: annotation.passageId,
  documentId: annotation.documentId,
  documentName: annotation.documentName,
  contentHash: annotation.contentHash,
  pageFrom: annotation.pageFrom,
  pageTo: annotation.pageTo,
  location: annotation.location,
  quote: annotation.quote,
  check: annotation.check,
  checkReason: annotation.checkReason,
});

/** The annotation as Blocks: its quote with its Citation, and the User's note under it. */
export function blocksOf(annotation: Annotation): NodeJSON[] {
  const blocks: NodeJSON[] = [];
  if (annotation.quote.trim() !== "") {
    blocks.push({
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: annotation.quote },
            { type: CITATION_NODE, attrs: { ...citationOf(annotation) } },
          ],
        },
      ],
    });
  }
  if (annotation.note) {
    blocks.push({ type: "paragraph", content: [{ type: "text", text: annotation.note }] });
  }
  return blocks;
}

function putInMind(
  editor: Editor,
  mindId: string,
  blocks: readonly NodeJSON[],
  atCursor: boolean,
): boolean {
  const ids = addInEditor(editor, blocks, atCursor, () => undefined);
  if (!ids) return false;
  offerEditorUndo(editor, (t) =>
    t("annotations.addToNote.added", { mind: nameOf(mindId) || t("mind.untitled") }),
  );
  return true;
}

/**
 * Puts the highlight's quote, with its checked Citation, and its note under it,
 * at the cursor of the Mind the assistant reads; a Mind chosen from the list
 * takes them at its end; a new Mind is made in the Document's Folder.
 */
export async function addAnnotationToNote(
  annotation: Annotation,
  target?: AddTarget,
): Promise<void> {
  try {
    const read = readMindHandle.current;
    if (!target && !read) return;
    const blocks = blocksOf(annotation);
    if (!target || (target.kind === "mind" && read?.mindId === target.mindId)) {
      if (read && !read.editor.isDestroyed) {
        putInMind(read.editor, read.mindId, blocks, read.cursorInMind() || read.cursorPlaced());
      }
      return;
    }
    const made = target.kind === "new";
    const folderId =
      useAppStore.getState().documents.find((each) => each.id === annotation.documentId)
        ?.folderId ?? null;
    const mindId = made ? (await core.createMind({ title: "", folderId })).id : target.mindId;
    await useAppStore.getState().changeLayout({
      type: "open",
      item: { kind: "mind", mindId },
      where: { in: "side" },
    });
    const editor = await whenMindEditor(mindId, MIND_OPEN_WAIT_MS);
    if (editor) {
      putInMind(editor, mindId, blocks, false);
      return;
    }
    if (made) await core.deleteMind(mindId);
    throw new Error(
      translateNow(made ? "viewer.selection.notOpenedNew" : "viewer.selection.notOpened", {
        mind: nameOf(mindId) || translateNow("mind.untitled"),
      }),
    );
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/**
 * Writes every annotation in `groups` into a new Mind in `folderId`, a section
 * for each Document, each quote with its checked Citation and its note under
 * it: one edit, so one Undo. Undo takes back the Blocks it added, never the
 * writing that came after them; the Mind it made goes only if nothing else is
 * in it, and a soft delete keeps even that recoverable.
 */
export async function collectIntoMind(
  groups: readonly AnnotationGroup[],
  folderId: string | null,
): Promise<void> {
  const count = groups.reduce((sum, group) => sum + group.annotations.length, 0);
  if (count === 0) {
    useNotices.getState().confirm("annotations.collect.empty");
    return;
  }
  let made: string | null = null;
  try {
    const blocks: NodeJSON[] = [];
    for (const group of groups) {
      if (group.annotations.length === 0) continue;
      blocks.push({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: group.documentName }],
      });
      for (const annotation of group.annotations) blocks.push(...blocksOf(annotation));
    }
    const mind = await core.createMind({ title: "", folderId });
    made = mind.id;
    const { blockIds } = await core.addToNote({
      mindId: mind.id,
      blocks,
      origin: null,
      model: null,
      generated: false,
      recordUse: false,
    });
    await useAppStore.getState().changeLayout({
      type: "open",
      item: { kind: "mind", mindId: mind.id },
      where: { in: "side" },
    });
    pushUndo({
      said: (t) =>
        count === 1
          ? t("annotations.collect.done.one", { mind: nameOf(mind.id) || t("mind.untitled") })
          : t("annotations.collect.done", {
              count,
              mind: nameOf(mind.id) || t("mind.untitled"),
            }),
      undo: async () => {
        const { kept, remaining } = await core.undoAddToNote({ mindId: mind.id, blockIds });
        if (kept === 0 && remaining === 0) await core.deleteMind(mind.id);
      },
    });
  } catch (error) {
    useAppStore.getState().reportError(error);
    // A Mind made for a collection that never went in leaves nothing behind.
    if (made !== null) core.deleteMind(made).catch(console.error);
  }
}

/** Collects what `input` names, into a new Mind in `folderId`. */
export async function collectAnnotations(
  input: AnnotationsIn,
  folderId: string | null,
): Promise<void> {
  try {
    const groups = await core.annotationsIn(input);
    await collectIntoMind(groups, folderId);
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/** Saves a Document's highlights and notes as Markdown, in the Output location. */
export async function exportAnnotations(document: Document): Promise<void> {
  try {
    const saved = await core.saveAnnotationsExport(document.id);
    if (saved.status === "empty") {
      useNotices.getState().confirm("annotations.export.empty");
      return;
    }
    if (saved.status === "cancelled") return;
    if (saved.status === "saved") {
      useAnnotations.getState().showExport({
        documentId: document.id,
        name: saved.file.name,
        folder: saved.file.folder,
        inDefaultFolder: saved.file.inDefaultFolder,
        path: saved.file.path,
      });
      return;
    }
    if (saved.status === "not-allowed") {
      useNotices
        .getState()
        .showError(
          new Error(
            translateNow("annotations.export.notAllowed", { folder: saved.linkedFolderPath }),
          ),
        );
    }
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
