import type { ChatProviderKind } from "../core/api";
import {
  catalogModel,
  catalogProvider,
  modelsProviderOfKind,
  providersWithModels,
  withoutDateSuffix,
} from "../core/providers/catalog";

/** What names a model: the provider it runs on, and the names that provider's own list gives. */
export interface ModelSource {
  kind?: ChatProviderKind | null;
  /** A hosted provider's endpoint, for the catalog set of its region. */
  endpoint?: string | null;
  /** The provider's own names by model id, where its list gives them (the ChatGPT plan's). */
  names?: Readonly<Record<string, string>> | undefined;
}

/** Providers whose model ids the User names: the catalog has nothing to say about them. */
const SERVERS: ReadonlySet<ChatProviderKind> = new Set(["ollama", "openai-compatible"]);

/** The sets searched when the provider isn't known: the first-class ones before OpenRouter's many. */
const SETS = [
  ...providersWithModels().filter((set) => !set.startsWith("openrouter")),
  ...providersWithModels().filter((set) => set.startsWith("openrouter")),
];

const tidy = (name: string) => name.replace(/\s*\(latest\)$/i, "").trim();

const namesForRole = (set: string, modelId: string): boolean => {
  const provider = catalogProvider(set.split("/")[0] ?? set);
  const id = withoutDateSuffix(modelId);
  return Object.values(provider?.roles ?? {}).some(
    (each) => each !== undefined && withoutDateSuffix(each) === id,
  );
};

function catalogName(modelId: string, { kind, endpoint }: ModelSource): string | undefined {
  if (kind) {
    return SERVERS.has(kind)
      ? undefined
      : catalogModel(modelsProviderOfKind(kind, endpoint), modelId)?.name;
  }
  // A model a provider names for a role is its own; another provider may resell it under a longer name (#1317).
  for (const set of SETS) {
    if (!namesForRole(set, modelId)) continue;
    const name = catalogModel(set, modelId)?.name;
    if (name) return name;
  }
  for (const set of SETS) {
    const name = catalogModel(set, modelId)?.name;
    if (name) return name;
  }
  return undefined;
}

/**
 * The name to show for a model, in every language (names aren't translated):
 * the provider catalog's, else the provider's own list's, else the id itself,
 * for one nothing names (an Ollama tag, an OpenAI-compatible server's model).
 * Without a provider the catalog is searched whole.
 */
export function modelName(modelId: string, source: ModelSource = {}): string {
  const found = catalogName(modelId, source) ?? source.names?.[modelId];
  return (found && tidy(found)) || modelId;
}
