import { useEffect, useId, useRef, useState } from "react";
import type {
  ChatModelChoice,
  ChatModelGroup,
  ChatProvider,
  ModelRoles,
} from "../../../../core/api";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { core } from "../../core";
import { useGap, useLanguage, useT } from "../../i18n";
import { setAnswersModel } from "../../modelInUse";
import { useModelNames } from "../../modelNames";
import type { SettingsTarget } from "../../settingsPages";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import type { ServicesView } from "../../transcriptionServices";
import { TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { useTranscriptionSetUp } from "../meetings/TranscriptionSetUp";
import { ReadProblem } from "../ReadProblem";
import { PopUpSelect } from "../settings/PopUpButton";
import {
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsSection,
} from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";
import { DecisionSortingSetUp, firstModelOf } from "./DecisionKeyForm";
import { JevSortingSetUp } from "./JevSortingSetUp";
import { ModelHealthLine, useModelHealthFailure } from "./ModelHealthLine";
import { providerName } from "./ProviderPage";
import { SortingLine, SortingSelect, useSorting } from "./SortingChoice";
import { keyProviderOf, type SetUpOffer, type SortingOption } from "./sortingOptions";

export type Role = "chatModel" | "quickTasksModel" | "imageModel";

/** "" is Automatic: the setting left for the core to work out. */
export const keyOf = (choice: ChatModelChoice | null | undefined): string =>
  choice ? `${choice.providerId}\n${choice.modelId}` : "";

export const choiceOf = (value: string): ChatModelChoice | null => {
  const [providerId, modelId] = value.split("\n");
  return providerId && modelId ? { providerId, modelId } : null;
};

/** The models Automatic comes to for the other jobs, which follow the settings and the providers' menus. */
export function useModelRoles(groups: readonly ChatModelGroup[]): ModelRoles | null {
  const user = useAppStore((state) => state.settings?.user);
  const [roles, setRoles] = useState<ModelRoles | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again whenever they change.
  useEffect(() => {
    core.getModelRoles().then(setRoles, (failure: unknown) => {
      console.error("Couldn't read which models the other jobs use:", failure);
    });
  }, [user?.chatModel, user?.quickTasksModel, user?.imageModel, groups]);
  return roles;
}

/** A long model name is cut inside its pop-up button, not let to push the row's label aside. */
const popUpWidth = "max-w-64";

/**
 * Settings › Models: three rows, each editable in place — your AI,
 * where meetings are transcribed, and what sorts Documents and names meeting hints. Quick tasks
 * and reading images follow your AI model, with no row of their own. `services`: the page's one
 * read of the transcription services, which its row, the line under the list and Your providers'
 * transcription keys draw from.
 */
export function ModelDefaults({
  groups,
  providers,
  services,
}: {
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
  services: ServicesView;
}) {
  const t = useT();
  const id = useId();
  const roles = useModelRoles(groups);

  return (
    <SettingsSection title={t("models.defaults.title")} testId="model-defaults">
      <SettingsGroup>
        <YourAiRow id={`${id}-ai`} groups={groups} providers={providers} roles={roles} />
        <TranscriptionRow id={`${id}-meetings`} services={services} />
        <SortingRow id={`${id}-sorting`} />
      </SettingsGroup>
      <SettingsHelp className="flex flex-col gap-1 empty:hidden">
        <TranscriptionRouteConsent read={services} />
      </SettingsHelp>
    </SettingsSection>
  );
}

function YourAiRow({
  id,
  groups,
  providers,
  roles,
}: {
  id: string;
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
  roles: ModelRoles | null;
}) {
  const t = useT();
  // A choice kept from before the row went (#1922): it still wins, so the line would not be true.
  const following = useAppStore(
    (state) => !state.settings?.user.quickTasksModel && !state.settings?.user.imageModel,
  );
  const health = useModelHealthFailure();
  return (
    <SettingsRow
      data-testid="model-default-row-chatModel"
      label={t("models.defaults.yourAi")}
      htmlFor={id}
      detail={
        following ? (
          <span data-testid="models-follow-answers">{t("models.defaults.followAnswers")}</span>
        ) : undefined
      }
      control={
        <>
          <span id={`${id}-tip`} className="sr-only">
            {t("models.defaults.answers.tip")}
          </span>
          <RoleSelect id={id} job="chatModel" groups={groups} providers={providers} roles={roles} />
        </>
      }
    >
      {health && <ModelHealthLine />}
    </SettingsRow>
  );
}

const TRANSCRIPTION: readonly SettingsTarget[] = ["transcription"];

/** Where meetings are transcribed, with "Set up another transcription service" at its picker's foot. */
function TranscriptionRow({ id, services }: { id: string; services: ServicesView }) {
  const t = useT();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const setUp = useTranscriptionSetUp(id, services);
  const reached = useSettingsTarget<HTMLDivElement>(TRANSCRIPTION, true, () =>
    document.getElementById(id)?.focus(),
  );
  return (
    <SettingsRow
      ref={reached}
      data-testid="model-default-row-transcription"
      data-read-host
      label={t("models.defaults.transcription")}
      htmlFor={id}
      control={
        <TranscriptionRouteSelect
          id={id}
          popUp
          className={popUpWidth}
          localOnly={localOnly}
          read={services}
          setUp={setUp.rows}
          onChosen={setUp.onChosen}
        />
      }
    >
      {setUp.panel}
    </SettingsRow>
  );
}

function SortingRow({ id }: { id: string }) {
  const t = useT();
  const {
    settingsOptions: options,
    current,
    choose,
    read,
    library,
    setUpOffers,
    jevSettings,
    decisionHosts,
    reread,
  } = useSorting();
  const [settingUp, setSettingUp] = useState<SetUpOffer["id"] | null>(null);
  const close = () => {
    setSettingUp(null);
    document.getElementById(id)?.focus();
  };
  const host = decisionHosts?.find((each) => each.host === settingUp);
  const keyProvider = keyProviderOf(current, decisionHosts);
  const failed = read.state === "failed";
  return (
    <SettingsRow
      data-testid="model-default-row-sorting"
      data-read-host
      label={t("models.defaults.sorting")}
      htmlFor={failed ? undefined : id}
      control={
        failed ? undefined : (
          <SortingSelect
            id={id}
            popUp
            className={popUpWidth}
            options={options}
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
        // Choosing here never turns tagging on: Turn on… does, once Jev is chosen (#2308).
        <JevSortingSetUp
          jev={jevSettings}
          choose={async () => {
            const chosen = await choose({ classifier: { kind: "jev" } });
            reread();
            return chosen;
          }}
          onChosen={close}
          onCancel={close}
        />
      ) : host ? (
        // As for Jev: choosing here never turns tagging on; Turn on… does (#2308).
        <DecisionSortingSetUp
          key={host.host}
          host={host}
          choose={async () => {
            const chosen = await choose({ classifier: firstModelOf(host) });
            reread();
            return chosen;
          }}
          onChosen={close}
          onCancel={close}
        />
      ) : (
        <div className="flex flex-col gap-1">
          {keyProvider && !current?.unresolved && <UsesKeyLine catalogId={keyProvider} />}
          <SortingLine option={current} reading={read.state === "loading"} choosing={false} />
          {library && !library.settings.automatic && current && !current.unresolved && (
            <TurnOnTagging option={current} />
          )}
        </div>
      )}
    </SettingsRow>
  );
}

/** The chat provider's key the chosen decision model uses, which Your providers lists as that provider (#1907). */
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

const TURN_ON = ["turn-on-tagging"] as const;

/**
 * With tagging new Documents off, so a model chosen here tags nothing (#2308): a line that says
 * so, and Turn on…, which shows what each new Document would send, and to whom, before Use this
 * turns it on.
 */
function TurnOnTagging({ option }: { option: SortingOption }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const use = useRef<HTMLButtonElement>(null);
  const turnOn = useRef<HTMLButtonElement>(null);
  const reached = useSettingsTarget<HTMLDivElement>(TURN_ON, true, () => setAsking(true));
  useEffect(() => {
    if (asking) use.current?.focus();
  }, [asking]);
  const close = () => {
    setAsking(false);
    turnOn.current?.focus();
  };
  const turnOnNow = async () => {
    const settings = useAppStore.getState().library?.settings;
    if (!settings) return;
    try {
      await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
      await useAppStore.getState().refreshLibrary();
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };
  return (
    <div ref={reached} className="flex flex-col gap-1">
      <p data-testid="models-tagging-off" className="text-[12px] leading-5 text-ink-meta">
        {t("models.sorting.off")}
        <span aria-hidden="true"> · </span>
        <button
          ref={turnOn}
          type="button"
          data-testid="models-tagging-turn-on"
          aria-expanded={asking}
          onClick={() => setAsking(true)}
          className="font-semibold text-accent underline-offset-2 hover:underline"
        >
          {t("models.sorting.turnOn")}
        </button>
      </p>
      {asking && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes what Turn on… opened, as elsewhere in Settings.
        <div
          data-testid="models-tagging-consent"
          className="flex flex-col gap-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <SortingLine option={option} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              ref={use}
              type="button"
              data-testid="models-tagging-use"
              onClick={() => void turnOnNow()}
              className={buttonStyle("primary", "sm")}
            >
              {t("setup.step.useThis")}
            </button>
            <button
              type="button"
              data-testid="models-tagging-cancel"
              onClick={close}
              className="text-[13px] leading-5 font-semibold text-ink-secondary hover:text-ink"
            >
              {t("library.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The choice for one job, in the list of models the providers offer it, with Automatic where the core can work it out. */
export function RoleSelect({
  id,
  job,
  groups,
  providers,
  roles,
  className = popUpWidth,
  labelledBy,
  focusOnShow,
  onChosen,
  onBlur,
  onEscape,
}: {
  id: string;
  job: Role;
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
  roles: ModelRoles | null;
  className?: string;
  /** The element that names it, where its label isn't one that points at it. */
  labelledBy?: string;
  /** It takes the focus when it shows (Change was just pressed). */
  focusOnShow?: boolean;
  onChosen?(): void;
  onBlur?(): void;
  onEscape?(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const field = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focusOnShow) field.current?.focus();
  }, [focusOnShow]);
  const user = useAppStore((state) => state.settings?.user);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const saved = keyOf(user?.[job]);
  // Shown at once; the setting follows when the core has it.
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);

  const modelOf = (choice: ChatModelChoice) => nameOf(choice.modelId, choice.providerId).name;
  const labelOf = (choice: ChatModelChoice) => {
    const group = groups.find((each) => each.provider.id === choice.providerId);
    return group
      ? `${modelOf(choice)} · ${providerName(group.provider, t, language)}`
      : modelOf(choice);
  };
  const options = groups.flatMap((group) =>
    group.models
      .filter((modelId) => job !== "imageModel" || group.about[modelId]?.readsImages)
      .map((modelId) => ({ providerId: group.provider.id, modelId })),
  );
  const current = choiceOf(value);
  // A provider's menu may not list the model in use, or not have loaded yet.
  if (
    current &&
    providers.some((each) => each.id === current.providerId) &&
    !options.some((each) => keyOf(each) === value)
  ) {
    options.unshift(current);
  }
  const automatic =
    job === "chatModel"
      ? null
      : ((job === "quickTasksModel" ? roles?.quickTasks : roles?.images) ?? null);
  const empty = options.length === 0;
  // Nothing to choose, which the setup card's Change still opens, to say so: no dead end. Not
  // said before the list has come, when nothing is known to read images or not.
  const none = empty && job === "imageModel" && groups.length > 0;

  const choose = (next: string) => {
    const choice = choiceOf(next);
    if (job === "chatModel" && !choice) return;
    setValue(next);
    if (job === "chatModel" && choice) void setAnswersModel(choice);
    else {
      void updateSettings({
        user: job === "quickTasksModel" ? { quickTasksModel: choice } : { imageModel: choice },
      });
    }
    onChosen?.();
  };

  return (
    <PopUpSelect
      ref={field}
      id={id}
      aria-describedby={`${id}-tip`}
      aria-labelledby={labelledBy}
      data-testid={`model-default-${job}`}
      value={value}
      disabled={empty && !focusOnShow}
      title={current ? current.modelId : undefined}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      onChange={(event) => choose(event.target.value)}
      className={className}
    >
      {job === "chatModel" ? (
        (empty || !current) && <option value="">{t("models.defaults.noModel")}</option>
      ) : (
        <option value="">
          {automatic
            ? t("models.defaults.automatic", { model: modelOf(automatic) })
            : t(none ? "models.defaults.images.none" : "models.defaults.automaticNone")}
        </option>
      )}
      {options.map((choice) => (
        <option key={keyOf(choice)} value={keyOf(choice)} title={choice.modelId}>
          {labelOf(choice)}
        </option>
      ))}
    </PopUpSelect>
  );
}
