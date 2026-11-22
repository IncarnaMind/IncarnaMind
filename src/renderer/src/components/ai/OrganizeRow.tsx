import { type CSSProperties, useId, useState } from "react";
import type { LibrarySettings, TaggingModels } from "../../../../core/api";
import { formatTime } from "../../../../shared/dates";
import { listOf } from "../../../../shared/i18n/join";
import { sortingSwitchOn } from "../../../../shared/libraryModels";
import { useAgentAlone } from "../../agentNote";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { placesText, stoppedPlaces, tagWithAi } from "../../taggingStop";
import { useUndo } from "../../undo";
import { ProblemLine } from "../ProblemLine";
import type { useSorting } from "../providers/SortingChoice";
import type { SortingOption } from "../providers/sortingOptions";
import { SettingsRow, SettingsSwitch } from "../settings/SettingsGroup";
import { useTaggingService } from "../useTaggingService";
import { useSortingPicker } from "./SortingPicker";

const TAGGING = ["tagging"] as const;
const TURN_ON = ["turn-on-tagging"] as const;

/**
 * Settings › AI › Organize and Tags: the one model for Organize, Tags and meeting hints, set up in
 * place from its picker's foot (Jev, a decision model host), and its options under it: sorting
 * and tagging new Documents as they arrive, and reading scans as page images.
 */
export function OrganizeRows({
  id,
  sorting,
}: {
  id: string;
  /** The page's one read of what can sort (`useSorting`), which Accounts and keys reads too. */
  sorting: ReturnType<typeof useSorting>;
}) {
  const t = useT();
  const { current, read, library } = sorting;
  const agentAlone = useAgentAlone();
  const picker = useSortingPicker(id, sorting);

  const failed = picker.failed;
  const optionsShown = library !== null && !failed && current !== null && !current.unresolved;
  const switchId = `${id}-automatic`;
  const reached = useSettingsTarget<HTMLDivElement>(TAGGING, true, () =>
    document.getElementById(id)?.focus(),
  );
  // Its switch shows once what sorts now is known: until then, the target waits for it.
  useSettingsTarget<HTMLDivElement>(TURN_ON, optionsShown, () =>
    document.getElementById(switchId)?.focus(),
  );
  const models = read.state === "ready" ? read.data : null;
  const hints = current && !current.unresolved ? current.decisionModel : null;
  return (
    <>
      <SettingsRow
        ref={reached}
        data-testid="model-default-row-sorting"
        data-read-host
        label={t("ai.jobs.organize")}
        htmlFor={failed ? undefined : id}
        detail={
          agentAlone && read.state === "ready" && !current
            ? t("ai.jobs.organize.agent")
            : hints !== null && (
                <span data-testid="ai-organize-hints">
                  {t(hints ? "ai.jobs.organize.hints" : "ai.jobs.organize.noHints")}
                </span>
              )
        }
        control={picker.control}
      >
        {picker.below}
      </SettingsRow>
      {optionsShown && library && current && (
        <OrganizeOptions
          switchId={switchId}
          settings={library.settings}
          option={current}
          models={models}
        />
      )}
    </>
  );
}

/** An option sits under its job's row, its words and the hairline above it indented past the row's. */
const optionRow = {
  className: "pl-6",
  style: { "--row-inset": "40px" } as CSSProperties,
};

/**
 * The Organize and Tags row's options, under it. Turning on sorting new Documents as they arrive
 * is the consent for the service the line names (ADR-0022, #2308); so is reading scans as page
 * images, for the service that reads them.
 */
