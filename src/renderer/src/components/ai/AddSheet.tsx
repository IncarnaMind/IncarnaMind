import { type Ref, useRef, useState } from "react";
import type { MessageKey } from "../../../../shared/i18n";
import { useLanguage, useT } from "../../i18n";
import { ROUTE_LABELS } from "../../transcriptionServices";
import { MicLineIcon, SearchLineIcon } from "../lineIcons";
import { ProviderLogo } from "../providers/ProviderLogo";
import { keyProviderName } from "../providers/shared";
import { buttonStyle, dialogClass } from "../ui";
import { useModal } from "../useModal";
import {
  type DirectoryGroup,
  entryKey,
  entryName,
  jobsOf,
  type PlanId,
  type ServiceEntry,
  type ServiceJob,
  serviceDirectory,
} from "./serviceDirectory";

const GROUP_NAMES: Record<DirectoryGroup, MessageKey> = {
  plans: "ai.add.group.plans",
  popular: "ai.add.group.popular",
  local: "ai.add.group.local",
  meetings: "ai.add.group.meetings",
  organize: "ai.add.group.organize",
  more: "ai.add.group.more",
};

const JOB_NAMES: Record<ServiceJob, MessageKey> = {
  answers: "ai.add.job.answers",
  transcription: "ai.add.job.transcription",
  search: "ai.add.job.search",
  organize: "ai.add.job.organize",
  hints: "ai.add.job.hints",
};

const PLAN_NAMES: Record<PlanId, { name: MessageKey; line: MessageKey }> = {
  chatgpt: { name: "ai.plan.chatgpt", line: "ai.plan.chatgpt.line" },
  "claude-account": { name: "ai.plan.claude", line: "ai.plan.claude.line" },
  copilot: { name: "ai.plan.copilot", line: "ai.plan.copilot.line" },
};

const PLAN_LOGOS: Record<PlanId, string> = {
  chatgpt: "openai",
  "claude-account": "anthropic",
  copilot: "copilot",
};

/** An entry's name as the directory shows and searches it. */
export function useEntryName(): (entry: ServiceEntry) => string {
  const t = useT();
  const language = useLanguage();
  return (entry) => {
    if (entry.kind === "plan") return t(PLAN_NAMES[entry.plan].name);
    if (entry.kind === "provider") {
      return entry.provider.id === "openai-compatible"
        ? t("providers.form.title.server")
        : keyProviderName(entry.provider.id, t, language);
    }
    if (entry.kind === "transcription") return t(ROUTE_LABELS[entry.route]);
    return entryName(entry, language) ?? "";
  };
}

/**
 * Every service the User can set up, in one list: the directory's groups, each entry tagged with
 * the jobs it can do, and a search that finds one by name. Choosing one hands it to `onOpen`,
 * whose page holds its key or sign-in and what it sends. `offered`: the plans this copy can set up.
 */
