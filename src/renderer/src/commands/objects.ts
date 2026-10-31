import type { LinkedFolder, TabItem } from "../../../core/api";
import { WALL_SWITCH } from "../../../shared/commands";
import { displayName } from "../../../shared/documentNames";
import { core, files } from "../core";
import { useDocumentPasswords } from "../documentPasswords";
import { showFileLabelKey, userFile } from "../fileInfo";
import { countNow, translateNow } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { bridgeFrom, type LibraryBridge } from "../libraryBridges";
import { fileStatusLabel, folderName } from "../linkedFolders";
import { useRequests } from "../requests";
import { useAppStore } from "../store";
import { findTab } from "../tabs";
import { deleteTag } from "../tagChanges";
import { stoppedPlaces, tagWithAi } from "../taggingStop";
import { type Command, type CommandContext, needsHere } from "./registry";
import { documentsOf, everyDocument, idsOf, onlyOne } from "./targets";

const store = () => useAppStore.getState();
const reportError = (error: unknown) => store().reportError(error);
const RENAME_KEYS = "F2";

/** In the group right of the one in front, made if there is room: VS Code's Open to the Side. */
const openBeside = (item: TabItem) =>
  void store().changeLayout({ type: "open", item, preview: false, where: { in: "side" } });

/** For one thing that isn't the one in front: that one is split with Split to the right. */
const besideFront = (ctx: CommandContext, kind: "mind" | "document"): boolean => {
  const [id] = idsOf(ctx, kind);
  const front = currentTabOf(store().layout)?.item;
  const shown =
    front?.kind === "mind" ? front.mindId : front?.kind === "document" ? front.documentId : null;
  return onlyOne(ctx) && id !== undefined && id !== shown;
};

/** The Mind a Mind's row, or the tab showing it, stands for. */
const mindOf = (ctx: CommandContext) => {
  const target = ctx.selection[0] ?? ctx.focus;
  const shown = target?.kind === "tab" ? findTab(store().layout, target.id)?.item : undefined;
  const id =
    shown?.kind === "mind" ? shown.mindId : target?.kind === "mind" ? target.id : undefined;
  return store().minds.find((each) => each.id === id);
};
const ofMind = (ctx: CommandContext) => mindOf(ctx) !== undefined;
const folderOf = (ctx: CommandContext) => {
  const id = idsOf(ctx, "folder")[0];
  return store().library?.groups.find((each) => each.id === id);
};
const linkedOf = (ctx: CommandContext): LinkedFolder | undefined => {
  const id = idsOf(ctx, "linkedFolder")[0];
  return store().linkedFolders.find((each) => each.id === id);
};

/** How many Documents a selection holds, or 0 for one: its commands then say "these 3". */
const many = (ctx: CommandContext): number => {
  const count = documentsOf(ctx).length;
  return count > 1 ? count : 0;
};

function bridgeOf(ctx: CommandContext): LibraryBridge | null {
  const documents = documentsOf(ctx);
  const [first] = documents;
  if (!first) return null;
  return {
    kind: "documents",
    title:
      documents.length === 1
        ? displayName(first)
        : translateNow("library.count", { count: countNow(documents.length) }),
    count: documents.length,
    scope: { folderIds: [], tagIds: [], documentIds: documents.map((each) => each.id) },
  };
}

/** Why a Document's file can't be opened or shown now, if it can't. */
const fileReason = (ctx: CommandContext) => {
  for (const document of documentsOf(ctx)) {
    const state = fileStatusLabel(document.fileStatus);
    if (state) return { reason: state.reason };
  }
  return true as const;
};

const onFiles = (ctx: CommandContext) => everyDocument(ctx, userFile);

/** A PDF that couldn't be read for want of its password (#763). */
const isLockedPdf = (document: { kind: string; failure: { reason: string } | null }) =>
  document.kind === "pdf" && document.failure?.reason === "password-protected";

/** The Mind a Word file was imported as (#720), while it is there. */
const importedMindOf = (ctx: CommandContext) => {
  const id = documentsOf(ctx)[0]?.importedAs;
  return id ? store().minds.find((each) => each.id === id) : undefined;
};

