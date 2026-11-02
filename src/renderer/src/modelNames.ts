import { type ModelSource, modelName } from "../../shared/modelName";
import { useAnswers } from "./answers";
import { useT } from "./i18n";
import { useAppStore } from "./store";

/** What shows a model: its name, and its id for the tooltip where the two differ. */
export interface ShownModel {
  name: string;
  /** The id, to show on hover; undefined when the name is the id. */
  id: string | undefined;
}

/**
 * Names models for display (`modelName`), knowing the providers the menu has
 * loaded: with a provider id, that provider's kind and own names; without one,
 * any loaded provider's names, then the whole catalog.
 */
export function shownModelNow(modelId: string, providerId?: string | null): ShownModel {
  const groups = useAnswers.getState().models;
  const readiness = useAppStore.getState().chatReadiness;
  const group = providerId ? groups?.find((each) => each.provider.id === providerId) : undefined;
  const current =
    providerId && readiness?.ready === true && readiness.provider.id === providerId
      ? readiness.provider
      : undefined;
  const source: ModelSource = group
    ? { kind: group.provider.kind, endpoint: group.provider.endpoint, names: group.names }
    : current
      ? { kind: current.kind, endpoint: current.endpoint }
      : { names: groups?.find((each) => each.names[modelId])?.names };
  const name = modelName(modelId, source);
  return { name, id: name === modelId ? undefined : modelId };
}

/** As `shownModelNow`, and drawn again when the names it reads change. */
export function useModelNames(): (modelId: string, providerId?: string | null) => ShownModel {
  useAnswers((state) => state.models);
  useAppStore((state) => state.chatReadiness);
  return shownModelNow;
}

/** The company a failed request went to, else its kind: how a problem line says whose side failed. */
export function useServiceName(providerId: string | null): string {
  const t = useT();
  const provider = useAnswers(
    (state) => state.models?.find((group) => group.provider.id === providerId)?.provider,
  );
  return provider
    ? (provider.service?.name ?? t(`providers.kind.${provider.kind}`))
    : t("answer.error.thisService");
}
