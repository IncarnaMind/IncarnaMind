import { useEffect, useId, useMemo, useRef } from "react";
import type {
  AddFoundSourceResult,
  FoundSource,
  ReferenceName,
  SourceLicence,
  SourceProviderOutcome,
} from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { type AddState, keyLines, useFindSources } from "../findSources";
import { useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import { useAppStore } from "../store";
import { CloseLineIcon } from "./icons";
import { MetaLine } from "./MetaLine";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { SourceKeyField } from "./SourceKeyField";
import { buttonStyle, iconButtonClass, inputClass, sectionTitleClass } from "./ui";

/** How far back "Since …" offers, in years from this one. */
const SINCE = [0, 1, 2, 5, 10];

/** A name as a results list shows it: given name first, a whole name as written. */
const shownName = (name: ReferenceName) =>
  "literal" in name ? name.literal : [name.given, name.family].filter(Boolean).join(" ");

/** Licences with words of their own; any other shows as the provider writes it. */
const LICENCE_WORDS: Readonly<Record<string, MessageKey>> = {
  "public-domain": "sources.licence.public-domain",
  "other-oa": "sources.licence.other-oa",
  "publisher-specific-oa": "sources.licence.publisher-specific-oa",
};

/**
 * Find sources in the Library (#296): search OpenAlex, arXiv and PubMed for
 * papers, then add each to the Folder chosen, an open-access one as a
 * Document, any other as its reference record with "Get the PDF…" to its
 * publisher's page. A panel between rules at the top of the Library, like
 * its other forms; Esc or ✕ closes it. Each provider asks for consent the
 * first time it is searched (the consent dialog); a provider declined,
 * failing or in local mode says so in one line with one action.
 */
export function FindSourcesPanel() {
  const t = useT();
  const language = useLanguage();
  const titleId = useId();
  const {
    query,
    fromYear,
    openAccessOnly,
    providers,
    off,
    folderId,
    searching,
    result,
    error,
    keyOpen,
    edit,
    toggleProvider,
    search,
    close,
  } = useFindSources();
  const groups = useAppStore((state) => state.library?.groups);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const thisYear = new Date().getFullYear();
  const years = useMemo(() => {
    const offered = SINCE.map((back) => thisYear - back);
    // A year an Answer searched from, if it isn't one of these.
    return fromYear !== null && !offered.includes(fromYear)
      ? [...offered, fromYear].sort((a, b) => b - a)
      : offered;
  }, [thisYear, fromYear]);
  const searchers = providers.filter((each) => each.searches);
  const n = (count: number) => formatCount(count, language);

  return (
    <section
      aria-labelledby={titleId}
      data-testid="find-sources"
      className="mb-5 border-y border-rule py-4"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className={sectionTitleClass}>
          {t("sources.title")}
        </h2>
        <button
          type="button"
          data-testid="find-sources-close"
          aria-label={t("sources.close")}
          title={t("sources.close")}
          onClick={close}
          className={iconButtonClass}
        >
          <CloseLineIcon />
        </button>
      </div>
      <p className="mt-0.5 text-ui leading-5 text-ink-meta">{t("sources.intro")}</p>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          ref={field}
          type="search"
          data-testid="find-sources-query"
          aria-label={t("sources.search.label")}
          placeholder={t("sources.search.placeholder")}
          value={query}
          onChange={(event) => edit({ query: event.target.value })}
          className={`${inputClass} mt-0 min-w-48 flex-1`}
        />
        <button
          type="submit"
          data-testid="find-sources-search"
          disabled={searching || query.trim() === ""}
          className={buttonStyle("primary")}
        >
          {t(searching ? "sources.searching" : "sources.search")}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-ui leading-5 text-ink-secondary">
        <label className="flex items-center gap-2">
          {t("sources.since")}
          <select
            data-testid="find-sources-since"
            value={fromYear ?? ""}
            onChange={(event) =>
              edit({ fromYear: event.target.value === "" ? null : Number(event.target.value) })
            }
            className="rounded-sm border border-rule-strong bg-sheet px-1.5 py-0.5 text-ink"
          >
            <option value="">{t("sources.since.any")}</option>
            {years.map((year) => (
              <option key={year} value={year}>
                {t("sources.since.year", { year })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="find-sources-open-only"
            checked={openAccessOnly}
            onChange={(event) => edit({ openAccessOnly: event.target.checked })}
            className="size-4 accent-ink"
          />
          {t("sources.openOnly")}
        </label>
        {searchers.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as a toolbar names its part.
          <span
            role="group"
            aria-label={t("sources.providers")}
            className="flex items-center gap-1.5"
          >
            <span aria-hidden="true">{t("sources.providers")}</span>
            {searchers.map((provider) => {
              const on = !off.includes(provider.id);
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={on}
                  data-testid="find-sources-provider"
                  title={t(`sources.provider.${provider.id}.about` as MessageKey)}
                  onClick={() => toggleProvider(provider.id)}
                  className={`h-6 rounded-sm px-2 text-ui ${
                    on
                      ? "bg-chip text-ink shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
                      : "text-ink-meta line-through hover:bg-chip"
                  }`}
                >
                  {provider.name}
                </button>
              );
            })}
          </span>
        )}
        <label className="flex min-w-0 items-center gap-2">
          {t("sources.addTo")}
          <select
            data-testid="find-sources-folder"
            value={folderId ?? ""}
            onChange={(event) => edit({ folderId: event.target.value || null })}
            className="max-w-56 min-w-0 truncate rounded-sm border border-rule-strong bg-sheet px-1.5 py-0.5 text-ink"
          >
            <option value="">{t("library.unsorted")}</option>
            {(groups ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {keyLines(providers, off, keyOpen, result).map((provider) => (
        <SourceKeyField key={provider.id} provider={provider} />
      ))}
      {error && (
        <ProblemLine
          className="mt-3"
          testId="find-sources-error"
          action={{ label: t("sources.retry"), onClick: () => void search() }}
        >
          {error}
        </ProblemLine>
      )}
      {result?.outcome === "local-mode" && (
        <ProblemLine
          className="mt-3"
          testId="find-sources-local-mode"
          action={{
            label: t("sources.privacySettings"),
            onClick: () => useAppStore.getState().openSettings("privacy"),
          }}
        >
          {t("sources.localMode")}
        </ProblemLine>
      )}
      {result?.outcome === "found" && (
        <div className="mt-3">
          <p
            role="status"
            data-testid="find-sources-count"
            className="text-ui leading-5 text-ink-meta"
          >
            {result.works.length === 0
              ? t("sources.none")
              : t(result.works.length === 1 ? "sources.count.one" : "sources.count", {
                  count: n(result.works.length),
                })}
          </p>
          {result.providers.map((provider) =>
            provider.failure ? <ProviderProblem key={provider.id} provider={provider} /> : null,
          )}
          {result.works.length > 0 && (
            <ul data-testid="find-sources-results" className="mt-2 border-b border-rule">
              {result.works.map((work) => (
                <ResultRow key={work.key} work={work} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** A provider that gave nothing: why, in one line, with what to do. */
function ProviderProblem({ provider }: { provider: SourceProviderOutcome }) {
  const t = useT();
  const failure = provider.failure;
  if (!failure) return null;
  const openKey = () => useFindSources.getState().openKey(provider.id);
  const action: ProblemAction =
    failure.reason === "declined"
      ? {
          label: t("sources.privacySettings"),
          onClick: () => useAppStore.getState().openSettings("privacy"),
        }
      : failure.reason === "needs-key"
        ? { label: t("sources.key.add"), onClick: openKey }
        : failure.reason === "key-rejected"
          ? { label: t("sources.key.change"), onClick: openKey }
          : { label: t("sources.retry"), onClick: () => void useFindSources.getState().search() };
  return (
    <ProblemLine
      testId="find-sources-problem"
      title={failure.message}
      action={action}
      className="mt-1"
    >
      {t(`sources.problem.${failure.reason}`, { provider: provider.name })}
    </ProblemLine>
  );
}

function licenceWords(licence: SourceLicence, t: ReturnType<typeof useT>): string {
  const key = LICENCE_WORDS[licence.id];
  const label = key ? t(key) : licence.label;
  return licence.commercial === false
    ? t("sources.licence.nonCommercial", { licence: label })
    : label;
}

/** One found work: what it is, whether it is open, and Add. */
function ResultRow({ work }: { work: FoundSource }) {
  const t = useT();
  const language = useLanguage();
  const add = useFindSources((state) => state.adds[work.key]);
  const { fields, access } = work;
  const authors = fields.authors.slice(0, 3).map(shownName).join(", ");
  const byline = [
    fields.authors.length > 3 ? t("sources.authors.more", { names: authors }) : authors,
    fields.issued.slice(0, 4),
    fields.containerTitle,
  ].filter(Boolean);
  const facts = [
    t(access.kind === "open" ? `sources.access.${access.format}` : "sources.access.closed"),
    ...(access.kind === "open" && access.licence ? [licenceWords(access.licence, t)] : []),
    ...(access.kind === "open" && (access.version === "accepted" || access.version === "submitted")
      ? [t(`sources.version.${access.version}`)]
      : []),
    ...(work.citedBy !== null
      ? [t("sources.citedBy", { count: formatCount(work.citedBy, language) })]
      : []),
    ...(work.unofficial ? [t("sources.unofficial")] : []),
    t("sources.foundBy", {
      providers: work.foundBy.map((each) => each.name).join(language === "zh-CN" ? "、" : ", "),
    }),
  ];
  const open = access.kind === "open";
  const done = add?.status === "done" ? add.result : null;
  const inLibrary = add ? null : work.inLibrary;
  const hasDocument = done?.outcome === "document" || Boolean(inLibrary?.documentId);
  // Kept as its reference alone: an open copy can still be tried again.
  const referenceOnly =
    done?.outcome === "reference" || Boolean(inLibrary && !inLibrary.documentId);
  const page = (done?.outcome === "reference" ? done.landingUrl : null) ?? work.landingUrl;
  return (
    <li
      data-testid="find-sources-result"
      data-access={access.kind === "open" ? access.format : "closed"}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-rule py-3"
    >
      <div className="min-w-0">
        <p data-testid="find-sources-result-title" className="break-words text-ink">
          {fields.title}
        </p>
        {byline.length > 0 && (
          <MetaLine parts={byline} className="text-ui leading-5 break-words text-ink-secondary" />
        )}
        <MetaLine
          parts={facts}
          data-testid="find-sources-result-facts"
          className="text-ui leading-5 break-words text-ink-meta"
        />
        {work.notice && (
          <p
            data-testid="find-sources-result-notice"
            className="text-ui leading-5 break-words text-ink-meta"
          >
            {t("sources.notice", { notice: work.notice })}
          </p>
        )}
        <AddLine work={work} add={add} />
      </div>
      <div className="flex flex-col items-end gap-1">
        {!hasDocument && (open || !referenceOnly) && (
          <AddButton work={work} add={add} open={open} again={done?.outcome === "reference"} />
        )}
        {page && !hasDocument && (!open || referenceOnly) && (
          <a
            href={page}
            target="_blank"
            rel="noreferrer"
            data-testid="find-sources-get-pdf"
            className={buttonStyle("ghost")}
          >
            {t(
              access.kind === "open" && access.format === "web-page"
                ? "sources.openPage"
                : "sources.getPdf",
            )}
          </a>
        )}
      </div>
    </li>
  );
}

/** Add; or, `again` after its open copy couldn't be had and its reference was kept, another try. */
function AddButton({
  work,
  add,
  open,
  again,
}: {
  work: FoundSource;
  add: AddState | undefined;
  open: boolean;
  again: boolean;
}) {
  const t = useT();
  const adding = add?.status === "adding";
  return (
    <button
      type="button"
      data-testid="find-sources-add"
      disabled={adding}
      onClick={() => void useFindSources.getState().add(work)}
      className={buttonStyle(open ? "secondary" : "ghost")}
    >
      {t(
        adding
          ? "sources.adding"
          : again
            ? "sources.retry"
            : open
              ? "sources.add"
              : "sources.addReference",
      )}
    </button>
  );
}

/** Where a work is in the Library, once added, or why it couldn't be. */
function AddLine({ work, add }: { work: FoundSource; add: AddState | undefined }) {
  const t = useT();
  const groups = useAppStore((state) => state.library?.groups);
  const openDocument = (documentId: string) =>
    useAppStore.getState().openDocument({ documentId }, { as: "here" });
  if (!add) {
    if (!work.inLibrary) return null;
    const documentId = work.inLibrary.documentId;
    return (
      <ProblemLine
        role="status"
        testId="find-sources-in-library"
        className="mt-1"
        action={
          documentId
            ? { label: t("sources.open"), onClick: () => openDocument(documentId) }
            : undefined
        }
      >
        {t(documentId ? "sources.inLibrary" : "sources.inLibrary.reference")}
      </ProblemLine>
    );
  }
  if (add.status === "adding") return null;
  if (add.status === "failed") {
    return (
      <ProblemLine className="mt-1" testId="find-sources-added" title={add.message}>
        {t("sources.failed")}
      </ProblemLine>
    );
  }
  return (
    <AddedLine
      work={work}
      result={add.result}
      folderId={add.folderId}
      groups={groups}
      openDocument={openDocument}
    />
  );
}

function AddedLine({
  work,
  result,
  folderId,
  groups,
  openDocument,
}: {
  work: FoundSource;
  result: AddFoundSourceResult;
  /** The Folder it was added to, whatever "Add to" says now. */
  folderId: string | null;
  groups: readonly { id: string; name: string }[] | undefined;
  openDocument(documentId: string): void;
}) {
  const t = useT();
  if (result.outcome === "document") {
    const folder = groups?.find((group) => group.id === folderId);
    return (
      <ProblemLine
        role="status"
        testId="find-sources-added"
        className="mt-1"
        action={{ label: t("sources.open"), onClick: () => openDocument(result.document.id) }}
      >
        {result.existing
          ? t("sources.inLibrary")
          : folder
            ? t("sources.added", { folder: folder.name })
            : t("sources.added.unsorted")}
      </ProblemLine>
    );
  }
  if (result.outcome === "reference") {
    return (
      <ProblemLine role="status" testId="find-sources-added" className="mt-1">
        {result.existing
          ? t("sources.inLibrary.reference")
          : result.reason === "closed"
            ? t("sources.added.reference")
            : t(`sources.added.${result.reason}`)}
      </ProblemLine>
    );
  }
  const findSources = useFindSources.getState();
  // The provider whose key it wanted: the one that found it and takes a key.
  const keyed = work.foundBy.find((each) =>
    findSources.providers.some((provider) => provider.id === each.id && provider.key !== "none"),
  );
  const action =
    result.reason === "declined" || result.reason === "local-mode"
      ? {
          label: t("sources.privacySettings"),
          onClick: () => useAppStore.getState().openSettings("privacy"),
        }
      : (result.reason === "needs-key" || result.reason === "key-rejected") && keyed
        ? {
            label: t(result.reason === "needs-key" ? "sources.key.add" : "sources.key.change"),
            onClick: () => findSources.openKey(keyed.id),
          }
        : result.reason === "rate-limited"
          ? { label: t("sources.retry"), onClick: () => void findSources.add(work) }
          : { label: t("sources.search"), onClick: () => void findSources.search() };
  return (
    <ProblemLine
      className="mt-1"
      testId="find-sources-added"
      title={result.message}
      action={action}
    >
      {t(`sources.failed.${result.reason}`)}
    </ProblemLine>
  );
}
