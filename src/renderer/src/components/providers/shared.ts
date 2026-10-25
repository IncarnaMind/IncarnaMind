import { useRef, useState } from "react";
import type { ChatProvider, ChatReadiness, ProviderErrorKind } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import type { Endpoint } from "../../../../core/providers/catalog";
import {
  catalogProvider,
  catalogProviderOf,
  endpointOf,
  fieldValueOf,
  isPreset,
  kindOfCatalogId,
} from "../../../../core/providers/catalog/providers";
import { OLLAMA_CLOUD } from "../../../../core/providers/ollamaCloud";
import { isSignInRoute, SIGN_IN_ROUTES } from "../../../../core/providers/signInRoutes";
import { checkApiKey } from "../../../../shared/apiKey";
import type { MessageKey, MessageParams } from "../../../../shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Where an undo line of a change made in Settings › Models shows: the sidebar's is behind it. */
export const MODELS_UNDO_PLACE = "settings:models";

/** What a failed connection test means, in words. The ChatGPT plan's own kinds live under `chatgpt.`. */
export function testErrorKey(kind: ProviderErrorKind): MessageKey {
  switch (kind) {
    case "not-signed-in":
    case "plan-limit":
    case "blocked":
      return `chatgpt.test.${kind}`;
    default:
      return `providers.test.${kind}`;
  }
}

/** What to configure before Questions can be asked, in words: a sign-in names its provider. */
export function readinessKey(readiness: Extract<ChatReadiness, { ready: false }>): MessageKey {
  if (readiness.reason !== "sign-in-required") return `providers.readiness.${readiness.reason}`;
  const { kind } = readiness.provider;
  return isSignInRoute(kind)
    ? SIGN_IN_ROUTES[kind].problems["signed-out"].line
    : "chatgpt.readiness.sign-in-required";
}

export const catalogIdOf = (provider: ChatProvider) => provider.catalogId ?? provider.kind;

/** The region a click on a catalog entry means: the one asked for, else the interface language's own, else its first. */
export function regionFor(
  catalogId: string,
  endpoint: string | null,
  language: Language,
): string | null {
  const catalog = catalogProvider(catalogId);
  return catalog
    ? (endpointOf(catalog, endpoint ?? defaultRegion(catalogId, language))?.id ?? null)
    : null;
}

/**
 * The provider a click on a catalog entry opens, if one is saved: for a hosted provider the one
 * on the region it means, so a Kimi saved on China is not one on International. A server the User
 * gives can be added again at another address, so it is never "saved".
 */
export function savedProviderFor(
  providers: readonly ChatProvider[],
  catalogId: string,
  endpoint: string | null,
  language: Language,
): ChatProvider | undefined {
  if (catalogId === "openai-compatible") return undefined;
  const region = regionFor(catalogId, endpoint, language);
  return providers.find(
    (each) => catalogIdOf(each) === catalogId && (region === null || each.endpoint === region),
  );
}

export function keyProviderName(id: string, t: Translate, language: Language): string {
  const preset = catalogProvider(id);
  if (isPreset(preset)) return preset.name[language === "zh-CN" ? "zh" : "en"];
  return t(`providers.kind.${kindOfCatalogId(id)}`);
}

/** "OpenAI","OpenAI-compatible server · api.deepseek.com", "Ollama · on this computer". */
export function providerLabel(provider: ChatProvider, t: Translate, language: Language): string {
  if (provider.kind === "chatgpt") return t("chatgpt.title");
  if (provider.kind === "claude-account") return t("providers.kind.claude-account");
  const catalog = catalogProviderOf(provider.kind, provider.catalogId);
  const kind = isPreset(catalog)
    ? keyProviderName(catalog.id, t, language)
    : t(`providers.kind.${provider.kind}`);
  if (catalog && catalog.endpoints.length > 0) {
    // A hosted provider: its name, and its region when it has more than one, or the value its
    // address was built from (an AWS region, a Cloudflare account).
    const [first] = catalog.endpoints;
    const value = first && fieldValueOf(first, provider.baseUrl);
    if (value) return `${kind} · ${value}`;
    if (catalog.endpoints.length === 1) return kind;
    const region = catalog.endpoints.find((each) => each.id === provider.endpoint);
    return region ? `${kind} · ${regionName(region, t, language)}` : kind;
  }
  // Ollama's default model can be a cloud model, which runs on ollama.com, not here.
  if (provider.kind === "ollama" && provider.service?.id === OLLAMA_CLOUD.id) {
    return `${kind} · ${t("providers.settings.cloud")}`;
  }
  return `${kind} · ${provider.service?.name ?? t("providers.settings.local")}`;
}

/** Who receives the data, for messages like "Questions are off: you chose not to send to {service}". */
export const serviceName = (provider: ChatProvider, t: Translate, language: Language) =>
  provider.service?.name ?? providerLabel(provider, t, language);

/** The region a provider with both China and International opens on: the interface language's. */
export function defaultRegion(catalogId: string, language: Language): string {
  const ids = catalogProvider(catalogId)?.endpoints.map((each) => each.id) ?? [];
  const own = language === "zh-CN" ? "cn" : "intl";
  return ids.includes("cn") && ids.includes("intl") ? own : "";
}

/** The regions as the form lists them, "International / China", whatever order the catalog keeps them in. */
export const regionsListed = (endpoints: readonly Endpoint[]): Endpoint[] =>
  endpoints.toSorted((a, b) => Number(b.id === "intl") - Number(a.id === "intl"));

/** A region as the form says it: "China" or "International"; any other by its own label. */
export const regionName = (endpoint: Endpoint, t: Translate, language: Language): string =>
  endpoint.id === "cn" || endpoint.id === "intl"
    ? t(`providers.region.${endpoint.id}`)
    : endpoint.label[language === "zh-CN" ? "zh" : "en"];

/** The host of a server address, or null while it isn't one yet. */
function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).host || null;
  } catch {
    return null;
  }
}

/**
 * An API key field that keeps a key only for the provider and server it was
 * typed for, so it is never sent to another: choosing another provider clears
 * it, and so does leaving the address field pointing at another host. `text`
 * is the key as it is sent, and `stray` the character in it that keys don't use.
 */
export function useProviderKey() {
  const [apiKey, setApiKey] = useState("");
  /** The host the address field held when the key was typed, if it held one. */
  const typedFor = useRef<string | null>(null);
  const { key: text, stray } = checkApiKey(apiKey);
  return {
    apiKey,
    text,
    stray,
    /** The key as typed, with the server address the form holds now. */
    type(value: string, baseUrl = "") {
      setApiKey(value);
      typedFor.current = hostOf(baseUrl);
    },
    /** Another provider was chosen, or the key was saved. */
    clear() {
      setApiKey("");
      typedFor.current = null;
    },
    /** The address field was left: a key typed for another host goes. */
    leftAddress(baseUrl: string) {
      const host = hostOf(baseUrl);
      if (typedFor.current === null) typedFor.current = host;
      else if (host !== typedFor.current) {
        setApiKey("");
        typedFor.current = null;
      }
    },
  };
}