export function ServiceDirectory({
  offered,
  added,
  onOpen,
  searchRef,
}: {
  offered(plan: PlanId): boolean;
  /** Whether an entry is set up already: it says so. */
  added(entry: ServiceEntry): boolean;
  onOpen(entry: ServiceEntry): void;
  /** Its search field, for whatever shows the directory to focus as it opens. */
  searchRef?: Ref<HTMLInputElement>;
}) {
  const t = useT();
  const language = useLanguage();
  const name = useEntryName();
  const [query, setQuery] = useState("");
  const all = serviceDirectory(language, { offered, name });
  const count = all.reduce((sum, group) => sum + group.entries.length, 0);
  const groups = serviceDirectory(language, { offered, name, query });
  return (
    <div data-testid="provider-directory" className="flex min-h-0 flex-col gap-3">
      <label className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]">
        <SearchLineIcon className="size-3.5 shrink-0" />
        <input
          ref={searchRef}
          type="search"
          data-testid="provider-directory-search"
          value={query}
          placeholder={t("ai.add.search", { count })}
          aria-label={t("ai.add.search", { count })}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Esc empties the field first; with it empty, Esc closes the sheet.
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-placeholder"
        />
      </label>
      {groups.length === 0 ? (
        <p className="px-1 text-[13px] leading-5 text-ink-meta">
          {t("models.directory.noMatch", { query: query.trim() })}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(({ group, entries }) => (
            <section
              key={group}
              data-testid="provider-directory-group"
              data-group={group}
              aria-labelledby={`directory-${group}`}
            >
              <h3
                id={`directory-${group}`}
                className="mb-1 px-1 text-[12px] leading-[18px] font-semibold text-ink-secondary"
              >
                {t(GROUP_NAMES[group])}
              </h3>
              <ul className="flex flex-col">
                {entries.map((entry) => (
                  <li key={entryKey(entry)}>
                    <Entry
                      entry={entry}
                      name={name(entry)}
                      added={added(entry)}
                      onOpen={() => onOpen(entry)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Entry({
  entry,
  name,
  added,
  onOpen,
}: {
  entry: ServiceEntry;
  name: string;
  added: boolean;
  onOpen(): void;
}) {
  const t = useT();
  const line = added
    ? t("models.directory.added")
    : entry.kind === "plan"
      ? t(PLAN_NAMES[entry.plan].line)
      : null;
  const logo =
    entry.kind === "plan"
      ? PLAN_LOGOS[entry.plan]
      : entry.kind === "provider"
        ? entry.provider.id
        : entry.kind === "decision"
          ? entry.host
          : entry.kind === "rerank"
            ? entry.service
            : null;
  return (
    <button
      type="button"
      data-testid="provider-directory-entry"
      data-entry={entryKey(entry)}
      data-catalog-id={entry.kind === "provider" ? entry.provider.id : undefined}
      onClick={onOpen}
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-1 py-1.5 text-left hover:bg-frame active:bg-hover focus-visible:-outline-offset-2"
    >
      <ProviderLogo
        id={logo}
        fallback={
          entry.kind === "transcription" ? <MicLineIcon className="size-[18px]" /> : undefined
        }
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-ink" title={name}>
          {name}
        </span>
        {line && <span className="truncate text-[12px] leading-[18px] text-ink-meta">{line}</span>}
      </span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {jobsOf(entry).map((job) => (
          <span
            key={job}
            data-testid="provider-directory-job"
            className="inline-flex h-[18px] items-center rounded-sm bg-chip px-1.5 text-[11px] leading-[18px] font-semibold text-ink-secondary"
          >
            {t(JOB_NAMES[job])}
          </span>
        ))}
      </span>
    </button>
  );
}

/**
 * "Add an account or key": the directory over Settings, as a sheet. Choosing an entry closes it
 * and opens that entry's page in Settings; Cancel or Esc closes it with nothing changed.
 */
export function AddSheet({
  open,
  offered,
  added,
  onOpen,
  onClose,
}: {
  open: boolean;
  offered(plan: PlanId): boolean;
  added(entry: ServiceEntry): boolean;
  onOpen(entry: ServiceEntry): void;
  onClose(): void;
}) {
  const t = useT();
  const search = useRef<HTMLInputElement>(null);
  // Opened to find a service: typing starts the search.
  const dialog = useModal(open, { initialFocus: search });
  return (
    <dialog
      ref={dialog}
      data-testid="ai-add-sheet"
      aria-labelledby="ai-add-sheet-title"
      onClose={(event) => {
        // React passes "close" up its tree: it mustn't close the Settings dialog this one sits in.
        event.stopPropagation();
        onClose();
      }}
      className={`${dialogClass} w-[min(640px,calc(100vw-48px))] flex-col overflow-hidden p-0 open:flex`}
    >
      {open && (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pt-5 pb-3">
            <h2 id="ai-add-sheet-title" className="text-[17px] leading-6 font-semibold text-ink">
              {t("ai.add.title")}
            </h2>
            <ServiceDirectory offered={offered} added={added} onOpen={onOpen} searchRef={search} />
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-rule px-6 py-3">
            <p className="text-[12px] leading-[18px] text-ink-meta">{t("ai.add.foot")}</p>
            <button
              type="button"
              data-testid="ai-add-sheet-cancel"
              onClick={onClose}
              className={buttonStyle("secondary", "sm")}
            >
              {t("providers.settings.cancel")}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