export const mindCommands: readonly Command[] = [
  {
    id: "mind.open",
    label: "mind.open",
    group: "open",
    appliesTo: ["mind"],
    when: onlyOne,
    reversible: true,
    run: (ctx) => store().openMind(idsOf(ctx, "mind")[0] ?? ""),
  },
  {
    id: "mind.openTab",
    label: "mind.openTab",
    group: "open",
    appliesTo: ["mind"],
    when: onlyOne,
    reversible: true,
    run: (ctx) => store().openMind(idsOf(ctx, "mind")[0] ?? "", { newTab: true }),
  },
  {
    id: "mind.openBeside",
    label: "command.openBeside",
    group: "open",
    appliesTo: ["mind"],
    when: (ctx) => besideFront(ctx, "mind"),
    reversible: true,
    run: (ctx) => openBeside({ kind: "mind", mindId: idsOf(ctx, "mind")[0] ?? "" }),
  },
  // Exporting (Export as…, Export options…) is in ./exports.
  {
    id: "mind.moveTo",
    label: "mind.moveTo",
    rowKeys: "CmdOrCtrl+Shift+M",
    group: "move",
    top: 30,
    appliesTo: ["mind", "tab"],
    when: (ctx) => ofMind(ctx) && ctx.here?.["mind.moveTo"] !== undefined,
    reversible: true,
    run: (ctx) => ctx.here?.["mind.moveTo"]?.(),
  },
  {
    id: "mind.rename",
    label: "mind.rename",
    keywords: ["command.rename.keywords"],
    rowKeys: RENAME_KEYS,
    group: "edit",
    top: 32,
    appliesTo: ["mind"],
    reversible: true,
    ...needsHere("mind.rename"),
    when: (ctx) => onlyOne(ctx) && ctx.here?.["mind.rename"] !== undefined,
  },
  {
    id: "mind.duplicate",
    label: "mind.duplicate",
    group: "main",
    appliesTo: ["mind", "tab"],
    when: (ctx) => onlyOne(ctx) && ofMind(ctx),
    // Undo sends the copy to Recently deleted.
    reversible: true,
    async run(ctx) {
      const mind = mindOf(ctx);
      if (mind) await store().duplicateMind(mind.id);
    },
  },
  {
    id: "mind.delete",
    label: "mind.deleteAction",
    group: "danger",
    destructive: true,
    appliesTo: ["mind", "tab"],
    when: (ctx) => onlyOne(ctx) && ofMind(ctx),
    reversible: true,
    async run(ctx) {
      const mind = mindOf(ctx);
      if (mind) await store().deleteMind(mind.id);
    },
  },
];

