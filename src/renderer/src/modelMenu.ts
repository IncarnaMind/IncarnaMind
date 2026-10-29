/**
 * "Choose another model" from an Answer that couldn't add Citations (#765), or that failed on its
 * model (#1848), opens the composer's model menu: each request counts up, and the composer's
 * model chip opens its menu when the count changes. A model picked there is kept with when, so
 * the failed Answer can offer to be asked again with it.
 */
import { create } from "zustand";
import type { ChatModelChoice } from "../../core/api";

export const useModelMenuRequests = create<{ count: number }>()(() => ({ count: 0 }));

export const requestModelMenu = () =>
  useModelMenuRequests.setState((state) => ({ count: state.count + 1 }));

const useModelPicks = create<{ pick: { choice: ChatModelChoice; at: number } | null }>()(() => ({
  pick: null,
}));

/** The composer's model chip: the User chose this model for the Mind's next Questions. */
export const noteModelPick = (choice: ChatModelChoice) =>
  useModelPicks.setState({ pick: { choice, at: Date.now() } });

/** A model the User picked (with when, in ms) that counts for a failure at `since` (ISO 8601) on `failed`. */
export function pickedSince(
  pick: { choice: ChatModelChoice; at: number } | null,
  since: string,
  failed: { providerId: string | null; modelId: string | null },
): ChatModelChoice | null {
  if (!pick || pick.at <= Date.parse(since)) return null;
  const { providerId, modelId } = pick.choice;
  return providerId === failed.providerId && modelId === failed.modelId ? null : pick.choice;
}

/**
 * The model the User picked in the composer since `since`, when it isn't the one that failed:
 * what a failed Answer can be asked again with. Null until then.
 */
export function useModelPickedSince(
  since: string,
  failed: { providerId: string | null; modelId: string | null },
): ChatModelChoice | null {
  return pickedSince(
    useModelPicks((state) => state.pick),
    since,
    failed,
  );
}
