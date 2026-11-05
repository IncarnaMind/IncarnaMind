/**
 * The one action a group of Organize failures offers (#2308): add credit, check
 * the key, or choose another model, in the words the Answer's problems already
 * use. Once the User is back from adding credit, every Document that still has
 * that failure tries once by itself (#2535).
 */

import { core } from "./core";
import { billingUrlOfProvider, useKeyRefusals } from "./keyRefusals";
import { organizeDocuments } from "./organizeDocuments";
import { type ReviewProblemKind, reviewProblemsOf } from "./reviewProblems";
import { allExamples, isOwnDocument, useAppStore } from "./store";

/** Settings › Models › Advanced › Tagging: the one model choice for tagging and Organize. */
const organizeModelSettings = () => useAppStore.getState().openSettings("models", "tagging");

/** The Documents whose latest failure is this cause now, the list To review and ⌘K act on (#2535). */
export function documentsOfCause(kind: ReviewProblemKind): readonly string[] {
  const state = useAppStore.getState();
  const own = state.documents.filter((document) => isOwnDocument(document, allExamples(state)));
  return (
    reviewProblemsOf(own, state.library?.assignments ?? []).find((problem) => problem.kind === kind)
      ?.documentIds ?? []
  );
}

let retryPending = false;

/**
 * The User came back after adding credit: every Document that still has the credit failure tries
 * once, with no press. Only an Add credit press arms this, so a plain return spends nothing (#2535).
 */
function retryWhenBack(): void {
  if (retryPending) return;
  retryPending = true;
  window.addEventListener(
    "focus",
    () => {
      retryPending = false;
      const ids = documentsOfCause("credit");
      if (ids.length === 0) return;
      void organizeDocuments([...ids]).catch((error: unknown) =>
        useAppStore.getState().reportError(error),
      );
    },
    { once: true },
  );
}

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
    if (provider && url) {
      useKeyRefusals.getState().openBilling(provider.id, url);
      retryWhenBack();
    } else {
      organizeModelSettings();
    }
  } catch (error) {
    reportError(error);
  }
}
