import { useEffect, useRef, useState } from "react";
import type { ChatProvider } from "../../../../core/api";
import {
  type CatalogProvider,
  catalogModel,
  modelsProviderOfKind,
} from "../../../../core/providers/catalog";
import { kindOfCatalogId } from "../../../../core/providers/catalog/providers";
import { useLanguage, useT } from "../../i18n";
import { SearchLineIcon } from "../lineIcons";
import { SettingsBackLink } from "../SettingsBackLink";
import { SettingsGroup, SettingsRowAction, SettingsSection } from "../settings/SettingsGroup";
import { type DirectoryGroup, directoryGroups } from "./directoryGroups";
import { ProviderLogo } from "./ProviderLogo";
import { keyProviderName, savedProviderFor } from "./shared";

const regionOf = (entry: CatalogProvider, group: DirectoryGroup): string | null => {
  const region = group === "international" ? "intl" : group === "china" ? "cn" : null;
  return region !== null && entry.endpoints.some((each) => each.id === region) ? region : null;
};

export function ProviderDirectory({
  providers,
  onBack,
  onOpen,
}: {
  providers: readonly ChatProvider[];
  onBack(): void;
  onOpen(catalogId: string, endpoint: string | null): void;
}) {
  const t = useT();
  const language = useLanguage();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // Opened to find a provider: typing starts the search.
  useEffect(() => search.current?.focus(), []);
  const groups = directoryGroups(language, query);
  return (
    <section data-testid="provider-directory" className="flex flex-col gap-4">
      <SettingsBackLink
        label={t("settings.pages.models")}
        testId="models-back"
        onBack={onBack}
        focused={false}
      />
      <h4 className="text-[15px] leading-[22px] font-semibold text-ink">
        {t("models.directory.title")}
      </h4>
      <label className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]">
        <SearchLineIcon className="size-3.5 shrink-0" />
        <input
          ref={search}
          type="search"
          data-testid="provider-directory-search"
          value={query}
          placeholder={t("models.directory.search")}
          aria-label={t("models.directory.search")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Esc empties the field first; with it empty, Esc closes Settings.
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              setQuery("");
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-placeholder"
        />
      </label>
      {groups.length === 0 && (
        <p className="text-[13px] leading-5 text-ink-meta">
          {t("models.directory.noMatch", { query: query.trim() })}
        </p>
      )}
      {groups.length > 0 && (
        <div className="flex flex-col gap-6">
          {groups.map(({ group, providers: entries }) => (
            <div key={group} data-testid="provider-directory-group" data-group={group}>
              <SettingsSection title={t(`models.directory.group.${group}`)} titleAs="h5">
                <SettingsGroup>
                  {entries.map((entry) => {
                    const region = regionOf(entry, group);
                    return (
                      <Entry
                        key={entry.id}
                        entry={entry}
                        added={
                          savedProviderFor(providers, entry.id, region, language) !== undefined
                        }
                        onOpen={() => onOpen(entry.id, region)}
                      />
                    );
                  })}
                </SettingsGroup>
              </SettingsSection>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Entry({
  entry,
  added,
  onOpen,
}: {
  entry: CatalogProvider;
  added: boolean;
  onOpen(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const name = keyProviderName(entry.id, t, language);
  const answers = entry.roles.answers;
  const line = added
    ? t("models.directory.added")
    : answers && entry.group !== "local"
      ? (catalogModel(modelsProviderOfKind(kindOfCatalogId(entry.id), null, entry.id), answers)
          ?.name ?? answers)
      : null;
  return (
    <SettingsRowAction
      testId="provider-directory-entry"
      data-catalog-id={entry.id}
      data-opens={`entry:${entry.id}`}
      leading={<ProviderLogo id={entry.id} />}
      label={
        <span className="block truncate" title={name}>
          {name}
        </span>
      }
      detail={
        line ? (
          <span className="block truncate" title={line}>
            {line}
          </span>
        ) : undefined
      }
      onClick={onOpen}
    />
  );
}