export const documentCommands: readonly Command[] = [
  {
    id: "document.open",
    label: "mind.open",
    group: "open",
    appliesTo: ["document"],
    when: onlyOne,
    reversible: true,
    run: (ctx) => store().openDocument({ documentId: idsOf(ctx, "document")[0] ?? "" }),
  },
  {
    id: "document.openTab",
    label: "mind.openTab",
    group: "open",
    appliesTo: ["document"],
    when: onlyOne,
    reversible: true,
    run: (ctx) =>
      store().openDocument({ documentId: idsOf(ctx, "document")[0] ?? "" }, { as: "here" }),
  },
  {
    id: "document.openBeside",
    label: "command.openBeside",
    group: "open",
    appliesTo: ["document"],
    when: (ctx) => besideFront(ctx, "document"),
    reversible: true,
    run: (ctx) => openBeside({ kind: "document", documentId: idsOf(ctx, "document")[0] ?? "" }),
  },
  {
    id: "document.openMind",
    label: "document.openMind",
    group: "open",
    appliesTo: ["document"],
    when: (ctx) => onlyOne(ctx) && importedMindOf(ctx) !== undefined,
    reversible: true,
    run(ctx) {
      const mind = importedMindOf(ctx);
      if (mind) store().openMind(mind.id);
    },
  },
  {
    id: "document.ask",
    assistant: false,
    label: (ctx, t) =>
      many(ctx) ? t("library.ask.documents", { count: countNow(many(ctx)) }) : t("documents.ask"),
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => documentsOf(ctx).length >= 1,
    reversible: true,
    run(ctx) {
      const bridge = bridgeOf(ctx);
      if (bridge) return store().askAbout(bridge);
    },
  },
  {
    id: "document.startMind",
    label: (ctx, t) =>
      many(ctx)
        ? t("documents.startMind.many", { count: countNow(many(ctx)) })
        : t("documents.startMind"),
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => documentsOf(ctx).length >= 1,
    reversible: true,
    run: async (ctx) => {
      const bridge = bridgeOf(ctx);
      if (bridge) await store().startMindFrom(bridge);
    },
  },
  {
    id: "document.moveTo",
    label: "documents.moveTo",
    rowKeys: "CmdOrCtrl+Shift+M",
    group: "move",
    top: 30,
    appliesTo: ["document"],
    reversible: true,
    ...needsHere("document.moveTo"),
  },
  {
    id: "document.retry",
    label: (ctx, t) =>
      many(ctx)
        ? t("documents.retryAction.many", { count: countNow(many(ctx)) })
        : t("documents.retryAction"),
    group: "main",
    appliesTo: ["document"],
    when: (ctx) =>
      everyDocument(
        ctx,
        (document) =>
          ((onlyOne(ctx) && ctx.here?.["document.retry"] !== undefined) ||
            document.status === "failed" ||
            document.status === "no-text") &&
          document.fileStatus === "available" &&
          !isLockedPdf(document),
      ),
    reversible: true,
    run: async (ctx) => {
      if (onlyOne(ctx) && ctx.here?.["document.retry"]) return ctx.here["document.retry"]();
      await Promise.all(idsOf(ctx, "document").map((id) => store().retryDocument(id)));
    },
  },
  {
    id: "document.readHiddenSheets",
    label: "documents.readHiddenSheets",
    group: "main",
    appliesTo: ["document"],
    assistant: { never: "privacy" },
    when: (ctx) =>
      onlyOne(ctx) &&
      everyDocument(
        ctx,
        (document) =>
          document.kind === "xlsx" &&
          document.fileStatus === "available" &&
          document.status !== "queued" &&
          document.status !== "extracting" &&
          (document.unreadParts?.hiddenSheets.length ?? 0) > 0,
      ),
    reversible: true,
    run: async (ctx) => {
      const id = idsOf(ctx, "document")[0];
      if (id) await store().readHiddenSheets(id);
    },
  },
  {
    // Opens it where its password is asked for (#763).
    id: "document.unlock",
    label: "documents.unlockAction",
    group: "main",
    appliesTo: ["document"],
    when: (ctx) =>
      onlyOne(ctx) &&
      everyDocument(
        ctx,
        (document) => isLockedPdf(document) && document.fileStatus === "available",
      ),
    reversible: true,
    run: (ctx) => store().openDocument({ documentId: idsOf(ctx, "document")[0] ?? "" }),
  },
  {
    id: "document.forgetPassword",
    label: "documents.forgetPasswordAction",
    group: "edit",
    appliesTo: ["document"],
    when: (ctx) =>
      onlyOne(ctx) &&
      useDocumentPasswords.getState().kept.includes(idsOf(ctx, "document")[0] ?? ""),
    // Nothing is lost: the text read stays, and the password opens it again.
    reversible: true,
    run: async (ctx) => {
      await core.forgetDocumentPassword(idsOf(ctx, "document")[0] ?? "").catch(reportError);
    },
  },
  {
    id: "document.tags",
    label: "document.tags",
    group: "tags",
    top: 31,
    appliesTo: ["document"],
    reversible: true,
    ...needsHere("document.tags"),
  },
  {
    id: "document.rename",
    label: "documents.renameAction",
    keywords: ["command.rename.keywords"],
    rowKeys: RENAME_KEYS,
    group: "edit",
    top: 32,
    appliesTo: ["document"],
    reversible: true,
    ...needsHere("document.rename"),
    when: (ctx) => onlyOne(ctx) && ctx.here?.["document.rename"] !== undefined,
  },
  {
    id: "document.openExternally",
    label: "documents.copy.open",
    group: "file",
    appliesTo: ["document"],
    when: (ctx) => onlyOne(ctx) && onFiles(ctx),
    // Its file isn't where it was: the item says why.
    enabled: fileReason,
    reversible: true,
    run(ctx) {
      for (const id of idsOf(ctx, "document")) files.openDocumentExternally(id).catch(reportError);
    },
  },
  {
    id: "document.showInFolder",
    label: (_ctx, t) => t(showFileLabelKey(navigator.platform)),
    group: "file",
    appliesTo: ["document"],
    when: (ctx) => onlyOne(ctx) && onFiles(ctx),
    enabled: fileReason,
    reversible: true,
    run(ctx) {
      for (const id of idsOf(ctx, "document")) files.showDocumentInFolder(id).catch(reportError);
    },
  },
  {
    id: "document.delete",
    label: (ctx, t) =>
      many(ctx)
        ? t("documents.deleteAction.many", { count: countNow(many(ctx)) })
        : t(
            documentsOf(ctx).every((document) => document.fileStatus === "missing")
              ? "documents.removeAction"
              : "documents.deleteAction",
          ),
    group: "danger",
    destructive: true,
    appliesTo: ["document"],
    reversible: true,
    async run(ctx) {
      await store().deleteDocuments(documentsOf(ctx).map((document) => document.id));
    },
  },
];