function OrganizeOptions({
  switchId,
  settings,
  option,
  models,
}: {
  switchId: string;
  settings: LibrarySettings;
  option: SortingOption | null;
  models: TaggingModels | null;
}) {
  const t = useT();
  const language = useLanguage();
  const library = useAppStore((state) => state.library);
  const [problem, setProblem] = useState<string | null>(null);
  const on = library ? sortingSwitchOn(library) : settings.automatic;
  const asks = library?.asksFor ?? [];
  const save = async (next: Partial<LibrarySettings> & { turnOn?: boolean }) => {
    setProblem(null);
    try {
      await core.saveLibrarySettings({ ...settings, ...next });
      await useAppStore.getState().refreshLibrary();
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  const resolved = option && !option.unresolved ? option : null;
  // In Local mode nothing goes to a cloud model, so the line says that rather than where it would.
  const sends = !resolved
    ? null
    : !resolved.provider
      ? t("tagging.automatic.local")
      : models?.localMode
        ? t("tagging.localMode")
        : t("setup.sorting.sendsWhenOn", { service: resolved.provider });
  const stopped = stoppedPlaces(library);
  return (
    <>
      <SettingsRow
        {...optionRow}
        data-testid="ai-organize-automatic"
        label={t("ai.organize.automatic")}
        htmlFor={switchId}
        detail={
          <>
            {sends && <p data-testid="tagging-automatic-sends">{sends}</p>}
            {asks.length > 0 && (
              <p data-testid="tagging-automatic-asks">
                {t("ai.organize.automatic.asks", {
                  service: listOf(
                    asks.map((each) => each.name),
                    language,
                  ),
                })}
              </p>
            )}
            <p>{t("ai.organize.automatic.line")}</p>
            {models?.planPausedUntil && (
              <p data-testid="tagging-plan-paused">
                {t("tagging.plan.paused", { time: formatTime(models.planPausedUntil, language) })}
              </p>
            )}
            {stopped.length > 0 && (
              <p data-testid="tagging-stopped">
                {t("tagging.stoppedIn", { places: placesText(stopped, library, t, language) })}{" "}
                <button
                  type="button"
                  data-testid="tagging-restart"
                  onClick={() =>
                    void tagWithAi(stopped).then(
                      (change) => useUndo.getState().push(change),
                      (failure: unknown) => setProblem(errorMessage(failure, t)),
                    )
                  }
                  className="text-accent underline-offset-2 hover:text-accent-strong hover:underline"
                >
                  {t("folder.tagWithAi")}
                </button>
              </p>
            )}
          </>
        }
        control={
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            data-testid="tagging-automatic-organize"
            aria-checked={on}
            checked={on}
            disabled={!resolved}
            onChange={(event) =>
              void save({ automatic: event.target.checked, turnOn: event.target.checked })
            }
            className="switch"
          />
        }
      >
        {problem && <ProblemLine>{problem}</ProblemLine>}
      </SettingsRow>
      <PageImagesRow />
    </>
  );
}

/**
 * Reading a scan with no text sends its first pages as pictures to the service that reads images
 * for Organize: its own switch, per service (ADR-0022), shown while that service is a cloud one.
 */
function PageImagesRow() {
  const t = useT();
  const id = useId();
  const reader = useTaggingService("scan-images", true);
  const [problem, setProblem] = useState<string | null>(null);
  if (reader.route.where !== "cloud" || !reader.known) return null;
  const service = reader.route.service;
  const set = async (on: boolean) => {
    setProblem(null);
    try {
      if (on) await core.allowDataFlow("scan-images", service.id);
      else await core.revokeConsent("scan-images", service.id);
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  const switchId = `${id}-switch`;
  return (
    <SettingsRow
      {...optionRow}
      data-testid="ai-organize-page-images"
      label={t("ai.organize.pageImages")}
      htmlFor={switchId}
      detail={t("ai.organize.pageImages.line", { service: service.name })}
      control={
        <SettingsSwitch
          id={switchId}
          testId="ai-organize-page-images-switch"
          checked={reader.allowed === true}
          onChange={(on) => void set(on)}
        />
      }
    >
      {problem && <ProblemLine>{problem}</ProblemLine>}
    </SettingsRow>
  );
}
