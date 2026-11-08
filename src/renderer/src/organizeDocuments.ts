import { create } from "zustand";
import type { OrganizeStart } from "../../core/api";
import { core } from "./core";
import { organize, organizeEach } from "./organizeReview";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";

/** The User's own Documents in no Folder: what the Library's Organize sorts. */
export function looseDocumentIds(
  state: Pick<AppState, "documents" | "library" | "examples" | "otherExamples">,
): string[] {
  const filed = new Set(
    (state.library?.assignments ?? [])
      .filter((item) => item.groupId !== null)
      .map((item) => item.documentId),
  );
  const examples = allExamples(state);
  return state.documents
    .filter((each) => !filed.has(each.id) && isOwnDocument(each, examples))
    .map((each) => each.id);
}

/** What an Organize was asked for: these Documents, those in no Folder (null), or a Folder's. */
export type OrganizeTarget = { ids: readonly string[] | null } | { folderId: string };

export type OrganizeNeeds = Extract<OrganizeStart, { ready: false }>;

/**
 * The Organize waiting for the User at the Library's top (#1569): no model, or the first time a
 * cloud service would read the Documents, which its card asks about.
 */
export const useOrganizeAsk = create<{
  asked: { target: OrganizeTarget; needs: OrganizeNeeds } | null;
  ask(target: OrganizeTarget, needs: OrganizeNeeds): void;
  close(): void;
}>()((set) => ({
  asked: null,
  ask: (target, needs) => set({ asked: { target, needs } }),
  close: () => set({ asked: null }),
}));

/**
 * Runs Organize on a model of this kind: planned as a whole into the Review, where nothing moves
 * before the User confirms it. A model that can only choose among Folders (a decision model)
 * sorts each into the Folders there are, and with none the starter Folders open instead.
 * `forService`: the service a press was authorized for; Organize sends nowhere else. `once`:
 * allowed for this run alone, under the User's earlier no.
 */
async function run(
  target: OrganizeTarget,
  model: Extract<OrganizeStart, { ready: true }>["model"],
  options: { forService?: string; once?: boolean },
): Promise<void> {
  const app = useAppStore.getState();
  const library = app.library;
  if (!library) return;
  const sent = {
    ...(options.forService !== undefined && { forService: options.forService }),
    ...(options.once === true && { once: true }),
  };
  if ("folderId" in target) {
    if (model === "chat") {
      await organize({ folderId: target.folderId, ...sent });
      return;
    }
    const inside = library.assignments
      .filter((item) => item.groupId === target.folderId)
      .map((item) => item.documentId);
    await organizeEach(inside, target.folderId, sent);
    return;
  }
  if (model === "chat") {
    await organize({ ...(target.ids && { documentIds: [...target.ids] }), ...sent });
    return;
  }
  if (library.groups.length === 0) app.openLibrary("starters");
  else await organizeEach(target.ids ?? looseDocumentIds(app), null, sent);
}

/**
 * Organize, from the Library, ⌘K, a Folder's menu, the footer's Allow or a fix (#2308, #1569). It
 * runs at once when nothing needs asking; otherwise the Library's top asks first: for a model
 * when there is none, or, the first time a cloud service would read the Documents, the card that
 * says what goes there.
 */
export async function organizeTarget(
  target: OrganizeTarget,
  options: { forService?: string } = {},
): Promise<void> {
  const needs = await core.startOrganize();
  const app = useAppStore.getState();
  if (!needs.ready) {
    app.openLibrary();
    useOrganizeAsk.getState().ask(target, needs);
    return;
  }
  useOrganizeAsk.getState().close();
  // The model it just kept shows in the Library's settings before the run reads them.
  await app.refreshLibrary();
  await run(target, needs.model, options);
}

/** Organize these Documents, or (null) the Library's Documents in no Folder. */
export function organizeDocuments(
  ids: readonly string[] | null,
  options: { forService?: string } = {},
): Promise<void> {
  return organizeTarget({ ids }, options);
}

/** Organize This Folder: its own Documents, into subfolders inside it; nothing moves out of it. */
export function organizeFolder(folderId: string): Promise<void> {
  useAppStore.getState().openLibrary();
  return organizeTarget({ folderId });
}

/**
 * The card's "Allow and organize": the consent for the service it named (ADR-0022), then the
 * run. Under the User's earlier no it keeps nothing, and the run alone goes.
 */
export async function allowAndOrganize(): Promise<void> {
  const { asked } = useOrganizeAsk.getState();
  if (!asked || asked.needs.needs !== "consent") return;
  const { target, needs } = asked;
  useOrganizeAsk.getState().close();
  const forService = needs.service.id;
  if (needs.declined) {
    await run(target, needs.model, { forService, once: true });
    return;
  }
  const now = await core.allowOrganize(forService);
  if (!now.ready) {
    useOrganizeAsk.getState().ask(target, now);
    return;
  }
  await useAppStore.getState().refreshLibrary();
  await run(target, now.model, { forService });
}