export const folderCommands: readonly Command[] = [
  {
    id: "folder.open",
    label: "folder.open",
    group: "open",
    appliesTo: ["folder"],
    reversible: true,
    run: (ctx) => store().openLibrary(idsOf(ctx, "folder")[0]),
  },
  {
    id: "folder.newMind",
    label: "folder.newMindHere",
    group: "main",
    top: 22,
    appliesTo: ["folder"],
    reversible: true,
    run: async (ctx) => {
      await store().createMind({ titled: true, folderId: idsOf(ctx, "folder")[0] ?? null });
    },
  },
  {
    id: "folder.ask",
    assistant: false,
    label: "library.ask.folder",
    group: "main",
    appliesTo: ["folder"],
    when: (ctx) => folderBridge(ctx) !== null,
    reversible: true,
    run(ctx) {
      const bridge = folderBridge(ctx);
      if (bridge) return store().askAbout(bridge);
    },
  },
  {
    id: "folder.organize",
    label: "folder.organize",
    group: "main",
    top: 24,
    appliesTo: ["folder"],
    enabled: (ctx) =>
      folderDocumentIds(ctx).length > 0 ? true : { reason: "folder.organize.empty" },
    // Suggestions are reviewed and taken back from the Library.
    reversible: true,
    async run(ctx) {
      if (!store().library?.settings.classifier) return store().openSettings("models", "tagging");
      await core.classifyDocuments(folderDocumentIds(ctx));
    },
  },
  {
    id: "folder.tagWithAi",
    label: "folder.tagWithAi",
    keywords: ["tagging.resume.keywords"],
    group: "main",
    appliesTo: ["folder"],
    when: (ctx) => {
      const id = idsOf(ctx, "folder")[0];
      return !!id && stoppedPlaces(store().library).includes(id);
    },
    reversible: true,
    async run(ctx) {
      const id = idsOf(ctx, "folder")[0];
      if (id) return tagWithAi([id]);
    },
  },
  {
    id: "folder.editDescription",
    label: "folder.editDescription",
    group: "main",
    appliesTo: ["folder"],
    reversible: true,
    run(ctx) {
      const id = idsOf(ctx, "folder")[0];
      if (!id) return;
      store().openLibrary(id);
      useRequests.getState().ask({ editFolder: id });
    },
  },
  {
    id: WALL_SWITCH,
    assistant: { never: "wall" },
    label: "folder.keepInside",
    hint: "folder.keepInside.hint",
    purpose: "folder.keepInside.hint",
    group: "main",
    appliesTo: ["folder"],
    checked: (ctx) => folderOf(ctx)?.keepInside === true,
    reversible: true,
    async run(ctx) {
      const folder = folderOf(ctx);
      if (!folder) return;
      await store().editFolder(folder.id, {
        name: folder.name,
        description: folder.description,
        countsOwnFiles: folder.countsOwnFiles,
        keepInside: folder.keepInside !== true,
      });
    },
  },
  {
    id: "folder.rename",
    label: "folder.rename",
    keywords: ["command.rename.keywords"],
    rowKeys: RENAME_KEYS,
    group: "edit",
    top: 32,
    appliesTo: ["folder"],
    reversible: true,
    ...needsHere("folder.rename"),
  },
  {
    id: "folder.delete",
    label: "folder.delete",
    group: "danger",
    destructive: true,
    appliesTo: ["folder"],
    reversible: true,
    async run(ctx) {
      const folder = folderOf(ctx);
      if (folder) await store().deleteFolder(folder.id);
    },
  },
];

