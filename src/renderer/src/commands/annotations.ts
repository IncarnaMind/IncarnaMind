/**
 * A highlight's actions, in the shared right-click and ⋯ menu and in ⌘K
 * (#327): its note, its colour, Add to note, collecting the Document's into a
 * Mind, exporting them, and deleting it with Undo.
 */
import type { Annotation } from "../../../core/api";
import { ANNOTATION_COLOURS } from "../../../core/api";
import { ANNOTATION_COLOUR_LABELS } from "../../../shared/annotationColours";
import {
  addAnnotationToNote,
  collectAnnotations,
  deleteAnnotation,
  editAnnotation,
  exportAnnotations,
} from "../annotationActions";
import { useNoteEditor } from "../annotationNote";
import { useAnnotations } from "../annotations";
import { useAppStore } from "../store";
import { addsWithoutAsking } from "../viewer/selectionActions";
import { viewerTabOf } from "../viewerTab";

import type { Command, CommandContext } from "./registry";

const focused = (ctx: CommandContext): Annotation | null => {
  if (ctx.focus?.kind !== "annotation") return null;
  const id = ctx.focus.id;
  for (const list of Object.values(useAnnotations.getState().byDocument)) {
    const found = list.find((annotation) => annotation.id === id);
    if (found) return found;
  }
  return null;
};

const only = (ctx: CommandContext) => ctx.focus?.kind === "annotation";

const COLOUR_COMMANDS: readonly Command[] = ANNOTATION_COLOURS.map((colour) => ({
  id: `annotation.colour.${colour}`,
  label: `annotations.colour.${colour}`,
  group: "main",
  appliesTo: ["annotation"],
  when: only,
  checked: (ctx) => focused(ctx)?.colour === colour,
  reversible: true,
  run: (ctx) => {
    const annotation = focused(ctx);
    if (annotation && annotation.colour !== colour) void editAnnotation(annotation, { colour });
  },
}));

/** Collects every highlight of one colour in the Library into a new Mind. */
const COLLECT_COLOUR: readonly Command[] = ANNOTATION_COLOURS.map((colour) => ({
  id: `annotations.collectColour.${colour}`,
  label: (_ctx, t) =>
    t("annotations.collect.colour", { colour: t(ANNOTATION_COLOUR_LABELS[colour]).toLowerCase() }),
  group: "main",
  reversible: true,
  run: () => void collectAnnotations({ colour }, null),
}));

const documentOf = (ctx: CommandContext): string | null => {
  if (ctx.focus?.kind !== "document") return null;
  return ctx.focus.id;
};

export const annotationCommands: readonly Command[] = [
  ...COLLECT_COLOUR,
  {
    id: "folder.collectAnnotations",
    label: "command.annotations.collectFolder",
    group: "main",
    appliesTo: ["folder"],
    when: (ctx) => ctx.focus?.kind === "folder",
    reversible: true,
    run: (ctx) => {
      const folderId = ctx.focus?.kind === "folder" ? ctx.focus.id : null;
      if (folderId) void collectAnnotations({ folderId }, folderId);
    },
  },
  {
    id: "document.showAnnotations",
    label: "command.annotations.list",
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => documentOf(ctx) !== null,
    enabled: (ctx) => {
      const documentId = documentOf(ctx);
      return (
        (documentId !== null &&
          useAnnotations.getState().room[viewerTabOf(documentId) ?? ""] !== false) || {
          reason: "annotations.needsRoom",
        }
      );
    },
    reversible: true,
    run: async (ctx) => {
      const documentId = documentOf(ctx);
      if (!documentId) return;
      await useAppStore.getState().openDocument({ documentId }, { as: "list" });
      const tab = viewerTabOf(documentId);
      if (tab) useAnnotations.getState().togglePanel(true, tab);
    },
  },
  {
    id: "document.exportAnnotations",
    label: "command.annotations.export",
    group: "file",
    appliesTo: ["document"],
    when: (ctx) => documentOf(ctx) !== null,
    reversible: true,
    run: (ctx) => {
      const documentId = documentOf(ctx);
      if (!documentId) return;
      const document = useAppStore.getState().documents.find((each) => each.id === documentId);
      if (document) void exportAnnotations(document);
    },
  },
  {
    id: "annotation.editNote",
    label: "annotations.menu.editNote",
    group: "main",
    appliesTo: ["annotation"],
    when: only,
    reversible: true,
    run: (ctx) => {
      const annotation = focused(ctx);
      if (annotation) useNoteEditor.getState().open(annotation.id, annotation.documentId);
    },
  },
  ...COLOUR_COMMANDS,
  {
    id: "annotation.addToNote",
    label: "annotations.menu.addToNote",
    group: "main",
    appliesTo: ["annotation"],
    when: only,
    reversible: true,
    run: (ctx) => {
      const annotation = focused(ctx);
      if (annotation) {
        void addAnnotationToNote(annotation, addsWithoutAsking() ? undefined : { kind: "new" });
      }
    },
  },
  {
    id: "annotation.collect",
    label: "annotations.menu.collect",
    group: "main",
    appliesTo: ["annotation"],
    when: only,
    reversible: true,
    run: (ctx) => {
      const annotation = focused(ctx);
      if (!annotation) return;
      const folderId =
        useAppStore.getState().documents.find((each) => each.id === annotation.documentId)
          ?.folderId ?? null;
      void collectAnnotations({ documentId: annotation.documentId }, folderId);
    },
  },
  {
    id: "annotation.export",
    label: "annotations.menu.export",
    group: "file",
    appliesTo: ["annotation"],
    when: only,
    reversible: true,
    run: (ctx) => {
      const annotation = focused(ctx);
      if (!annotation) return;
      const document = useAppStore
        .getState()
        .documents.find((each) => each.id === annotation.documentId);
      if (document) void exportAnnotations(document);
    },
  },
  {
    id: "annotation.delete",
    label: "annotations.menu.delete",
    group: "danger",
    appliesTo: ["annotation"],
    when: only,
    destructive: true,
    reversible: true,
    run: (ctx) => {
      const annotation = focused(ctx);
      if (annotation) void deleteAnnotation(annotation);
    },
  },
];
