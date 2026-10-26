import { create } from "zustand";
import type {
  ChatReadiness,
  DeviceSettings,
  Document,
  EmbeddingModelStatus,
  EmbeddingSettings,
  ExampleGroup,
  Examples,
  Folder,
  FolderMove,
  GettingStarted,
  KeptCitationText,
  LayoutChange,
  LayoutTab,
  LibraryGroup,
  LibraryGroupInput,
  LibrarySnapshot,
  LinkedFolder,
  LinkedFolderLayout,
  LinkedFolderPreview,
  Mind,
  PrivacySettings,
  RerankSettings,
  RestoreRef,
  SearchScope,
  Settings,
  SettingsPatch,
  Skill,
  Tag,
} from "../../core/api";
import { EXAMPLE_GROUPS } from "../../core/api";
import { resolveLanguage } from "../../core/language";
import type { UiUsageEvent } from "../../core/usageEvents";
import { displayName } from "../../shared/documentNames";
import type { DocumentLocation } from "../../shared/documentViewer";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
import { filingFolder } from "../../shared/searchScope";
import { tagLinks } from "../../shared/tagLinks";
import {
  deleted,
  documentsAdded,
  folderLinked,
  linkedFolderPaused,
  renamed,
  retagged,
} from "./changes";
import { core, files } from "./core";
import { LIBRARY_DELETED } from "./deletedItems";
import { isSearchable } from "./documentStatus";
import { applyAssignments, applyDocumentChanges, createDocumentUpdates } from "./documentUpdates";
import { describeError, errorMessage } from "./errors";
import { languageNow } from "./i18n";
import {
  createLayoutSlice,
  currentMindIdOf,
  focusedGroupOf,
  followLayout,
  groupsMerged,
  type LayoutSlice,
  type TabNotice,
  WINDOW_ID,
} from "./layoutSlice";
import { type LibraryBridge, mindToAskIn } from "./libraryBridges";
import { NEEDS_REVIEW } from "./libraryFilters";
import type { WordsInLine } from "./lineNames";
import { formatCount, folderName as linkedFolderName } from "./linkedFolders";
import {
  foldersMovedFrom,
  itemsOf,
  type MoveItems,
  madeMessage,
  movedLocally,
  moveMessage,
  moveName,
  type Names,
  namesOfFolders,
  namesOfMoving,
  undoMoves,
} from "./moves";
import { untitledFolderName } from "./newFolder";
import { useNotices } from "./notices";
import type { ObjectRef } from "./objects";
import { useRequests } from "./requests";
import { resolveSettingsPage, type SettingsPage, type SettingsTarget } from "./settingsPages";
import { returnFocusAfterTabClose } from "./tabFocus";
import { tabTitle } from "./tabs";
import { asOneStep, makeInTurn, sayWhileSlow, type Undoable, UndoRefused, useUndo } from "./undo";

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };

/**
 * A folder the User picked to link, while the link dialog shows what linking
 * it would take: the preview once it is counted, or why it couldn't be.
 */
export interface LinkingFolder {
  path: string;
  preview: LinkedFolderPreview | null;
  error: string | null;
}

/** What a Document tab shows: its Document, opened at a location. */
export interface ViewerTarget extends DocumentLocation {
  /** Counts every opening of the tab at a place, so opening it there again re-applies it. */
  request: number;
}

/**
 * How a Document opens:
 * - "citation": from a Citation or link in a group (`from`), as a preview in the
 *   group to its right, the focus staying where it was (unless the groups are merged);
 * - "list": from the sidebar, ⌘K or a test, as a preview beside the Mind;
 * - "library": from a Library row in group `from`, as a preview to its right;
 * - "here": a normal tab in group `from` (⌘-click in the Library).
 *
 * A Document already open goes to its tab, in any group. `keep`, for
 * "citation": a preview there is kept (Open the page, in a Citation's card).
 */
export interface OpenDocumentHow {
  as: "citation" | "list" | "library" | "here";
  from?: string;
  keep?: boolean;
  /** "citation": a tab of its own, not a preview the next Citation opened replaces; the focus stays. */
  stay?: boolean;
}

export interface AppState extends LayoutSlice {
  status: Status;
  minds: Mind[];
  /** A Mind just created: its first line takes the focus once it shows (#908). */
  bodyToFocus: string | null;
  /** Set once loaded. */
  settings: Settings | null;
  /** Whether Questions can be asked. Set once loaded, then follows the core's event. */
  chatReadiness: ChatReadiness | null;
  /** Most recently added first. */
  documents: Document[];
  /**
   * The text kept of Documents unlinked with their Linked folder, so the
   * Citations that quote it can still be checked. Set once loaded, then follows the core's event.
   */
  keptCitationTexts: KeptCitationText[];
  /** Names of the files the last add couldn't take, shown until dismissed. */
  skippedFiles: string[];
  /** Names of the files the last add found in IncarnaMind already, shown until dismissed. */
  alreadyAdded: string[];
  /** The built-in embedding model and its download. Set once loaded, then follows the core's event. */
  embeddingModel: EmbeddingModelStatus | null;
  /** The embedding model search uses, local mode and any rebuild. Set once loaded, then follows the core's event. */
  embedding: EmbeddingSettings | null;
  /** Reranking, and the built-in reranking model's download. Set once loaded, then follows the core's event. */
  rerank: RerankSettings | null;
  settingsOpen: boolean;
  /** The page Settings shows. */
  settingsPage: SettingsPage;
  /** A setting Settings opened at, shown and focused once it is drawn, which then clears this. */
  settingsAt: SettingsTarget | null;
  /**
   * Every Folder of every Linked folder, flat, in name order: each Linked
   * folder's own Folder and those inside it. The sidebar builds the tree from each `parentId`.
   */
  folders: Folder[];
  /** The Linked folders, in path order. Set once loaded, then follows the core's event. */
  linkedFolders: LinkedFolder[];
  /** The folder the link dialog asks about, until the User links it or cancels. */
  linking: LinkingFolder | null;
  /** More folders dropped at once, which the link dialog asks about in turn. */
  linkQueue: LinkingFolder[];
  /** Every Tag, in name order. */
  tags: Tag[];
  /**
   * The Tags whose Documents the sidebar and the Library show: those with any
   * of them (`NEEDS_REVIEW` stands for a Tag awaiting review). Empty: all.
   */
  tagFilter: readonly string[];
  tagsDialogOpen: boolean;
  library: LibrarySnapshot | null;
  /**
   * What the Library was asked to show: "all"; a Folder's id, "unsorted" or
   * `LIBRARY_DELETED`, whose section the page brings into view (then "all"
   * again); or "starters", the starter Folders at its top.
   */
  libraryFilter: string;
  refreshLibrary(): Promise<void>;
  /**
   * Shows the Library (one tab per window), at a Folder's section if given:
   * its tab where it is open, else a new tab in the focused group, to the side,
   * or behind the one shown.
   */
  openLibrary(filter?: string, options?: { side?: boolean; behind?: boolean }): void;
  /**
   * Shows Home (one tab per window): its tab where it is open, else a new one
   * in the focused group; with `first`, as at a launch, just before the tab
   * that group shows.
   */
  openHome(options?: { side?: boolean; first?: boolean }): Promise<void>;
  /** Every Skill, in name order, on or off. Set once loaded, then follows the core's event. */
  skills: Skill[];
  /** The first-run example Mind and its Documents (onboarding). Null until loaded. */
  examples: Examples | null;
  otherExamples: Examples[];
  ownAnswerArrived: boolean;
  askedOwnAtLaunch: boolean;
  usageNotice: "auto" | "kept" | "answered";
  /**
   * The privacy choices on this device: the first run asks about usage data
   * from them. Set once loaded, then follows the core's event.
   */
  privacy: PrivacySettings | null;
  /**
   * The Mind whose editor should start a Question at its end once it shows,
   * e.g. a new one, with the Search scope it starts with (from the Library), if any.
   */
  questionToStart: { mindId: string; scope: SearchScope | null } | null;

