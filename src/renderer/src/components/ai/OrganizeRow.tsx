import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import type { LibrarySettings, TaggingModels } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { formatTime } from "../../../../shared/dates";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useGap, useLanguage, useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { placesText, stoppedPlaces, tagWithAi } from "../../taggingStop";
import { useUndo } from "../../undo";
import { ProblemLine } from "../ProblemLine";
import { DecisionSortingSetUp, firstModelOf } from "../providers/DecisionKeyForm";
import { JevSortingSetUp } from "../providers/JevSortingSetUp";
import { SortingSelect, type useSorting } from "../providers/SortingChoice";
import {
  keyProviderOf,
  type SetUpOffer,
  type SortingOption,
  sortingKey,
} from "../providers/sortingOptions";
import { ReadProblem } from "../ReadProblem";
import { SettingsRow, SettingsSwitch } from "../settings/SettingsGroup";
import { useTaggingService } from "../useTaggingService";
import { popUpWidth } from "./RoleSelect";

type Translate = ReturnType<typeof useT>;

const REACHED_BY = ["tagging", "turn-on-tagging"] as const;

/** Who pays for a sorting model, as the core groups its list; a plan by its own name. */
type SortingPayer = { kind: "plan"; name: string } | { kind: "keys" } | { kind: "local" };

/**
 * Everything that can sort, grouped by who pays: the list the picker always had first (the best
 * each key reaches, Jev, the User's AI model, the models on this computer), then every other model
 * the core lists, which Advanced › Tagging listed before.
 */
export function organizeGroups(
  shown: readonly SortingOption[],
  models: TaggingModels | null,
  language: Language,
  t: Translate,
): { label: string; options: SortingOption[] }[] {
  const words = language === "zh-CN" ? "zh" : "en";
  const listed = new Map(
    (models?.options ?? []).map((each) => [sortingKey(each.classifier), each]),
  );
  const all = [...shown];
  const seen = new Set(shown.map((each) => sortingKey(each.classifier)));
  for (const each of models?.options ?? []) {
    const key = sortingKey(each.classifier);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = each.classifier.kind === "auto" ? t("tagging.decision.auto") : each.name;
    const provider = each.provider ? each.provider[words] : null;
    all.push({
      classifier: each.classifier,
      label: provider ? `${name} · ${provider}` : name,
      provider: each.group === "local" ? null : provider,
      decisionModel: each.decisionModel,
      ...(each.classifier.kind === "chat" && { modelName: each.name }),
    });
  }
  const payerOf = (option: SortingOption): SortingPayer => {
    const known = listed.get(sortingKey(option.classifier));
    if (known?.group === "plan") return { kind: "plan", name: known.provider?.[words] ?? "" };
    if (known?.group === "local" || (!known && option.provider === null)) return { kind: "local" };
    return { kind: "keys" };
  };
  const labelOf = (payer: SortingPayer) =>
    payer.kind === "plan"
      ? t("ai.payer.plan", { plan: payer.name })
      : t(payer.kind === "keys" ? "ai.payer.keys" : "ai.payer.local");
  const groups = new Map<string, { rank: number; label: string; options: SortingOption[] }>();
  for (const option of all) {
    const payer = payerOf(option);
    const label = labelOf(payer);
    const rank = payer.kind === "plan" ? 0 : payer.kind === "keys" ? 1 : 2;
    const group = groups.get(label);
    if (group) group.options.push(option);
    else groups.set(label, { rank, label, options: [option] });
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ label, options }) => ({ label, options }));
}

