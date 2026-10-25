import type { Language } from "../../../../core/language";
import type { CatalogProvider } from "../../../../core/providers/catalog";
import { CATALOG_PROVIDERS } from "../../../../core/providers/catalog/providers";

export type DirectoryGroup = "popular" | "international" | "china" | "local" | "other";

/** What most Users of the language set up first (#179). */
const POPULAR: Record<Language, readonly string[]> = {
  en: ["anthropic", "openai", "google", "ollama", "openrouter"],
  "zh-CN": ["deepseek", "qwen", "kimi", "glm", "siliconflow", "ollama"],
};

const ORDER: Record<Language, readonly DirectoryGroup[]> = {
  en: ["popular", "international", "china", "local", "other"],
  "zh-CN": ["popular", "china", "international", "local", "other"],
};

const matches = (provider: CatalogProvider, query: string): boolean => {
  const words = query.trim().toLocaleLowerCase();
  return (
    words === "" ||
    [provider.id, provider.name.en, provider.name.zh].some((text) =>
      text.toLocaleLowerCase().includes(words),
    )
  );
};

/** Each provider once: under Popular where it is popular, else in its own group; one with a region in two groups (`alsoListedIn`) also in the other. Empty groups are left out. */
export function directoryGroups(
  language: Language,
  query = "",
): { group: DirectoryGroup; providers: CatalogProvider[] }[] {
  const popular = POPULAR[language];
  const shown = CATALOG_PROVIDERS.filter((provider) => matches(provider, query));
  return ORDER[language]
    .map((group) => ({
      group,
      providers:
        group === "popular"
          ? popular.flatMap((id) => shown.filter((provider) => provider.id === id))
          : shown.filter(
              (provider) =>
                (provider.group === group && !popular.includes(provider.id)) ||
                provider.alsoListedIn === group,
            ),
    }))
    .filter((each) => each.providers.length > 0);
}
