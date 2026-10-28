import { useEffect, useId, useRef, useState } from "react";
import type {
  ChatModelChoice,
  ChatModelGroup,
  ChatProvider,
  ModelRoles,
} from "../../../../core/api";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { ReadProblem } from "../ReadProblem";
import { fieldClass, hintClass, ruledListClass, sectionTitleClass } from "../ui";
import { ModelHealthLine } from "./ModelHealthLine";
import { providerName } from "./ProviderPage";
import { SortingLine, SortingSelect, useSorting } from "./SortingChoice";

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

export const jobSelectClass = `${fieldClass} w-full max-w-[26rem] min-w-0 flex-1 basis-60`;
/** A row of its own: the field keeps one line's height, where the flex row above grows sideways. */
const rowSelectClass = `${fieldClass} w-full max-w-[26rem]`;

/**
 * Settings › Models: the same three rows as first run (#1922), each editable in place — your AI,
 * where meetings are transcribed, and what sorts Documents and names meeting hints. Quick tasks
 * and reading images follow your AI model, with no row of their own.
 */
export function ModelDefaults({
  groups,
  providers,
}: {
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
}) {
  const t = useT();
  const id = useId();
  const roles = useModelRoles(groups);

  return (
    <section data-testid="model-defaults" className="flex flex-col gap-2">
      <h4 className={sectionTitleClass}>{t("models.defaults.title")}</h4>
      <div className={ruledListClass}>
        <YourAiRow id={`${id}-ai`} groups={groups} providers={providers} roles={roles} />
        <TranscriptionRow id={`${id}-meetings`} />
        <SortingRow id={`${id}-sorting`} />
      </div>
      <TranscriptionRouteConsent />
    </section>
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
  return (
    <div data-testid="model-default-row-chatModel" className="flex flex-col gap-0.5 py-2">
      <label htmlFor={id} className="text-ui font-semibold text-ink">
        {t("models.defaults.yourAi")}
      </label>
      <span id={`${id}-tip`} className="sr-only">
        {t("models.defaults.answers.tip")}
      </span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <RoleSelect id={id} job="chatModel" groups={groups} providers={providers} roles={roles} />
        <ModelHealthLine />
      </div>
      {following && (
        <p data-testid="models-follow-answers" className={hintClass}>
          {t("models.defaults.followAnswers")}
        </p>
      )}
    </div>
  );
}

function TranscriptionRow({ id }: { id: string }) {
  const t = useT();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  return (
    <div
      data-testid="model-default-row-transcription"
      data-read-host
      className="flex flex-col gap-0.5 py-2"
    >
      <label htmlFor={id} className="text-ui font-semibold text-ink">
        {t("models.defaults.transcription")}
      </label>
      <TranscriptionRouteSelect id={id} className={rowSelectClass} localOnly={localOnly} />
    </div>
  );
}

function SortingRow({ id }: { id: string }) {
  const t = useT();
  const { options, current, choose, read } = useSorting();
  return (
    <div
      data-testid="model-default-row-sorting"
      data-read-host
      className="flex flex-col gap-0.5 py-2"
    >
      <label htmlFor={id} className="text-ui font-semibold text-ink">
        {t("models.defaults.sorting")}
      </label>
      {read.state === "failed" ? (
        <ReadProblem
          words={t("setup.sorting.failed")}
          read={read}
          testId="models-sorting-problem"
        />
      ) : (
        <>
          <SortingSelect
            id={id}
            className={rowSelectClass}
            options={options}
            current={current}
            onChange={(option) => void choose(option)}
          />
          <SortingLine option={current} reading={read.state === "loading"} />
        </>
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
  className = jobSelectClass,
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
    void updateSettings(
      job === "chatModel"
        ? // Quick tasks and reading images are automatic, with no row of their own (#1922).
          {
            user: { chatModel: choice, quickTasksModel: null, imageModel: null },
            device: { lastChatModel: choice },
          }
        : {
            user: job === "quickTasksModel" ? { quickTasksModel: choice } : { imageModel: choice },
          },
    );
    onChosen?.();
  };

  return (
    <select
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
    </select>
  );
}