  load(): Promise<void>;
  /**
   * Creates a Mind, in `folderId` if given, else where `filingFolder` says (#1362), and opens it
   * in a new tab after the shown one, in the focused group or `groupId`, with its title focused,
   * or with a Question started in it (with a Search scope, if given). It says nothing and leaves
   * nothing to undo: ⌘Z stays the editor's own, and Delete takes the Mind back. Resolves to its
   * id once it is shown, or null if it wasn't made or the core refused its tab.
   */
  createMind(options?: {
    startQuestion?: boolean;
    /** Its name, which its text starts with as a Heading 1 ("Create a new note called …"). */
    title?: string;
    /** A new Mind to write in: its first line is an empty Heading 1, its title to be typed. */
    titled?: boolean;
    scope?: SearchScope | null;
    /** Null: in no Folder, whichever Mind is in front. */
    folderId?: string | null;
    groupId?: string;
    /** Runs once it is made and shown, with its id. */
    made?(mindId: string): void;
  }): Promise<string | null>;
  /**
   * Moves Minds and Documents into a Folder, or out of every Folder (null):
   * shown at once, then as the core has it, with "Moved … · Undo" (and ⌘Z).
   * Drops on a Folder and "Move to…" share it. Resolves to the change it put on
   * the undo stack, or null when nothing moved.
   */
  moveToFolder(items: MoveItems, folderId: string | null): Promise<Undoable | null>;
  /**
   * Makes "Untitled Folder" (numbered if that is taken) and asks the sidebar to
   * open its name field, or, given a `name`, makes it with that name. With
   * `items`, the Minds and Documents go into it at once. One step to undo, with
   * its first name (`nameNewFolder`). Resolves to the Folder's id, or null if
   * it couldn't be made.
   */
  createFolder(items?: MoveItems, name?: string): Promise<string | null>;
  /** Names the Folder just made: part of making it, so one Undo takes both back. */
  nameNewFolder(folderId: string, name: string): Promise<void>;
  /** Renames a Folder, keeping its description. */
  renameFolder(folderId: string, name: string): Promise<void>;
  /** Changes a Folder's name, description or evidence choice, with Undo. Throws what the core throws. */
  editFolder(folderId: string, input: LibraryGroupInput): Promise<void>;
  /** Deletes a Folder, with Undo: its Documents and Minds go to Not in a Folder. */
  deleteFolder(folderId: string): Promise<void>;
  /** Deletes the Minds, Documents and Folders given, together, with one Undo. */
  deleteSelection(items: readonly ObjectRef[]): Promise<void>;
  /** Lists a Mind just made and opens it in a new tab after the shown one, in the focused group or `groupId`; false if the core refused it. */
  showNewMind(mind: Mind, groupId?: string): Promise<boolean>;
  /** Called once the new Mind's text has the focus. */
  bodyFocused(): void;
  /** Starts a Question at the end of the open Mind, or of a new Mind if none is open. */
  startQuestion(): void;
  /** Called once the Question asked for is started. */
  questionStarted(): void;
  /**
   * "Ask about this Folder" in the Library: a Question with the bridge's
   * Search scope at the end of the most recent Mind (see `mindToAskIn`), or
   * of a new Mind if there is none, with the cursor in it. A Question in a Mind
   * already there is the note's own to undo.
   */
  askAbout(bridge: LibraryBridge): Promise<void>;
  /**
   * "Start a Mind from this Folder": a new Mind titled as the Library's
   * sheet, whose first Block is a Question with the bridge's Search scope.
   */
  startMindFrom(bridge: LibraryBridge): Promise<string | null>;
  /** Opens the first-run example Mind, making the examples again if they were removed. */
  openExamples(): Promise<void>;
  /** Makes the first-run example again and opens it, with Undo. */
  showExamples(): Promise<void>;
  /** Opens another example in a new tab, making it first if it isn't there; the Mind in view stays. */
  openExample(group: ExampleGroup): Promise<void>;
  removeExamples(): Promise<void>;
  /**
   * Ticks steps of the "Get started" checklist, or hides it. Only once it
   * started (a first run), and only what changes.
   */
  updateGettingStarted(patch: Partial<GettingStarted>): void;
  /**
   * Shows a Mind: its tab where it is open, else a new tab in the focused
   * group after the shown one; with `newTab`, a new tab in the focused group
   * even where it is open; with `behind`, a new tab that stays behind the one shown.
   */
  openMind(id: string, options?: { newTab?: boolean; behind?: boolean }): void;
  /** Closes a tab, offering to reopen it; if it was shown, the tab after it (or else before it) is. */
  closeTab(tabId: string): void;
  /** ⇧⌘T: reopens the tab closed last, where it was. */
  reopenTab(): void;
  /** A line about the tabs, in the sidebar foot's one slot: a tab closed, or why a shortcut did nothing. */
  showTabNotice(notice: TabNotice): void;
  /** Renames a Mind, with Undo. */
  renameMind(id: string, title: string): Promise<void>;
  deleteMind(id: string): Promise<void>;
  /** Shows a failure that happened outside a store action, e.g. while saving an edit. */
  reportError(error: unknown): void;
  /**
   * Opens Settings at a page: the general one unless asked otherwise, e.g.
   * Models to set one up, or Privacy to allow a declined flow; and, with
   * `at`, at one setting on it.
   */
  openSettings(page?: SettingsPage, at?: SettingsTarget): void;
  closeSettings(): void;
  showSettingsPage(page: SettingsPage): void;
  /**
   * Shows a Document in a Document tab (see `OpenDocumentHow`), optionally at a
   * page range, highlighting a quote (Citations).
   */
  openDocument(location: DocumentLocation, how?: OpenDocumentHow): void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  /** Changes pane widths on screen only, e.g. while dragging a divider. */
  previewLayout(layout: Partial<DeviceSettings>): void;
  /**
   * Adds picked files as Documents. Files already in IncarnaMind, and those
   * it can't take, are named in the footer, once.
   */
  addDocuments(picked: readonly File[]): Promise<void>;
  /**
   * What dropping on the window does: files are added as Documents, and each
   * folder opens the link dialog (see `addLinkedFolder`), one after another.
   * `folders` are the dropped items the drop said are folders.
   */
  addDropped(dropped: readonly File[], folders: readonly File[]): Promise<void>;
  /**
   * The same, given absolute paths: a path that turns out to be a folder is
   * offered for linking. For the smoke tests, which can't drop a folder.
   */
  addPaths(paths: readonly string[]): Promise<void>;
  /** "Add Documents": the system's open dialog (see `FilesBridge.pickDocuments`), then the files picked are added. */
  pickDocuments(): Promise<void>;
  /**
   * "Add files or a folder…" (#1942): the system's open dialog, then the files
   * picked are added and a folder picked is offered to be read where it is.
   */
  pickDocumentsOrFolder(): Promise<void>;
  /** While that dialog is open: the buttons that open it wait, so it isn't opened twice. */
  pickingDocuments: boolean;
  /**
   * "Locate file…" on a Document whose file moved: the system's open dialog,
   * then the file picked is added, which points the Document at it if it has
   * the Document's content. Says what happened: "cancelled", "located", or
   * "other" when the file was a different one (and became a Document of its own).
   */
  locateDocumentFile(id: string): Promise<"cancelled" | "located" | "other">;
  renameDocument(id: string, name: string): Promise<void>;
  /** To Recently deleted, at once, with one undo line for all of them. */
  deleteDocuments(ids: readonly string[]): Promise<void>;
  /** Processes a Document that failed again, from its file. */
  retryDocument(id: string): Promise<void>;
  dismissSkippedFiles(): void;
  dismissAlreadyAdded(): void;
  /** Downloads the embedding model again after a failure. */
  downloadEmbeddingModel(): Promise<void>;
  /** Downloads the built-in reranking model again after a failure. */
  downloadRerankingModel(): Promise<void>;
  /** Tries the chosen embedding provider again after an error. */
  retryEmbedding(): Promise<void>;
  /**
   * Asks for a folder with the system's folder picker, then opens the link
   * dialog on it: what linking it would take, counted from its files' metadata.
   */
  addLinkedFolder(): Promise<void>;
  /** Links the folder the link dialog asks about, shown in `layout`, and closes the dialog. */
  confirmLinkedFolder(layout: LinkedFolderLayout): Promise<void>;
  /** Closes the link dialog without linking. */
  cancelLinkedFolder(): void;
  /** Pauses or resumes a Linked folder's indexing, with Undo. Resolves to that change, if it changed anything. */
  setLinkedFolderPaused(linkedFolderId: string, paused: boolean): Promise<Undoable | undefined>;
  /** Downloads a Linked folder's online-only files and indexes them. */
  downloadOnlineOnlyFiles(linkedFolderId: string): Promise<void>;
  /** Shows a Linked folder in the system's file manager. */
  showLinkedFolder(linkedFolderId: string): Promise<void>;
  /**
   * "Locate folder…": the system's folder picker, then the Linked folder is
   * looked for there, its Documents keeping their ids and Citations. Says why
   * if the folder picked isn't it.
   */
  locateLinkedFolder(linkedFolderId: string): Promise<void>;
  /** Unlinks a folder: its Documents leave the index; nothing on disk changes. */
  removeLinkedFolder(linkedFolderId: string): Promise<void>;
  /** Adds a Tag to the filter, or takes it out if it is in it. */
  toggleTagFilter(tagId: string): void;
  /** Shows the Documents with any of these Tags; none shows them whatever their Tags. */
  setTagFilter(tagIds: readonly string[]): void;
  addDocumentTag(documentId: string, tagId: string): Promise<void>;
  removeDocumentTag(documentId: string, tagId: string): Promise<void>;
  /** Puts a Tag on several Documents at once, resolving to the change it put on the undo stack. */
  addTagToDocuments(documentIds: readonly string[], tagId: string): Promise<Undoable | null>;
  removeTagFromDocuments(documentIds: readonly string[], tagId: string): Promise<void>;
  /** Creates a Tag; the list follows the core's event. Throws what the core throws. */
  createTag(name: string, description?: string): Promise<Tag>;
  /** Recomputes the automatic Tags of these Documents, or of all of them. */
  retagDocuments(documentIds?: string[]): Promise<void>;
  openTagsDialog(): void;
  closeTagsDialog(): void;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<void>;
  removeSkill(skillId: string): Promise<void>;
  /** Copies a Skill (a built-in one) as the User's own. */
  duplicateSkill(skillId: string): Promise<void>;
  /** Installs the built-in Skills the User removed again. */
  restoreBuiltInSkills(): Promise<void>;
}

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** Puts a Document in the list: in place if it's there, otherwise first. */
const upsert = (documents: Document[], item: Document) =>
  documents.some((each) => each.id === item.id)
    ? documents.map((each) => (each.id === item.id ? item : each))
    : [item, ...documents];

