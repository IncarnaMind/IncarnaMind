/**
 * "Choose another model" from an Answer that couldn't add Citations (#765), or that failed on its
 * model (#1848), opens the composer's model menu: each request counts up, and the composer's
 * model chip opens its menu when the count changes.
 */
import { create } from "zustand";
import type { ChatModelChoice } from "../../core/api";

export const useModelMenuRequests = create<{ count: number }>()(() => ({ count: 0 }));

export const requestModelMenu = () =>
  useModelMenuRequests.setState((state) => ({ count: state.count + 1 }));

/**
 * The model a failed Answer can be asked again with: the one the composer's chip shows now, when it
 * isn't the one that failed. The chip is the Note's own pick, else the last one, else the default,
 * so a pick in the menu, one made elsewhere, and the fall-back when its service is removed all
 * count, in any window and after a relaunch.
 */
export function retryModel(
  failed: { providerId: string | null; modelId: string | null },
  inUse: ChatModelChoice | null,
): ChatModelChoice | null {
  if (!inUse) return null;
  return inUse.providerId === failed.providerId && inUse.modelId === failed.modelId ? null : inUse;
}
