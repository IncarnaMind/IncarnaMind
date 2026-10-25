import type { LibrarySnapshot } from "../../core/api";
import type { CommandId } from "../../shared/commands";
import { displayName } from "../../shared/documentNames";
import { mindName } from "../../shared/naming";
import { commands } from "./commands/registry";
import {
  ConversationLineIcon,
  DocumentLineIcon,
  FolderLineIcon,
  MindLineIcon,
} from "./components/lineIcons";
import { TagDot } from "./components/TagColour";
import { conversationLabel, openConversation, useConversations } from "./conversations";
import { nameWithPlace, placesOf } from "./documentPlaces";
import { KIND_LABELS } from "./fileInfo";
import { type FoundObject, findable } from "./finding";
import { folderCounts } from "./libraryPage";
import type { ObjectRef, Translate } from "./objects";
import { useAppStore } from "./store";

type AppState = ReturnType<typeof useAppStore.getState>;

const store = () => useAppStore.getState();

const openWith = (id: CommandId, ref: ObjectRef) =>
  commands.run(id, { selection: [], focus: ref, surface: "palette" });

/** Calls `changed` when what `pick` reads of the store changes. */
const onStore =
  (...pick: ((state: AppState) => unknown)[]) =>
  (changed: () => void) =>
    useAppStore.subscribe((state, before) => {
      if (pick.some((read) => read(state) !== read(before))) changed();
    });

const folderNames = (library: LibrarySnapshot | null) =>
  new Map(library?.groups.map((folder) => [folder.id, folder.name]));

const withFolder = (kind: string, folder: string | undefined) =>
  folder ? `${kind} · ${folder}` : kind;

const count = (t: Translate, n: number, one: "library.count.one", many: "library.count") =>
  t(n === 1 ? one : many, { count: n });

findable.register({
  kind: "mind",
  group: { id: "minds", title: "palette.group.minds" },
  objects(t) {
    const { minds, library } = store();
    const folders = folderNames(library);
    return minds.map(
      (mind): FoundObject => ({
        ref: { kind: "mind", id: mind.id },
        name: mindName(mind) || t("mind.untitled"),
        meta: withFolder(
          t("palette.kind.mind"),
          mind.folderId ? folders.get(mind.folderId) : undefined,
        ),
        icon: (className) => <MindLineIcon className={className} />,
      }),
    );
  },
  subscribe: onStore(
    (state) => state.minds,
    (state) => state.library,
  ),
  open: (ref) => openWith("mind.open", ref),
});

findable.register({
  kind: "conversation",
  group: { id: "conversations", title: "palette.group.conversations" },
  objects(t) {
    const folders = folderNames(store().library);
    return useConversations.getState().list.map(
      (conversation): FoundObject => ({
        ref: { kind: "conversation", id: conversation.id },
        name: conversationLabel(conversation),
        meta: withFolder(
          t("palette.kind.conversation"),
          conversation.folderId ? folders.get(conversation.folderId) : undefined,
        ),
        icon: (className) => <ConversationLineIcon className={className} />,
      }),
    );
  },
  subscribe(changed) {
    const stopList = useConversations.subscribe((state, before) => {
      if (state.list !== before.list) changed();
    });
    const stopFolders = onStore((state) => state.library)(changed);
    return () => {
      stopList();
      stopFolders();
    };
  },
  open: (ref) => openConversation(ref.id),
});

findable.register({
  kind: "document",
  group: { id: "documents", title: "palette.group.documents" },
  objects(t) {
    const { documents, library, linkedFolders } = store();
    const folders = folderNames(library);
    const folderOf = new Map(library?.assignments.map((each) => [each.documentId, each.groupId]));
    const places = placesOf(documents, linkedFolders);
    return documents.map((document): FoundObject => {
      const groupId = folderOf.get(document.id);
      return {
        ref: { kind: "document", id: document.id },
        name: nameWithPlace(displayName(document), places.get(document.id) ?? null),
        meta: withFolder(t(KIND_LABELS[document.kind]), groupId ? folders.get(groupId) : undefined),
        icon: (className) => <DocumentLineIcon kind={document.kind} className={className} />,
      };
    });
  },
  subscribe: onStore(
    (state) => state.documents,
    (state) => state.library,
    (state) => state.linkedFolders,
  ),
  open: (ref, { inTab }) => openWith(inTab ? "document.openTab" : "document.open", ref),
});

findable.register({
  kind: "folder",
  group: { id: "foldersAndTags", title: "palette.group.foldersAndTags" },
  objects(t) {
    const { library, documents } = store();
    const inFolder = folderCounts(library?.groups ?? [], documents, library?.assignments ?? []);
    return (library?.groups ?? []).map(
      (folder): FoundObject => ({
        ref: { kind: "folder", id: folder.id },
        name: folder.name,
        meta: `${t("palette.kind.folder")} · ${count(t, inFolder.get(folder.id) ?? 0, "library.count.one", "library.count")}`,
        icon: (className) => <FolderLineIcon className={className} />,
      }),
    );
  },
  subscribe: onStore(
    (state) => state.library,
    (state) => state.documents,
  ),
  open: (ref) => openWith("folder.open", ref),
});

findable.register({
  kind: "tag",
  group: { id: "foldersAndTags", title: "palette.group.foldersAndTags" },
  objects(t) {
    const { tags, documents } = store();
    const tagged = new Map<string, number>();
    for (const document of documents) {
      for (const link of document.tags) tagged.set(link.tagId, (tagged.get(link.tagId) ?? 0) + 1);
    }
    return tags.map((tag): FoundObject => {
      const n = tagged.get(tag.id) ?? 0;
      return {
        ref: { kind: "tag", id: tag.id },
        name: tag.name,
        meta: `${t("palette.kind.tag")} · ${t(n === 1 ? "palette.tag.count.one" : "palette.tag.count", { count: n })}`,
        icon: (className) => (
          <span aria-hidden="true" className={`flex items-center justify-center ${className}`}>
            <TagDot colour={tag.colour} />
          </span>
        ),
      };
    });
  },
  subscribe: onStore(
    (state) => state.tags,
    (state) => state.documents,
  ),
  open: (ref) => openWith("tag.open", ref),
});
