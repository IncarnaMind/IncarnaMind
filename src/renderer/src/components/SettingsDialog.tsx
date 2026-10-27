import { type ReactNode, useEffect, useState } from "react";
import type { LanguagePreference } from "../../../core/language";
import type { MessageKey } from "../../../shared/i18n";
import { core, files } from "../core";
import { useT } from "../i18n";
import { offeredSettingsPages, type SettingsPage, settingsPageLabels } from "../settingsPages";
import { recordUsage, useAppStore } from "../store";
import { AuthorNameSettings } from "./AuthorNameSettings";
import { AgentsSettings } from "./agents/AgentsSettings";
import { ConnectorsSettings } from "./connectors/ConnectorsSettings";
import { EvidenceSettings } from "./EvidenceSettings";
import { CloseLineIcon } from "./lineIcons";
import { MeetingsSettings } from "./MeetingsSettings";
import { MotionSettings } from "./MotionSettings";
import { OutputLocationSettings } from "./OutputLocationSettings";
import { PrivacySettings } from "./PrivacySettings";
import { EmbeddingSettingsSection } from "./providers/EmbeddingSettings";
import { ModelsSettings } from "./providers/ModelsSettings";
import { RerankSettingsSection } from "./providers/RerankSettings";
import { SavedWebPagesSettings } from "./SavedWebPagesSettings";
import { SkillScriptsSettings, SkillsSettings } from "./SkillsSettings";
import { SpendingCapSettings } from "./SpendingCapSettings";
import { SuggestionSettings } from "./SuggestionSettings";
import { TaskNotificationSettings } from "./TaskNotificationSettings";
import {
  buttonClass,
  dialogFrameClass,
  navRowClass,
  ruledListClass,
  sectionNoteClass,
  sectionTitleClass,
} from "./ui";
import { useBackdropClose, useModal } from "./useModal";
import { WebSearchSettings } from "./WebSearchSettings";

const languageOptions: readonly { value: LanguagePreference; label: MessageKey }[] = [
  { value: "system", label: "settings.language.system" },
  { value: "en", label: "settings.language.en" },
  { value: "zh-CN", label: "settings.language.zh-CN" },
];

const REPOSITORY_URL = "https://github.com/IncarnaMind/IncarnaMind";

/**
 * Settings, in a native modal <dialog>: a list of pages on the frame on the
 * left (General, Models, Search, Meetings, Connectors, Skills, Privacy; Memory joins when a setting lands on it), and the chosen page on the right under its serif title.
 */
