/**
 * The one action a group of Organize failures offers (#2308): add credit, check
 * the key, or choose another model, in the words the Answer's problems already
 * use. Once the User is back from adding credit, the group tries once by itself
 * (#2535).
 */

import { core } from "./core";
import { billingUrlOfProvider, useKeyRefusals } from "./keyRefusals";
import { organizeDocuments } from "./organizeDocuments";
import type { ReviewProblemKind } from "./reviewProblems";
import { useAppStore } from "./store";

/** Settings › Models › Advanced › Tagging: the one model choice for tagging and Organize. */
const organizeModelSettings = () => useAppStore.getState().openSettings("models", "tagging");

/** The User came back to the app after adding credit: the Documents try once, with no press. */
function retryWhenBack(documents: readonly string[]): void {
  window.addEventListener(
    "focus",
    () => {
      void organizeDocuments([...documents]).catch((error: unknown) =>
        useAppStore.getState().reportError(error),
      );
    },
    { once: true },
  );
}

export async function fixOrganizeProblem(
  kind: ReviewProblemKind,
  documents: readonly string[],
): Promise<void> {
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
    if (provider && url) {
      useKeyRefusals.getState().openBilling(provider.id, url);
      retryWhenBack(documents);
    } else {
      organizeModelSettings();
    }
  } catch (error) {
    reportError(error);
  }
}
