import { create } from "zustand";
import {
  type AddFoundSourceResult,
  type FindSourcesResult,
  type FoundSource,
  SOURCE_KIND_PROVIDERS,
  type SourceProviderInfo,
} from "../../core/api";
import { core } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { useAppStore } from "./store";

/** A work being added, or how adding it went, with the Folder it went to (null: Not in a Folder). */
export type AddState =
  | { status: "adding" }
  | { status: "done"; result: AddFoundSourceResult; folderId: string | null }
  | { status: "failed"; message: string };

/** What a search is for, as the panel's fields hold it. */
export interface SourceSearch {
  query: string;
  fromYear: number | null;
  toYear: number | null;
  openAccessOnly: boolean;
}

interface FindSourcesState extends SourceSearch {
  /** The panel shows in the Library. */
  open: boolean;
  /** The providers that search, with the User's consent decisions; empty until first opened. */
  providers: SourceProviderInfo[];
  /** Providers turned off for searches here, by id: by the User, and at first those searched only when chosen. */
  off: string[];
  /** The providers an Answer's search used, until the list of providers is here; null for the default ones. */
  focus: readonly string[] | null;
  /** Where added works go: a Folder, or null for Not in a Folder. */
  folderId: string | null;
  searching: boolean;
  /** The last search's results; null before any. */
  result: FindSourcesResult | null;
  /** What went wrong with the last search, in words. */
  error: string | null;
  /** Each work added this time, by key. */
  adds: Record<string, AddState>;
  /** The provider whose key field is open, by id. */
  keyOpen: string | null;
  openKey(providerId: string | null): void;
  /**
   * Opens Find sources in the Library, adding to the Folder shown there; with
   * a search (an Answer's), fills it in and runs it.
   */
  show(search?: Partial<SourceSearch> & { providers?: readonly string[] }): void;
  close(): void;
  edit(change: Partial<SourceSearch & { folderId: string | null }>): void;
  toggleProvider(id: string): void;
  search(): Promise<void>;
  add(work: FoundSource): Promise<void>;
  /** Keeps (or with null removes) the User's own key for a provider; the problem in words, or null. */
  setKey(providerId: string, key: string | null): Promise<string | null>;
}

/** Counts searches, so only the latest one's answer is shown. */
let searchTicket = 0;

/** The providers the last search couldn't ask for want of the User's key, or whose key they refused. */
function keyProblems(result: FindSourcesResult | null): string[] {
  if (result?.outcome !== "found") return [];
  return result.providers
    .filter(
      (each) => each.failure?.reason === "needs-key" || each.failure?.reason === "key-rejected",
    )
    .map((each) => each.id);
}

/**
 * The providers whose key line shows under the search: one that searches and
 * is chosen; one that only looks citations up (GovInfo) when a provider of its
 * kind is chosen (the eCFR), when the last search asked for its key, or while
 * its field is open.
 */
export function keyLines(
  providers: readonly SourceProviderInfo[],
  off: readonly string[],
  keyOpen: string | null,
  result: FindSourcesResult | null,
): SourceProviderInfo[] {
  const wanted = keyProblems(result);
  const chosen = (id: string) =>
    !off.includes(id) && providers.some((each) => each.id === id && each.searches);
  return providers.filter((each) => {
    if (each.key === "none") return false;
    if (each.searches) return !off.includes(each.id);
    const peers = Object.values(SOURCE_KIND_PROVIDERS)
      .filter((ids) => ids.includes(each.id))
      .flat();
    return keyOpen === each.id || wanted.includes(each.id) || peers.some(chosen);
  });
}

/** The Folder the Library shows, if it shows one: where Find sources adds by default. */
function shownFolder(): string | null {
  const { libraryFilter, library } = useAppStore.getState();
  return library?.groups.some((group) => group.id === libraryFilter) ? libraryFilter : null;
}

export const useFindSources = create<FindSourcesState>()((set, get) => ({
  open: false,
  query: "",
  fromYear: null,
  toYear: null,
  openAccessOnly: false,
  providers: [],
  off: [],
  focus: null,
  folderId: null,
  searching: false,
  result: null,
  error: null,
  adds: {},
  keyOpen: null,

  openKey(providerId) {
    set({ keyOpen: providerId });
  },

  show(search) {
    const app = useAppStore.getState();
    const folderId = get().open ? get().folderId : shownFolder();
    const { providers: used, ...fields } = search ?? {};
    const focus = used ?? null;
    set({ open: true, folderId, focus, ...fields });
    // The Library, as a tab, as it was: the User's Mind stays where it is.
    app.openLibrary(app.libraryFilter);
    // Drug labels and trials start off: they are asked only when chosen, never with a search for papers.
    const startOff = (providers: SourceProviderInfo[]) =>
      providers
        .filter((each) => (focus ? !focus.includes(each.id) : !each.searchedByDefault))
        .map((each) => each.id);
    if (focus && get().providers.length > 0) set({ off: startOff(get().providers) });
    core.listSourceProviders().then(
      (providers) =>
        set((state) => ({
          providers,
          off: state.providers.length === 0 || focus ? startOff(providers) : state.off,
        })),
      (error: unknown) => app.reportError(error),
    );
    if (search?.query) void get().search();
  },

  close() {
    set({ open: false });
  },

  edit(change) {
    set(change);
  },

  toggleProvider(id) {
    const { off } = get();
    set({ off: off.includes(id) ? off.filter((each) => each !== id) : [...off, id] });
  },

  async search() {
    const { query, fromYear, toYear, openAccessOnly, providers, off, focus } = get();
    if (query.trim() === "") return;
    const ticket = ++searchTicket;
    set({ searching: true, error: null });
    try {
      const searching = providers.filter((each) => each.searches).map((each) => each.id);
      const result = await core.findSources({
        query,
        fromYear,
        toYear,
        openAccessOnly,
        ...(providers.length > 0
          ? { providers: searching.filter((id) => !off.includes(id)) }
          : focus && { providers: [...focus] }),
      });
      // A search started since has the last word.
      if (ticket === searchTicket) set({ result, adds: {} });
    } catch (error) {
      // The last search's results aren't this one's: they go with it.
      if (ticket === searchTicket)
        set({ error: errorMessage(error, translateNow), result: null, adds: {} });
    } finally {
      if (ticket === searchTicket) set({ searching: false });
      // A consent decision may have changed what each provider shows.
      core.listSourceProviders().then(
        (providers) => set({ providers }),
        () => undefined,
      );
    }
  },

  async setKey(providerId, key) {
    try {
      await core.setSourceProviderKey(providerId, key);
      const providers = await core.listSourceProviders();
      // Another provider's field, opened while this key was kept, stays open with what is typed
      // in it.
      set((state) => ({ providers, keyOpen: state.keyOpen === providerId ? null : state.keyOpen }));
      // A search that wanted this key is asked again with it.
      if (key !== null && keyProblems(get().result).includes(providerId)) void get().search();
      return null;
    } catch (error) {
      return errorMessage(error, translateNow);
    }
  },

  async add(work) {
    const { folderId } = get();
    set((state) => ({ adds: { ...state.adds, [work.key]: { status: "adding" } } }));
    let next: AddState;
    try {
      const result = await core.addFoundSource({ key: work.key, folderId });
      next = { status: "done", result, folderId };
    } catch (error) {
      next = { status: "failed", message: errorMessage(error, translateNow) };
    }
    set((state) => ({ adds: { ...state.adds, [work.key]: next } }));
  },
}));
