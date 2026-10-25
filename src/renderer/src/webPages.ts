/**
 * Saving web pages as Documents (#261), from "Add a web page…", a paste on
 * the sidebar or a drop on the window, and "Fetch again": what is being
 * fetched, and the pages that couldn't be, until dismissed or tried again.
 */
import { create } from "zustand";
import type { Document, WebPageFailureReason, WebPageResult } from "../../core/api";
import type { Language } from "../../core/language";
import { formatDate } from "../../shared/dates";
import type { MessageKey } from "../../shared/i18n";
import { pastedAddresses } from "../../shared/webAddresses";
import { core } from "./core";
import { useAppStore } from "./store";

export interface WebPageProblem {
  /** The address, or "document:<id>" for "Fetch again". */
  key: string;
  address: string;
  reason: WebPageFailureReason;
  message: string;
  folderId: string | null;
  /** As the save asked; absent: as Settings say. */
  keepLook?: boolean;
  /** Set for "Fetch again". */
  document: { id: string; name: string } | null;
}

interface WebPagesState {
  dialogOpen: boolean;
  /**
   * The addresses "Add a web page…" is saving: it shows how each goes, and
   * why one couldn't be added, where the sidebar's status would otherwise.
   */
  dialogAddresses: readonly string[];
  /** Keys, as `WebPageProblem.key`. */
  fetching: readonly string[];
  problems: readonly WebPageProblem[];
  openDialog(): void;
  submitDialog(addresses: readonly string[], keepLook: boolean): Promise<void>;
  closeDialog(): void;
  add(addresses: readonly string[], folderId?: string | null, keepLook?: boolean): Promise<void>;
  fetchAgain(document: Pick<Document, "id" | "name">, once?: boolean): Promise<void>;
  tryAgain(problem: WebPageProblem, once?: boolean): Promise<void>;
  dismiss(problem: WebPageProblem): void;
}

/** The dialog says how its own addresses go; the sidebar's status says the rest. */
export const outsideDialog = (state: Pick<WebPagesState, "dialogAddresses">, key: string) =>
  !state.dialogAddresses.includes(key);

/** A paste of many links doesn't fetch them all at once. */
const AT_ONCE = 4;

const REFUSED: ReadonlySet<WebPageFailureReason> = new Set([
  "invalid-address",
  "not-a-page",
  "video",
  "not-text",
]);

export const canTryAgain = (problem: Pick<WebPageProblem, "reason">) =>
  !REFUSED.has(problem.reason);

export const heldInLocalMode = (problem: Pick<WebPageProblem, "reason">) =>
  problem.reason === "local-mode";

export const siteOf = (address: string): string => URL.parse(address)?.host ?? address;

export const reasonKey = (reason: WebPageFailureReason): MessageKey => `webPages.reason.${reason}`;

/** Only when the paste or drop is nothing but addresses (see `pastedAddresses`). */
export function linksIn(data: DataTransfer): string[] {
  const list = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  return pastedAddresses(list || data.getData("text/plain"));
}

/** "10 Oct 2026", "2026年10月10日"; a date that isn't ISO 8601 stays as the page gives it. */
export function pageDate(value: string, language: Language): string {
  if (!/^\d{4}-\d{2}/.test(value)) return value;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return formatDate(time, language);
}

export const useWebPages = create<WebPagesState>()((set, get) => {
  const start = (key: string) => {
    set((state) => ({
      fetching: [...state.fetching, key],
      problems: state.problems.filter((each) => each.key !== key),
    }));
  };
  const finish = (key: string, problem: WebPageProblem | null) => {
    set((state) => ({
      fetching: state.fetching.filter((each) => each !== key),
      problems: problem ? [...state.problems, problem] : state.problems,
    }));
  };
  const problemOf = (
    key: string,
    result: Extract<WebPageResult, { outcome: "failed" }>,
    folderId: string | null,
    document: WebPageProblem["document"],
    keepLook?: boolean,
  ): WebPageProblem => ({
    key,
    address: result.address,
    reason: result.failure.reason,
    message: result.failure.message,
    folderId,
    ...(keepLook === undefined ? {} : { keepLook }),
    document,
  });
  const failedAction = (error: unknown) => useAppStore.getState().reportError(error);

  const save = async (
    address: string,
    folderId: string | null,
    keepLook?: boolean,
    once?: boolean,
  ) => {
    if (get().fetching.includes(address)) return;
    start(address);
    try {
      const result = await core.saveWebPage({
        address,
        folderId,
        ...(keepLook === undefined ? {} : { keepLook }),
        ...(once && { localModeOnce: true }),
      });
      if (result.outcome === "failed") {
        finish(address, problemOf(address, result, folderId, null, keepLook));
        return;
      }
      finish(address, null);
      if (result.existing) {
        useAppStore.setState((state) => ({
          alreadyAdded: [...new Set([...state.alreadyAdded, result.document.name])],
        }));
      }
    } catch (error) {
      finish(address, null);
      failedAction(error);
    }
  };

  return {
    dialogOpen: false,
    dialogAddresses: [],
    fetching: [],
    problems: [],

    openDialog() {
      set({ dialogOpen: true, dialogAddresses: [] });
    },
    async submitDialog(addresses, keepLook) {
      set({ dialogAddresses: [...new Set(addresses)] });
      await get().add(addresses, null, keepLook);
    },
    closeDialog() {
      set((state) => ({
        dialogOpen: false,
        dialogAddresses: [],
        // What it said has been read; a page still being fetched says how it went in the sidebar.
        problems: state.problems.filter((each) => !state.dialogAddresses.includes(each.key)),
      }));
    },

    async add(addresses, folderId = null, keepLook) {
      const queue = [...new Set(addresses)];
      const worker = async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          await save(next, folderId, keepLook);
        }
      };
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
    },

    async fetchAgain(document, once) {
      const key = `document:${document.id}`;
      if (get().fetching.includes(key)) return;
      start(key);
      try {
        const result = await core.fetchWebPageAgain(
          document.id,
          once ? { localModeOnce: true } : undefined,
        );
        finish(
          key,
          result.outcome === "failed"
            ? problemOf(key, result, null, { id: document.id, name: document.name })
            : null,
        );
      } catch (error) {
        finish(key, null);
        failedAction(error);
      }
    },

    async tryAgain(problem, once) {
      if (problem.document) return get().fetchAgain(problem.document, once);
      await save(problem.address, problem.folderId, problem.keepLook, once);
    },

    dismiss(problem) {
      set((state) => ({ problems: state.problems.filter((each) => each.key !== problem.key) }));
    },
  };
});
