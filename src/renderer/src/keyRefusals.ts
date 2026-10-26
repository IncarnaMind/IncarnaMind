/**
 * A refused key leads somewhere (#765): "Check the key" on a refused Answer
 * opens that company's key field in Settings › Models, with the refusal said
 * beside it, and once a key for it is saved the Answer offers to ask again.
 */
import { create } from "zustand";
import type { ChatProvider } from "../../core/api";
import {
  billingUrlOf,
  catalogProviderOf,
  KEY_PROVIDERS,
} from "../../core/providers/catalog/providers";
import { core } from "./core";
import { useAppStore } from "./store";

/** The refusal Settings › Models opens on. */
export interface KeyRefusal {
  catalogId: string;
  kind: "auth" | "out-of-credit";
  /** The provider's endpoint (its region), when it has several. */
  endpoint: string | null;
  /** The model the refused Answer asked, to keep in the form. */
  modelId: string;
  /** When the key was refused: the Answer's last change. ISO 8601; null when unknown. */
  at: string | null;
}

interface KeyRefusalsState {
  /** The refusal Settings › Models shows, from "Check the key"; null once it is done with. */
  showing: KeyRefusal | null;
  /** When a key was last saved here for each provider, by id: Answers it refused before then can be asked again. */
  savedAt: Readonly<Record<string, string>>;
  /** When credit was last opened here for each provider, by id: its Answer offers to ask again. */
  billingOpenedAt: Readonly<Record<string, string>>;
  openBilling(providerId: string | null, url: string): void;
  /** Opens the key field of a refused provider; a provider with no key field opens Models as it is. */
  check(
    providerId: string | null,
    modelId: string,
    at: string | null,
    kind?: KeyRefusal["kind"],
  ): Promise<void>;
  /** The same for background work, which knows the company it sends to, not the provider: the one saved for it. */
  checkService(serviceId: string | null): Promise<void>;
  saved(provider: ChatProvider): void;
  done(): void;
}

/** The id a provider's key field goes by; null when it takes no key, as a sign-in route does. */
export const keyProviderOf = (provider: ChatProvider | undefined): string | null => {
  if (!provider) return null;
  const id = provider.catalogId ?? provider.kind;
  return KEY_PROVIDERS.includes(id) ? id : null;
};

/** Where the provider's credit is added, when its catalog entry has a page for it. */
export const billingUrlOfProvider = (provider: ChatProvider | undefined): string | null => {
  if (!provider) return null;
  const catalog = catalogProviderOf(provider.kind, provider.catalogId);
  return (catalog && billingUrlOf(catalog, provider.endpoint)) || null;
};

export const useKeyRefusals = create<KeyRefusalsState>()((set, get) => ({
  showing: null,
  savedAt: {},
  billingOpenedAt: {},
  openBilling(providerId, url) {
    window.open(url, "_blank", "noreferrer");
    if (providerId) {
      set((state) => ({
        billingOpenedAt: { ...state.billingOpenedAt, [providerId]: new Date().toISOString() },
      }));
    }
  },

  async check(providerId, modelId, at, kind = "auth") {
    const { openSettings, reportError } = useAppStore.getState();
    try {
      const providers = providerId ? await core.listChatProviders() : [];
      const provider = providers.find((each) => each.id === providerId);
      const id = keyProviderOf(provider);
      if (provider && id) {
        set({ showing: { catalogId: id, endpoint: provider.endpoint, modelId, at, kind } });
      }
    } catch (error) {
      reportError(error);
    }
    openSettings("models");
  },

  async checkService(serviceId) {
    const sent = serviceId
      ? (await core.listChatProviders().catch(() => [])).filter(
          (each) => each.service?.id === serviceId,
        )
      : [];
    await get().check(sent.length === 1 ? (sent[0]?.id ?? null) : null, "", null);
  },

  saved: (provider) =>
    set((state) => ({
      showing: null,
      savedAt: { ...state.savedAt, [provider.id]: new Date().toISOString() },
    })),

  done: () => set({ showing: null }),
}));

/** Whether a key for the provider was saved after an Answer it refused. */
export function useKeySavedSince(providerId: string | null, at: string | null): boolean {
  return useKeyRefusals((state) => {
    const saved = providerId ? state.savedAt[providerId] : undefined;
    return saved !== undefined && at !== null && Date.parse(saved) > Date.parse(at);
  });
}

/** Whether the User was sent to add credit for the provider after an Answer it refused. */
export function useBillingOpenedSince(providerId: string | null, at: string | null): boolean {
  return useKeyRefusals((state) => {
    const opened = providerId ? state.billingOpenedAt[providerId] : undefined;
    return opened !== undefined && at !== null && Date.parse(opened) > Date.parse(at);
  });
}