export const tagCommands: readonly Command[] = [
  {
    id: "tag.open",
    label: "mind.open",
    group: "open",
    appliesTo: ["tag"],
    reversible: true,
    run(ctx) {
      // Its Documents, in the Library: the Tag filter the Library and the sidebar share.
      store().setTagFilter(idsOf(ctx, "tag").slice(0, 1));
      store().openLibrary();
    },
  },
  {
    id: "tag.rename",
    label: "tag.rename",
    keywords: ["command.rename.keywords"],
    rowKeys: RENAME_KEYS,
    group: "edit",
    appliesTo: ["tag"],
    reversible: true,
    run(ctx) {
      // In its row where it has a field; elsewhere, in the Tags dialog.
      if (ctx.here?.["tag.rename"]) return ctx.here["tag.rename"]();
      useRequests.getState().ask({ manageTag: { id: idsOf(ctx, "tag")[0] ?? "" } });
      store().openTagsDialog();
    },
  },
  {
    id: "tag.delete",
    label: "tag.delete",
    group: "danger",
    destructive: true,
    appliesTo: ["tag"],
    reversible: true,
    run: (ctx) => deleteTag(idsOf(ctx, "tag")[0] ?? "").catch(reportError),
  },
  {
    id: "tag.manage",
    label: "tags.menu.manage",
    group: "edit",
    appliesTo: ["tag"],
    reversible: true,
    run: () => store().openTagsDialog(),
  },
  {
    // From anywhere, as ⌘K offers it: the sidebar lists only the Tags in use.
    id: "tags.manage",
    label: "tags.menu.manage",
    group: "main",
    reversible: true,
    run: () => store().openTagsDialog(),
  },
];

const kindsIn = (ctx: CommandContext) => new Set(ctx.selection.map((each) => each.kind)).size;
const rowMoveTo = (ctx: CommandContext) =>
  ctx.here?.["mind.moveTo"] ?? ctx.here?.["document.moveTo"];

/** A selection of several kinds: only what applies to all of it, as `registerMixedMenu` lists. */
export const mixedSelectionCommands: readonly Command[] = [
  {
    id: "selection.moveTo",
    assistant: false,
    label: (ctx, t) => t("selection.moveTo", { count: countNow(ctx.selection.length) }),
    rowKeys: "CmdOrCtrl+Shift+M",
    group: "move",
    // Folders don't go inside Folders until #246.
    appliesTo: ["mind", "document"],
    when: (ctx) => kindsIn(ctx) > 1 && rowMoveTo(ctx) !== undefined,
    reversible: true,
    run: (ctx) => rowMoveTo(ctx)?.(),
  },
  {
    id: "selection.delete",
    assistant: false,
    label: (ctx, t) => t("selection.delete", { count: countNow(ctx.selection.length) }),
    rowKeys: "CmdOrCtrl+Backspace",
    group: "danger",
    destructive: true,
    appliesTo: ["mind", "document", "folder"],
    when: (ctx) => kindsIn(ctx) > 1,
    reversible: true,
    run: (ctx) => store().deleteSelection(ctx.selection),
  },
];

const folderDocumentIds = (ctx: CommandContext): string[] => {
  const id = idsOf(ctx, "folder")[0];
  return (store().library?.assignments ?? []).flatMap((item) =>
    item.groupId === id ? [item.documentId] : [],
  );
};