/**
 * Settings › AI › Organize and Tags: the one model for Organize, Tags and meeting hints, set up in
 * place from its picker's foot (Jev, a decision model host), and its options with it once the row
 * is opened: sorting and tagging new Documents as they arrive, and reading scans as page images.
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
  const language = useLanguage();
  const {
    settingsOptions,
    current,
    choose,
    read,
    library,
    setUpOffers,
    jevSettings,
    decisionHosts,
    reread,
  } = sorting;
  const [settingUp, setSettingUp] = useState<SetUpOffer["id"] | null>(null);

  const reached = useSettingsTarget<HTMLDivElement>(REACHED_BY, true);
  const close = () => {
    setSettingUp(null);
    document.getElementById(id)?.focus();
  };
  const host = decisionHosts?.find((each) => each.host === settingUp);
  const keyProvider = keyProviderOf(current, decisionHosts);
  const failed = read.state === "failed";
  const models = read.state === "ready" ? read.data : null;
  const groups = organizeGroups(settingsOptions, models, language, t);
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
          hints !== null && (
            <span data-testid="ai-organize-hints">
              {t(hints ? "ai.jobs.organize.hints" : "ai.jobs.organize.noHints")}
            </span>
          )
        }
        control={
          failed ? undefined : (
            <SortingSelect
              id={id}
              popUp
              className={popUpWidth}
              options={settingsOptions}
              groups={groups}
              current={current}
              setUp={{ offers: setUpOffers, open: settingUp, onChoose: setSettingUp }}
              onChange={(option) => {
                setSettingUp(null);
                void choose(option);
              }}
            />
          )
        }
      >
        {failed ? (
          <ReadProblem
            words={t("setup.sorting.failed")}
            read={read}
            testId="models-sorting-problem"
          />
        ) : settingUp === "jev" && jevSettings ? (
          // Choosing here never turns tagging on: its own switch does, with its line (#2308).
          <JevSortingSetUp
            jev={jevSettings}
            choosing={false}
            choose={async () => {
              const chosen = await choose({ classifier: { kind: "jev" } });
              reread();
              return chosen;
            }}
            onChosen={close}
            onCancel={close}
          />
        ) : host ? (
          <DecisionSortingSetUp
            key={host.host}
            host={host}
            choosing={false}
            choose={async () => {
              const chosen = await choose({ classifier: firstModelOf(host) });
              reread();
              return chosen;
            }}
            onChosen={close}
            onCancel={close}
          />
        ) : (
          keyProvider && !current?.unresolved && <UsesKeyLine catalogId={keyProvider} />
        )}
      </SettingsRow>
      {library && !failed && current && !current.unresolved && (
        <OrganizeOptions settings={library.settings} option={current} models={models} />
      )}
    </>
  );
}

/** The chat provider's key the chosen decision model uses, which Accounts and keys lists as that company (#1907). */
function UsesKeyLine({ catalogId }: { catalogId: string }) {
  const t = useT();
  const language = useLanguage();
  const spaced = useGap();
  const named = catalogProvider(catalogId)?.name[language === "zh-CN" ? "zh" : "en"] ?? catalogId;
  // The Chinese line has no spaces of its own: a Latin name gets them, a Chinese one none.
  const provider =
    language === "zh-CN" ? `${spaced("汉", named)}${named}${spaced(named, "汉")}` : named;
  return (
    <p data-testid="models-sorting-key" className="text-[12px] leading-5 text-ink-meta">
      {t("decisions.usesKey", { provider })}
    </p>
  );
}

/** An option sits under its job's row, its words and the hairline above it indented past the row's. */
const optionRow = {
  className: "pl-6",
  style: { "--row-inset": "40px" } as CSSProperties,
};

/**
 * The Organize and Tags row's options, under it once it is opened. Turning on sorting new
 * Documents as they arrive is the consent for the service the line names (ADR-0022, #2308); so is
 * reading scans as page images, for the service that reads them.
 */
function OrganizeOptions({
  settings,
  option,
  models,
}: {
  settings: LibrarySettings;
  option: SortingOption | null;
  models: TaggingModels | null;
}) {
  const t = useT();
  const language = useLanguage();
  const library = useAppStore((state) => state.library);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = useRef<HTMLInputElement>(null);
  const turnOnAsked = useAppStore((state) => state.settingsAt === "turn-on-tagging");
  useEffect(() => {
    if (turnOnAsked) toggle.current?.focus();
  }, [turnOnAsked]);
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
  const sends = !resolved
    ? null
    : resolved.provider
      ? t("setup.sorting.sendsWhenOn", { service: resolved.provider })
      : t("tagging.automatic.local");
  const stopped = stoppedPlaces(library);
  const switchId = useId();
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
            ref={toggle}
            id={switchId}
            type="checkbox"
            role="switch"
            data-testid="tagging-automatic-organize"
            aria-checked={settings.automatic}
            checked={settings.automatic}
            disabled={!resolved}
            onChange={(event) =>
              void save(
                event.target.checked ? { automatic: true, turnOn: true } : { automatic: false },
              )
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
