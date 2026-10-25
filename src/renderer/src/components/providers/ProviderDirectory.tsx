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
import { type DirectoryGroup, directoryGroups } from "./directoryGroups";
import { ProviderLogo } from "./ProviderLogo";
import { keyProviderName, savedProviderFor } from "./shared";

const headClass = "text-[13px] leading-5 font-semibold text-ink";

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
    <section data-testid="provider-directory" className="@container flex flex-col gap-4">
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
      {groups.map(({ group, providers: entries }) => (
        <div
          key={group}
          data-testid="provider-directory-group"
          data-group={group}
          className="flex flex-col gap-2"
        >
          <h5 className={headClass}>{t(`models.directory.group.${group}`)}</h5>
          <div className="grid grid-cols-1 gap-2 @[30rem]:grid-cols-2">
            {entries.map((entry) => {
              const region = regionOf(entry, group);
              return (
                <Tile
                  key={entry.id}
                  entry={entry}
                  added={savedProviderFor(providers, entry.id, region, language) !== undefined}
                  onOpen={() => onOpen(entry.id, region)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function Tile({
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
    <button
      type="button"
      data-testid="provider-directory-entry"
      data-catalog-id={entry.id}
      data-opens={`entry:${entry.id}`}
      onClick={onOpen}
      className="flex min-w-0 items-center gap-2.5 rounded-lg p-2.5 text-left shadow-[inset_0_0_0_1px_var(--color-rule)] hover:bg-frame hover:shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
    >
      <ProviderLogo id={entry.id} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-[18px] font-semibold text-ink" title={name}>
          {name}
        </span>
        {line && (
          <span className="truncate text-[12px] leading-[17px] text-ink-meta" title={line}>
            {line}
          </span>
        )}
      </span>
    </button>
  );
}
