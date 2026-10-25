import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type {
  ChatModelChoice,
  ChatModelGroup,
  ChatProvider,
  ModelRoles,
} from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { fieldClass, ruledListClass, sectionTitleClass } from "../ui";
import { ModelHealthLine } from "./ModelHealthLine";
import { providerName } from "./ProviderPage";

export type Role = "chatModel" | "quickTasksModel" | "imageModel";

export const ROWS: readonly { role: Role; label: MessageKey; tip: MessageKey }[] = [
  { role: "chatModel", label: "models.defaults.answers", tip: "models.defaults.answers.tip" },
  {
    role: "quickTasksModel",
    label: "models.defaults.quickTasks",
    tip: "models.defaults.quickTasks.tip",
  },
  { role: "imageModel", label: "models.defaults.images", tip: "models.defaults.images.tip" },
];

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

/** What a job's model is, in a line: its name and provider, or Automatic and the model it comes to. */
export function useJobSummary(
  role: Role,
  groups: readonly ChatModelGroup[],
  roles: ModelRoles | null,
  providers: readonly ChatProvider[] = [],
): string {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const user = useAppStore((state) => state.settings?.user);
  const modelOf = (choice: ChatModelChoice) => nameOf(choice.modelId, choice.providerId).name;
  const chosen = user?.[role];
  if (chosen) {
    const provider =
      groups.find((each) => each.provider.id === chosen.providerId)?.provider ??
      providers.find((each) => each.id === chosen.providerId);
    return provider
      ? `${modelOf(chosen)} · ${providerName(provider, t, language)}`
      : modelOf(chosen);
  }
  if (role === "chatModel") return t("models.defaults.noModel");
  const automatic = role === "quickTasksModel" ? roles?.quickTasks : roles?.images;
  if (automatic) return t("models.defaults.automatic", { model: modelOf(automatic) });
  const loaded = groups.length > 0;
  return t(
    role === "imageModel" && loaded
      ? "models.defaults.images.none"
      : "models.defaults.automaticNone",
  );
}

/** One job's name on the left and what it uses on the right, in Settings and at first run. */
export function JobRow({
  id,
  label,
  tip,
  testId,
  children,
}: {
  id: string;
  label: string;
  tip: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-1 py-2">
      <label
        htmlFor={id}
        title={tip}
        className="text-ui font-semibold text-ink"
        data-testid={testId}
      >
        {label}
      </label>
      <span id={`${id}-tip`} className="sr-only">
        {tip}
      </span>
      {children}
    </div>
  );
}

export const jobSelectClass = `${fieldClass} w-full max-w-[26rem] min-w-0 flex-1 basis-60`;

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
        {ROWS.map((row) => (
          <JobRow
            key={row.role}
            id={`${id}-${row.role}`}
            label={t(row.label)}
            tip={t(row.tip)}
            testId={`model-default-label-${row.role}`}
          >
            <RoleSelect
              id={`${id}-${row.role}`}
              role={row.role}
              groups={groups}
              providers={providers}
              roles={roles}
            />
            {row.role === "chatModel" && <ModelHealthLine />}
          </JobRow>
        ))}
        <JobRow
          id={`${id}-meetings`}
          label={t("models.defaults.meetings")}
          tip={t("models.defaults.meetings.tip")}
          testId="model-default-label-meetings"
        >
          <TranscriptionRouteSelect id={`${id}-meetings`} className={jobSelectClass} />
        </JobRow>
      </div>
      <TranscriptionRouteConsent />
    </section>
  );
}

/** The choice for one job, in the list of models the providers offer it, with Automatic where the core can work it out. */
export function RoleSelect({
  id,
  role,
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
  role: Role;
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
  const saved = keyOf(user?.[role]);
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
      .filter((modelId) => role !== "imageModel" || group.about[modelId]?.readsImages)
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
    role === "chatModel"
      ? null
      : ((role === "quickTasksModel" ? roles?.quickTasks : roles?.images) ?? null);
  const empty = options.length === 0;
  // Nothing to choose, which the setup card's Change still opens, to say so: no dead end. Not
  // said before the list has come, when nothing is known to read images or not.
  const none = empty && role === "imageModel" && groups.length > 0;

  const choose = (next: string) => {
    const choice = choiceOf(next);
    if (role === "chatModel" && !choice) return;
    setValue(next);
    void updateSettings(
      role === "chatModel"
        ? { user: { chatModel: choice }, device: { lastChatModel: choice } }
        : {
            user: role === "quickTasksModel" ? { quickTasksModel: choice } : { imageModel: choice },
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
      data-testid={`model-default-${role}`}
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
      {role === "chatModel" ? (
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