const folderBridge = (ctx: CommandContext): LibraryBridge | null => {
  const folder = folderOf(ctx);
  return folder
    ? bridgeFrom(
        { kind: "folder", id: folder.id, name: folder.name },
        folderDocumentIds(ctx),
        false,
      )
    : null;
};

const REVEAL = showFileLabelKey(navigator.platform);

export const linkedFolderCommands: readonly Command[] = [
  {
    id: "linkedFolder.pause",
    label: (ctx, t) =>
      t(linkedOf(ctx)?.status === "paused" ? "linkedFolders.resume" : "linkedFolders.pause"),
    group: "main",
    appliesTo: ["linkedFolder"],
    reversible: true,
    run(ctx) {
      const linked = linkedOf(ctx);
      return linked && store().setLinkedFolderPaused(linked.id, linked.status !== "paused");
    },
  },
  {
    id: "linkedFolder.download",
    label: (ctx, t) => {
      const count = linkedOf(ctx)?.onlineOnly.files ?? 0;
      return count === 1
        ? t("linkedFolders.downloadOnlineOnly.one")
        : t("linkedFolders.downloadOnlineOnly.other", { count: countNow(count) });
    },
    group: "main",
    appliesTo: ["linkedFolder"],
    when(ctx) {
      const online = linkedOf(ctx)?.onlineOnly;
      return online !== undefined && !online.downloading && online.files > 0;
    },
    reversible: true,
    run: async (ctx) => {
      const linked = linkedOf(ctx);
      if (linked) await store().downloadOnlineOnlyFiles(linked.id);
    },
  },
  {
    id: "linkedFolder.reveal",
    label: REVEAL,
    group: "file",
    appliesTo: ["linkedFolder"],
    enabled: (ctx) =>
      linkedOf(ctx)?.status === "unavailable"
        ? { reason: "linkedFolders.reveal.unavailableReason" }
        : true,
    reversible: true,
    run: async (ctx) => {
      const linked = linkedOf(ctx);
      if (linked) await store().showLinkedFolder(linked.id);
    },
  },
  {
    id: "linkedFolder.locate",
    label: "linkedFolders.locateAction",
    group: "file",
    appliesTo: ["linkedFolder"],
    // Locating it again, where it was, puts it back.
    reversible: true,
    run: async (ctx) => {
      const linked = linkedOf(ctx);
      if (linked) await store().locateLinkedFolder(linked.id);
    },
  },
  {
    id: "linkedFolder.unlink",
    assistant: { never: "permanent" },
    label: "linkedFolders.unlinkAction",
    group: "danger",
    destructive: true,
    appliesTo: ["linkedFolder"],
    reversible: { confirm: "linkedFolders.unlink.body" },
    run(ctx) {
      const linked = linkedOf(ctx);
      if (linked) useRequests.getState().ask({ unlink: { linked, name: folderName(linked.path) } });
    },
  },
];

export const answerCommands: readonly Command[] = [
  {
    id: "answer.copy",
    label: "object.copy",
    group: "main",
    appliesTo: ["answer"],
    reversible: true,
    ...needsHere("answer.copy"),
  },
  {
    id: "answer.regenerate",
    label: "answer.regenerate",
    group: "main",
    appliesTo: ["answer"],
    reversible: true,
    ...needsHere("answer.regenerate"),
  },
];

export const citationCommands: readonly Command[] = [
  // "Checked by me" (#1933), as a toggle: the first while it is off, the second while it is on;
  // from the Citation's menu, or from ⌘K while its card shows.
  ...(["signOff", "signOffRemove"] as const).map(
    (action): Command => ({
      id: `citation.${action}`,
      label: "signOff.action",
      assistant: { never: "signOff" },
      keywords: ["signOff.keywords"],
      group: "edit",
      reversible: true,
      checked: () => action === "signOffRemove",
      ...needsHere(`citation.${action}`),
    }),
  ),
  {
    id: "citation.remove",
    label: "citation.remove",
    group: "danger",
    appliesTo: ["citation"],
    // The note's own undo (⌘Z) brings it back.
    reversible: true,
    ...needsHere("citation.remove"),
  },
];
