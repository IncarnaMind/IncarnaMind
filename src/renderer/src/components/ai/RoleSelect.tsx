import { useEffect, useState } from "react";
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
import { providerName } from "../providers/ProviderPage";
import { PopUpSelect } from "../settings/PopUpButton";
import { groupByPayer, type Payer, payerOf } from "./payers";

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
export const popUpWidth = "max-w-64";

/** An option group's name: the plan that includes it, the User's keys, or this computer. */
export function usePayerName(providers: readonly ChatProvider[]): (payer: Payer) => string {
  const t = useT();
  const language = useLanguage();
  return (payer) => {
    if (payer.kind === "keys") return t("ai.payer.keys");
    if (payer.kind === "local") return t("ai.payer.local");
    const plan = providers.find((each) => each.id === payer.providerId);
    return t("ai.payer.plan", { plan: plan ? providerName(plan, t, language) : "" });
  };
}

/**
 * The choice for one job, among the models the providers offer it, grouped by who pays. Quick
 * tasks and reading images start on Automatic, which follows the Answers model: "Follows Answers
 * · {model}".
 */
export function RoleSelect({
  id,
  job,
  groups,
  providers,
  roles,
  describedBy,
}: {
  id: string;
  job: Role;
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
  roles: ModelRoles | null;
  describedBy?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const payerName = usePayerName(providers);
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
  const providerOf = (choice: ChatModelChoice) =>
    providers.find((each) => each.id === choice.providerId) ??
    groups.find((each) => each.provider.id === choice.providerId)?.provider;
  const grouped = groupByPayer(options, (choice) => {
    const provider = providerOf(choice);
    return provider ? payerOf(provider) : { kind: "keys" };
  });
  const automatic =
    job === "chatModel"
      ? null
      : ((job === "quickTasksModel" ? roles?.quickTasks : roles?.images) ?? null);
  const empty = options.length === 0;
  // Nothing reads images: said, not left as a blank choice. Not before the list has come.
  const none = empty && job === "imageModel" && groups.length > 0;

  const choose = (next: string) => {
    const choice = choiceOf(next);
    if (job === "chatModel" && !choice) return;
    setValue(next);
    void updateSettings(
      job === "chatModel"
        ? // Choosing Answers sets the jobs that follow it back to following it.
          {
            user: { chatModel: choice, quickTasksModel: null, imageModel: null },
            device: { lastChatModel: choice },
          }
        : {
            user: job === "quickTasksModel" ? { quickTasksModel: choice } : { imageModel: choice },
          },
    );
  };

  return (
    <PopUpSelect
      id={id}
      aria-describedby={describedBy}
      data-testid={`model-default-${job}`}
      value={value}
      disabled={empty}
      title={current ? current.modelId : undefined}
      onChange={(event) => choose(event.target.value)}
      className={popUpWidth}
    >
      {job === "chatModel" ? (
        (empty || !current) && <option value="">{t("models.defaults.noModel")}</option>
      ) : (
        <option value="">
          {automatic
            ? t("ai.jobs.follows", { model: modelOf(automatic) })
            : t(none ? "models.defaults.images.none" : "ai.jobs.followsNone")}
        </option>
      )}
      {grouped.map(({ payer, items }) => (
        <optgroup
          key={payer.kind === "plan" ? payer.providerId : payer.kind}
          label={payerName(payer)}
        >
          {items.map((choice) => (
            <option key={keyOf(choice)} value={keyOf(choice)} title={choice.modelId}>
              {labelOf(choice)}
            </option>
          ))}
        </optgroup>
      ))}
    </PopUpSelect>
  );
}