export function SettingsDialog() {
  const t = useT();
  const open = useAppStore((state) => state.settingsOpen);
  const asks = useAppStore((state) => state.settingsOpenCount);
  const page = useAppStore((state) => state.settingsPage);
  const showPage = useAppStore((state) => state.showSettingsPage);
  const close = useAppStore((state) => state.closeSettings);
  const dialog = useModal(open, { request: asks });
  useBackdropClose(dialog, close);
  /** The pages shown since Settings opened. Closing forgets them. */
  const [visited, setVisited] = useState<readonly SettingsPage[]>([]);
  if (open && !visited.includes(page)) setVisited([...visited, page]);
  if (!open && visited.length > 0) setVisited([]);

  // Usage data: which pages people open (sent only while the User agrees).
  useEffect(() => {
    if (open) recordUsage({ event: "settings_page_viewed", fields: { page } });
  }, [open, page]);

  return (
    <dialog
      ref={dialog}
      // The browser can close the dialog and tell React a task later, by which time Settings may
      // have been asked for again: a close event that finds the dialog open is old news.
      onClose={(event) => {
        if (!event.currentTarget.open) close();
      }}
      data-testid="settings"
      data-page={page}
      aria-labelledby="settings-title"
      className={`${dialogFrameClass} h-[min(740px,calc(100vh-48px))] max-h-none w-[min(880px,calc(100vw-48px))] max-w-none overflow-hidden`}
    >
      <div className="flex h-full min-h-0">
        <nav
          aria-labelledby="settings-title"
          data-testid="settings-nav"
          className="flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-rule bg-frame p-2"
        >
          <div className="flex h-11 shrink-0 items-center px-2">
            <h2 id="settings-title" className="text-ui font-semibold text-ink">
              {t("settings.title")}
            </h2>
          </div>
          {offeredSettingsPages.map((each) => (
            <button
              key={each}
              type="button"
              data-testid={`settings-nav-${each}`}
              aria-current={page === each ? "page" : undefined}
              onClick={() => showPage(each)}
              className={navRowClass(page === each)}
            >
              {t(settingsPageLabels[each])}
            </button>
          ))}
        </nav>
        <section aria-labelledby="settings-page-title" className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[60px] shrink-0 items-center justify-between gap-3 pt-2 pr-4 pl-8">
            <h3
              id="settings-page-title"
              data-testid="settings-page-title"
              className="font-serif text-heading font-semibold text-ink [font-variation-settings:'opsz'_32]"
            >
              {t(settingsPageLabels[page])}
            </h3>
            <button
              type="button"
              data-testid="settings-close"
              aria-label={t("settings.close")}
              title={t("settings.close")}
              onClick={close}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-chip hover:text-ink focus-visible:outline-offset-0"
            >
              <CloseLineIcon className="size-4" />
            </button>
          </header>
          {/*
           * Rendered only while open, so each opening loads fresh data. A page
           * stays rendered (hidden) once shown, so a form half filled in, or
           * a Connector unfolded, are still there after a look at another page.
           */}
          <div className="relative min-h-0 flex-1">
            {visited.map((each) => (
              <div
                key={each}
                data-testid={`settings-page-${each}`}
                hidden={each !== page}
                className="absolute inset-0 overflow-y-auto px-8 pt-1 pb-8"
              >
                <PageContent page={each} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </dialog>
  );
}

function PageContent({ page }: { page: SettingsPage }) {
  switch (page) {
    case "general":
      return (
        <Page>
          <LanguageSettings />
          <SpendingCapSettings />
          <MotionSettings />
          <TaskNotificationSettings />
          <SuggestionSettings />
          <OutputLocationSettings />
          <AuthorNameSettings />
          <DataFolderSettings />
          <AboutSettings />
        </Page>
      );
    case "models":
      return <ModelsSettings />;
    case "search":
      return (
        <Page>
          <Titled title="embeddingProviders.settings.title">
            <EmbeddingSettingsSection />
          </Titled>
          <RerankSettingsSection />
          <WebSearchSettings />
          <SavedWebPagesSettings />
          <EvidenceSettings />
        </Page>
      );
    case "meetings":
      return (
        <Page>
          <MeetingsSettings />
        </Page>
      );
    case "connectors":
      return (
        <Page>
          <ConnectorsSettings />
        </Page>
      );
    case "skills":
      return (
        <Page>
          <SkillsSettings />
          <SkillScriptsSettings />
        </Page>
      );
    case "agents":
      return (
        <Page>
          <AgentsSettings />
        </Page>
      );
    case "privacy":
      return (
        <Page>
          <PrivacySettings />
        </Page>
      );
  }
}

/** A section under its title, for a part of a page that has none of its own. */
function Titled({
  title,
  testId,
  children,
}: {
  title: MessageKey;
  testId?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section data-testid={testId}>
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t(title)}</h4>
      {children}
    </section>
  );
}

/** A page's sections, 28px apart. */
function Page({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-7">{children}</div>;
}

/** Settings → General → Interface language: a ruled list of choices. */
function LanguageSettings() {
  const t = useT();
  const language = useAppStore((state) => state.settings?.user.language);
  const updateSettings = useAppStore((state) => state.updateSettings);
  return (
    <section data-testid="language-settings">
      <h4 id="language-title" className={`mb-2 ${sectionTitleClass}`}>
        {t("settings.language")}
      </h4>
      <div role="radiogroup" aria-labelledby="language-title" className={ruledListClass}>
        {languageOptions.map((option) => (
          <label
            key={option.value}
            className="flex h-10 cursor-pointer items-center gap-3 text-ui text-ink"
          >
            <input
              type="radio"
              name="language"
              value={option.value}
              checked={language === option.value}
              onChange={() => void updateSettings({ user: { language: option.value } })}
              className="size-4 shrink-0 accent-ink"
            />
            {t(option.label)}
          </label>
        ))}
      </div>
    </section>
  );
}

/**
 * Settings → General → Data folder: where everything is kept, opened in the
 * file manager for a backup, and its logs folder, e.g. for a bug report.
 */
function DataFolderSettings() {
  const t = useT();
  const open = (folder: Promise<void>) =>
    folder.catch((failure: unknown) => {
      useAppStore.getState().reportError(failure);
    });
  return (
    <section data-testid="data-folder-settings">
      <h4 className={sectionTitleClass}>{t("export.dataFolder.title")}</h4>
      <p className={sectionNoteClass}>
        {t("export.dataFolder.body")}
        <br />
        {t("export.dataFolder.backup")}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="open-data-folder"
          onClick={() => void open(files.openDataFolder())}
          className={buttonClass}
        >
          {t("export.dataFolder.open")}
        </button>
        <button
          type="button"
          data-testid="open-logs-folder"
          title={t("export.dataFolder.logs.tip")}
          onClick={() => void open(files.openLogsFolder())}
          className={buttonClass}
        >
          {t("export.dataFolder.openLogs")}
        </button>
      </div>
    </section>
  );
}

/** Settings → General → About: where IncarnaMind's source lives. */
function AboutSettings() {
  const t = useT();
  return (
    <section data-testid="about-settings">
      <h4 className={sectionTitleClass}>{t("settings.about.title")}</h4>
      <p className={sectionNoteClass}>{t("settings.about.body")}</p>
      <div className="flex flex-col items-start gap-1">
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-ui text-accent underline-offset-2 hover:text-accent-strong hover:underline"
        >
          {t("settings.about.repository")}
        </a>
        <button
          type="button"
          data-testid="about-citation-licences"
          onClick={() => core.openCitationStyleLicences().catch(useAppStore.getState().reportError)}
          className="text-ui text-accent underline-offset-2 hover:text-accent-strong hover:underline"
        >
          {t("settings.about.citationLicences")}
        </button>
      </div>
    </section>
  );
}