interface LinkStep {
  linkedFolderId: string;
  path: string;
  before: LibraryBefore;
}

interface LibraryBefore {
  documentIds: string[];
  linkedFolders: { path: string; layout: LinkedFolderLayout }[];
}

const linkSteps = new Map<Undoable, LinkStep>();

const inside = (folder: string, path: string) =>
  path !== folder && (path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`));

function moveLinkSteps(from: string, to: string): void {
  const moved = (path: string) =>
    path === from || inside(from, path) ? to + path.slice(from.length) : path;
  for (const link of linkSteps.values()) {
    link.path = moved(link.path);
    for (const merged of link.before.linkedFolders) merged.path = moved(merged.path);
  }
}

/** Puts a Linked folder in the list in place, if it's there. New ones arrive with the core's event. */
const replaceLinked = (linkedFolders: LinkedFolder[], linked: LinkedFolder) =>
  linkedFolders.map((each) => (each.id === linked.id ? linked : each));

/**
 * The core's per-Document events (status, Tags, moves, removals, Library
 * assignments), applied to the store together at most every 100ms (see
 * `createDocumentUpdates`). A store action that sets the Documents or the
 * Library itself flushes them first, so nothing older lands on top of it.
 */
const documentUpdates = createDocumentUpdates((changes) =>
  useAppStore.setState((state) => ({
    documents: applyDocumentChanges(state.documents, changes.upserted, changes.removed),
    // Before the Library is loaded there is nothing to change: loading reads it whole.
    ...(state.library && { library: applyAssignments(state.library, changes.assignments) }),
  })),
);

/**
 * Whole lists the core pushes by event, and `load` reads too. A list pushed
 * after `load` read its own is newer, so `load` must not put its copy back
 * over it: on a slow first run, the example Linked folder's Folder, made by
 * its first scan, was pushed while `load` still waited, and then vanished.
 * The core's events and replies arrive in the order it sent them.
 */
type PushedList =
  | "settings"
  | "minds"
  | "folders"
  | "linkedFolders"
  | "keptCitationTexts"
  | "tags"
  | "skills"
  | "chatReadiness"
  | "embeddingModel"
  | "embedding"
  | "rerank"
  | "privacy";
let pushes = 0;
const lastPushed = new Map<PushedList, number>();
const pushed = (list: PushedList) => lastPushed.set(list, ++pushes);

/** Reads a list for `load`, noting which pushes it already includes. */
function readList<T>(list: PushedList, request: Promise<T>, readAt: Map<PushedList, number>) {
  return request.then((value) => {
    readAt.set(list, pushes);
    return value;
  });
}

/** Whether the list was pushed after `load` read it. */
const pushedSince = (list: PushedList, readAt: Map<PushedList, number>) =>
  (lastPushed.get(list) ?? 0) > (readAt.get(list) ?? 0);

const LOADED_KEY = "incarnamind.window.loaded";

// A reload of the window (View › Reload) keeps the tab it showed; only a new window opens on Home.
function windowLoadedBefore(): boolean {
  try {
    const before = sessionStorage.getItem(LOADED_KEY) !== null;
    sessionStorage.setItem(LOADED_KEY, "1");
    return before;
  } catch (error) {
    console.warn("Couldn't tell whether this window loaded before; it opens on Home.", error);
    return false;
  }
}

export const useAppStore = create<AppState>()((set, get) => {
  let libraryRequest = 0;
  /** The interface's words, outside React: for the lines the store writes (Undo's). */
  const t = (key: MessageKey, params?: MessageParams) =>
    translate(
      get().settings?.language ?? resolveLanguage("system", navigator.languages),
      key,
      params,
    );

  /**
   * Moves, shown at once and then sent to the core; if the core refuses, the
   * Minds and the Library are read again, as it has them. Returns what it did.
   */
  const move = async (items: MoveItems, folderId: string | null) => {
    documentUpdates.flush();
    set((state) => movedLocally(state, items, folderId));
    try {
      return await core.moveToFolder({ ...itemsOf(items), folderId });
    } catch (error) {
      set({ minds: await core.listMinds() });
      await get().refreshLibrary();
      throw error;
    }
  };
  /** Runs an action, reporting a failure instead of throwing. */
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      useNotices.getState().showError(error);
    }
  };
  const push = (change: Undoable) => useUndo.getState().push(change);
  const removeOwn = async (ids: readonly string[]): Promise<RestoreRef[]> => {
    // One deleted since, or taken over by a Linked folder, is no longer this add's.
    const own = new Set(
      (await core.listDocuments({ linkedFolderId: null })).map((each) => each.id),
    );
    const taken: RestoreRef[] = [];
    for (const id of ids) {
      if (!own.has(id)) continue;
      await core.deleteDocument(id);
      taken.push({ kind: "document", id });
    }
    documentUpdates.flush();
    set((state) => ({
      documents: state.documents.filter((each) => !taken.some((ref) => ref.id === each.id)),
    }));
    return taken;
  };
  const libraryBefore = async (path: string): Promise<LibraryBefore> => {
    const [documents, linked] = await Promise.all([core.listDocuments(), core.listLinkedFolders()]);
    return {
      documentIds: documents.map((each) => each.id),
      linkedFolders: linked
        .filter((each) => inside(path, each.path))
        .map((each) => ({ path: each.path, layout: each.layout })),
    };
  };
  const unlinkStep = async (link: LinkStep) => {
    const linked = await core.listLinkedFolders();
    const now =
      linked.find((each) => each.id === link.linkedFolderId) ??
      linked.find((each) => each.path === link.path);
    if (!now) throw new UndoRefused((t) => t("error.linkedFolder.notFound"), null);
    if (now.path !== link.path) moveLinkSteps(link.path, now.path);
    // A merged folder that can't be linked again refuses the Undo before anything changes.
    for (const inner of link.before.linkedFolders) {
      try {
        await core.previewLinkedFolder(inner.path);
      } catch (error) {
        if (describeError(error).wording?.key !== "error.path.noFolder") throw error;
        // Its own link's Undo could only be refused too.
        for (const [step, other] of linkSteps) {
          if (other.path !== inner.path) continue;
          linkSteps.delete(step);
          useUndo.getState().withdraw(step);
        }
        const name = linkedFolderName(inner.path);
        throw new UndoRefused((t) => t("undo.linkedFolder.mergedGone", { name }), null);
      }
    }
    await core.removeLinkedFolder(now.id, { keep: link.before.documentIds });
    // The Linked folders it merged are linked again, their Documents keeping their ids.
    for (const inner of link.before.linkedFolders) {
      const back = await core.addLinkedFolder(inner.path);
      showLinked(await core.setLinkedFolderLayout(back.id, inner.layout));
      for (const other of linkSteps.values()) {
        if (other.path === inner.path) other.linkedFolderId = back.id;
      }
    }
  };
  const withdrawLinkSteps = (linkedFolderId: string) => {
    const gone = [...linkSteps].filter(([, link]) => link.linkedFolderId === linkedFolderId);
    for (let next = gone.pop(); next; next = gone.pop()) {
      const [step, link] = next;
      if (!linkSteps.delete(step)) continue;
      useUndo.getState().withdraw(step);
      // The folders it merged went with it.
      const merged = new Set(link.before.linkedFolders.map((each) => each.path));
      gone.push(...[...linkSteps].filter(([, inner]) => merged.has(inner.path)));
    }
  };
  const showLinked = (linked: LinkedFolder) =>
    set((state) => ({ linkedFolders: replaceLinked(state.linkedFolders, linked) }));

  /**
   * Refuses to put something back in a Folder deleted since, as the core would,
   * offering to restore the Folder first (`names`: theirs when the change was made).
   */
  const refuseIfDeleted = (folderIds: readonly string[], names: ReadonlyMap<string, string>) => {
    const { library } = get();
    if (!library) return;
    const gone = folderIds.find((id) => !library.groups.some((group) => group.id === id));
    if (gone === undefined) return;
    const name = names.get(gone) ?? "";
    throw new UndoRefused((t) => t("undo.folderGone", { name }), {
      label: (t) => t("undo.restoreFolder", { name }),
      run: async () => {
        await core.restore([{ kind: "folder", id: gone }]);
        await get().refreshLibrary();
      },
    });
  };

  /** Takes a move back: each Mind and conversation to where it was, each Document's assignment as it was. */
  const putBack = async (done: FolderMove, names: ReadonlyMap<string, string>) => {
    refuseIfDeleted(foldersMovedFrom(done), names);
    for (const back of undoMoves(done)) await move(back.items, back.folderId);
    for (const document of done.documents)
      await core.restoreAssignment(document.id, document.previous);
  };

  /**
   * Built here, not in the action that reads the Minds, Documents and Library: closures made in
   * one scope all keep what any of them uses, and the undo stack keeps these as long as the session.
   * `named` and `names` are cut to what the line and the refusal say.
   */
  const moveChange = (made: {
    moving: MoveItems;
    folderId: string | null;
    folderName: string;
    named: Names;
    names: ReadonlyMap<string, string>;
    done: FolderMove;
  }): Undoable => {
    const { moving, folderId, folderName, named, names } = made;
    let { done } = made;
    return {
      said: (t) =>
        moveMessage(t, moving, folderId === null ? t("library.unsorted") : folderName, named),
      name: (t) => moveName(t, moving, named),
      undo: () => putBack(done, names),
      redo: async () => {
        if (folderId !== null) refuseIfDeleted([folderId], names);
        done = await move(moving, folderId);
      },
    };
  };

  const folderMade = (made: {
    folderId: string;
    going: MoveItems | null;
    named: Names;
    names: ReadonlyMap<string, string>;
    done: FolderMove | null;
  }) => {
    const { folderId, going, named, names } = made;
    let { done } = made;
    return (folderName: string): Undoable => ({
      said: (t) => madeMessage(t, folderName, going, named),
      name: (t) => t("undo.name.newFolder"),
      undo: async () => {
        if (done) await putBack(done, names);
        await core.deleteLibraryGroup(folderId);
        await get().refreshLibrary();
      },
      redo: async () => {
        await core.restore([{ kind: "folder", id: folderId }]);
        await get().refreshLibrary();
        if (going) done = await move(going, folderId);
      },
    });
  };

  /**
   * The Folder made last, until it is named: its first name is part of making
   * it, so that replaces its step and one Undo takes both back.
   */
  let justMade: { id: string; step: Undoable; stepNamed(name: string): Undoable } | null = null;

  /** A Mind renamed from `before`, with Undo, if its title changed. */
  const offerRename = (mind: Mind, before: string) => {
    if (before === mind.title) return;
    const rename = (name: string) => core.renameMind(mind.id, name);
    push(
      renamed((t) => mindName(mind) || t("mind.untitled"), rename, { before, after: mind.title }),
    );
  };

  /** Puts a Folder's fields back as given. */
  const folderFields = (id: string, group: LibraryGroupInput) => async () => {
    await core.updateLibraryGroup(id, group);
    await get().refreshLibrary();
  };

  /** Each Document's name, as the undo line says it. */
  const documentNames = (ids: readonly string[]) =>
    ids.map((id) => {
      const document = get().documents.find((each) => each.id === id);
      return document ? displayName(document) : "";
    });

  /** Puts a Tag on Documents, or takes it off, with Undo: their links go back as they were. */
  const retag = async (added: boolean, documentIds: readonly string[], tagId: string) => {
    const ids = [...documentIds];
    const before = tagLinks(get().documents, ids, tagId);
    const names = documentNames(ids);
    const again = () =>
      added ? core.addTagToDocuments(ids, tagId) : core.removeTagFromDocuments(ids, tagId);
    await again();
    const tag = get().tags.find((each) => each.id === tagId)?.name ?? "";
    const change = retagged({ added, tag, names }, before, again);
    push(change);
    return change;
  };

  /** Closes a tab, then says so with Reopen. */
  const closeTabWith = async (tab: LayoutTab) => {
    const returnFocus = returnFocusAfterTabClose(tab.id, get().layout);
    const next = await get().changeLayout({ type: "close", tabId: tab.id });
    if (next) {
      returnFocus(next);
      get().showTabNotice({ kind: "closed", item: tab.item, count: 1 });
    }
  };

  /**
   * Opens the link dialog on a folder: at once, then with what linking it
   * would take once that's counted (unless it already is).
   */
  const showLinking = async (folder: LinkingFolder) => {
    set({ linking: folder });
    if (folder.preview || folder.error) return;
    const { path } = folder;
    try {
      const preview = await core.previewLinkedFolder(path);
      if (get().linking?.path === path) set({ linking: { path, preview, error: null } });
    } catch (error) {
      if (get().linking?.path === path) {
        set({ linking: { path, preview: null, error: errorMessage(error, t) } });
      }
    }
  };

  /** Asks about folders to link, one at a time: now if the dialog is free, otherwise after the others. */
  const offerLinks = (folders: readonly LinkingFolder[]) => {
    const [first, ...rest] = get().linking ? [] : folders;
    set((state) => ({ linkQueue: [...state.linkQueue, ...(first ? rest : folders)] }));
    if (first) void showLinking(first);
  };

  /** The dialog is done with a folder: it asks about the next one, if any. */
  const nextLink = () => {
    const [next, ...rest] = get().linkQueue;
    set({ linking: null, linkQueue: rest });
    if (next) void showLinking(next);
  };

  /**
   * Adds files by path, as Documents: names those IncarnaMind has already,
   * and those it can't take, once (in the footer), and offers any that turn
   * out to be folders for linking.
   */
  const addByPath = async (
    paths: readonly string[],
    folders: readonly string[],
    notOnDisk: readonly string[],
  ) => {
    // Before adding: what status events bring meanwhile is new, not something added before.
    documentUpdates.flush();
    const known = new Set(get().documents.map((each) => each.id));
    const result =
      paths.length > 0
        ? await core.addDocuments([...paths])
        : { documents: [], skipped: [], added: [] };
    const linkable: LinkingFolder[] = folders.map((path) => ({ path, preview: null, error: null }));
    const skipped = [...notOnDisk];
    for (const { path } of result.skipped) {
      // A folder (the drop didn't say) can't be added, but can be linked: only a folder has a preview.
      const preview = await core.previewLinkedFolder(path).catch(() => null);
      if (preview) linkable.push({ path, preview, error: null });
      else skipped.push(fileName(path));
    }
    documentUpdates.flush();
    set((state) => {
      // Status events may already have brought newer copies of these; keep those.
      const listed = new Set(state.documents.map((each) => each.id));
      const added = new Map<string, Document>();
      for (const item of result.documents) {
        if (!listed.has(item.id)) added.set(item.id, item);
      }
      return {
        documents: [...[...added.values()].reverse(), ...state.documents],
        skippedFiles: skipped,
        alreadyAdded: [
          ...new Set(
            result.documents.filter((item) => known.has(item.id)).map((item) => item.name),
          ),
        ],
      };
    });
    offerLinks(linkable);
    if (result.added.length === 0) return;
    push(documentsAdded(result.added.length, () => removeOwn(result.added)));
  };

  /** Dropped or picked files' paths, and the names of those that aren't on disk. */
  const pathsOf = (picked: readonly File[]) => {
    const paths: string[] = [];
    const notOnDisk: string[] = [];
    for (const file of picked) {
      const path = files.pathForFile(file);
      if (path) paths.push(path);
      else notOnDisk.push(file.name);
    }
    return { paths, notOnDisk };
  };

  return {
    ...createLayoutSlice(set, get, (error) => useNotices.getState().showError(error)),
    status: { kind: "loading" },
    minds: [],
    bodyToFocus: null,
    pickingDocuments: false,
    settings: null,
    chatReadiness: null,
    documents: [],
    keptCitationTexts: [],
    skippedFiles: [],
    alreadyAdded: [],
    embeddingModel: null,
    embedding: null,
    rerank: null,
    settingsOpen: false,
    settingsPage: "general",
    settingsAt: null,
    folders: [],
    linkedFolders: [],
    linking: null,
    linkQueue: [],
    tags: [],
    tagFilter: [],
    tagsDialogOpen: false,
    library: null,
    libraryFilter: "all",
    refreshLibrary: async () => {
      const ticket = ++libraryRequest;
      const library = await core.getLibrary();
      if (ticket !== libraryRequest) return;
      // The assignments that came before the snapshot are in it already: it replaces them.
      documentUpdates.flush();
      set({
        library,
        ...(!["all", "unsorted", "starters", LIBRARY_DELETED].includes(get().libraryFilter) &&
        !library.groups.some((g) => g.id === get().libraryFilter)
          ? { libraryFilter: "all" }
          : {}),
      });
    },
    openHome: async (options) => {
      const { layout } = get();
      const group = layout ? focusedGroupOf(layout) : null;
      const shown = group?.tabs.find((tab) => tab.id === group.activeTabId);
      await get().changeLayout({
        type: "open",
        item: { kind: "home" },
        where: options?.side
          ? { in: "side" }
          : options?.first && group
            ? {
                in: "group",
                groupId: group.id,
                // Just before the tab that was in front, so closing Home shows it again.
                before:
                  shown && !shown.pinned ? shown.id : group.tabs.find((tab) => !tab.pinned)?.id,
              }
            : { in: "place" },
      });
    },
    openLibrary: (filter = "all", options) => {
      set({ libraryFilter: filter });
      void get().changeLayout({
        type: "open",
        item: { kind: "library" },
        where: options?.side ? { in: "side" } : { in: "place" },
        ...(options?.behind && { behind: true }),
      });
    },
    skills: [],
    examples: null,
    otherExamples: [],
    ownAnswerArrived: false,
    askedOwnAtLaunch: false,
    usageNotice: "auto",
    privacy: null,
    questionToStart: null,

    async load() {
      try {
        // A first run: the example Mind is made, once, and is what the app opens on.
        const offered = await core.offerExamples().catch(() => null);
        if (offered?.mindId) await startGettingStarted(offered.mindId);
        await get().loadLayout();
        const readAt = new Map<PushedList, number>();
        const [
          minds,
          settings,
          documents,
          chatReadiness,
          folders,
          embeddingModel,
          tags,
          skills,
          embedding,
          linkedFolders,
          keptCitationTexts,
          examples,
          otherExamples,
          connectors,
          rerank,
          privacy,
        ] = await Promise.all([
          readList("minds", core.listMinds(), readAt),
          readList("settings", core.getSettings(), readAt),
          core.listDocuments(),
          readList("chatReadiness", core.getChatReadiness(), readAt),
          readList("folders", core.listFolders(), readAt),
          readList("embeddingModel", core.getEmbeddingModel(), readAt),
          readList("tags", core.listTags(), readAt),
          readList("skills", core.listSkills(), readAt),
          readList("embedding", core.getEmbeddingSettings(), readAt),
          readList("linkedFolders", core.listLinkedFolders(), readAt),
          readList("keptCitationTexts", core.listKeptCitationTexts(), readAt),
          core.getExamples(),
          Promise.all(OTHER_EXAMPLE_GROUPS.map((group) => core.getExamples(group))),
          core.listConnectors(),
          readList("rerank", core.getRerankSettings(), readAt),
          readList("privacy", core.getPrivacySettings(), readAt),
        ]);
        const reloaded = windowLoadedBefore();
        // Minds made before this setting existed count as an earlier launch.
        const launchedBefore = settings.device.openedBefore || minds.length > 0;
        // Before the tabs are drawn, so the Mind left in front isn't drawn only to be covered.
        if (!offered?.mindId && launchedBefore && !reloaded) {
          await get().openHome({ first: true });
        }
        // What the core's events brought before this is in the lists just read.
        documentUpdates.flush();
        const read = {
          linkedFolders,
          minds,
          settings,
          keptCitationTexts,
          chatReadiness,
          folders,
          embeddingModel,
          tags,
          skills,
          embedding,
          rerank,
          privacy,
        } satisfies Pick<AppState, PushedList>;
        const fresh = Object.fromEntries(
          Object.entries(read).filter(([list]) => !pushedSince(list as PushedList, readAt)),
        ) as Partial<Pick<AppState, PushedList>>;
        set({
          ...fresh,
          documents,
          examples,
          otherExamples: otherExamples.filter(isMade),
          askedOwnAtLaunch: settings.device.gettingStarted.askedOwn,
          status: { kind: "ready" },
        });
        if (!settings.device.openedBefore) {
          void get().updateSettings({ device: { openedBefore: true } });
        }
        await get().refreshLibrary();
        tickIndexed(connectors.length);
      } catch (error) {
        set({ status: { kind: "failed", message: errorMessage(error, t) } });
      }
    },

    createMind: async (options) => {
      let made: string | null = null;
      await attempt(async () => {
        const { layout, minds } = get();
        const inFront = minds.find((each) => each.id === currentMindIdOf(layout));
        const folderId =
          options?.folderId === undefined
            ? filingFolder(options?.scope ?? null, inFront?.folderId ?? null)
            : options.folderId;
        const mind = await core.createMind({
          ...(options?.title && { title: options.title }),
          ...((options?.title || options?.titled) && { headed: true }),
          ...(folderId && { folderId }),
        });
        set(
          options?.startQuestion
            ? { questionToStart: { mindId: mind.id, scope: options.scope ?? null } }
            : { bodyToFocus: mind.id },
        );
        if (!(await get().showNewMind(mind, options?.groupId))) {
          // The core refused the tab: no editor comes to take the focus it was given.
          if (get().bodyToFocus === mind.id) get().bodyFocused();
          return;
        }
        made = mind.id;
        options?.made?.(mind.id);
      });
      return made;
    },

    showNewMind: async (mind, groupId) => {
      // The "minds.changed" event may have listed it already.
      set((state) => ({ minds: [mind, ...state.minds.filter((each) => each.id !== mind.id)] }));
      return (
        (await get().changeLayout({
          type: "open",
          item: { kind: "mind", mindId: mind.id },
          where: { in: "group", ...(groupId && { groupId }) },
        })) !== null
      );
    },

    bodyFocused: () => set({ bodyToFocus: null }),

    startQuestion() {
      const { layout, createMind } = get();
      const mindId = currentMindIdOf(layout);
      if (mindId) set({ questionToStart: { mindId, scope: null } });
      else void createMind({ startQuestion: true });
    },

    questionStarted: () => set({ questionToStart: null }),

    async askAbout({ scope }) {
      const { minds, layout } = get();
      const mindId = mindToAskIn({
        minds,
        openMindId: currentMindIdOf(layout),
        exampleMindIds: exampleMindIds(get()),
      });
      if (!mindId) {
        await get().createMind({ startQuestion: true, scope });
        return;
      }
      get().openMind(mindId);
      set({ questionToStart: { mindId, scope } });
    },

    // From a Folder as it is, the new Mind is the Folder's.
    startMindFrom: ({ kind, scope, title }) =>
      get().createMind({
        startQuestion: true,
        title,
        scope,
        folderId: kind === "folder" ? (scope.folderIds[0] ?? null) : null,
      }),

    moveToFolder: async (items, folderId) => {
      let change: Undoable | null = null;
      await attempt(async () => {
        const { minds, documents, library } = get();
        // Only what isn't there already: dropping a Mind back on its own Folder moves nothing.
        const folderOf = new Map(
          library?.assignments.map((each) => [each.documentId, each.groupId]),
        );
        const mindIds = itemsOf(items).mindIds.filter(
          (id) => minds.find((mind) => mind.id === id)?.folderId !== folderId,
        );
        const documentIds = itemsOf(items).documentIds.filter(
          (id) => (folderOf.get(id) ?? null) !== folderId,
        );
        if (mindIds.length + documentIds.length === 0) return;
        const moving = { mindIds, documentIds };
        const done = await move(moving, folderId);
        change = moveChange({
          moving,
          folderId,
          folderName: library?.groups.find((group) => group.id === folderId)?.name ?? "",
          named: namesOfMoving(moving, { minds, documents }),
          names: namesOfFolders(library, [folderId, ...foldersMovedFrom(done)]),
          done,
        });
        push(change);
      });
      return change;
    },

    createFolder: async (items, named) => {
      let madeId: string | null = null;
      await attempt(async () => {
        const { minds, documents, library } = get();
        const name =
          named?.trim() ||
          untitledFolderName(
            t,
            (library?.groups ?? []).map((group) => group.name),
          );
        const folder = await core.createLibraryGroup({ name, description: "" });
        await get().refreshLibrary();
        const chosen = items ? itemsOf(items) : null;
        const going =
          chosen && chosen.mindIds.length + chosen.documentIds.length > 0 ? chosen : null;
        const done = going ? await move(going, folder.id) : null;
        const stepNamed = folderMade({
          folderId: folder.id,
          going,
          named: namesOfMoving(going ?? {}, { minds, documents }),
          names: namesOfFolders(library, done ? foldersMovedFrom(done) : []),
          done,
        });
        const step = stepNamed(name);
        justMade = { id: folder.id, step, stepNamed };
        push(step);
        if (!named?.trim()) useRequests.getState().ask({ nameFolder: folder.id });
        madeId = folder.id;
      });
      return madeId;
    },

    nameNewFolder: (folderId, name) =>
      attempt(async () => {
        const folder = get().library?.groups.find((group) => group.id === folderId);
        const trimmed = name.trim();
        if (!folder || !trimmed || trimmed === folder.name) return;
        const made = justMade;
        if (made?.id !== folderId || useUndo.getState().done.at(-1) !== made.step) {
          await get().editFolder(folderId, { name: trimmed, description: folder.description });
          return;
        }
        await core.updateLibraryGroup(folderId, { name: trimmed, description: folder.description });
        await get().refreshLibrary();
        justMade = null;
        useUndo.getState().withdraw(made.step);
        push(made.stepNamed(trimmed));
      }),

    renameFolder: (folderId, name) =>
      attempt(async () => {
        const folder = get().library?.groups.find((group) => group.id === folderId);
        const trimmed = name.trim();
        if (!folder || !trimmed || trimmed === folder.name) return;
        await get().editFolder(folderId, { name: trimmed, description: folder.description });
      }),

    async editFolder(folderId, input) {
      const folder = get().library?.groups.find((group) => group.id === folderId);
      const edited = await core.updateLibraryGroup(folderId, input);
      await get().refreshLibrary();
      if (!folder) return;
      const fields = (group: LibraryGroup) => ({
        name: group.name,
        description: group.description,
        countsOwnFiles: group.countsOwnFiles,
      });
      const before = fields(folder);
      const after = fields(edited);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const rename = before.name !== after.name;
      push({
        said: (t) => t(rename ? "object.renamed" : "undo.folderEdited", { name: after.name }),
        name: (t) => t(rename ? "undo.name.rename" : "undo.name.editFolder"),
        undo: folderFields(folderId, before),
        redo: folderFields(folderId, after),
      });
    },

    // Its Minds' list follows the core's "minds.changed" event, the Library its "library.changed".
    deleteFolder: (folderId) =>
      attempt(async () => {
        const folder = get().library?.groups.find((group) => group.id === folderId);
        const remove = async () => {
          await core.deleteLibraryGroup(folderId);
          await get().refreshLibrary();
        };
        await remove();
        if (folder) push(deleted(folder.name, [{ kind: "folder", id: folderId }], remove));
      }),

    deleteSelection: (items) => {
      const ids = (kind: ObjectRef["kind"]) =>
        items.flatMap((each) => (each.kind === kind ? [each.id] : []));
      const count = items.length;
      // A Folder last: what was in it is put back into it once it is back.
      return asOneStep(
        {
          said: (t) => t("object.deleted.items", { count }),
          name: (t) => t("selection.delete", { count }),
        },
        async () => {
          for (const id of ids("mind")) await get().deleteMind(id);
          if (ids("document").length > 0) await get().deleteDocuments(ids("document"));
          for (const id of ids("folder")) await get().deleteFolder(id);
        },
      );
    },

    openExamples: () =>
      attempt(async () => {
        let { examples } = get();
        if (!examples?.mindId) {
          examples = await core.createExamples();
          set({ examples });
        }
        if (examples.mindId) get().openMind(examples.mindId);
      }),

    showExamples: () =>
      attempt(async () => {
        await get().openExamples();
        push({
          said: (t) => t("undo.examplesShown"),
          name: (t) => t("undo.name.showExamples"),
          undo: () => core.removeExamples(),
          redo: async () => {
            await core.restoreExamples();
          },
        });
      }),

    openExample: (group) =>
      attempt(async () => {
        const made = await core.createExamples(group);
        if (made.mindId) get().openMind(made.mindId);
        recordUsage({ event: "example_opened", fields: { group } });
      }),

    // The core closes each Mind's tab; its Documents go with their Linked folder.
    removeExamples: () =>
      attempt(async () => {
        // The earlier version's tea example is removed as the default one; Undo makes the credit paper.
        const groups = madeExamples(get()).map((each) =>
          each.group === "tea" ? undefined : each.group,
        );
        // The first open can't go on without its example: removing them ends it, Undo resumes it.
        const hidden = get().settings?.device.gettingStarted.hidden ?? false;
        const remove = async () => {
          for (const group of groups) await core.removeExamples(group);
          get().updateGettingStarted({ hidden: true });
        };
        await remove();
        push({
          said: (t) => t("undo.examplesRemoved"),
          name: (t) => t("undo.name.removeExamples"),
          undo: async () => {
            for (const group of groups) await core.restoreExamples(group);
            get().updateGettingStarted({ hidden });
          },
          redo: remove,
        });
      }),

    updateGettingStarted(patch) {
      const { settings } = get();
      const current = settings?.device.gettingStarted;
      if (!settings || !current?.started) return;
      const next = { ...current, ...patch };
      if (
        Object.entries(next).every(([key, value]) => current[key as keyof GettingStarted] === value)
      ) {
        return;
      }
      // At once, so ticks made together don't undo each other; the core's event confirms it.
      set({ settings: { ...settings, device: { ...settings.device, gettingStarted: next } } });
      core.updateSettings({ device: { gettingStarted: next } }).catch(() => undefined);
    },

    openMind(id, options) {
      void get().changeLayout({
        type: "open",
        item: { kind: "mind", mindId: id },
        where: options?.newTab || options?.behind ? { in: "group" } : { in: "place" },
        ...(options?.behind && { behind: true }),
      });
    },

    closeTab(tabId) {
      const tab = get()
        .layout?.groups.flatMap((group) => group.tabs)
        .find((each) => each.id === tabId);
      if (tab) void closeTabWith(tab);
    },

    reopenTab() {
      if (!get().layout?.reopenable) return;
      const line = useUndo.getState().line;
      if (line?.told?.action?.testId === "tab-notice-reopen") useUndo.getState().dismiss();
      void get().changeLayout({ type: "reopen" });
    },

    showTabNotice(notice) {
      const says: WordsInLine = (t) => {
        switch (notice.kind) {
          case "closed":
            return notice.count > 1
              ? t("tabs.notice.closedMany", { count: notice.count })
              : t("tabs.notice.closed", { title: tabTitle(get(), notice.item, t) });
          case "pinned":
            return t("tabs.notice.pinned", { title: tabTitle(get(), notice.item, t) });
          case "noGroup":
            return t("tabs.notice.noGroup", { n: notice.group, shortcut: notice.shortcut });
          case "maxGroups":
            return t("tabs.notice.maxGroups");
          case "merged":
            return t("tabs.notice.merged");
          case "assistantNarrow":
            return t("assistant.narrow");
        }
      };
      useUndo.getState().tell({
        says,
        ...(notice.kind === "closed" && {
          action: {
            label: (t) => t("tabs.notice.reopen"),
            shortcut: "tab.reopen",
            testId: "tab-notice-reopen",
            run: () => get().reopenTab(),
          },
        }),
      });
    },

    // The list follows the core's "minds.changed" event, which arrives before these calls return.
    renameMind: (id, title) =>
      attempt(async () => {
        const before = get().minds.find((mind) => mind.id === id)?.title;
        const mind = await core.renameMind(id, title);
        if (before !== undefined) offerRename(mind, before);
      }),

    deleteMind: (id) =>
      attempt(async () => {
        const mind = get().minds.find((each) => each.id === id);
        const remove = () => core.deleteMind(id);
        await remove();
        push(
          deleted(
            (t) => (mind && mindName(mind)) || t("mind.untitled"),
            [{ kind: "mind", id }],
            remove,
          ),
        );
      }),

    reportError(error) {
      useNotices.getState().showError(error);
    },

    openDocument(location, how = { as: "list" }) {
      const { documentId, ...place } = location;
      const item = { kind: "document", documentId } as const;
      const at = Object.keys(place).length > 0 ? { place } : {};
      // A merged window shows one group: what opens to the side comes to the front.
      const merged = groupsMerged();
      const keep = how.keep ? { keep: true } : {};
      const change: LayoutChange =
        how.as === "here"
          ? {
              type: "open",
              item,
              ...at,
              preview: false,
              where: { in: "group", ...(how.from && { groupId: how.from }) },
            }
          : how.as === "list"
            ? { type: "open", item, ...at, preview: true, where: { in: "beside" }, focus: merged }
            : {
                type: "open",
                item,
                ...at,
                ...keep,
                preview: !how.stay,
                where: { in: "side", ...(how.from && { from: how.from }) },
                focus: merged && !how.stay,
              };
      void get().changeLayout(change);
    },

    openSettings(page, at) {
      // Also a click handler: anything but a page name opens General.
      set({ settingsOpen: true, settingsPage: resolveSettingsPage(page), settingsAt: at ?? null });
    },

    showSettingsPage(page) {
      set({ settingsPage: resolveSettingsPage(page) });
    },

    closeSettings() {
      set({ settingsOpen: false, settingsAt: null });
    },

    updateSettings: (patch) =>
      attempt(async () => {
        set({ settings: await core.updateSettings(patch) });
      }),

    previewLayout(layout) {
      const { settings } = get();
      if (settings) set({ settings: { ...settings, device: { ...settings.device, ...layout } } });
    },

    addDocuments: (picked) =>
      attempt(async () => {
        const { paths, notOnDisk } = pathsOf(picked);
        await addByPath(paths, [], notOnDisk);
      }),

    addDropped: (dropped, folders) =>
      attempt(async () => {
        const folderPaths = pathsOf(folders).paths;
        const { paths, notOnDisk } = pathsOf(dropped);
        const filePaths = paths.filter((path) => !folderPaths.includes(path));
        await addByPath(filePaths, folderPaths, notOnDisk);
      }),

    addPaths: (paths) => attempt(() => addByPath(paths, [], [])),

    pickDocuments: () =>
      attempt(async () => {
        if (get().pickingDocuments) return;
        set({ pickingDocuments: true });
        try {
          const paths = await files.pickDocuments();
          if (paths.length > 0) await addByPath(paths, [], []);
        } finally {
          set({ pickingDocuments: false });
        }
      }),

    pickDocumentsOrFolder: () =>
      attempt(async () => {
        if (get().pickingDocuments) return;
        set({ pickingDocuments: true });
        try {
          const { files: paths, folders } = await files.pickDocumentsOrFolder();
          if (paths.length > 0 || folders.length > 0) await addByPath(paths, folders, []);
        } finally {
          set({ pickingDocuments: false });
        }
      }),

    async locateDocumentFile(id) {
      const paths = await files.pickDocuments();
      if (paths.length === 0) return "cancelled";
      const result = await core.addDocuments(paths);
      documentUpdates.flush();
      set((state) => ({
        documents: result.documents.reduce(upsert, state.documents),
      }));
      return result.documents.some((each) => each.id === id && each.fileStatus === "available")
        ? "located"
        : "other";
    },

    renameDocument: (id, name) =>
      attempt(async () => {
        const before = get().documents.find((each) => each.id === id)?.name;
        const rename = async (to: string) => {
          const document = await core.renameDocument(id, to);
          documentUpdates.flush();
          set((state) => ({ documents: upsert(state.documents, document) }));
          return document;
        };
        const document = await rename(name);
        if (before === undefined || before === document.name) return;
        push(renamed(displayName(document), rename, { before, after: document.name }));
      }),

    deleteDocuments: (ids) =>
      attempt(() =>
        makeInTurn(async () => {
          const before = get().documents;
          // A second ⌘⌫ waits for the first: what that one took is gone by now.
          const asked = new Set(ids);
          const live = before.filter((each) => asked.has(each.id)).map((each) => each.id);
          if (live.length === 0) return;
          const first = before.find((each) => each.id === live[0]);
          const gone = new Set(live);
          const removed = before.filter((each) => gone.has(each.id));
          const at = new Map(before.map((each, index) => [each.id, index]));
          const placeOf = (document: Document) => at.get(document.id) ?? before.length;
          const takeOut = () =>
            set((state) => ({ documents: state.documents.filter((each) => !gone.has(each.id)) }));
          const putBack = () =>
            set((state) => {
              const here = new Set(state.documents.map((each) => each.id));
              const back = [...state.documents, ...removed.filter((each) => !here.has(each.id))];
              return { documents: back.sort((a, b) => placeOf(a) - placeOf(b)) };
            });
          const work = async () => {
            await core.deleteDocuments(live);
            documentUpdates.flush();
            takeOut();
          };
          const remove = () =>
            live.length > 1
              ? sayWhileSlow(
                  (t) =>
                    t("object.deleting.documents", {
                      count: formatCount(live.length, languageNow()),
                    }),
                  work,
                )
              : work();
          await remove();
          const shown = first ? displayName(first) : "";
          push(
            deleted(
              shown,
              live.map((id) => ({ kind: "document", id })),
              remove,
              { putBack, takeOut },
            ),
          );
        }),
      ),

    // Its status follows the core's "document.status" event too.
    retryDocument: (id) =>
      attempt(async () => {
        const retried = await core.retryDocument(id);
        documentUpdates.flush();
        set((state) => ({ documents: upsert(state.documents, retried) }));
      }),

    dismissSkippedFiles() {
      set({ skippedFiles: [] });
    },

    dismissAlreadyAdded() {
      set({ alreadyAdded: [] });
    },

    downloadEmbeddingModel: () =>
      attempt(async () => {
        set({ embeddingModel: await core.downloadEmbeddingModel() });
      }),

    downloadRerankingModel: () =>
      attempt(async () => {
        set({ rerank: await core.downloadRerankingModel() });
      }),

    retryEmbedding: () =>
      attempt(async () => {
        set({ embedding: await core.retryEmbedding() });
      }),

    addLinkedFolder: () =>
      attempt(async () => {
        const path = await files.pickLinkedFolder();
        // The dialog opens at once; a big folder takes a moment to count.
        if (path) offerLinks([{ path, preview: null, error: null }]);
      }),

    // Its Documents, Folders and progress arrive with the core's events.
    confirmLinkedFolder: (layout) =>
      attempt(async () => {
        const preview = get().linking?.preview;
        nextLink();
        if (!preview) return;
        // Inside a Linked folder already: nothing is linked, so its layout stays as the User set it.
        if (preview.insideLinkedFolderId !== null) {
          await core.addLinkedFolder(preview.path);
          useRequests.getState().ask({ showLinked: preview.insideLinkedFolderId });
          return;
        }
        const link: LinkStep = {
          linkedFolderId: "",
          path: preview.path,
          before: { documentIds: [], linkedFolders: [] },
        };
        let linked: Promise<boolean> = Promise.resolve(false);
        const step = folderLinked(
          () => linkedFolderName(link.path),
          async () => {
            if (!(await linked)) {
              throw new UndoRefused((t) => t("error.linkedFolder.notFound"), null);
            }
            await unlinkStep(link);
          },
          async () => {
            link.before = await libraryBefore(link.path);
            const again = await core.addLinkedFolder(link.path);
            link.linkedFolderId = again.id;
            showLinked(await core.setLinkedFolderLayout(again.id, layout));
            useRequests.getState().ask({ showLinked: again.id });
          },
        );
        // Its line shows at once, within 100 ms of the click, whatever the folder holds; its Undo waits for the link.
        linkSteps.set(step, link);
        push(step);
        const linking = (async () => {
          link.before = await libraryBefore(preview.path);
          const added = await core.addLinkedFolder(preview.path);
          link.linkedFolderId = added.id;
          useRequests.getState().ask({ showLinked: added.id });
          // Set now, before its first scan ends, so the scan's own suggestion doesn't replace it.
          showLinked(await core.setLinkedFolderLayout(added.id, layout));
        })();
        linked = linking.then(
          () => true,
          () => false,
        );
        try {
          await linking;
        } catch (error) {
          linkSteps.delete(step);
          useUndo.getState().withdraw(step);
          throw error;
        }
      }),

    // The dialog's own close (Esc, or after linking) calls this too: only a folder still asked about counts.
    cancelLinkedFolder() {
      if (get().linking) nextLink();
    },

    setLinkedFolderPaused: async (linkedFolderId, paused) => {
      let change: Undoable | undefined;
      await attempt(async () => {
        const before = get().linkedFolders.find((each) => each.id === linkedFolderId);
        const setPaused = async (to: boolean) => {
          showLinked(await core.setLinkedFolderPaused(linkedFolderId, to));
        };
        await setPaused(paused);
        if (before && (before.status === "paused") !== paused) {
          change = linkedFolderPaused(linkedFolderName(before.path), paused, setPaused);
          push(change);
        }
      });
      return change;
    },

    downloadOnlineOnlyFiles: (linkedFolderId) =>
      attempt(async () => {
        const linked = await core.downloadOnlineOnlyFiles(linkedFolderId);
        set((state) => ({ linkedFolders: replaceLinked(state.linkedFolders, linked) }));
      }),

    showLinkedFolder: (linkedFolderId) =>
      attempt(async () => {
        await files.showLinkedFolder(linkedFolderId);
      }),

    // Its Documents follow the core's events, as its scan finds them there.
    locateLinkedFolder: (linkedFolderId) =>
      attempt(async () => {
        const path = await files.pickLinkedFolder(linkedFolderId);
        if (!path) return;
        const was = get().linkedFolders.find((each) => each.id === linkedFolderId)?.path;
        const linked = await core.locateLinkedFolder(linkedFolderId, path);
        set((state) => ({ linkedFolders: replaceLinked(state.linkedFolders, linked) }));
        if (was !== undefined && was !== linked.path) {
          moveLinkSteps(was, linked.path);
          // The Edit menu and the undo line name a link's step by its folder's name now.
          useUndo.setState({});
        }
      }),

    // The list, its Folders and Documents follow the core's events.
    removeLinkedFolder: (linkedFolderId) =>
      attempt(async () => {
        await core.removeLinkedFolder(linkedFolderId);
        withdrawLinkSteps(linkedFolderId);
      }),

    toggleTagFilter(tagId) {
      const current = get().tagFilter;
      set({
        tagFilter: current.includes(tagId)
          ? current.filter((each) => each !== tagId)
          : [...current, tagId],
      });
    },

    setTagFilter(tagIds) {
      set({ tagFilter: [...new Set(tagIds)] });
    },

    // The Documents follow the core's "documents.tagged" event, which arrives before these calls return.
    addDocumentTag: (documentId, tagId) => attempt(() => retag(true, [documentId], tagId)),

    removeDocumentTag: (documentId, tagId) => attempt(() => retag(false, [documentId], tagId)),

    addTagToDocuments: async (documentIds, tagId) => {
      let change: Undoable | null = null;
      await attempt(async () => {
        change = await retag(true, documentIds, tagId);
      });
      return change;
    },

    removeTagFromDocuments: (documentIds, tagId) => attempt(() => retag(false, documentIds, tagId)),

    async createTag(name, description = "") {
      const tag = await core.createTag({ name, description });
      // The list follows "tags.changed"; this makes the new Tag usable at once.
      set((state) => ({
        tags: state.tags.some((each) => each.id === tag.id)
          ? state.tags
          : [...state.tags, tag].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
            ),
      }));
      return tag;
    },

    retagDocuments: (documentIds) =>
      attempt(async () => {
        await core.retagDocuments(documentIds);
      }),

    openTagsDialog() {
      set({ tagsDialogOpen: true });
    },

    closeTagsDialog() {
      set({ tagsDialogOpen: false });
    },

    // The list follows the core's "skills.changed" event, which arrives before these calls return.
    setSkillEnabled: (skillId, enabled) =>
      attempt(async () => {
        await core.setSkillEnabled(skillId, enabled);
      }),

    removeSkill: (skillId) =>
      attempt(async () => {
        await core.removeSkill(skillId);
      }),

    duplicateSkill: (skillId) =>
      attempt(async () => {
        await core.duplicateSkill(skillId);
      }),

    restoreBuiltInSkills: () =>
      attempt(async () => {
        await core.restoreBuiltInSkills();
      }),
  };
});

/**
 * The checklist starts with the example Mind on a first run, which opens as
 * the only tab, before the store has loaded the settings.
 */
async function startGettingStarted(exampleMindId: string): Promise<void> {
  try {
    const { device } = await core.getSettings();
    await core.updateSettings({
      device: { gettingStarted: { ...device.gettingStarted, started: true } },
    });
    await core.changeLayout(WINDOW_ID, {
      type: "open",
      item: { kind: "mind", mindId: exampleMindId },
    });
  } catch {
    // Then the app opens as usual, without the checklist.
  }
}

/** A Document of the User's own: not one of the examples. */
export const isOwnDocument = (document: Document, examples: readonly Examples[]) =>
  document.linkedFolderId === null ||
  !examples.some((each) => each.linkedFolderId === document.linkedFolderId);

/** The example a first run makes, shown first; the earlier version's tea example stands in for it. */
const FIRST_RUN_EXAMPLE: ExampleGroup = "credit";
const withExamples =
  (examples: Examples) =>
  (state: Pick<AppState, "otherExamples">): Partial<AppState> =>
    examples.group === FIRST_RUN_EXAMPLE || examples.group === "tea"
      ? { examples }
      : {
          otherExamples: [
            ...state.otherExamples.filter((each) => each.group !== examples.group),
            ...(isMade(examples) ? [examples] : []),
          ],
        };

const OTHER_EXAMPLE_GROUPS = EXAMPLE_GROUPS.filter((group) => group !== FIRST_RUN_EXAMPLE);
const isMade = (examples: Examples) => examples.mindId !== null || examples.linkedFolderId !== null;

export const allExamples = (state: Pick<AppState, "examples" | "otherExamples">): Examples[] =>
  [state.examples, ...state.otherExamples].filter((each) => each !== null);

const madeExamples = (state: Pick<AppState, "examples" | "otherExamples">): Examples[] =>
  allExamples(state).filter(isMade);

export const exampleMindIds = (state: Pick<AppState, "examples" | "otherExamples">): string[] =>
  allExamples(state).flatMap((each) => (each.mindId ? [each.mindId] : []));

const readOwnDocument = (document: Document, state: AppState) =>
  isSearchable(document.status) && isOwnDocument(document, allExamples(state));

/** Ticks "Add your Documents" once a Document of the User's own has been read, or there are Connectors. */
function tickIndexed(connectors: number): void {
  const state = useAppStore.getState();
  const { documents, updateGettingStarted } = state;
  if (connectors > 0 || documents.some((each) => readOwnDocument(each, state)))
    updateGettingStarted({ indexed: true });
}

// Settings can change outside this window (another window, or the core itself), so follow the core's event.
core.on("settings.changed", (settings) => {
  pushed("settings");
  useAppStore.setState({ settings });
});

// The same for the list of Minds: created, renamed, deleted, or reordered by an edit.
// A deleted Mind's tab closes in the core, which says so with "layout.changed".
core.on("minds.changed", (minds) => {
  pushed("minds");
  const state = useAppStore.getState();
  useAppStore.setState({ minds });
  // An example Mind deleted like any other: no longer an example.
  for (const examples of allExamples(state)) {
    if (examples.mindId && !minds.some((mind) => mind.id === examples.mindId)) {
      core.getExamples(examples.group === "tea" ? undefined : examples.group).then(
        (current) => useAppStore.setState(withExamples(current)),
        () => undefined,
      );
    }
  }
});

followLayout(
  (partial) => useAppStore.setState(partial),
  (error) => useNotices.getState().showError(error),
);

// Processing happens in the background: follow each Document's status as the core reports it.
core.on("document.status", (changed) => {
  documentUpdates.upsert([changed]);
  const state = useAppStore.getState();
  if (readOwnDocument(changed, state)) state.updateGettingStarted({ indexed: true });
});

// The examples made, opened again or removed: their Mind and Linked folder show "Example".
core.on("examples.changed", (examples) => useAppStore.setState(withExamples(examples)));

// Privacy choices change on the Privacy page, in the usage data card, or with local mode.
core.on("privacy.changed", (privacy) => {
  pushed("privacy");
  useAppStore.setState({ privacy });
});

/**
 * Usage data from the interface (see src/core/usageEvents.ts): the core
 * sends it only while the User agrees, and drops it otherwise.
 */
export function recordUsage(event: UiUsageEvent): void {
  core.recordUsage(event).catch((error: unknown) => console.error(error));
}

core.on("connectors.changed", (connectors) => tickIndexed(connectors.length));

// An Answer to a Question of the User's own: anything but the example Answer, written again.
// Only one that arrives: not one refused or failed (#766).
core.on("answer.finished", ({ answerId, status }) => {
  const state = useAppStore.getState();
  if (status === "done" && !allExamples(state).some((each) => each.answerId === answerId)) {
    state.updateGettingStarted({ askedOwn: true });
    useAppStore.setState({ ownAnswerArrived: true });
  }
});

core.on("chatReadiness.changed", (chatReadiness) => {
  pushed("chatReadiness");
  useAppStore.setState({ chatReadiness });
});

// An outside agent asked to show one of its Citations (#351): it opens beside the Mind, at its quote.
core.on("agents.citationShown", (place) => {
  const state = useAppStore.getState();
  if (state.settingsOpen) state.closeSettings();
  state.openDocument(place, { as: "list" });
});

// The embedding model downloads in the background: follow its state and progress.
core.on("embeddingModel.status", (embeddingModel) => {
  pushed("embeddingModel");
  useAppStore.setState({ embeddingModel });
});

// The embedding model can change in Settings or by local mode, and a rebuild reports its progress.
core.on("embedding.changed", (embedding) => {
  pushed("embedding");
  useAppStore.setState({ embedding });
});

// Reranking changes in Settings, and the built-in reranking model downloads in the background.
core.on("rerank.changed", (rerank) => {
  pushed("rerank");
  useAppStore.setState({ rerank });
});

// Folders change through this window or another: follow the list. The sidebar's tree follows it.
core.on("folders.changed", (folders) => {
  pushed("folders");
  useAppStore.setState({ folders });
});

// Linked folders added, removed, or scanning, paused, out of reach, or making progress.
core.on("linkedFolders.changed", (linkedFolders) => {
  pushed("linkedFolders");
  useAppStore.setState({ linkedFolders });
});

// A Linked folder was unlinked: the text its Citations quote is kept, so they can still be checked.
core.on("keptCitationTexts.changed", (keptCitationTexts) => {
  pushed("keptCitationTexts");
  useAppStore.setState({ keptCitationTexts });
});

// Documents removed from the index, e.g. with their Linked folder.
core.on("documents.removed", (removed) => documentUpdates.remove(removed));

// Documents whose files moved to another Folder on disk.
core.on("documents.moved", (moved) => documentUpdates.upsert(moved));

// Renamed here, in another window or by the assistant.
core.on("documents.renamed", (renamed) => documentUpdates.upsert(renamed));

// Tags change through this window or another: follow the list, and drop a deleted Tag from the filter.
core.on("tags.changed", (tags) => {
  pushed("tags");
  const { tagFilter } = useAppStore.getState();
  const kept = tagFilter.filter(
    (value) => value === NEEDS_REVIEW || tags.some((tag) => tag.id === value),
  );
  useAppStore.setState({ tags, ...(kept.length !== tagFilter.length && { tagFilter: kept }) });
});

// Skills are imported, turned on or off, or removed, through this window or another.
core.on("skills.changed", (skills) => {
  pushed("skills");
  useAppStore.setState({ skills });
});

// Documents' Tags, or their tagging, changed: by the User, by automatic tagging, or with a deleted Tag.
core.on("documents.tagged", (tagged) => documentUpdates.upsert(tagged));

// Documents' reference records changed: the User edited one, put one back, or Look up filled one.
core.on("references.changed", (changed) => documentUpdates.upsert(changed));

// Organize queued, started, finished or failed on Documents, or the User put one in a Folder.
core.on("library.assignments", (assignments) => documentUpdates.assign(assignments));

// The Folders or the settings changed: read the Library again.
core.on("library.changed", () => {
  void useAppStore
    .getState()
    .refreshLibrary()
    .catch((error) => useAppStore.getState().reportError(error));
});
