/**
 * The one action a group of Organize failures offers (#2308), on the Answer's
 * own ways on: adding credit, checking the key, or another model for Organize.
 */

import { core } from "./core";
import { billingUrlOfProvider, useKeyRefusals } from "./keyRefusals";
import type { ReviewProblemKind } from "./reviewProblems";
import { useAppStore } from "./store";

/** Settings › Models › Advanced › Tagging: the one model choice for tagging and Organize. */
const organizeModelSettings = () => useAppStore.getState().openSettings("models", "tagging");

export async function fixOrganizeProblem(kind: ReviewProblemKind): Promise<void> {
  const { reportError } = useAppStore.getState();
  try {
    if (kind === "rateLimit") return;
    if (kind === "planLimit") {
      organizeModelSettings();
      return;
    }
    const route = await core.getTaggingRoute("classification");
    if (route.where !== "cloud") {
      organizeModelSettings();
      return;
    }
    if (kind === "keyRefused") {
      await useKeyRefusals.getState().checkService(route.service.id);
      return;
    }
    const providers = await core.listChatProviders();
    const provider = providers.find((each) => each.service?.id === route.service.id);
    const url = billingUrlOfProvider(provider);
    if (provider && url) useKeyRefusals.getState().openBilling(provider.id, url);
    else organizeModelSettings();
  } catch (error) {
    reportError(error);
  }
}
