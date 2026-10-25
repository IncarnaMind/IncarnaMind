import { create } from "zustand";
import type { ErrorWording } from "../../core/errors";
import type { MessageKey } from "../../shared/i18n";
import { describeError } from "./errors";
import type { Words } from "./lineNames";

/** How long a confirmation ("Copied") shows before it goes by itself. An error never does. */
export const CONFIRMATION_SHOWN_MS = 3000;

/** The timers a notice uses, so a test can run them without waiting. */
export interface Clock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemClock: Clock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Something that went wrong, in the words of the dictionary where there are plain ones. */
export interface ErrorNotice {
  id: number;
  /** The core's own sentence. */
  message: string;
  /** The sentence as a key of the dictionary, which the notice says in the interface language. */
  wording: ErrorWording | null;
  /** Plain words for a failure of the system's, which replace the sentence. */
  reason: MessageKey | null;
  /** The technical text, for the Details. */
  detail: string;
  /** The one thing that puts it right, as a button beside Dismiss. */
  action: NoticeAction | null;
}

export interface NoticeAction {
  label: Words;
  run(): Promise<void> | void;
}

/** Something that worked, said once. */
export interface Confirmation {
  id: number;
  message: MessageKey;
}

interface NoticesState {
  /** Oldest first. An error stays until the User dismisses it, and never goes by itself. */
  errors: readonly ErrorNotice[];
  confirmation: Confirmation | null;
  /** Shows a failure where the action that failed has nowhere of its own to say it. */
  showError(error: unknown, action?: NoticeAction): void;
  dismissError(id: number): void;
  /** Shows what worked for a few seconds; the next one takes its place. */
  confirm(message: MessageKey): void;
  dismissConfirmation(): void;
}

/** Notices by kind: errors stay, confirmations go by themselves (docs/agents/interaction.md). */
export function createNotices(clock: Clock = systemClock) {
  let ids = 0;
  let timer: unknown;
  return create<NoticesState>()((set, get) => ({
    errors: [],
    confirmation: null,
    showError(error, action) {
      const { message, wording, reason, detail } = describeError(error);
      // The same failure twice is one notice: it says it once.
      if (
        get().errors.some(
          (each) => each.message === message && each.reason === reason && each.detail === detail,
        )
      ) {
        return;
      }
      set((state) => ({
        errors: [
          ...state.errors,
          { id: ++ids, message, wording, reason, detail, action: action ?? null },
        ],
      }));
    },
    dismissError(id) {
      set((state) => ({ errors: state.errors.filter((each) => each.id !== id) }));
    },
    confirm(message) {
      clock.clearTimeout(timer);
      const id = ++ids;
      set({ confirmation: { id, message } });
      timer = clock.setTimeout(() => {
        if (get().confirmation?.id === id) set({ confirmation: null });
      }, CONFIRMATION_SHOWN_MS);
    },
    dismissConfirmation() {
      clock.clearTimeout(timer);
      set({ confirmation: null });
    },
  }));
}

export const useNotices = createNotices();
